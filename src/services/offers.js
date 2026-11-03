// Order bumps, upsells and downsells.
//
// Three shapes of the same idea: a second thing offered to somebody who is
// already buying. They differ in WHEN, and the when is what makes them
// different features rather than one feature with a flag.
//
//   bump      a checkbox inside the checkout, ticked before paying. It joins
//             the same charge, so there is one authorization and one receipt.
//   upsell    offered AFTER the payment succeeded, charged in one click
//             against the credential the first sale produced.
//   downsell  offered instead, to somebody who declined the upsell.
//
// WHY THE UPSELL IS A SEPARATE CHARGE and not an edit of the first one: the
// first charge is already authorized and, for Pix or boleto, already paid.
// Re-charging a different amount is not something a gateway offers, and
// pretending otherwise is how a refund request gets written.
//
// WHICH GATEWAYS CAN DO IT: only the ones whose saved credential can be
// charged again. Mercado Pago's token is single use and PayPal wants the buyer
// to approve every purchase, so for those the funnel simply does not appear.
// Offering a one-click button that cannot click is worse than not offering it.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const money = require("../lib/money");
const { badRequest, notFound } = require("../lib/errors");
const catalog = require("./catalog");

const KINDS = ["bump", "upsell", "downsell"];

// The most bumps a checkout will show. Past three it stops being an offer and
// starts being a second shopping page, on the screen where the buyer has
// already decided.
const MAX_BUMPS_SHOWN = 3;

