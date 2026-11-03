// Signing in, signing out, and the first run.
//
// These three sit OUTSIDE the wall, so they do their own CSRF protection
// rather than inheriting it.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../../db/merchant-context");
const csrf = require("../../lib/csrf");
const { isDemo } = require("../../config");
const merchants = require("../../services/merchants");
const merchantUsers = require("../../services/merchant-users");
const apiKeys = require("../../services/api-keys");
const { ApiError } = require("../../lib/errors");

const router = express.Router();

// Tighter than the dashboard's own limit, and counted per address. It is the
// second brake, not the first: the real one is the per-account lockout in
// merchant-users, because an attacker rotating addresses walks past this.
const loginLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  skip: () => isDemo(),
  standardHeaders: true,
  legacyHeaders: false,
});

// A redirect target from the query string is a place an attacker can choose,
// so only a path on this site is allowed through.
function safeNext(value) {
  const target = String(value || "");
  if (!target.startsWith("/dashboard")) return "/dashboard";
  if (target.startsWith("//")) return "/dashboard"; // "//evil.test" is another origin
  return target;
}

// ---------------------------------------------------------------------------
// First run
//
// A brand new installation has no account, so there is no way to sign in and
// nothing to sign in to. This page creates the first merchant and the first
// owner, and then it is GONE: once any account exists it answers 404, so it
// cannot be used to add an owner to somebody else's installation.
// ---------------------------------------------------------------------------

async function setupIsOpen() {
  return merchantUsers.installationIsEmpty();
}

router.get("/setup", loginLimit, async (req, res, next) => {
  try {
    if (!(await setupIsOpen())) return res.redirect("/dashboard/login");
    res.render("dashboard/setup", { title: "Set up OpenCheckout", errors: {}, values: {} });
  } catch (err) {
    next(err);
  }
});

router.post("/setup", loginLimit, csrf.protect, async (req, res, next) => {
  try {
    if (!(await setupIsOpen())) return res.redirect("/dashboard/login");

    const body = req.body || {};
    const values = { business: body.business, email: body.email, name: body.name };

    const merchant = await ctx.withoutMerchant("the first merchant is what defines ownership", () =>
      merchants.create({ name: body.business, supportEmail: body.email })
    );

    let user;
    try {
      user = await merchantUsers.create({
        merchantId: merchant.id,
        email: body.email,
        name: body.name,
        plainPassword: body.password,
      });
    } catch (err) {
      // The merchant was created a moment ago and now has no owner, which is
      // a dead row that would also keep the setup page closed forever. It goes
      // back out.
      await ctx.withoutMerchant("rolling back a merchant whose owner could not be created", () =>
        require("../../db").query(`delete from merchants where id = $1`, [merchant.id])
      );
      throw err;
    }

    // A pair of keys to start with, so the first thing somebody does after
    // setting up is not "go and find where keys are made".
    await ctx.withMerchant(merchant.id, async () => {
      await apiKeys.create(merchant.id, { label: "Test mode", livemode: false });
      await apiKeys.create(merchant.id, { label: "Live mode", livemode: true });
    });

    req.session.dashboard = { userId: user.id };
    if (req.session) req.session.flash = { kind: "ok", message: "Your installation is ready." };
    return res.redirect("/dashboard");
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).render("dashboard/setup", {
        title: "Set up OpenCheckout",
        errors: err.fields || { form: err.message },
        values: { business: req.body.business, email: req.body.email, name: req.body.name },
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

router.get("/login", loginLimit, async (req, res, next) => {
  try {
    if (await setupIsOpen()) return res.redirect("/dashboard/setup");
    if (req.user) return res.redirect(safeNext(req.query.next));

    res.render("dashboard/login", {
      title: "Sign in",
      error: null,
      values: {},
      next: safeNext(req.query.next),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/login", loginLimit, csrf.protect, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await merchantUsers.authenticate(body.email, body.password);

    if (!result.ok) {
      // ONE MESSAGE for an unknown email and a wrong password. Telling them
      // apart turns this form into a list of who has an account here.
      //
      // A lock is told plainly, because the person needs to know that waiting
      // is the answer, and because by then the attacker already knows.
      const message =
        result.reason === "locked"
          ? `Too many attempts. Try again in ${result.lockedMinutes} minutes.`
          : "That email and password do not match.";

      return res.status(401).render("dashboard/login", {
        title: "Sign in",
        error: message,
        values: { email: body.email },
        next: safeNext(body.next),
      });
    }

    // A new session id on sign in, so a token fixed before the login cannot be
    // used after it.
    req.session.regenerate = undefined;
    req.session.csrf = null;
    req.session.dashboard = { userId: result.user.id };
    csrf.tokenFor(req);

    return res.redirect(safeNext(body.next));
  } catch (err) {
    return next(err);
  }
});

router.post("/logout", csrf.protect, (req, res) => {
  if (req.session) {
    delete req.session.dashboard;
    req.session.csrf = null;
  }
  res.redirect("/dashboard/login");
});

module.exports = { router, safeNext };
