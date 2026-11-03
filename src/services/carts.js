// Abandoned carts.
//
// A DESIGN DECISION WORTH STATING PLAINLY: this project does not send the
// recovery email. It emits a `cart.abandoned` event carrying a working
// recovery link, and the integrator sends the message with whatever they
// already use.
//
// That is not laziness. Owning email delivery would mean owning SMTP
// configuration, sender domains, SPF and DKIM, bounce handling and
// deliverability reputation, in a project someone else self-hosts. Every SaaS
// that would install this already has a transactional email provider wired up,
// with their own templates and their own sending domain, and a message that
// comes from their own domain is the one that actually gets opened.
//
// So the mechanism is: the page tells us the email as soon as it has one, we
// notice when nothing was paid, and we hand the integrator a link and a reason
// to write.
const db = require("../db");
const ctx = require("../db/merchant-context");
const v = require("../lib/validators");
const money = require("../lib/money");
const { randomUrlToken } = require("../lib/crypto");
const { config } = require("../config");
const events = require("./events");
const webhooksOut = require("./webhooks-out");
const sessions = require("./checkout-sessions");

// How long after the session was created before the cart counts as abandoned.
// Short enough to still be relevant, long enough that someone who stepped away
// to find their card is not written to while they are still on the page.
const ABANDON_AFTER_MINUTES = 30;

// When reminders go out, in hours after abandonment. Three is where the
// returns stop: the fourth message is the one that gets marked as spam.
const REMINDER_HOURS = [1, 24, 72];

