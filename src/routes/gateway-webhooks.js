// Inbound notifications from the payment gateways.
//
// Mounted at /gateway-webhooks. The address carries a token:
//
//   POST /gateway-webhooks/asaas/<token>
//
// THAT TOKEN IS NOT DECORATION. With every merchant using their own gateway
// account, a notification's signature can only be verified with THAT
// merchant's key, and the verification has to happen before the order is
// found. So the merchant has to come from the URL: there is nothing else to
// look them up by at that point in the request.
//
// NO RATE LIMIT HERE, on purpose. The gateway has to be able to deliver, every
// time. The protection is the signature check inside, and the deduplication
// that follows it.
const express = require("express");
const ctx = require("../db/merchant-context");
const db = require("../db");
const gatewayConfig = require("../services/gateway-config");
const orders = require("../services/orders");
const { getGateway } = require("../gateways");

const router = express.Router();

// Has this notification already been handled?
//
// Gateways resend. A resent "paid" must not pay twice, and the insert against
// a unique index is what makes that true even when two copies arrive at the
// same instant: one insert wins, the other sees the duplicate and stops.
async function alreadySeen(gateway, eventId, merchantId) {
  if (!eventId) return false;
  try {
    await db.query(
      `insert into gateway_events (gateway, event_id, merchant_id) values ($1, $2, $3)`,
      [gateway, String(eventId), merchantId],
      { withoutMerchant: "deduplication happens before the notification is attributed to an order" }
    );
    return false;
  } catch (err) {
    const duplicate = err.code === "23505" || /duplicate|unique/i.test(err.message || "");
    if (duplicate) return true;
    throw err;
  }
}

async function handle(gatewayName, req, res) {
  const resolved = await gatewayConfig.merchantByWebhookToken(req.params.token);
  if (!resolved) {
    // 404, not 200. The gateway retries, and the merchant sees the failures in
    // their gateway dashboard, which is far better than silently swallowing
    // somebody's payment notification.
    return res.status(404).json({ error: "Unknown webhook address." });
  }
  if (resolved.gateway !== gatewayName) {
    return res.status(404).json({ error: "Unknown webhook address." });
  }

  return ctx.withMerchant(resolved.merchantId, async () => {
    const gateway = await getGateway({
      merchantId: resolved.merchantId,
      gateway: gatewayName,
      livemode: resolved.livemode,
    });

    // The signature check comes first, before anything is parsed or looked up.
    // Awaited because some adapters verify against a fetched certificate.
    if (!(await gateway.verifyWebhook(req))) {
      console.warn(`[gateway-webhooks] Rejected an unsigned ${gatewayName} notification.`);
      return res.status(401).json({ error: "Invalid signature." });
    }

    const event = await gateway.parseWebhook(req);
    if (!event) {
      // Understood, and nothing to do: a notification type this adapter does
      // not map. 200 so the gateway stops resending it.
      return res.json({ received: true, ignored: true });
    }

    if (await alreadySeen(gatewayName, event.eventId, resolved.merchantId)) {
      return res.json({ received: true, duplicate: true });
    }

    const order = await findOrder(resolved.merchantId, gatewayName, event);
    if (!order) {
      // A charge this installation did not create. It could be a sale made
      // elsewhere in the same gateway account, which is legitimate. Logged and
      // accepted, because resending will not make it ours.
      console.warn(
        `[gateway-webhooks] ${gatewayName} notification for an unknown charge ` +
          `${event.gatewayChargeId || event.gatewayCaptureId || event.externalReference}.`
      );
      return res.json({ received: true, unknown_charge: true });
    }

    // Some gateways tell us which charge changed and nothing else. For those,
    // the only honest move is to ask, server to server, rather than guess from
    // a notification that states no status.
    if (gateway.statusFromQuery || !event.status) {
      const reconciled = await orders.reconcile(resolved.merchantId, order);
      return res.json({
        received: true,
        changed: reconciled.changed,
        status: reconciled.status,
        source: "query",
      });
    }

    // THE AMOUNT CHECK. When the notification states an amount, it has to
    // match what we charged. A "paid" for less than the order is not a paid
    // order, and without this check a mismatched notification would release
    // the product for a fraction of the price.
    if (event.amountCents != null && Number(event.amountCents) !== Number(order.amount_cents)) {
      console.error(
        `[gateway-webhooks] Amount mismatch on ${order.public_id}: ` +
          `notification says ${event.amountCents}, order is ${order.amount_cents}.`
      );
      return res.status(202).json({ received: true, amount_mismatch: true });
    }

    // Learn the identifiers this notification taught us, before the status
    // changes. An order rescued by its external reference has no charge id
    // yet, and a PayPal order has no capture id until the capture happens.
    await rememberIdentifiers(resolved.merchantId, order, gatewayName, event);

    // MONEY GOING BACK DOES NOT GO THROUGH markStatus.
    //
    // A refund has to move the order's running total and decide, from that,
    // whether the sale is reversed at all: a partial refund leaves a paid
    // order, because the buyer still has what they bought. Letting the status
    // machine handle it would turn every partial refund into a full reversal.
    if (event.status === "refunded" || event.partialRefund) {
      const refunds = require("../services/refunds");
      const applied = await refunds.applyFromGateway({
        merchantId: resolved.merchantId,
        order,
        amountCents: event.refundedCents,
        gatewayRefundId: event.gatewayRefundId || null,
      });
      const fresh = await orders.findById(resolved.merchantId, order.id);
      return res.json({
        received: true,
        refund: applied ? applied.public_id : null,
        status: fresh.status,
      });
    }

    // A dispute is recorded before the order moves, so the amount at stake is
    // on file even if the status transition is refused.
    if (event.status === "chargeback") {
      const disputes = require("../services/disputes");
      await disputes.open({
        merchantId: resolved.merchantId,
        order,
        gateway: gatewayName,
        gatewayDisputeId: event.disputeId || event.eventId,
        amountCents: event.amountCents,
        currency: event.currency,
        reason: event.disputeReason || event.eventType,
      });
    }

    const result = await orders.markStatus(
      resolved.merchantId,
      order.id,
      event.status,
      `webhook:${gatewayName}`
    );

    return res.json({ received: true, changed: result.changed, status: result.order.status });
  });
}

