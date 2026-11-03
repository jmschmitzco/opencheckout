// The customer portal: where a buyer cancels, changes their card and reads
// their invoices without emailing anybody.
//
// THE DESIGN DECISION THAT SHAPES THIS FILE: there is no password here, and
// there never will be. The integrator already knows who their user is, so they
// mint a short lived link for that user and redirect to it. Asking the buyer
// to authenticate again would mean storing credentials for people who are not
// our users, which is both a worse experience and a liability nobody needs.
//
// So the link IS the credential. That makes three properties mandatory:
//   - short lived, measured in minutes
//   - single use, consumed when it is opened
//   - exchanged for a cookie, so the token stops travelling in the URL the
//     moment it is used, and never ends up in a referrer header or a shared
//     screenshot
const db = require("../db");
const { randomUrlToken, safeEqual } = require("../lib/crypto");
const { config } = require("../config");
const v = require("../lib/validators");
const { notFound } = require("../lib/errors");
const merchants = require("./merchants");
const subscriptions = require("./subscriptions");
const customers = require("./customers");
const orders = require("./orders");

// Long enough to survive a redirect through the integrator's app and a slow
// phone, short enough that a link in a browser history is worthless.
const LINK_TTL_MINUTES = 15;

// How long the exchanged cookie lasts. The buyer is doing one errand.
const SESSION_TTL_MINUTES = 60;

async function createSession(merchantId, customerId, { returnUrl = null } = {}) {
  const merchant = await merchants.findById(merchantId);
  if (!merchant) throw notFound("Merchant not found.");

  const token = randomUrlToken(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000);
  const allowHttp = process.env.NODE_ENV !== "production";

  await db.query(
    `insert into portal_sessions (merchant_id, customer_id, token, return_url, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      merchantId,
      customerId,
      token,
      v.redirectUrl(returnUrl, merchants.allowedHosts(merchant), { allowHttp }),
      expiresAt,
    ]
  );

  return {
    object: "portal_session",
    url: `${config.baseUrl}/portal/${token}`,
    expires_at: expiresAt,
  };
}

// Consumes a link. Returns the merchant and customer it was minted for, or
// null for anything expired, unknown or already used.
//
// This is a lookup by a token that is itself the only identifier available, so
// it runs outside a merchant context and returns the merchant it found.
async function consume(token) {
  const clean = String(token || "").trim();
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(clean)) return null;

  const result = await db.query(
    `select * from portal_sessions where token = $1`,
    [clean],
    { withoutMerchant: "the portal link is the only identifier the request carries" }
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  if (!safeEqual(row.token, clean)) return null;

  // SINGLE USE HAS TO BE ATOMIC. Checking `used_at` and then setting it lets
  // two requests arriving together both pass, which is exactly the shape of a
  // link opened twice by an email client that prefetches.
  const claimed = await db.query(
    `update portal_sessions set used_at = now()
      where merchant_id = $1 and id = $2 and used_at is null
      returning id`,
    [row.merchant_id, row.id]
  );
  if (!claimed.rows[0]) return null;

  return {
    merchantId: row.merchant_id,
    customerId: row.customer_id,
    returnUrl: row.return_url,
    expiresAt: new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000),
  };
}

// Everything the portal page shows, in one call.
async function overview(merchantId, customerId) {
  const [customer, subs, recentOrders] = await Promise.all([
    customers.findById(merchantId, customerId),
    subscriptions.list(merchantId, { customerId, limit: 20 }),
    orders.list(merchantId, { customerId, limit: 20 }),
  ]);
  if (!customer) throw notFound("Customer not found.");

  const withInvoices = [];
  for (const subscription of subs) {
    withInvoices.push({
      ...subscriptions.toApi(subscription),
      invoices: (await subscriptions.invoicesFor(merchantId, subscription.id)).map((invoice) => ({
        period_start: invoice.period_start,
        period_end: invoice.period_end,
        status: invoice.status,
        amount_cents: invoice.amount_cents,
        currency: invoice.currency,
      })),
    });
  }

  return {
    customer: customers.toApi(customer),
    subscriptions: withInvoices,
    orders: recentOrders.map((order) => orders.toApi(order)),
  };
}

module.exports = { LINK_TTL_MINUTES, SESSION_TTL_MINUTES, createSession, consume, overview };
