// Where a merchant's gateway credentials live.
//
// ONE ROW PER MERCHANT, GATEWAY AND MODE. Each merchant plugs in their own
// keys and the money lands in their own account. This installation never holds
// anybody's money, which is a deliberate design constraint and not an
// oversight: holding third party funds is a regulated activity in most
// jurisdictions, and a self-hosted open source project is in no position to be
// one.
//
// Credentials are encrypted with APP_SECRET before they are written, and the
// only thing the dashboard ever shows back is a mask.
const db = require("../db");
const { encryptJson, decryptJson, randomToken } = require("../lib/crypto");
const { config } = require("../config");
const v = require("../lib/validators");
const { badRequest } = require("../lib/errors");

// Short lived cache, keyed by merchant, gateway and mode. A checkout reads
// credentials on every charge and these rows almost never change; the write
// path clears the entry, so a key rotation takes effect immediately.
const cache = new Map();
const CACHE_MS = 30_000;

function cacheKey(merchantId, gateway, livemode) {
  return `${merchantId}:${gateway}:${livemode ? "live" : "test"}`;
}

// What each gateway needs, and which of those fields are secret. Used to
// validate a save and to decide what may be shown back.
const SHAPES = {
  asaas: { required: ["apiKey"], secret: ["apiKey", "webhookToken"] },
  pagarme: { required: ["secretKey"], secret: ["secretKey", "webhookPassword"] },
  mercadopago: { required: ["accessToken"], secret: ["accessToken", "webhookSecret"] },
  paypal: { required: ["clientId", "secret"], secret: ["secret"] },
};

async function save({ merchantId, gateway, livemode = false, credentials }) {
  const shape = SHAPES[gateway];
  if (!shape) throw badRequest(`Unknown gateway: ${gateway}.`);

  const incoming = credentials && typeof credentials === "object" ? credentials : {};
  const missing = shape.required.filter((field) => !v.text(incoming[field], 500));
  if (missing.length) {
    throw badRequest(`${gateway} needs: ${missing.join(", ")}.`, {
      [missing[0]]: "Required.",
    });
  }

  const clean = {};
  for (const [field, value] of Object.entries(incoming)) {
    const text = v.text(value, 2000);
    if (text) clean[field] = text;
  }

  const existing = await db.query(
    `select id, webhook_token from gateway_credentials
      where merchant_id = $1 and gateway = $2 and livemode = $3`,
    [merchantId, gateway, Boolean(livemode)]
  );

  if (existing.rows[0]) {
    await db.query(
      `update gateway_credentials
          set credentials = $4, active = true, updated_at = now()
        where merchant_id = $1 and gateway = $2 and livemode = $3`,
      [merchantId, gateway, Boolean(livemode), encryptJson(clean)]
    );
    cache.delete(cacheKey(merchantId, gateway, livemode));
    return { webhookToken: existing.rows[0].webhook_token, created: false };
  }

  // The unguessable part of the callback URL the gateway is configured with.
  // It is what identifies WHICH merchant an incoming notification belongs to,
  // and it has to be in the URL rather than in the body, because the signature
  // can only be verified with that merchant's own key, which we cannot look up
  // before we know who they are.
  const webhookToken = randomToken(24);
  await db.query(
    `insert into gateway_credentials (merchant_id, gateway, livemode, credentials, webhook_token)
     values ($1, $2, $3, $4, $5)`,
    [merchantId, gateway, Boolean(livemode), encryptJson(clean), webhookToken]
  );
  cache.delete(cacheKey(merchantId, gateway, livemode));
  return { webhookToken, created: true };
}

async function credentialsFor({ merchantId, gateway, livemode = false }) {
  const key = cacheKey(merchantId, gateway, livemode);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const result = await db.query(
    `select credentials, webhook_token from gateway_credentials
      where merchant_id = $1 and gateway = $2 and livemode = $3 and active = true`,
    [merchantId, gateway, Boolean(livemode)]
  );
  const row = result.rows[0];
  const value = row
    ? { ...(decryptJson(row.credentials) || {}), webhookToken: row.webhook_token, livemode: Boolean(livemode) }
    : null;

  cache.set(key, { value, at: Date.now() });
  return value;
}