// Finds the order a notification is about, trying each identifier the adapter
// could extract.
//
// THE EXTERNAL REFERENCE IS NOT A CONVENIENCE, it is the rescue path. If the
// response to a charge creation is lost in transit, the order has no charge id
// and the payment notification has no order: money in the merchant's account,
// an order pending forever, and nobody alerted. Every adapter sends our public
// id on creation, and every gateway echoes it back.
async function findOrder(merchantId, gatewayName, event) {
  if (event.gatewayChargeId) {
    const byCharge = await orders.findByCharge(merchantId, gatewayName, event.gatewayChargeId);
    if (byCharge) return byCharge;
  }

  if (event.gatewayCaptureId) {
    const byCapture = await orders.findByCaptureId(merchantId, gatewayName, event.gatewayCaptureId);
    if (byCapture) return byCapture;
  }

  if (event.externalReference) {
    const byReference = await orders.findByPublicId(merchantId, String(event.externalReference));
    // It has to be an order of THIS gateway. A malformed or hostile reference
    // must not be able to move an order that belongs to another processor.
    if (byReference && (!byReference.gateway || byReference.gateway === gatewayName)) {
      return byReference;
    }
  }

  return null;
}

async function rememberIdentifiers(merchantId, order, gatewayName, event) {
  const updates = {};
  if (event.gatewayChargeId && !order.gateway_charge_id) {
    updates.gateway_charge_id = String(event.gatewayChargeId);
  }
  if (event.gatewayCaptureId && !order.gateway_capture_id) {
    updates.gateway_capture_id = String(event.gatewayCaptureId);
  }
  if (!order.gateway) updates.gateway = gatewayName;
  if (!Object.keys(updates).length) return;

  const fields = Object.keys(updates);
  const values = fields.map((field) => updates[field]);
  const assignments = fields.map((field, index) => `${field} = $${index + 3}`).join(", ");
  await db.query(
    `update orders set ${assignments}, updated_at = now() where merchant_id = $1 and id = $2`,
    [merchantId, order.id, ...values]
  );
}

for (const gateway of ["asaas", "pagarme", "mercadopago", "paypal"]) {
  router.post(`/${gateway}/:token`, async (req, res) => {
    try {
      await handle(gateway, req, res);
    } catch (err) {
      console.error(`[gateway-webhooks] ${gateway} failed:`, err && err.message);
      // 500 so the gateway retries: the problem was ours.
      res.status(500).json({ error: "Could not process the notification." });
    }
  });
}

module.exports = { router, alreadySeen, findOrder, rememberIdentifiers };
