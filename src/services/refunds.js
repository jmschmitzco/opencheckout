// Giving money back.
//
// THREE RULES, and every one of them is here because the obvious version is
// wrong in a way somebody only notices from a support ticket.
//
//   1. A REQUEST IS NOT A REFUND. The processor can still deny it: a Pix
//      refund with no balance in the seller's account is refused outright, and
//      a card refund can fail at the issuer. A row starts as `requested` and
//      only the gateway moves it to `succeeded`. Marking it done when we asked
//      is how a buyer loses their access for a refund that never happened.
//
//   2. A PARTIAL REFUND DOES NOT REVERSE THE ORDER. The buyer still has what
//      they bought; they were given some money back. The order stays paid, the
//      running total on it goes up, and a different event goes out.
//
//   3. THE TOTAL IS CAPPED, counting what is still in flight. Without counting
//      pending requests, two tabs, or an impatient second click, refund the
//      same money twice and the merchant finds out from their statement.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const money = require("../lib/money");
const { scrub } = require("../lib/scrub");
const { badRequest, conflict, gatewayError } = require("../lib/errors");
const { getGateway } = require("../gateways");
const events = require("./events");
const webhooksOut = require("./webhooks-out");

const STATUSES = ["requested", "succeeded", "failed", "canceled"];
const SOURCES = ["dashboard", "api", "gateway"];

// Statuses a refund can be asked for. A refused or expired order was never
// paid, and a charged back one already had its money taken.
const REFUNDABLE_ORDER_STATUSES = ["paid", "refunded"];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function listForOrder(merchantId, orderId) {
  const result = await db.query(
    `select * from refunds where merchant_id = $1 and order_id = $2 order by id`,
    [merchantId, orderId]
  );
  return result.rows;
}

async function list(merchantId, { status = null, limit = 100 } = {}) {
  const params = [merchantId];
  const where = ["r.merchant_id = $1"];
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 100)));

  const result = await db.query(
    `select r.*, o.public_id as order_public_id, c.email
       from refunds r
       join orders o on o.id = r.order_id and o.merchant_id = r.merchant_id
       left join customers c on c.id = o.customer_id and c.merchant_id = o.merchant_id
      where ${where.join(" and ")}
      order by r.id desc limit $${params.length}`,
    params
  );
  return result.rows;
}

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(
    `select * from refunds where merchant_id = $1 and public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

// How much of this order could still go back, counting what is already in
// flight. The second half is the part that is easy to forget and expensive to
// forget: a request we have sent and not yet heard about is money that is
// probably already gone.
async function refundableCents(merchantId, order) {
  if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) return 0;

  const pending = await db.query(
    `select coalesce(sum(amount_cents), 0)::int as cents
       from refunds where merchant_id = $1 and order_id = $2 and status = 'requested'`,
    [merchantId, order.id]
  );

  const already = Math.max(0, Number(order.refunded_cents) || 0);
  const inFlight = Math.max(0, Number(pending.rows[0].cents) || 0);
  return Math.max(0, Number(order.amount_cents) - already - inFlight);
}

// ---------------------------------------------------------------------------
// Asking for one
// ---------------------------------------------------------------------------

async function request({ merchant, order, amountCents = null, reason = null, source = "api" }) {
  const merchantId = merchant.id;

  if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
    throw conflict(
      order.status === "chargeback"
        ? "This order was charged back, so the money has already gone back."
        : `An order that is ${order.status} has nothing to refund.`
    );
  }
  if (!order.gateway) throw conflict("This order never reached a gateway.");

  const available = await refundableCents(merchantId, order);
  if (available <= 0) {
    throw conflict("There is nothing left to refund on this order.");
  }

  // No amount means all of what is left, which is what somebody pressing
  // "refund" almost always means.
  const requested = amountCents == null ? available : v.amountCents(amountCents);
  if (requested == null || requested <= 0) {
    throw badRequest("The amount must be a whole number of cents above zero.", {
      amount_cents: "Invalid.",
    });
  }
  if (requested > available) {
    throw badRequest(
      `That is more than is left. At most ${money.formatMoney(available, order.currency)} can still go back.`,
      { amount_cents: "Too much." }
    );
  }

  const refund = await db.query(
    `insert into refunds
       (merchant_id, order_id, public_id, amount_cents, currency, reason, gateway, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      merchantId,
      order.id,
      ids.publicId("refund"),
      requested,
      order.currency,
      v.text(reason, 300),
      order.gateway,
      v.oneOf(source, SOURCES) || "api",
    ]
  );
  const row = refund.rows[0];
  await emit(merchantId, row, order, "refund.created");

  // PayPal refunds a CAPTURE, not the order we created. Every other adapter
  // refunds the charge it issued.
  const reference =
    order.gateway === "paypal" ? order.gateway_capture_id : order.gateway_charge_id;
  if (!reference) {
    await markFailed(merchantId, row.id, "This order has no charge to refund against.");
    throw conflict("This order has no charge that can be refunded.");
  }

  let answer;
  try {
    const gateway = await getGateway({
      merchantId,
      gateway: order.gateway,
      livemode: order.livemode,
      currency: order.currency,
    });
    answer = await gateway.refund(reference, {
      amountCents: requested,
      currency: order.currency,
      reason: v.text(reason, 300),
    });
  } catch (err) {
    console.error(`[refunds] ${row.public_id} failed at ${order.gateway}:`, scrub(err.message));
    await markFailed(merchantId, row.id, "The gateway refused the refund.");
    throw gatewayError("The gateway refused the refund. Nothing was given back.");
  }

  await db.query(
    `update refunds set gateway_refund_id = $3, updated_at = now()
      where merchant_id = $1 and id = $2`,
    [merchantId, row.id, (answer && answer.refundId) || null]
  );

  // SOME GATEWAYS SETTLE IMMEDIATELY and say so. Most answer "pending", and
  // for those the row stays `requested` until a notification arrives. We take
  // "DONE" at its word and nothing else: anything short of it is still a
  // promise, and a promise is not money.
  const settled = String((answer && answer.refundStatus) || "").toUpperCase();
  if (settled === "DONE" || settled === "SUCCEEDED" || settled === "COMPLETED") {
    return applySucceeded({ merchantId, refundId: row.id });
  }

  return findByPublicId(merchantId, row.public_id);
}

