// Disputes, which is what a chargeback is before anybody has won it.
//
// THE DIFFERENCE FROM A REFUND, and it is the whole reason this is a separate
// file: a refund is the merchant choosing to give money back. A dispute is the
// card network taking it, first, and asking questions afterwards. By the time
// one of these rows exists the money is already gone from the merchant's
// balance, so nothing here "does" anything to a gateway. It records.
//
// What the merchant can do about it happens in the processor's own dashboard,
// because that is where the evidence is uploaded and where the deadline lives.
// Pretending otherwise, with a button here that cannot actually submit
// evidence, would be worse than saying so.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const events = require("./events");
const webhooksOut = require("./webhooks-out");

const STATUSES = ["open", "won", "lost", "closed"];

// Opens one, or updates the one that is already there.
//
// Idempotent on (gateway, gateway_dispute_id), because the same notification
// arrives more than once and a second row would double the amount a merchant
// thinks is at stake.
async function open({ merchantId, order, gateway, gatewayDisputeId, amountCents, currency, reason, respondBy }) {
  const reference = gatewayDisputeId ? String(gatewayDisputeId) : null;

  if (reference) {
    const existing = await db.query(
      `select * from disputes where merchant_id = $1 and gateway = $2 and gateway_dispute_id = $3`,
      [merchantId, gateway, reference]
    );
    if (existing.rows[0]) return existing.rows[0];
  }

  const amount =
    amountCents != null
      ? Math.max(0, Math.trunc(Number(amountCents)))
      : Math.max(0, Number((order && order.amount_cents) || 0));

  const created = await db.query(
    `insert into disputes
       (merchant_id, order_id, public_id, amount_cents, currency, reason,
        gateway, gateway_dispute_id, respond_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      merchantId,
      order ? order.id : null,
      ids.publicId("dispute"),
      amount,
      String((order && order.currency) || currency || "BRL").toUpperCase(),
      v.text(reason, 300),
      gateway,
      reference,
      respondBy || null,
    ]
  );

  const row = created.rows[0];
  await emit(merchantId, row, order, "dispute.opened");
  return row;
}

async function close({ merchantId, disputeId, status, reason = null }) {
  const clean = v.oneOf(status, ["won", "lost", "closed"]) || "closed";
  const result = await db.query(
    `update disputes
        set status = $3, reason = coalesce($4, reason), resolved_at = now(), updated_at = now()
      where merchant_id = $1 and id = $2 and status = 'open'
      returning *`,
    [merchantId, disputeId, clean, v.text(reason, 300)]
  );
  if (!result.rows[0]) return null;

  const row = result.rows[0];
  const order = row.order_id ? await require("./orders").findById(merchantId, row.order_id) : null;
  await emit(merchantId, row, order, "dispute.closed");
  return row;
}

async function list(merchantId, { status = null, limit = 100 } = {}) {
  const params = [merchantId];
  const where = ["d.merchant_id = $1"];
  if (status) {
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 100)));

  const result = await db.query(
    `select d.*, o.public_id as order_public_id, c.email
       from disputes d
       left join orders o on o.id = d.order_id and o.merchant_id = d.merchant_id
       left join customers c on c.id = o.customer_id and c.merchant_id = o.merchant_id
      where ${where.join(" and ")}
      order by d.id desc limit $${params.length}`,
    params
  );
  return result.rows;
}

async function listForOrder(merchantId, orderId) {
  const result = await db.query(
    `select * from disputes where merchant_id = $1 and order_id = $2 order by id`,
    [merchantId, orderId]
  );
  return result.rows;
}

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(
    `select * from disputes where merchant_id = $1 and public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

// How much is currently being argued over. The dashboard shows it because it
// is money a merchant has lost but has not been told they lost.
async function openAmount(merchantId) {
  const result = await db.query(
    `select coalesce(sum(amount_cents), 0)::int as cents, count(*)::int as n
       from disputes where merchant_id = $1 and status = 'open'`,
    [merchantId]
  );
  return { cents: result.rows[0].cents, count: result.rows[0].n };
}

async function emit(merchantId, dispute, order, type) {
  try {
    const event = await events.record(
      merchantId,
      type,
      {
        dispute: toApi(dispute, order),
        order: order ? { id: order.public_id, status: order.status } : null,
      },
      { livemode: Boolean(order && order.livemode) }
    );
    await webhooksOut.enqueue(merchantId, event);
  } catch (err) {
    console.error(`[disputes] Could not emit ${type}:`, err && err.message);
  }
}

function toApi(row, order = null) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "dispute",
    order: order ? order.public_id : row.order_public_id || null,
    amount_cents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    gateway: row.gateway,
    respond_by: row.respond_by,
    opened_at: row.opened_at,
    resolved_at: row.resolved_at,
  };
}

module.exports = {
  STATUSES,
  open,
  close,
  list,
  listForOrder,
  findByPublicId,
  openAmount,
  toApi,
};
