// Where a buyer lands after approving a payment somewhere else.
//
//   GET /payments/:gateway/return?order=ord_...
//   GET /payments/:gateway/cancel?order=ord_...
//
// PayPal is the case this exists for. The buyer leaves, approves, and comes
// back, and THE MONEY ONLY EXISTS ONCE WE CAPTURE. An approved order that is
// never captured is an authorization that quietly expires, so this route is
// not a courtesy redirect: it is part of getting paid.
//
// Two things make it safe to expose:
//
//   1. It captures by asking the GATEWAY, never by trusting the query string.
//      The order id in the URL only says which order to look at; whether it
//      was approved is a question only PayPal can answer.
//   2. Capturing twice is not a problem. The adapter uses a stable
//      idempotency key and treats ALREADY_CAPTURED as success, which is what
//      makes the race between this route and the webhook harmless.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../db/merchant-context");
const db = require("../db");
const { isDemo } = require("../config");
const { getGateway, capabilitiesOf, GATEWAYS } = require("../gateways");
const orders = require("../services/orders");

const router = express.Router();

const limit = rateLimit({
  windowMs: 60_000,
  max: 60,
  skip: () => isDemo(),
  standardHeaders: true,
  legacyHeaders: false,
});

// The order's public id is the only identifier the return URL carries, and it
// is what tells us whose merchant context to open.
async function loadOrder(publicId) {
  const clean = String(publicId || "").trim();
  if (!/^ord_[a-z0-9]{8,40}$/.test(clean)) return null;
  const result = await db.query(
    `select * from orders where public_id = $1`,
    [clean],
    { withoutMerchant: "the return URL carries only the order id; the merchant comes from it" }
  );
  return result.rows[0] || null;
}

// Where to send the buyer once this is settled, with the outcome attached.
async function destinationFor(merchantId, order) {
  if (!order.session_id) return null;
  const result = await db.query(
    `select success_url, cancel_url from checkout_sessions where merchant_id = $1 and id = $2`,
    [merchantId, order.session_id]
  );
  const session = result.rows[0];
  if (!session) return null;

  const base =
    order.status === "canceled" || order.status === "pending"
      ? session.cancel_url || session.success_url
      : session.success_url;
  if (!base) return null;

  try {
    const url = new URL(base);
    url.searchParams.set("order_id", order.public_id);
    url.searchParams.set("status", order.status);
    return url.toString();
  } catch {
    return base;
  }
}

function render(res, status, title, message) {
  return res.status(status).render("error", { title, message });
}

router.get("/payments/:gateway/return", limit, async (req, res, next) => {
  try {
    const gatewayName = String(req.params.gateway || "");
    if (!GATEWAYS.includes(gatewayName) || !capabilitiesOf(gatewayName).usesRedirect) {
      return render(res, 404, "Not found", "There is nothing at this address.");
    }

    const order = await loadOrder(req.query.order);
    if (!order) {
      return render(
        res,
        404,
        "Order not found",
        "We could not find that payment. If you were charged, your receipt will still arrive."
      );
    }

    return ctx.withMerchant(order.merchant_id, async () => {
      // Already settled, by the webhook or by an earlier visit. Nothing to do
      // but send them on, which is also what makes a refresh harmless.
      if (orders.TERMINAL_PAID.includes(order.status)) {
        const destination = await destinationFor(order.merchant_id, order);
        return destination
          ? res.redirect(destination)
          : render(res, 200, "Payment confirmed", "Your payment is confirmed.");
      }

      const gateway = await getGateway({
        merchantId: order.merchant_id,
        gateway: gatewayName,
        livemode: order.livemode,
      });

      let captured;
      try {
        captured = await gateway.captureIfApproved(order.gateway_charge_id);
      } catch (err) {
        // The capture failed for a reason we cannot act on here. The order
        // stays pending, and the webhook or reconciliation will settle it.
        // Telling the buyer their payment failed would be a guess.
        console.error(`[payment-return] Capture failed for ${order.public_id}:`, err.message);
        const destination = await destinationFor(order.merchant_id, order);
        return destination
          ? res.redirect(destination)
          : render(
              res,
              202,
              "We are confirming your payment",
              "This can take a moment. You will get an email as soon as it is confirmed."
            );
      }

      // The capture id is what a refund later needs, and it only exists now.
      if (captured.captureId) {
        await db.query(
          `update orders set gateway_capture_id = $3, updated_at = now()
            where merchant_id = $1 and id = $2`,
          [order.merchant_id, order.id, String(captured.captureId)]
        );
      }

      // THE AMOUNT CHECK, same rule as the webhook: what was captured has to
      // be what was ordered. A capture for less is not a paid order.
      if (
        captured.status === "paid" &&
        captured.amountCents != null &&
        Number(captured.amountCents) !== Number(order.amount_cents)
      ) {
        console.error(
          `[payment-return] Amount mismatch on ${order.public_id}: ` +
            `captured ${captured.amountCents}, ordered ${order.amount_cents}.`
        );
        return render(
          res,
          202,
          "We are checking your payment",
          "Something about the amount did not match. Our team is looking at it."
        );
      }

      if (captured.status && captured.status !== order.status) {
        await orders.markStatus(
          order.merchant_id,
          order.id,
          captured.status,
          `return:${gatewayName}`
        );
      }

      const settled = await orders.findById(order.merchant_id, order.id);
      const destination = await destinationFor(order.merchant_id, settled);
      if (destination) return res.redirect(destination);

      return render(
        res,
        200,
        settled.status === "paid" ? "Payment confirmed" : "We are confirming your payment",
        settled.status === "paid"
          ? "Your payment is confirmed."
          : "This can take a moment. You will get an email as soon as it is confirmed."
      );
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/payments/:gateway/cancel", limit, async (req, res, next) => {
  try {
    const order = await loadOrder(req.query.order);
    if (!order) {
      return render(res, 404, "Not found", "There is nothing at this address.");
    }

    return ctx.withMerchant(order.merchant_id, async () => {
      // Cancelling at the gateway does not cancel the order outright: the
      // buyer may simply have changed their mind about PayPal and want to pay
      // another way. The session is still open, so they are sent back to it.
      const session = await db.query(
        `select public_id, client_secret, status from checkout_sessions
          where merchant_id = $1 and id = $2`,
        [order.merchant_id, order.session_id]
      );
      const row = session.rows[0];
      if (row && row.status === "open") {
        return res.redirect(`/c/${row.public_id}?k=${row.client_secret}`);
      }

      const destination = await destinationFor(order.merchant_id, order);
      return destination
        ? res.redirect(destination)
        : render(res, 200, "Payment cancelled", "Nothing was charged.");
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = { router, loadOrder, destinationFor };
