// The event log.
//
// Everything that happens is recorded here in exactly the shape the webhook
// carries. That matters for one specific reason: an integrator who missed a
// webhook, or whose server was down for an hour, can replay from this list
// instead of writing a reconciliation job against our order table. Without it,
// "we didn't get the webhook" has no answer.
const db = require("../db");
const ids = require("../lib/ids");

// The complete list, which is also the list the dashboard offers and the docs
// describe. A webhook endpoint subscribes to some of these, or to all of them
// by subscribing to none.
const EVENT_TYPES = [
  // Checkout
  "checkout.session.created",
  "checkout.session.completed",
  "checkout.session.expired",
  // Orders. These are the ones that mean money.
  "order.created",
  "order.paid",
  "order.refused",
  "order.refunded",
  "order.chargeback",
  "order.expired",
  // Subscriptions
  "subscription.created",
  "subscription.activated",
  "subscription.renewed",
  "subscription.payment_failed",
  "subscription.canceled",
  // Carts
  "cart.abandoned",
  "cart.recovered",
];

// How the dashboard groups them. Technical names stay the names an integrator
// subscribes to and reads in the payload; this only changes the label.
const EVENT_GROUPS = [
  { group: "Payments", events: ["order.paid", "order.refused", "order.created", "order.expired"] },
  { group: "Reversals", events: ["order.refunded", "order.chargeback"] },
  {
    group: "Subscriptions",
    events: [
      "subscription.created",
      "subscription.activated",
      "subscription.renewed",
      "subscription.payment_failed",
      "subscription.canceled",
    ],
  },
  {
    group: "Checkout",
    events: ["checkout.session.created", "checkout.session.completed", "checkout.session.expired"],
  },
  { group: "Carts", events: ["cart.abandoned", "cart.recovered"] },
];

function isKnownType(type) {
  return EVENT_TYPES.includes(String(type || ""));
}

// Records an event and returns it. The caller then hands it to the outbound
// queue; recording and delivering are separate so a delivery problem can never
// lose the record of what happened.
async function record(merchantId, type, data, { livemode = false } = {}) {
  if (!isKnownType(type)) throw new Error(`Unknown event type: ${type}`);

  const publicId = ids.publicId("event");
  const payload = {
    id: publicId,
    type,
    // When the event happened. Also what protects a signed delivery against
    // replay, and what lets a receiver put out of order events back in order.
    created_at: new Date().toISOString(),
    livemode: Boolean(livemode),
    data: data || {},
  };

  await db.query(
    `insert into events (merchant_id, public_id, type, livemode, payload)
     values ($1, $2, $3, $4, $5)`,
    [merchantId, publicId, type, Boolean(livemode), JSON.stringify(payload)]
  );

  return { publicId, type, payload };
}

async function list(merchantId, { type = null, limit = 50, before = null } = {}) {
  const params = [merchantId];
  const where = ["merchant_id = $1"];
  if (type) {
    params.push(type);
    where.push(`type = $${params.length}`);
  }
  if (before) {
    params.push(before);
    where.push(`id < (select id from events where merchant_id = $1 and public_id = $${params.length})`);
  }
  params.push(Math.max(1, Math.min(100, Number(limit) || 50)));

  const result = await db.query(
    `select public_id, type, livemode, payload, created_at
       from events
      where ${where.join(" and ")}
      order by id desc
      limit $${params.length}`,
    params
  );
  return result.rows.map((row) => {
    try {
      return JSON.parse(row.payload);
    } catch {
      return { id: row.public_id, type: row.type, created_at: row.created_at, data: {} };
    }
  });
}

module.exports = { EVENT_TYPES, EVENT_GROUPS, isKnownType, record, list };
