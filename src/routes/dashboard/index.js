// The merchant dashboard.
//
// Everything in OpenCheckout is on the API, which is enough for a developer
// and not enough for the person who owns the business. This is the part they
// use: paste the gateway keys, pick the colours, read the sales.
//
// It is server rendered, with no framework and no build step, like the rest of
// the project. A dashboard that needs a toolchain is a dashboard that stops
// building eighteen months after anybody last touched it.
//
// THE SHAPE OF EVERY REQUEST HERE:
//   rate limit -> session -> CSRF token -> signed in? -> merchant context
//
// The merchant context is opened from the SESSION, never from anything in the
// URL or the body. That is what makes it impossible to write a dashboard page
// that reads another merchant's data by accident: the guard in db/index.js
// refuses any query that does not name a merchant, and the only merchant
// available is the one who signed in.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../../db/merchant-context");
const csrf = require("../../lib/csrf");
const { isDemo, config } = require("../../config");
const merchants = require("../../services/merchants");
const merchantUsers = require("../../services/merchant-users");

const router = express.Router();

router.use(
  rateLimit({
    windowMs: 60_000,
    max: 300,
    skip: () => isDemo(),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// The dashboard is never framed. It holds the controls for somebody's money.
router.use((_req, res, next) => {
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  next();
});

router.use(csrf.attach);

// Flash messages survive exactly one redirect, which is what a redirect after
// a write needs: the write happens, the browser moves, the page says what
// happened. Keeping them in the session means no query string to forge.
router.use((req, res, next) => {
  res.locals.flash = (req.session && req.session.flash) || null;
  if (req.session && req.session.flash) delete req.session.flash;

  res.flash = (kind, message) => {
    if (req.session) req.session.flash = { kind, message };
  };
  next();
});

// Values every dashboard view needs, set once rather than in each route.
router.use((req, res, next) => {
  res.locals.path = req.baseUrl + req.path;
  res.locals.demo = isDemo();
  res.locals.baseUrl = config.baseUrl;
  next();
});

// ---------------------------------------------------------------------------
// Who is signed in
// ---------------------------------------------------------------------------

// Loads the signed in user and opens their merchant's context.
//
// It reloads the user from the database on every request rather than trusting
// what is in the cookie. A revoked account has to stop working on the next
// click, not when the cookie happens to expire.
async function loadUser(req, res, next) {
  const session = req.session && req.session.dashboard;
  if (!session || !session.userId) return next();

  try {
    const user = await merchantUsers.findById(session.userId);
    if (!user) {
      delete req.session.dashboard;
      return next();
    }

    req.user = user;
    req.merchantId = user.merchant_id;
    return ctx.withMerchant(user.merchant_id, async () => {
      req.merchant = await merchants.findById(user.merchant_id);
      if (!req.merchant || !req.merchant.active) {
        delete req.session.dashboard;
        return next();
      }
      res.locals.user = { id: user.id, email: user.email, name: user.name, role: user.role };
      res.locals.merchant = req.merchant;
      return next();
    });
  } catch (err) {
    return next(err);
  }
}

// Everything past this point needs somebody signed in. A browser gets the
// login page with a way back to where it was going; anything else gets a 401.
function requireUser(req, res, next) {
  if (req.user) return next();

  const wantsJson = String(req.get("accept") || "").includes("application/json");
  if (wantsJson) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Sign in first." } });
  }
  const target = encodeURIComponent(req.originalUrl || "/dashboard");
  return res.redirect(`/dashboard/login?next=${target}`);
}

router.use(loadUser);

// Sign in, sign out and first run setup live outside the wall.
router.use("/", require("./auth").router);

// Everything else is behind it, and behind CSRF.
router.use(requireUser);
router.use(csrf.protect);

router.use("/", require("./overview"));
router.use("/", require("./sales"));
router.use("/", require("./catalogue"));
router.use("/", require("./settings"));

// A dashboard address that does not exist gets the dashboard's own page, not
// the public one: the person is signed in and should stay oriented.
router.use((req, res) => {
  res.status(404).render("dashboard/message", {
    title: "Page not found",
    message: "There is nothing at that address.",
    backTo: "/dashboard",
  });
});

module.exports = { router, requireUser, loadUser };
