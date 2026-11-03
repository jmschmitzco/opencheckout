// The people who sign in to the dashboard.
//
// This is the one place in the system that holds a password, so it is the one
// place that has to be careful about three specific things:
//
//   1. THE SAME ANSWER FOR AN UNKNOWN EMAIL AND A WRONG PASSWORD. Telling
//      them apart turns the login form into a list of who has an account.
//   2. THE SAME AMOUNT OF WORK, TOO. A missing user that returns instantly,
//      while a real one spends a tenth of a second hashing, says the same
//      thing in a slower voice.
//   3. A BRAKE THAT SURVIVES A RESTART AND AN IP CHANGE. Attempts are counted
//      on the row, because an attacker rotating addresses walks past any
//      per-IP limit, and a process restart must not hand them a clean slate.
const db = require("../db");
const v = require("../lib/validators");
const password = require("../lib/password");
const { badRequest, conflict, notFound } = require("../lib/errors");

// Five wrong guesses, then fifteen minutes. Long enough to make an online
// attack pointless, short enough that somebody who mistyped their own password
// has not lost their evening.
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// Used to spend the same time on an unknown email as on a real one. It is a
// real hash of a value nobody knows, so verifying against it costs exactly
// what a genuine verification costs.
let decoyHash = null;
async function decoy() {
  if (!decoyHash) decoyHash = await password.hash(require("../lib/crypto").randomToken(16));
  return decoyHash;
}

const LOOKUP_REASON = "signing in is what DISCOVERS the merchant, so it cannot filter by one";

function normalizeEmail(value) {
  return v.email(value);
}

async function create({ merchantId, email, name, plainPassword, role = "owner" }) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw badRequest("A valid email is required.", { email: "Invalid." });

  const problem = password.problemWith(plainPassword);
  if (problem) throw badRequest(problem, { password: problem });

  const existing = await db.query(`select id from merchant_users where email = $1`, [cleanEmail], {
    withoutMerchant: LOOKUP_REASON,
  });
  if (existing.rows[0]) throw conflict("That email already has an account.", { email: "In use." });

  const result = await db.query(
    `insert into merchant_users (merchant_id, email, name, password_hash, role)
     values ($1, $2, $3, $4, $5)
     returning id, merchant_id, email, name, role, created_at`,
    [merchantId, cleanEmail, v.text(name, 120), await password.hash(plainPassword), role],
    { withoutMerchant: LOOKUP_REASON }
  );
  return result.rows[0];
}

async function findByEmail(email) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return null;
  const result = await db.query(`select * from merchant_users where email = $1`, [cleanEmail], {
    withoutMerchant: LOOKUP_REASON,
  });
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await db.query(`select * from merchant_users where id = $1`, [id], {
    withoutMerchant: LOOKUP_REASON,
  });
  return result.rows[0] || null;
}

function lockedFor(user) {
  if (!user || !user.locked_until) return 0;
  const remaining = new Date(user.locked_until).getTime() - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 60000) : 0;
}

// Returns { ok, user } or { ok: false, reason, lockedMinutes }.
//
// `reason` is for the log and for deciding whether to say "locked". It is
// never the difference between "no such email" and "wrong password": the form
// says the same thing for both.
async function authenticate(email, plainPassword) {
  const user = await findByEmail(email);

  if (!user) {
    // Spend the time anyway. An instant "no" for an unknown address is a
    // directory of who has an account, read one request at a time.
    await password.verify(String(plainPassword || ""), await decoy());
    return { ok: false, reason: "unknown" };
  }

  const minutes = lockedFor(user);
  if (minutes > 0) {
    return { ok: false, reason: "locked", lockedMinutes: minutes };
  }

  const result = await password.verify(String(plainPassword || ""), user.password_hash);
  if (!result.ok) {
    const attempts = user.failed_attempts + 1;
    const lockUntil =
      attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
    await db.query(
      `update merchant_users set failed_attempts = $2, locked_until = $3, updated_at = now()
        where id = $1`,
      [user.id, attempts >= MAX_ATTEMPTS ? 0 : attempts, lockUntil],
      { withoutMerchant: LOOKUP_REASON }
    );
    return {
      ok: false,
      reason: lockUntil ? "locked" : "wrong",
      lockedMinutes: lockUntil ? LOCK_MINUTES : 0,
    };
  }

  // A correct password clears the count, and upgrades the hash if it was
  // written with weaker parameters than the current ones. This is the only
  // moment the plaintext is in hand, so it is the only moment it can be done.
  const rehashed = result.needsRehash ? await password.hash(plainPassword) : null;
  await db.query(
    `update merchant_users
        set failed_attempts = 0, locked_until = null, last_login_at = now(),
            password_hash = coalesce($2, password_hash), updated_at = now()
      where id = $1`,
    [user.id, rehashed],
    { withoutMerchant: LOOKUP_REASON }
  );

  return { ok: true, user: await findById(user.id) };
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await findById(userId);
  if (!user) throw notFound("Account not found.");

  const current = await password.verify(String(currentPassword || ""), user.password_hash);
  if (!current.ok) {
    throw badRequest("That is not your current password.", { current_password: "Incorrect." });
  }

  const problem = password.problemWith(newPassword);
  if (problem) throw badRequest(problem, { password: problem });

  await db.query(
    `update merchant_users set password_hash = $2, updated_at = now() where id = $1`,
    [userId, await password.hash(newPassword)],
    { withoutMerchant: LOOKUP_REASON }
  );
  return true;
}

// Is this a brand new installation with nobody in it?
//
// It is what decides whether the first-run setup page exists. Once one account
// exists the page is gone, so it cannot be used to add a second owner to
// somebody else's installation.
async function installationIsEmpty() {
  const result = await db.query(`select 1 from merchant_users limit 1`, [], {
    withoutMerchant: "deciding whether ANY account exists cannot be scoped to one merchant",
  });
  return result.rows.length === 0;
}

async function listForMerchant(merchantId) {
  const result = await db.query(
    `select id, email, name, role, last_login_at, created_at
       from merchant_users where merchant_id = $1 order by created_at`,
    [merchantId]
  );
  return result.rows;
}

module.exports = {
  MAX_ATTEMPTS,
  LOCK_MINUTES,
  create,
  findByEmail,
  findById,
  authenticate,
  changePassword,
  installationIsEmpty,
  listForMerchant,
  lockedFor,
  normalizeEmail,
};