// Which gateways this merchant has set up, for the dashboard. Never returns a
// secret, only whether one is present.
async function listConfigured({ merchantId, livemode = null }) {
  const params = [merchantId];
  let modeFilter = "";
  if (livemode !== null) {
    params.push(Boolean(livemode));
    modeFilter = `and livemode = $${params.length}`;
  }
  const result = await db.query(
    `select gateway, livemode, active, webhook_token, created_at, updated_at
       from gateway_credentials
      where merchant_id = $1 ${modeFilter}
      order by gateway`,
    params
  );
  return result.rows.map((row) => ({
    gateway: row.gateway,
    livemode: row.livemode,
    active: row.active,
    webhook_url: `${config.baseUrl}/gateway-webhooks/${row.gateway}/${row.webhook_token}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

// Which payment methods this merchant can actually offer, which is the
// intersection of what they configured and what those gateways support.
//
// The checkout calls this before drawing the method buttons. Offering a method
// that cannot be charged is the worst kind of bug here: the buyer picks it,
// fills everything in, and only then finds out.
async function availableMethods({ merchantId, livemode = false }) {
  const { isDemo } = require("../config");
  if (isDemo()) return ["pix", "card", "boleto"];

  const configured = await listConfigured({ merchantId, livemode });
  const names = configured.filter((row) => row.active).map((row) => row.gateway);

  const methods = new Set();
  for (const name of names) {
    if (name === "paypal") {
      methods.add("paypal");
      continue;
    }
    // The three routable Brazilian processors each cover all three
    // instruments. A gateway added later declares its own list through its
    // adapter's supportedMethods.
    methods.add("pix");
    methods.add("card");
    methods.add("boleto");
  }
  return Array.from(methods);
}

// Which gateway takes a given method.
//
// With more than one configured, the first in ROUTABLE order wins. Explicit
// per-method routing is a dashboard feature worth having later; picking
// deterministically now means the behaviour is at least predictable.
async function gatewayForMethod({ merchantId, method, livemode = false }) {
  const { ROUTABLE } = require("../gateways");
  if (method === "paypal") return "paypal";

  const configured = await listConfigured({ merchantId, livemode });
  const active = configured.filter((row) => row.active).map((row) => row.gateway);
  const chosen = ROUTABLE.find((name) => active.includes(name));
  if (!chosen) {
    throw badRequest(
      "No payment gateway is configured for this merchant. Add one in the dashboard before selling."
    );
  }
  return chosen;
}

// Resolves which merchant an inbound notification belongs to, from the token
// in its URL. This runs before any merchant context exists, which is the whole
// reason the token is there.
async function merchantByWebhookToken(token) {
  const clean = String(token || "").trim();
  if (!/^[a-f0-9]{24,64}$/i.test(clean)) return null;
  const result = await db.query(
    `select merchant_id, gateway, livemode from gateway_credentials where webhook_token = $1`,
    [clean],
    { withoutMerchant: "the webhook token is what identifies the merchant of an inbound notification" }
  );
  const row = result.rows[0];
  return row ? { merchantId: row.merchant_id, gateway: row.gateway, livemode: row.livemode } : null;
}

async function deactivate({ merchantId, gateway, livemode = false }) {
  await db.query(
    `update gateway_credentials set active = false, updated_at = now()
      where merchant_id = $1 and gateway = $2 and livemode = $3`,
    [merchantId, gateway, Boolean(livemode)]
  );
  cache.delete(cacheKey(merchantId, gateway, livemode));
}

function clearCache() {
  cache.clear();
}

module.exports = {
  SHAPES,
  save,
  credentialsFor,
  listConfigured,
  availableMethods,
  gatewayForMethod,
  merchantByWebhookToken,
  deactivate,
  clearCache,
};