// ---------------------------------------------------------------------------
// What the gateway says afterwards
// ---------------------------------------------------------------------------

// Marks a refund succeeded and moves the money on the order.
//
// This is the ONLY place `orders.refunded_cents` goes up, and the only place
// an order becomes fully refunded, so the two can never disagree.
async function applySucceeded({ merchantId, refundId }) {
  const refund = await db.query(
    `update refunds set status = 'succeeded', succeeded_at = now(), updated_at = now()
      where merchant_id = $1 and id = $2 and status = 'requested'
      returning *`,
    [merchantId, refundId]
  );
  // Already applied. A gateway resending its notification must not move the
  // money twice.
  if (!refund.rows[0]) {
    const existing = await db.query(`select * from refunds where merchant_id = $1 and id = $2`, [
      merchantId,
      refundId,
    ]);
    return existing.rows[0] || null;
  }

  const row = refund.rows[0];
  const orders = require("./orders");

  const updated = await db.query(
    `update orders set refunded_cents = refunded_cents + $3, updated_at = now()
      where merchant_id = $1 and id = $2
      returning *`,
    [merchantId, row.order_id, row.amount_cents]
  );
  const order = updated.rows[0];

  await emit(merchantId, row, order, "refund.succeeded");

  if (order.refunded_cents >= order.amount_cents) {
    // Fully given back. Now, and only now, the order is reversed.
    await orders.markStatus(merchantId, order.id, "refunded", "refund:complete");
  } else {
    // Still a paid order. The buyer kept what they bought and got some money
    // back, and an integrator that treated this as a reversal would revoke
    // access somebody is still entitled to.
    await orders.emitOrderEvent(
      merchantId,
      await orders.findById(merchantId, order.id),
      "order.partially_refunded"
    );
  }

  return findByPublicId(merchantId, row.public_id);
}

