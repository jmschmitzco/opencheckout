// API keys: the credential an integration authenticates with.
//
// THE DESIGN, which is the same one Stripe and GitHub use: the full key is
// shown ONCE, at creation. Only its SHA-256 goes to the database, so a leaked
// database hands out no usable key. The prefix is stored in the clear just so
// the owner recognises which key is which in the dashboard, the way a card
// shows its last four digits.
//
// Two kinds:
//   secret       sk_live_... / sk_test_...  server to server, can do anything
//   publishable  pk_live_... / pk_test_...  safe in a browser, can only read a
//                session whose id it already has, and cannot list anything
//
// Two modes. A test key never touches a real gateway, and the objects it
// creates carry livemode = false, so an integrator can leave test traffic in
// the same installation without polluting their numbers.
const crypto = require("crypto");
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const { sha256 } = require("../lib/crypto");
const { badRequest } = require("../lib/errors");

const KINDS = ["secret", "publishable"];

// The lookup by hash is what DISCOVERS the merchant, so it cannot be scoped to
// one. Stated once, here, and used by both reads below.
const LOOKUP_REASON = "the key hash is what discovers the merchant; it is unique across the install";

function keyPrefixFor(kind, livemode) {
  const head = kind === "publishable" ? "pk" : "sk";
  return `${head}_${livemode ? "live" : "test"}_`;
}

function parseKind(key) {
  const text = String(key || "");
  if (text.startsWith("sk_")) return "secret";
  if (text.startsWith("pk_")) return "publishable";
  return null;
}

async function create(merchantId, { label, kind = "secret", livemode = false } = {}) {
  const cleanKind = v.oneOf(kind, KINDS);
  if (!cleanKind) throw badRequest(`Key kind must be one of: ${KINDS.join(", ")}.`);

  // 32 random bytes in base64url is 43 characters with no ambiguous symbol.
  const body = crypto.randomBytes(32).toString("base64url");
  const key = `${keyPrefixFor(cleanKind, livemode)}${body}`;

  const result = await db.query(
    `insert into api_keys (merchant_id, public_id, label, kind, livemode, key_prefix, key_hash)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, public_id, label, kind, livemode, key_prefix, created_at`,
    [
      merchantId,
      ids.publicId("apiKey"),
      v.text(label, 80) || "Integration",
      cleanKind,
      Boolean(livemode),
      // Enough to recognise, not enough to use.
      `${key.slice(0, keyPrefixFor(cleanKind, livemode).length + 6)}...`,
      sha256(key),
    ],
    { withoutMerchant: LOOKUP_REASON }
  );

  // `key` is returned, never stored. This is the only moment it exists.
  return { ...result.rows[0], key };
}

// Resolves a key to its merchant. Returns null for anything unknown, revoked
// or inactive, with no hint about which of those it was.
//
// last_used_at is refreshed at most once a minute. It is dashboard
// information, not an audit log, and it is not worth an UPDATE per request.
async function resolve(key) {
  const text = String(key || "").trim();
  const kind = parseKind(text);
  if (!kind || text.length < 20) return null;

  const result = await db.query(
    `select id, merchant_id, kind, livemode, label
       from api_keys
      where key_hash = $1 and active = true and revoked_at is null`,
    [sha256(text)],
    { withoutMerchant: LOOKUP_REASON }
  );
  const row = result.rows[0];
  if (!row) return null;

  await db
    .query(
      `update api_keys set last_used_at = now()
        where id = $1 and merchant_id = $2
          and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
      [row.id, row.merchant_id]
    )
    .catch(() => {
      /* a bookkeeping update must never fail a request */
    });

  return {
    keyId: row.id,
    merchantId: row.merchant_id,
    kind: row.kind,
    livemode: row.livemode,
    label: row.label,
  };
}

async function list(merchantId) {
  const result = await db.query(
    `select id, public_id, label, kind, livemode, key_prefix, active,
            last_used_at, revoked_at, created_at
       from api_keys
      where merchant_id = $1
      order by created_at desc`,
    [merchantId]
  );
  return result.rows;
}

async function revoke(merchantId, publicId) {
  const result = await db.query(
    `update api_keys
        set active = false, revoked_at = now()
      where merchant_id = $1 and public_id = $2 and revoked_at is null
      returning public_id`,
    [merchantId, publicId]
  );
  return Boolean(result.rows[0]);
}

module.exports = { KINDS, create, resolve, list, revoke, parseKind, keyPrefixFor };
