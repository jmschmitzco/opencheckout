// Subscriptions.
//
// A SaaS lives on recurring revenue, so this is not an add-on here; it is half
// the reason the project exists.
//
// HOW IT WORKS. A subscription-mode checkout session charges the first period
// like any other card sale, and the gateway hands back a reusable credential.
// That token is what every later period is charged against. The renewal loop
// runs on a clock, charges what is due, and moves the period forward.
//
// WHAT IT DELIBERATELY DOES NOT DO, yet:
//   - proration on a plan change. Charging the difference correctly means
//     pricing a partial period, and a wrong answer there is a refund request.
//     Changing a plan today ends one subscription and starts another.
//   - a one time setup fee alongside the recurring price. Two charges, two
//     refund paths.
// Both are listed in the roadmap. Refusing them out loud is better than
// implementing them approximately: approximate billing is the kind of bug a
// customer finds on their statement.
const db = require("../db");
const ctx = require("../db/merchant-context");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const { notFound, conflict } = require("../lib/errors");
const { getGateway } = require("../gateways");
const catalog = require("./catalog");
const events = require("./events");
const webhooksOut = require("./webhooks-out");

const STATUSES = ["incomplete", "trialing", "active", "past_due", "canceled", "unpaid"];

// Statuses that mean "let this user in". The entitlement endpoint is built on
// this list, and so is the portal.
//
// past_due is included on purpose. A card that failed this morning does not
// mean the customer stopped paying; locking them out on the first failure,
// before the retries have run, loses more customers than it saves revenue.
const ENTITLED_STATUSES = ["trialing", "active", "past_due"];

// When retries happen after a failed renewal, in days from the failure. Three
// attempts across a week covers an expired card being replaced, which is the
// usual cause.
const RETRY_DAYS = [1, 3, 7];