async function markFailed(merchantId, refundId, why) {
  const result = await db.query(
    `update refunds set status = 'failed', failure_reason = $3, updated_at = now()
      where merchant_id = $1 and id = $2 and status = 'requested'
      returning *`,
    [merchantId, refundId, v.text(why, 300)]
  );
  if (result.rows[0]) {
    const orders = require("./orders");
    const order = await orders.findById(merchantId, result.rows[0].order_id);
    await emit(merchantId, result.rows[0], order, "refund.failed");
  }
  return result.rows[0] || null;
}

// A refund notification arriving from the gateway.
//
// TWO CASES, and the second is the one that gets forgotten: the refund may
// have been issued in the processor's OWN dashboard, by somebody who never
// touched this system. That money is just as gone, so a row is created for it
// rather than the notification being discarded.
async function applyFromGateway({ merchantId, order, amountCents = null, gatewayRefundId = null }) {
  // A refund we already know about, matched by the gateway's own id first.
  if (gatewayRefundId) {
    const byId = await db.query(
      `select * from refunds where merchant_id = $1 and gateway_refund_id = $2`,
      [merchantId, String(gatewayRefundId)]
    );
    if (byId.rows[0]) {
      return byId.rows[0].status === "requested"
        ? applySucceeded({ merchantId, refundId: byId.rows[0].id })
        : byId.rows[0];
    }
  }

  // Otherwise the oldest request still waiting on this order, which is the one
  // this notification is almost certainly about.
  const waiting = await db.query(
    `select * from refunds
      where merchant_id = $1 and order_id = $2 and status = 'requested'
      order by id limit 1`,
    [merchantId, order.id]
  );
  if (waiting.rows[0]) {
    const pending = waiting.rows[0];
    // When the notification states an amount and it does not match what we
    // asked for, the row is corrected to what actually moved. The gateway is
    // the authority on that, not our request.
    if (amountCents != null && Number(amountCents) !== Number(pending.amount_cents)) {
      await db.query(
        `update refunds set amount_cents = $3, updated_at = now()
          where merchant_id = $1 and id = $2`,
        [merchantId, pending.id, Math.max(0, Math.trunc(Number(amountCents)))]
      );
    }
    if (gatewayRefundId) {
      await db.query(
        `update refunds set gateway_refund_id = $3 where merchant_id = $1 and id = $2`,
        [merchantId, pending.id, String(gatewayRefundId)]
      );
    }
    return applySucceeded({ merchantId, refundId: pending.id });
  }

  // Nothing waiting: this was issued outside OpenCheckout. Record it, so the
  // order's running total and the merchant's own dashboard tell the truth.
  const remaining = Math.max(0, Number(order.amount_cents) - Number(order.refunded_cents || 0));
  const amount =
    amountCents != null ? Math.min(remaining, Math.max(0, Math.trunc(Number(amountCents)))) : remaining;
  if (amount <= 0) return null;

  const created = await db.query(
    `insert into refunds
       (merchant_id, order_id, public_id, amount_cents, currency, gateway,
        gateway_refund_id, source, reason)
     values ($1, $2, $3, $4, $5, $6, $7, 'gateway', $8)
     returning *`,
    [
      merchantId,
      order.id,
      ids.publicId("refund"),
      amount,
      order.currency,
      order.gateway,
      gatewayRefundId ? String(gatewayRefundId) : null,
      "Issued in the gateway's own dashboard.",
    ]
  );
  return applySucceeded({ merchantId, refundId: created.rows[0].id });
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

async function emit(merchantId, refund, order, type) {
  try {
    const event = await events.record(
      merchantId,
      type,
      {
        refund: toApi(refund, order),
        order: order ? { id: order.public_id, status: order.status } : null,
      },
      { livemode: Boolean(order && order.livemode) }
    );
    await webhooksOut.enqueue(merchantId, event);
  } catch (err) {
    console.error(`[refunds] Could not emit ${type}:`, err && err.message);
  }
}

function toApi(row, order = null) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "refund",
    order: order ? order.public_id : row.order_public_id || null,
    amount_cents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    source: row.source,
    gateway: row.gateway,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    succeeded_at: row.succeeded_at,
  };
}

module.exports = {
  STATUSES,
  SOURCES,
  REFUNDABLE_ORDER_STATUSES,
  list,
  listForOrder,
  findByPublicId,
  refundableCents,
  request,
  applySucceeded,
  applyFromGateway,
  markFailed,
  toApi,
};