async function create(merchantId, input = {}) {
  const kind = v.oneOf(input.kind, KINDS);
  if (!kind) throw badRequest(`kind must be one of: ${KINDS.join(", ")}.`);

  const title = v.text(input.title, 120);
  if (!title) throw badRequest("An offer needs a title.", { title: "Required." });

  const trigger = await catalog.findProduct(merchantId, String(input.trigger_product || ""));
  if (!trigger) {
    throw badRequest("trigger_product does not exist.", { trigger_product: "Unknown product." });
  }

  const price = await catalog.findPrice(merchantId, String(input.price || ""));
  if (!price) throw badRequest("price does not exist.", { price: "Unknown price." });
  if (!price.active) throw badRequest("That price is no longer active.");
  if (price.type !== "one_time") {
    // A recurring price inside a funnel would create a subscription from a
    // one-click button with no second confirmation. That is a chargeback
    // waiting to be written.
    throw badRequest("An offer must point at a one time price, not a recurring one.");
  }
  if (price.unit_amount_cents <= 0) throw badRequest("That price has no amount set yet.");

  const result = await db.query(
    `insert into offers
       (merchant_id, public_id, trigger_product_id, kind, offer_price_id,
        title, description, image_url, sort)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      merchantId,
      ids.publicId("offer"),
      trigger.id,
      kind,
      price.id,
      title,
      v.text(input.description, 500),
      v.httpUrl(input.image_url, { allowHttp: process.env.NODE_ENV !== "production" }),
      v.integerInRange(input.sort, 0, 999, 0),
    ]
  );
  return result.rows[0];
}

// Offers joined to the price and product they sell, which is what every caller
// actually needs.
const SELECT_WITH_PRICE = `
  select o.*,
         p.public_id as price_public_id, p.unit_amount_cents, p.compare_at_cents,
         p.currency, p.type as price_type, p.max_installments,
         pr.id as product_id, pr.public_id as product_public_id, pr.name as product_name,
         pr.image_url as product_image_url
    from offers o
    join prices p   on p.id = o.offer_price_id   and p.merchant_id = o.merchant_id
    join products pr on pr.id = p.product_id      and pr.merchant_id = o.merchant_id`;

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(
    `${SELECT_WITH_PRICE} where o.merchant_id = $1 and o.public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

async function list(merchantId, { kind = null, triggerProductId = null } = {}) {
  const params = [merchantId];
  const where = ["o.merchant_id = $1"];
  if (kind) {
    params.push(kind);
    where.push(`o.kind = $${params.length}`);
  }
  if (triggerProductId) {
    params.push(triggerProductId);
    where.push(`o.trigger_product_id = $${params.length}`);
  }
  const result = await db.query(
    `${SELECT_WITH_PRICE} where ${where.join(" and ")} order by o.sort, o.id`,
    params
  );
  return result.rows;
}

async function deactivate(merchantId, publicId) {
  const result = await db.query(
    `update offers set active = false where merchant_id = $1 and public_id = $2 returning *`,
    [merchantId, publicId]
  );
  if (!result.rows[0]) throw notFound("Offer not found.");
  return findByPublicId(merchantId, publicId);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Builds "$3, $4, $5" for an IN list, and returns it with the values.
//
// Written out rather than using `= any($n::int[])`, which real Postgres
// accepts and the in-memory database the tests use does not. A query that
// only works in production is a query nobody has tested.
function inList(values, startAt) {
  return values.map((_value, index) => `$${startAt + index}`).join(", ");
}

// The product ids a session is selling, which is what an offer triggers on.
function triggerProductIdsOf(lineItems) {
  return Array.from(
    new Set((lineItems || []).map((item) => item.product_id).filter((id) => Number.isInteger(id)))
  );
}

// Bumps to show on a checkout.
//
// Filtered to the session's own currency, because a bump joins the SAME
// charge: an offer priced in another currency cannot be added to this total
// without inventing an exchange rate nobody agreed to.
async function bumpsForSession(merchantId, session, lineItems) {
  const productIds = triggerProductIdsOf(lineItems);
  if (!productIds.length) return [];

  const params = [merchantId, session.currency, MAX_BUMPS_SHOWN, ...productIds];
  const result = await db.query(
    `${SELECT_WITH_PRICE}
      where o.merchant_id = $1 and o.kind = 'bump' and o.active = true
        and p.active = true and pr.active = true
        and p.currency = $2
        and o.trigger_product_id in (${inList(productIds, 4)})
      order by o.sort, o.id
      limit $3`,
    params
  );

  // Something already in the cart is not an offer, it is a duplicate line.
  const alreadySelling = new Set(
    (lineItems || []).map((item) => item.price_id).filter((id) => Number.isInteger(id))
  );
  return result.rows.filter((offer) => !alreadySelling.has(offer.offer_price_id));
}

// The next step of the post-purchase funnel, or null when there is none.
//
// IT TAKES NO "what just happened" ARGUMENT, and that is the point. An earlier
// version did, and the page and the POST that followed it passed different
// values: the buyer declined the upsell, the POST correctly looked for a
// downsell, and then the page they landed on looked for an upsell again, found
// none unanswered, and sent them to the finish line. The downsell was
// unreachable.
//
// So the step is DEDUCED from what is already recorded, which is the only
// thing both callers can agree about:
//
//   an unanswered upsell            -> show it
//   every upsell answered, one declined -> show an unanswered downsell
//   anything else                   -> the funnel is over
//
// A buyer who ACCEPTED the upsell gets no downsell, which is the whole reason
// a downsell exists.
async function nextFunnelStep(merchantId, order) {
  // A funnel needs a credential to charge again. Without one the button would
  // be a lie.
  if (!order.card_token || !order.gateway) return null;

  const { capabilitiesOf } = require("../gateways");
  const { isDemo } = require("../config");
  if (!isDemo() && !capabilitiesOf(order.gateway).supportsRecurring) return null;

  // Which products this buyer bought on the order that started the funnel.
  const rootId = order.parent_order_id || order.id;
  const items = await db.query(
    `select distinct product_id from order_items
      where merchant_id = $1 and order_id = $2 and product_id is not null`,
    [merchantId, rootId]
  );
  const productIds = items.rows.map((row) => row.product_id);
  if (!productIds.length) return null;

  const candidates = await db.query(
    `${SELECT_WITH_PRICE}
      where o.merchant_id = $1 and o.active = true
        and p.active = true and pr.active = true
        and p.currency = $2
        and o.trigger_product_id in (${inList(productIds, 3)})
      order by o.sort, o.id`,
    [merchantId, order.currency, ...productIds]
  );
  if (!candidates.rows.length) return null;

  // Every offer already answered on this funnel, and HOW. An offer answered
  // once is never offered again: without that, a refresh of the one click page
  // is a second charge.
  const answered = await db.query(
    `select offer_id, kind, status from orders
      where merchant_id = $1 and parent_order_id = $2 and offer_id is not null`,
    [merchantId, rootId]
  );
  const answeredIds = new Set(answered.rows.map((row) => row.offer_id));
  // A decline is recorded as a canceled, zero amount row.
  const declinedAnUpsell = answered.rows.some(
    (row) => row.kind === "upsell" && row.status === "canceled"
  );

  const unanswered = (kind) =>
    candidates.rows.find((offer) => offer.kind === kind && !answeredIds.has(offer.id)) || null;

  const upsell = unanswered("upsell");
  if (upsell) return upsell;

  return declinedAnUpsell ? unanswered("downsell") : null;
}

// Has this exact offer already produced an order on this funnel?
async function alreadyTaken(merchantId, rootOrderId, offerId) {
  const result = await db.query(
    `select id from orders where merchant_id = $1 and parent_order_id = $2 and offer_id = $3`,
    [merchantId, rootOrderId, offerId]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function toApi(row) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "offer",
    kind: row.kind,
    title: row.title,
    description: row.description,
    image_url: row.image_url || row.product_image_url || null,
    price: row.price_public_id,
    product: row.product_public_id,
    currency: row.currency,
    unit_amount_cents: row.unit_amount_cents,
    compare_at_cents: row.compare_at_cents,
    active: row.active,
    sort: row.sort,
    created_at: row.created_at,
  };
}

// What a page renders, with the money already formatted on the server so no
// template has to do arithmetic.
function toView(row, { locale = "pt-BR" } = {}) {
  if (!row) return null;
  return {
    id: row.public_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    image_url: row.image_url || row.product_image_url || null,
    amount_cents: row.unit_amount_cents,
    amount_formatted: money.formatMoney(row.unit_amount_cents, row.currency, locale),
    compare_at_formatted: row.compare_at_cents
      ? money.formatMoney(row.compare_at_cents, row.currency, locale)
      : null,
  };
}

module.exports = {
  KINDS,
  MAX_BUMPS_SHOWN,
  create,
  list,
  findByPublicId,
  deactivate,
  bumpsForSession,
  nextFunnelStep,
  alreadyTaken,
  triggerProductIdsOf,
  inList,
  toApi,
  toView,
};
