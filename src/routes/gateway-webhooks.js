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
    if (!gateway.verifyWebhook(req)) {
      console.warn(`[gateway-webhooks] Rejected an unsigned ${gatewayName} notification.`);
      return res.status(401).json({ error: "Invalid signature." });
    }

    const event = gateway.parseWebhook(req);
    if (!event) {
      // Understood, and nothing to do: a notification type this adapter does
      // not map. 200 so the gateway stops resending it.
      return res.json({ received: true, ignored: true });
    }

    if (await alreadySeen(gatewayName, event.eventId, resolved.merchantId)) {
      return res.json({ received: true, duplicate: true });
    }

    if (!event.status || !event.gatewayChargeId) {
      return res.json({ received: true, ignored: true });
    }

    const order = await orders.findByCharge(resolved.merchantId, gatewayName, event.gatewayChargeId);
    if (!order) {
      // A charge this installation did not create. Could be a sale made
      // elsewhere in the same gateway account, which is legitimate. Logged and
      // accepted, because resending will not make it ours.
      console.warn(
        `[gateway-webhooks] ${gatewayName} notification for an unknown charge ${event.gatewayChargeId}.`
      );
      return res.json({ received: true, unknown_charge: true });
    }

    // THE AMOUNT CHECK. When the notification states an amount, it has to
    // match what we charged. A "paid" for less than the order is not a paid
    // order, and without this check a tampered or mismatched notification
    // would release the product for a fraction of the price.
    if (event.amountCents != null && Number(event.amountCents) !== Number(order.amount_cents)) {
      console.error(
        `[gateway-webhooks] Amount mismatch on ${order.public_id}: ` +
          `notification says ${event.amountCents}, order is ${order.amount_cents}.`
      );
      return res.status(202).json({ received: true, amount_mismatch: true });
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

module.exports = { router, alreadySeen };
