// OUTBOUND WEBHOOKS: how an integrator learns that money moved.
//
// This is the other half of the product. The session API is how work goes in;
// this is how the answer comes back, and for a SaaS it is the thing that
// actually unlocks the account.
//
// THE SIGNATURE. Every delivery carries:
//
//   OpenCheckout-Timestamp: <unix seconds of this attempt>
//   OpenCheckout-Signature: sha256=<hmac of "timestamp.body" with the endpoint secret>
//   OpenCheckout-Event: <event type>
//   OpenCheckout-Delivery: <attempt id>
//
// The receiver rebuilds "timestamp.body", compares the HMAC and rejects
// anything whose timestamp is more than five minutes from their own clock.
// Signing the body alone would let a captured delivery be replayed forever;
// including the timestamp in the signed material is what closes that.
//
// WHY A QUEUE AND NOT A DIRECT POST. The integrator's server will be down at
// some point, and a sale must not be lost to that. A delivery is a row, it is
// retried with a growing delay, and an endpoint that keeps failing is switched
// off so one broken integration does not consume the worker forever.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const { encryptText, decryptText, signPayload, randomToken } = require("../lib/crypto");
const { badRequest, notFound } = require("../lib/errors");
const { isKnownType } = require("./events");

// Growing delay between attempts: about a minute, five, half an hour, two
// hours, six hours. Five attempts span most of a day, which covers a deploy
// gone wrong without hammering a server that is genuinely down.
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

// Consecutive failures before an endpoint is disabled. Counted across
// deliveries, not within one: an endpoint that fails twenty separate events in
// a row is misconfigured, and quietly retrying forever helps nobody.
const FAILURES_BEFORE_DISABLE = 20;

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async function createEndpoint(merchantId, { url, events = [], livemode = false } = {}) {
  const clean = v.httpUrl(url, { allowHttp: process.env.NODE_ENV !== "production" });
  if (!clean) {
    throw badRequest("A webhook URL must be a valid https URL.", { url: "Invalid." });
  }

  const list = (Array.isArray(events) ? events : String(events || "").split(","))
    .map((e) => String(e).trim())
    .filter(Boolean);
  const unknown = list.filter((e) => !isKnownType(e));
  if (unknown.length) throw badRequest(`Unknown event types: ${unknown.join(", ")}.`);

  // The secret is generated here and shown once. The integrator needs it to
  // verify signatures, and we keep only an encrypted copy because we need it
  // to sign.
  const secret = `whsec_${randomToken(24)}`;

  const result = await db.query(
    `insert into webhook_endpoints (merchant_id, public_id, url, secret, events, livemode)
     values ($1, $2, $3, $4, $5, $6)
     returning id, public_id, url, events, livemode, active, created_at`,
    [merchantId, ids.publicId("webhookEndpoint"), clean, encryptText(secret), list.join(","), Boolean(livemode)]
  );
  return { ...result.rows[0], secret };
}

async function listEndpoints(merchantId) {
  const result = await db.query(
    `select id, public_id, url, events, livemode, active, failures, disabled_at, created_at
       from webhook_endpoints
      where merchant_id = $1
      order by created_at desc`,
    [merchantId]
  );
  return result.rows;
}

async function deleteEndpoint(merchantId, publicId) {
  const result = await db.query(
    `delete from webhook_endpoints where merchant_id = $1 and public_id = $2 returning public_id`,
    [merchantId, publicId]
  );
  if (!result.rows[0]) throw notFound("Webhook endpoint not found.");
  return true;
}