// Records the contact as soon as the page has one.
//
// Called while the buyer is still on the page, which is the only moment this
// can work: after they close the tab there is nobody to ask.
async function remember(merchantId, session, { email, name, phone } = {}) {
  const cleanEmail = v.email(email);
  if (!cleanEmail) return null;
  if (sessions.effectiveStatus(session) !== "open") return null;

  const existing = await db.query(
    `select * from abandoned_carts where merchant_id = $1 and session_id = $2`,
    [merchantId, session.id]
  );

  if (existing.rows[0]) {
    const result = await db.query(
      `update abandoned_carts
          set email = $3, name = coalesce($4, name), phone = coalesce($5, phone),
              total_cents = $6, currency = $7
        where merchant_id = $1 and session_id = $2
        returning *`,
      [
        merchantId,
        session.id,
        cleanEmail,
        v.text(name, 120),
        v.phoneBr(phone),
        session.total_cents,
        session.currency,
      ]
    );
    return result.rows[0];
  }

  const result = await db.query(
    `insert into abandoned_carts
       (merchant_id, session_id, email, name, phone, currency, total_cents, recovery_token)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      merchantId,
      session.id,
      cleanEmail,
      v.text(name, 120),
      v.phoneBr(phone),
      session.currency,
      session.total_cents,
      randomUrlToken(20),
    ]
  );
  return result.rows[0];
}

// The link that puts the buyer back where they left off.
//
// It points at the session, with the session's own secret, which means the
// cart is exactly as they left it, coupon included. It stops working when the
// session expires, which is correct: a recovery link that opens an expired
// cart is worse than no link.
function recoveryUrl(session) {
  return `${config.baseUrl}/c/${session.public_id}?k=${session.client_secret}&recovered=1`;
}

// Carts whose reminder is due. One row per reminder, so a cart that already
// had two only comes back for the third.
async function dueForReminder({ limit = 50 } = {}) {
  const result = await db.query(
    `select c.*, s.public_id as session_public_id, s.client_secret, s.status as session_status,
            s.expires_at, s.line_items, s.locale
       from abandoned_carts c
       join checkout_sessions s on s.id = c.session_id and s.merchant_id = c.merchant_id
      where c.status = 'open'
        and c.reminders_sent < $1
        and s.status = 'open'
        and s.expires_at > now()
        and c.created_at <= $2
      order by c.created_at
      limit $3`,
    [
      REMINDER_HOURS.length,
      new Date(Date.now() - ABANDON_AFTER_MINUTES * 60 * 1000),
      limit,
    ],
    { withoutMerchant: "the reminder loop runs for every merchant, one row at a time" }
  );

  // The hour gate is applied here rather than in SQL, because it depends on
  // how many reminders a row already had, and an interval computed from a
  // column is one of the places Postgres and the test database disagree.
  const now = Date.now();
  return result.rows.filter((row) => {
    const due = REMINDER_HOURS[row.reminders_sent];
    if (due == null) return false;
    const since = row.last_reminder_at ? new Date(row.last_reminder_at) : new Date(row.created_at);
    return now - since.getTime() >= due * 3600 * 1000;
  });
}

// Emits the event for one cart and counts the reminder.
async function announce(merchantId, cart) {
  const items = (() => {
    try {
      return JSON.parse(cart.line_items || "[]");
    } catch {
      return [];
    }
  })();

  const payload = {
    cart: {
      object: "cart",
      session: cart.session_public_id,
      email: cart.email,
      name: cart.name,
      phone: cart.phone,
      currency: cart.currency,
      total_cents: cart.total_cents,
      total_formatted: money.formatMoney(cart.total_cents, cart.currency, cart.locale),
      // The link is the point of the whole event.
      recovery_url: recoveryUrl({
        public_id: cart.session_public_id,
        client_secret: cart.client_secret,
      }),
      expires_at: cart.expires_at,
      reminder_number: cart.reminders_sent + 1,
      items: items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        amount_cents: item.amount_cents,
      })),
    },
  };

  const event = await events.record(merchantId, "cart.abandoned", payload, {
    livemode: Boolean(cart.livemode),
  });
  await webhooksOut.enqueue(merchantId, event);

  await db.query(
    `update abandoned_carts
        set reminders_sent = reminders_sent + 1, last_reminder_at = now()
      where merchant_id = $1 and id = $2`,
    [merchantId, cart.id]
  );

  return { announced: true, reminder: cart.reminders_sent + 1 };
}

// One pass of the loop.
async function runReminders({ limit = 25 } = {}) {
  const due = await dueForReminder({ limit });
  const results = [];
  for (const cart of due) {
    const result = await ctx.withMerchant(cart.merchant_id, () => announce(cart.merchant_id, cart));
    results.push(result);
  }
  return results;
}

// Called when a cart turns into a sale, so the reminders stop and the
// integrator can attribute the recovery.
async function markRecovered(merchantId, sessionId) {
  const result = await db.query(
    `update abandoned_carts
        set status = 'recovered', recovered_at = now()
      where merchant_id = $1 and session_id = $2 and status = 'open'
      returning *`,
    [merchantId, sessionId]
  );
  const cart = result.rows[0];
  if (!cart) return null;

  const event = await events.record(
    merchantId,
    "cart.recovered",
    { cart: { session: sessionId, email: cart.email, total_cents: cart.total_cents } },
    { livemode: false }
  );
  await webhooksOut.enqueue(merchantId, event);
  return cart;
}

// Sessions that ran out of time. Marks them expired and announces it, which is
// what lets an integrator release a reserved seat or a held inventory item.
async function expireStaleSessions({ limit = 100 } = {}) {
  const stale = await db.query(
    `select * from checkout_sessions
      where status = 'open' and expires_at <= now()
      order by expires_at
      limit $1`,
    [limit],
    { withoutMerchant: "the expiry sweep runs for every merchant, one row at a time" }
  );

  for (const session of stale.rows) {
    await ctx.withMerchant(session.merchant_id, async () => {
      await sessions.expire(session.merchant_id, session.id);
      const event = await events.record(
        session.merchant_id,
        "checkout.session.expired",
        { session: sessions.toApi({ ...session, status: "expired" }) },
        { livemode: session.livemode }
      );
      await webhooksOut.enqueue(session.merchant_id, event);
    });
  }
  return stale.rows.length;
}

// An order that never got a charge id never reached the gateway, or reached
// it and lost the answer. After a day it is written off as expired.
//
// EXPIRED, NOT CANCELLED, and the difference matters: `expired -> paid` is a
// legal transition and `canceled -> paid` is not. If this was the orphan case,
// where the charge exists on the gateway's side and the response was lost, a
// notification arriving later can still rescue the sale. Cancelling would
// close that door for a buyer whose money already moved.
const STRAND_AFTER_HOURS = 24;

async function expireStrandedOrders({ limit = 100 } = {}) {
  const stale = await db.query(
    `select id, merchant_id, public_id from orders
      where status = 'pending' and gateway_charge_id is null and created_at <= $1
      order by created_at
      limit $2`,
    [new Date(Date.now() - STRAND_AFTER_HOURS * 3600 * 1000), limit],
    { withoutMerchant: "the sweep runs for every merchant, one row at a time" }
  );

  const orders = require("./orders");
  for (const row of stale.rows) {
    await ctx.withMerchant(row.merchant_id, async () => {
      await orders.markStatus(row.merchant_id, row.id, "expired", "sweep:never-charged");
    });
  }
  return stale.rows.length;
}

module.exports = {
  STRAND_AFTER_HOURS,
  expireStrandedOrders,
  ABANDON_AFTER_MINUTES,
  REMINDER_HOURS,
  remember,
  recoveryUrl,
  dueForReminder,
  announce,
  runReminders,
  markRecovered,
  expireStaleSessions,
};
