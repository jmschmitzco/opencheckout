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

// What each gateway needs, and which of those fields are secret.
//
// `required` is what the API cannot work without. `verification` is what the
// WEBHOOK cannot be verified without, and it is separate because the
// consequence is different: without it the gateway still charges, and every
// notification it sends is silently discarded. A paid order that never
// confirms is worse than one that never starts, because the money moved.
const SHAPES = {
  asaas: {
    required: ["apiKey"],
    verification: ["webhookToken"],
    secret: ["apiKey", "webhookToken"],
  },
  pagarme: {
    required: ["secretKey"],
    verification: ["webhookUser", "webhookPassword"],
    secret: ["secretKey", "webhookPassword"],
  },
  mercadopago: {
    required: ["accessToken"],
    verification: ["webhookSecret"],
    secret: ["accessToken", "webhookSecret"],
  },
  paypal: {
    required: ["clientId", "secret"],
    verification: ["webhookId"],
    secret: ["secret"],
  },
};

// Gateways that have a sandbox worth offering. A developer evaluating this
// project needs to make a charge before they have a production account.
const HAS_SANDBOX = ["asaas", "paypal"];

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

  // Sandbox is opt-in and only where it exists. An unknown value is ignored
  // rather than guessed, because guessing "sandbox" would send real sales to a
  // test account and guessing "production" would charge real cards in a test.
  if (incoming.environment === "sandbox" && HAS_SANDBOX.includes(gateway)) {
    clean.environment = "sandbox";
  } else {
    clean.environment = "production";
  }

  // A gateway saved without what its webhook verification needs will take
  // money and then have every confirmation thrown away. That is reported back
  // rather than refused, so a merchant can set the API key first and the
  // webhook second, which is the order the gateway dashboards work in.
  const missingVerification = (shape.verification || []).filter((field) => !clean[field]);

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
    return {
      webhookToken: existing.rows[0].webhook_token,
      created: false,
      missingVerification,
    };
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
  return { webhookToken, created: true, missingVerification };
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

// Which payment methods this merchant can actually offer: what they have
// configured, intersected with what those gateways can do.
//
// The checkout calls this before drawing the method buttons, and session
// creation calls it before promising anything. Offering a method that cannot
// be charged is the worst bug on a checkout: the buyer picks it, fills
// everything in, and only then finds out.
async function availableMethods({ merchantId, livemode = false }) {
  const { isDemo } = require("../config");
  if (isDemo()) return ["pix", "card", "boleto"];

  const { capabilitiesOf } = require("../gateways");
  const configured = await listConfigured({ merchantId, livemode });

  const methods = new Set();
  for (const row of configured) {
    if (!row.active) continue;
    for (const method of capabilitiesOf(row.gateway).methods) methods.add(method);
  }
  // Returned in a stable order, so the page draws the buttons the same way
  // every time rather than in whatever order the rows came back.
  return ["pix", "card", "boleto", "paypal"].filter((method) => methods.has(method));
}

// Which gateway takes a given method, for this merchant.
async function gatewayForMethod({ merchantId, method, livemode = false }) {
  const { gatewaysForMethod } = require("../gateways");

  const configured = await listConfigured({ merchantId, livemode });
  const active = configured.filter((row) => row.active).map((row) => row.gateway);
  if (!active.length) {
    throw badRequest(
      "No payment gateway is configured for this merchant. Add one in the dashboard before selling."
    );
  }

  const candidates = gatewaysForMethod(method);
  const chosen = candidates.find((name) => active.includes(name));
  if (!chosen) {
    throw badRequest(
      `None of the configured gateways can take ${method}. Configured: ${active.join(", ")}.`
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
  HAS_SANDBOX,
  save,
  credentialsFor,
  listConfigured,
  availableMethods,
  gatewayForMethod,
  merchantByWebhookToken,
  deactivate,
  clearCache,
};
