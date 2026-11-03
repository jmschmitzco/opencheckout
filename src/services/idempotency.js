// Idempotency for the routes that create money.
//
// THE PROBLEM: a repeated POST, from a network retry, a double click, a phone
// with a bad signal or the back button, creates a second order and a second
// real charge on the card. The server cannot tell it is the same intent,
// because every request looks new.
//
// THE FIX: the caller sends an Idempotency-Key, generated ONCE per purchase
// attempt. The first request reserves it; repeats get the stored answer back
// instead of charging again.
//
// The reservation is an INSERT against a unique index, which is what makes it
// work under a genuine race: if two requests arrive at the same instant, only
// one insert succeeds and the other takes the "already exists" path. A
// "select then insert" would let both through.
const db = require("../db");

// A key still processing after this long is considered stuck, because the
// process handling it died, and may be taken over.
const STUCK_AFTER_SECONDS = 90;

function isValidKey(key) {
  return /^[A-Za-z0-9_:.-]{8,200}$/.test(String(key || ""));
}

// Tries to reserve the key. Returns one of:
//   { state: 'reserved' }                        go ahead and process
//   { state: 'completed', httpStatus, body }     return this, do not process
//   { state: 'in_progress' }                     another request has it
async function reserve(scope, key, merchantId = null) {
  try {
    await db.query(`insert into idempotency_keys (scope, key, merchant_id) values ($1, $2, $3)`, [
      scope,
      key,
      merchantId,
    ]);
    return { state: "reserved" };
  } catch (err) {
    const duplicate = err.code === "23505" || /duplicate|unique/i.test(err.message || "");
    if (!duplicate) throw err;
  }

  const result = await db.query(`select * from idempotency_keys where scope = $1 and key = $2`, [
    scope,
    key,
  ]);
  const row = result.rows[0];
  if (!row) return { state: "reserved" }; // unlikely race: it vanished, carry on

  if (row.status === "completed") {
    let body = null;
    try {
      body = row.response ? JSON.parse(row.response) : null;
    } catch {
      body = null;
    }
    return { state: "completed", httpStatus: row.http_status || 200, body };
  }

  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > STUCK_AFTER_SECONDS * 1000) {
    await db.query(`delete from idempotency_keys where id = $1`, [row.id]);
    return { state: "reserved" };
  }
  return { state: "in_progress" };
}

// Stores the answer, so repeats return the same thing.
async function complete(scope, key, { httpStatus, body, orderId = null }) {
  await db.query(
    `update idempotency_keys
        set status = 'completed', http_status = $3, response = $4, order_id = $5
      where scope = $1 and key = $2`,
    [scope, key, httpStatus, JSON.stringify(body == null ? null : body), orderId]
  );
}

// A business error does NOT become a stored answer. The buyer has to be able
// to fix the card and try again with the same key, and a stored "declined"
// would mean they could never succeed.
async function release(scope, key) {
  await db.query(`delete from idempotency_keys where scope = $1 and key = $2 and status = 'processing'`, [
    scope,
    key,
  ]);
}

// Express middleware factory. `scope` separates namespaces so the same key
// used on two different routes does not collide.
//
// Without a key the request simply goes through: idempotency is something the
// caller opts into, and refusing every request that lacks a header would break
// every integration the moment it was introduced. The hosted checkout page
// always sends one.
function middleware(scope) {
  return async (req, res, next) => {
    const key = String(req.get("idempotency-key") || "").trim();
    if (!key) return next();
    if (!isValidKey(key)) {
      return res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Idempotency-Key must be 8 to 200 characters of letters, digits, _ : . or -",
        },
      });
    }

    let reservation;
    try {
      reservation = await reserve(scope, key, req.merchantId || null);
    } catch (err) {
      return next(err);
    }

    if (reservation.state === "completed") {
      res.set("Idempotent-Replay", "true");
      return res.status(reservation.httpStatus).json(reservation.body);
    }
    if (reservation.state === "in_progress") {
      // 409 rather than waiting. The first request is still working, and the
      // right thing for the caller to do is retry in a moment, which is what
      // Retry-After says.
      res.set("Retry-After", "2");
      return res.status(409).json({
        error: {
          code: "request_in_progress",
          message: "A request with this Idempotency-Key is still being processed.",
        },
      });
    }

    // Hands the route the two calls it needs to close the loop.
    req.idempotency = {
      key,
      scope,
      complete: (httpStatus, body, orderId) => complete(scope, key, { httpStatus, body, orderId }),
      release: () => release(scope, key),
    };
    return next();
  };
}

module.exports = { STUCK_AFTER_SECONDS, isValidKey, reserve, complete, release, middleware };
