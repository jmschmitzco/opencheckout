// Tables that belong to a merchant.
//
// Any query that touches one of these without naming the merchant is a bug,
// and the guard in src/db/index.js refuses to run it. The alternative is
// hoping every author of every query remembers, and one forgotten filter means
// one merchant reading, or being charged for, another merchant's data.
//
// Four tables are intentionally absent:
//   merchants         the table that defines ownership
//   api_keys          the lookup by key hash is what DISCOVERS the merchant
//   idempotency_keys  scoped by its own unique key, written before a merchant
//                     is resolved
//   gateway_events    deduplicates by (gateway, event_id) before the merchant
//                     of the notification is known
//   schema_versions   installation metadata
const OWNED_TABLES = [
  "abandoned_carts",
  "brand_themes",
  "charges",
  "checkout_sessions",
  "coupons",
  "customers",
  "disputes",
  "events",
  "gateway_credentials",
  "offers",
  "order_items",
  "orders",
  "portal_sessions",
  "prices",
  "products",
  "refunds",
  "subscription_invoices",
  "subscriptions",
  "webhook_deliveries",
  "webhook_endpoints",
];

// Longest names first so "orders" does not match inside "order_items".
const TABLE_PATTERN = new RegExp(
  `\\b(${[...OWNED_TABLES].sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi"
);

// Which owned tables a statement mentions. Used by the guard, and by the
// static test that walks every query in the codebase.
function tablesIn(sql) {
  const found = new Set();
  const text = String(sql || "");
  let match;
  TABLE_PATTERN.lastIndex = 0;
  while ((match = TABLE_PATTERN.exec(text)) !== null) {
    found.add(match[1].toLowerCase());
  }
  return Array.from(found);
}

module.exports = { OWNED_TABLES, tablesIn };