// Turns an endpoint back on after the merchant fixed whatever was wrong.
async function reenableEndpoint(merchantId, publicId) {
  const result = await db.query(
    `update webhook_endpoints set active = true, failures = 0, disabled_at = null
      where merchant_id = $1 and public_id = $2
      returning public_id`,
    [merchantId, publicId]
  );
  if (!result.rows[0]) throw notFound("Webhook endpoint not found.");

  // Anything that failed while it was off is queued again, right away. The
  // alternative is telling the merchant to go and re-trigger a day of sales.
  await db.query(
    `update webhook_deliveries
        set status = 'pending', attempts = 0, next_attempt_at = now()
      where merchant_id = $1
        and endpoint_id = (select id from webhook_endpoints where merchant_id = $1 and public_id = $2)
        and status = 'failed'`,
    [merchantId, publicId]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

// One row per active endpoint subscribed to this event.
//
// Never throws. It is called from the path that just took someone's money, and
// a bookkeeping failure there must not turn a successful payment into an
// error the buyer sees.
async function enqueue(merchantId, event) {
  try {
    const endpoints = await db.query(
      `select id, events from webhook_endpoints
        where merchant_id = $1 and active = true and livemode = $2`,
      [merchantId, Boolean(event.payload.livemode)]
    );

    const body = JSON.stringify(event.payload);
    for (const endpoint of endpoints.rows) {
      // An empty subscription list means every event. That is the sensible
      // default for a first integration, which almost always wants all of them.
      const subscribed = String(endpoint.events || "")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (subscribed.length && !subscribed.includes(event.type)) continue;

      await db.query(
        `insert into webhook_deliveries
           (merchant_id, endpoint_id, event_public_id, event_type, payload)
         values ($1, $2, $3, $4, $5)`,
        [merchantId, endpoint.id, event.publicId, event.type, body]
      );
    }
  } catch (err) {
    console.error("[webhooks-out] Could not queue delivery:", err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function translateNetworkError(err) {
  const name = String((err && err.name) || "");
  const code = String((err && err.code) || "");
  const text = String((err && err.message) || "").toLowerCase();

  if (name === "AbortError" || text.includes("aborted")) return "The endpoint did not answer within 10s.";
  if (code === "ENOTFOUND" || text.includes("getaddrinfo")) return "Host not found: check the domain.";
  if (code === "ECONNREFUSED") return "Connection refused by the endpoint.";
  if (code === "ETIMEDOUT") return "The endpoint took too long to answer.";
  if (code === "ECONNRESET") return "The connection dropped mid-request.";
  if (text.includes("certificate") || code.startsWith("ERR_TLS")) {
    return "The endpoint's TLS certificate was rejected.";
  }
  if (text.includes("fetch failed")) return "Could not connect to the endpoint.";
  return "The delivery failed.";
}

async function deliver(delivery, { fetchImpl = globalThis.fetch } = {}) {
  const endpointResult = await db.query(
    `select * from webhook_endpoints where merchant_id = $1 and id = $2`,
    [delivery.merchant_id, delivery.endpoint_id]
  );
  const endpoint = endpointResult.rows[0];
  if (!endpoint) {
    await db.query(
      `update webhook_deliveries set status = 'failed', last_error = $3
        where merchant_id = $1 and id = $2`,
      [delivery.merchant_id, delivery.id, "The endpoint was deleted."]
    );
    return { ok: false, reason: "endpoint_deleted" };
  }

  const secret = decryptText(endpoint.secret);
  const timestamp = Math.floor(Date.now() / 1000);
  const attempt = delivery.attempts + 1;

  let status = 0;
  let error = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "OpenCheckout-Webhooks/1",
          "OpenCheckout-Timestamp": String(timestamp),
          "OpenCheckout-Signature": signPayload(delivery.payload, secret, timestamp),
          "OpenCheckout-Event": delivery.event_type,
          "OpenCheckout-Delivery": `${delivery.id}.${attempt}`,
        },
        body: delivery.payload,
        signal: controller.signal,
      });
      status = response.status;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    error = translateNetworkError(err);
  }

  const delivered = status >= 200 && status < 300;

  if (delivered) {
    await db.query(
      `update webhook_deliveries
          set status = 'delivered', attempts = $3, last_status_code = $4,
              last_error = null, delivered_at = now()
        where merchant_id = $1 and id = $2`,
      [delivery.merchant_id, delivery.id, attempt, status]
    );
    await db.query(
      `update webhook_endpoints set failures = 0 where merchant_id = $1 and id = $2`,
      [delivery.merchant_id, endpoint.id]
    );
    return { ok: true, status };
  }

  const exhausted = attempt >= MAX_ATTEMPTS;
  const delay = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
  // The next attempt time is computed here rather than in SQL. An interval
  // expression is one of the places where Postgres and the in-memory database
  // the tests use disagree, and a retry schedule that only works in production
  // is a retry schedule nobody has tested.
  const nextAttemptAt = new Date(Date.now() + delay * 1000);
  await db.query(
    `update webhook_deliveries
        set status = $5, attempts = $3, last_status_code = $4, last_error = $6,
            next_attempt_at = $7
      where merchant_id = $1 and id = $2`,
    [
      delivery.merchant_id,
      delivery.id,
      attempt,
      status || null,
      exhausted ? "failed" : "pending",
      error || `The endpoint answered ${status}.`,
      nextAttemptAt,
    ]
  );

  const failures = await db.query(
    `update webhook_endpoints set failures = failures + 1
      where merchant_id = $1 and id = $2
      returning failures`,
    [delivery.merchant_id, endpoint.id]
  );
  if ((failures.rows[0] || {}).failures >= FAILURES_BEFORE_DISABLE) {
    await db.query(
      `update webhook_endpoints set active = false, disabled_at = now()
        where merchant_id = $1 and id = $2`,
      [delivery.merchant_id, endpoint.id]
    );
  }

  return { ok: false, status, error };
}

// Sends what is due. Called by the background loop, and directly by tests.
async function dispatchPending({ limit = 50, fetchImpl = globalThis.fetch } = {}) {
  const due = await db.query(
    `select * from webhook_deliveries
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at
      limit $1`,
    [limit],
    { withoutMerchant: "the delivery worker runs for every merchant, one row at a time" }
  );

  const results = [];
  for (const delivery of due.rows) {
    // Each row carries its merchant, so the context is opened per row rather
    // than per batch.
    const ctx = require("../db/merchant-context");
    const result = await ctx.withMerchant(delivery.merchant_id, () => deliver(delivery, { fetchImpl }));
    results.push(result);
  }
  return results;
}

async function listDeliveries(merchantId, { limit = 50 } = {}) {
  const result = await db.query(
    `select d.id, d.event_public_id, d.event_type, d.status, d.attempts,
            d.last_status_code, d.last_error, d.created_at, d.delivered_at,
            e.url, e.public_id as endpoint
       from webhook_deliveries d
       join webhook_endpoints e on e.id = d.endpoint_id and e.merchant_id = d.merchant_id
      where d.merchant_id = $1
      order by d.id desc
      limit $2`,
    [merchantId, Math.max(1, Math.min(200, Number(limit) || 50))]
  );
  return result.rows;
}

// Queues one event again, by hand, from the dashboard.
async function retry(merchantId, deliveryId) {
  const result = await db.query(
    `update webhook_deliveries
        set status = 'pending', attempts = 0, next_attempt_at = now()
      where merchant_id = $1 and id = $2
      returning id`,
    [merchantId, deliveryId]
  );
  if (!result.rows[0]) throw notFound("Delivery not found.");
  return true;
}

module.exports = {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  FAILURES_BEFORE_DISABLE,
  createEndpoint,
  listEndpoints,
  deleteEndpoint,
  reenableEndpoint,
  enqueue,
  deliver,
  dispatchPending,
  listDeliveries,
  retry,
  translateNetworkError,
};