function addInterval(date, interval, count = 1) {
  const next = new Date(date.getTime());
  const n = Math.max(1, Number(count) || 1);
  if (interval === "day") next.setDate(next.getDate() + n);
  else if (interval === "week") next.setDate(next.getDate() + 7 * n);
  else if (interval === "year") next.setFullYear(next.getFullYear() + n);
  else {
    // Month arithmetic has an edge every integrator eventually hits: the 31st
    // plus one month. Clamping to the last day of the target month is what
    // keeps a subscription started on 31 January billing on 28 February
    // instead of silently jumping to 3 March.
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + n);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

// Called when a subscription-mode order is paid. The order carries the card
// token; this turns it into a recurring commitment.
async function createFromPaidOrder({ merchantId, order, session }) {
  const items = require("./checkout-sessions").parseLineItems(session);
  const item = items.find((i) => i.type === "recurring");
  if (!item) return null;

  const existing = await db.query(
    `select * from subscriptions
      where merchant_id = $1 and customer_id = $2 and price_id = $3
        and status in ('trialing', 'active', 'past_due')`,
    [merchantId, order.customer_id, item.price_id]
  );
  if (existing.rows[0]) {
    // Already subscribed to this exact price. Creating a second one would bill
    // twice, and the integrator almost certainly did not mean to.
    return existing.rows[0];
  }

  const now = new Date();
  const trialDays = Number(item.trial_days) || 0;
  const trialEnd = trialDays ? new Date(now.getTime() + trialDays * 86400000) : null;
  const periodEnd = trialEnd || addInterval(now, item.interval, item.interval_count);

  const result = await db.query(
    `insert into subscriptions
       (merchant_id, public_id, livemode, customer_id, product_id, price_id, status,
        quantity, currency, amount_cents, interval, interval_count,
        current_period_start, current_period_end, trial_end, payment_method,
        gateway, card_token, external_reference, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     returning *`,
    [
      merchantId,
      ids.publicId("subscription"),
      order.livemode,
      order.customer_id,
      item.product_id,
      item.price_id,
      trialEnd ? "trialing" : "active",
      item.quantity,
      order.currency,
      item.unit_amount_cents * item.quantity,
      item.interval,
      item.interval_count,
      now,
      periodEnd,
      trialEnd,
      order.payment_method,
      order.gateway,
      order.card_token,
      order.external_reference,
      order.metadata,
    ]
  );
  const subscription = result.rows[0];

  await db.query(
    `insert into subscription_invoices
       (merchant_id, subscription_id, order_id, period_start, period_end, status, amount_cents, currency)
     values ($1, $2, $3, $4, $5, 'paid', $6, $7)`,
    [merchantId, subscription.id, order.id, now, periodEnd, order.amount_cents, order.currency]
  );

  await emit(merchantId, subscription, "subscription.created");
  await emit(merchantId, subscription, "subscription.activated");
  return subscription;
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

// Everything whose period ended, or whose retry is due.
async function dueForRenewal({ limit = 50 } = {}) {
  const result = await db.query(
    `select * from subscriptions
      where status in ('active', 'trialing', 'past_due')
        and ((next_attempt_at is not null and next_attempt_at <= now())
             or (next_attempt_at is null and current_period_end <= now()))
      order by current_period_end
      limit $1`,
    [limit],
    { withoutMerchant: "the renewal loop runs for every merchant, one row at a time" }
  );
  return result.rows;
}

// Charges one period. Returns { ok, status }.
async function renew(merchantId, subscription) {
  if (subscription.cancel_at_period_end) {
    // The customer asked to stop and has now reached the end of what they paid
    // for. Charging again here would be the single worst bug this file could
    // have.
    return cancelNow(merchantId, subscription.id, "period_end");
  }
  if (!subscription.card_token) {
    return markPaymentFailed(merchantId, subscription, "No saved card to charge.");
  }

  const orders = require("./orders");
  const customers = require("./customers");
  const customer = await customers.findById(merchantId, subscription.customer_id);
  if (!customer) return markPaymentFailed(merchantId, subscription, "The customer record is gone.");

  const periodStart = new Date(subscription.current_period_end);
  const periodEnd = addInterval(periodStart, subscription.interval, subscription.interval_count);

  const { randomUrlToken } = require("../lib/crypto");
  const inserted = await db.query(
    `insert into orders
       (merchant_id, public_id, livemode, customer_id, kind, status, payment_method,
        installments, currency, amount_cents, gateway, card_token, checkout_token,
        external_reference, metadata)
     values ($1, $2, $3, $4, 'main', 'pending', 'card', 1, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      merchantId,
      ids.publicId("order"),
      subscription.livemode,
      subscription.customer_id,
      subscription.currency,
      subscription.amount_cents,
      subscription.gateway,
      subscription.card_token,
      randomUrlToken(24),
      subscription.external_reference,
      subscription.metadata,
    ]
  );
  const order = inserted.rows[0];

  const price = subscription.price_id
    ? await db.query(`select p.public_id, pr.name from prices p
                        join products pr on pr.id = p.product_id and pr.merchant_id = p.merchant_id
                       where p.merchant_id = $1 and p.id = $2`, [merchantId, subscription.price_id])
    : { rows: [] };
  const description = (price.rows[0] && price.rows[0].name) || "Subscription renewal";

  await db.query(
    `insert into order_items
       (merchant_id, order_id, kind, product_id, price_id, description,
        quantity, unit_amount_cents, amount_cents)
     values ($1, $2, 'main', $3, $4, $5, $6, $7, $8)`,
    [
      merchantId,
      order.id,
      subscription.product_id,
      subscription.price_id,
      description,
      subscription.quantity,
      Math.floor(subscription.amount_cents / Math.max(1, subscription.quantity)),
      subscription.amount_cents,
    ]
  );

  let charge;
  try {
    const gateway = await getGateway({
      merchantId,
      gateway: subscription.gateway,
      livemode: subscription.livemode,
    });
    const { customerId } = await gateway.ensureCustomer(customer);
    charge = await gateway.chargeWithToken({
      order: {
        id: order.id,
        publicId: order.public_id,
        amountCents: order.amount_cents,
        currency: order.currency,
        description,
        installments: 1,
        method: "card",
      },
      customer,
      customerId,
      cardToken: subscription.card_token,
    });
  } catch (err) {
    console.error(`[subscriptions] Renewal of ${subscription.public_id} failed:`, err.message);
    // The order row was created before the call and nothing will ever settle
    // it, so it is closed here. Leaving it pending would show the merchant a
    // renewal that looks like it is still coming, forever, and would keep the
    // reconciliation loop asking about a charge that was never made.
    await db.query(
      `update orders set status = 'canceled', refusal_reason = $3, updated_at = now()
        where merchant_id = $1 and id = $2 and status = 'pending'`,
      [merchantId, order.id, "The gateway could not be reached."]
    );
    return markPaymentFailed(merchantId, subscription, "The gateway could not be reached.");
  }

  await db.query(
    `update orders set gateway_charge_id = $3, status = $4, refusal_reason = $5,
            paid_at = case when $4 = 'paid' then now() else null end, updated_at = now()
      where merchant_id = $1 and id = $2`,
    [
      merchantId,
      order.id,
      charge.gatewayChargeId || null,
      charge.status === "paid" ? "paid" : "refused",
      charge.refusalReason || null,
    ]
  );

  const fresh = await orders.findById(merchantId, order.id);
  await orders.emitOrderEvent(merchantId, fresh, charge.status === "paid" ? "order.paid" : "order.refused");

  if (charge.status !== "paid") {
    return markPaymentFailed(merchantId, subscription, charge.refusalReason || "The card was declined.");
  }

  const updated = await db.query(
    `update subscriptions
        set status = 'active', current_period_start = $3, current_period_end = $4,
            attempt_count = 0, next_attempt_at = null, trial_end = null, updated_at = now()
      where merchant_id = $1 and id = $2
      returning *`,
    [merchantId, subscription.id, periodStart, periodEnd]
  );

  await db.query(
    `insert into subscription_invoices
       (merchant_id, subscription_id, order_id, period_start, period_end, status, amount_cents, currency)
     values ($1, $2, $3, $4, $5, 'paid', $6, $7)`,
    [merchantId, subscription.id, order.id, periodStart, periodEnd, order.amount_cents, order.currency]
  );

  await emit(merchantId, updated.rows[0], "subscription.renewed");
  return { ok: true, status: "active" };
}

// A failed renewal. The subscription goes past_due and a retry is scheduled.
// After the last retry it becomes unpaid, which is the state that means "we
// gave up", and the integrator's webhook handler is what decides whether that
// locks the account.
async function markPaymentFailed(merchantId, subscription, reason) {
  const attempt = (subscription.attempt_count || 0) + 1;
  const exhausted = attempt > RETRY_DAYS.length;
  const nextAttempt = exhausted
    ? null
    : new Date(Date.now() + RETRY_DAYS[attempt - 1] * 86400000);

  const result = await db.query(
    `update subscriptions
        set status = $3, attempt_count = $4, next_attempt_at = $5, updated_at = now()
      where merchant_id = $1 and id = $2
      returning *`,
    [merchantId, subscription.id, exhausted ? "unpaid" : "past_due", attempt, nextAttempt]
  );

  await emit(merchantId, result.rows[0], "subscription.payment_failed", { reason, attempt });
  return { ok: false, status: result.rows[0].status, reason };
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

async function cancel(merchantId, publicId, { atPeriodEnd = true } = {}) {
  const subscription = await findByPublicId(merchantId, publicId);
  if (!subscription) throw notFound("Subscription not found.");
  if (subscription.status === "canceled") throw conflict("This subscription is already canceled.");

  if (!atPeriodEnd) {
    const result = await cancelNow(merchantId, subscription.id, "immediate");
    return result.subscription;
  }

  const result = await db.query(
    `update subscriptions set cancel_at_period_end = true, updated_at = now()
      where merchant_id = $1 and id = $2
      returning *`,
    [merchantId, subscription.id]
  );
  await emit(merchantId, result.rows[0], "subscription.canceled", { at_period_end: true });
  return result.rows[0];
}

async function cancelNow(merchantId, subscriptionId, reason) {
  const result = await db.query(
    `update subscriptions
        set status = 'canceled', canceled_at = now(), cancel_at_period_end = false,
            next_attempt_at = null, updated_at = now()
      where merchant_id = $1 and id = $2
      returning *`,
    [merchantId, subscriptionId]
  );
  if (result.rows[0]) {
    await emit(merchantId, result.rows[0], "subscription.canceled", { reason });
  }
  return { ok: true, status: "canceled", subscription: result.rows[0] };
}

// Undoes a cancel_at_period_end, as long as the period has not ended yet.
async function resume(merchantId, publicId) {
  const subscription = await findByPublicId(merchantId, publicId);
  if (!subscription) throw notFound("Subscription not found.");
  if (subscription.status === "canceled") {
    throw conflict("This subscription already ended. Start a new one instead.");
  }
  if (!subscription.cancel_at_period_end) return subscription;

  const result = await db.query(
    `update subscriptions set cancel_at_period_end = false, updated_at = now()
      where merchant_id = $1 and id = $2
      returning *`,
    [merchantId, subscription.id]
  );
  await emit(merchantId, result.rows[0], "subscription.activated", { resumed: true });
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(
    `select * from subscriptions where merchant_id = $1 and public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

async function list(merchantId, { status = null, customerId = null, limit = 50 } = {}) {
  const params = [merchantId];
  const where = ["merchant_id = $1"];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    where.push(`customer_id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(100, Number(limit) || 50)));
  const result = await db.query(
    `select * from subscriptions where ${where.join(" and ")}
      order by id desc limit $${params.length}`,
    params
  );
  return result.rows;
}

async function invoicesFor(merchantId, subscriptionId, { limit = 24 } = {}) {
  const result = await db.query(
    `select * from subscription_invoices
      where merchant_id = $1 and subscription_id = $2
      order by period_start desc
      limit $3`,
    [merchantId, subscriptionId, Math.max(1, Math.min(100, Number(limit) || 24))]
  );
  return result.rows;
}

// THE ENTITLEMENT QUESTION: may this customer in?
//
// This is what a SaaS calls on login, and it is why the external_id column
// exists. It answers from subscriptions AND from paid one-off orders, because
// plenty of products sell lifetime access alongside a monthly plan, and an
// integrator should not have to ask two different questions.
async function entitlementsFor(merchantId, customerId) {
  const [subs, lifetime] = await Promise.all([
    db.query(
      `select s.*, pr.public_id as product_public_id, pr.name as product_name,
              pr.metadata as product_metadata, p.public_id as price_public_id
         from subscriptions s
         left join products pr on pr.id = s.product_id and pr.merchant_id = s.merchant_id
         left join prices p on p.id = s.price_id and p.merchant_id = s.merchant_id
        where s.merchant_id = $1 and s.customer_id = $2
        order by s.id desc`,
      [merchantId, customerId]
    ),
    db.query(
      `select distinct pr.public_id as product_public_id, pr.name as product_name,
              pr.metadata as product_metadata, o.paid_at
         from orders o
         join order_items i on i.order_id = o.id and i.merchant_id = o.merchant_id
         join products pr on pr.id = i.product_id and pr.merchant_id = o.merchant_id
         join prices p on p.id = i.price_id and p.merchant_id = o.merchant_id
        where o.merchant_id = $1 and o.customer_id = $2 and o.status = 'paid'
          and p.type = 'one_time'`,
      [merchantId, customerId]
    ),
  ]);

  const items = [];
  for (const row of subs.rows) {
    items.push({
      object: "entitlement",
      source: "subscription",
      subscription: row.public_id,
      product: row.product_public_id,
      product_name: row.product_name,
      price: row.price_public_id,
      status: row.status,
      active: ENTITLED_STATUSES.includes(row.status),
      cancel_at_period_end: row.cancel_at_period_end,
      current_period_end: row.current_period_end,
      trial_end: row.trial_end,
      metadata: catalog.parseMetadata(row.product_metadata),
    });
  }
  for (const row of lifetime.rows) {
    items.push({
      object: "entitlement",
      source: "purchase",
      product: row.product_public_id,
      product_name: row.product_name,
      status: "paid",
      active: true,
      purchased_at: row.paid_at,
      metadata: catalog.parseMetadata(row.product_metadata),
    });
  }

  return { active: items.some((item) => item.active), items };
}

async function emit(merchantId, subscription, type, extra = {}) {
  if (!subscription) return;
  try {
    const event = await events.record(
      merchantId,
      type,
      { subscription: toApi(subscription), ...extra },
      { livemode: subscription.livemode }
    );
    await webhooksOut.enqueue(merchantId, event);
  } catch (err) {
    console.error(`[subscriptions] Could not emit ${type}:`, err && err.message);
  }
}

function toApi(row) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "subscription",
    livemode: row.livemode,
    status: row.status,
    quantity: row.quantity,
    currency: row.currency,
    amount_cents: row.amount_cents,
    interval: row.interval,
    interval_count: row.interval_count,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    trial_end: row.trial_end,
    cancel_at_period_end: row.cancel_at_period_end,
    canceled_at: row.canceled_at,
    payment_method: row.payment_method,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    external_reference: row.external_reference,
    metadata: catalog.parseMetadata(row.metadata),
    created_at: row.created_at,
  };
}

// One pass of the renewal loop. Called by the background worker and directly
// by tests, which is why it takes no clock of its own: the test moves the
// period end instead.
async function runRenewals({ limit = 25 } = {}) {
  const due = await dueForRenewal({ limit });
  const results = [];
  for (const subscription of due) {
    const result = await ctx.withMerchant(subscription.merchant_id, () =>
      renew(subscription.merchant_id, subscription)
    );
    results.push(result);
  }
  return results;
}

module.exports = {
  STATUSES,
  ENTITLED_STATUSES,
  RETRY_DAYS,
  addInterval,
  createFromPaidOrder,
  dueForRenewal,
  renew,
  runRenewals,
  markPaymentFailed,
  cancel,
  cancelNow,
  resume,
  findByPublicId,
  list,
  invoicesFor,
  entitlementsFor,
  toApi,
};
