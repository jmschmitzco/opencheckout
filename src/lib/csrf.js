// Cross-site request forgery protection for the dashboard.
//
// The dashboard is authenticated by a COOKIE, which means a request forged on
// another site arrives already signed in. Everything behind it changes money
// or configuration: gateway credentials, refunds, API keys. So it gets three
// defences, because each one covers a gap the others leave:
//
//   1. SameSite=lax on the session cookie, set where the session is created.
//      It stops the cookie riding a cross-site POST at all, and it is the
//      strongest of the three. It is also the one that depends entirely on
//      the browser, which is why it is not the only one.
//   2. A token this file issues, tied to the session and submitted with every
//      form. A page on another origin cannot read it.
//   3. An Origin check, for the case where a request states where it came
//      from. A form posted from another site cannot forge that header.
//
// GET is never protected, and that is a rule rather than an oversight: a GET
// must not change anything, so there is nothing for a forged one to do. If a
// GET route here ever needs protecting, the route is wrong, not this file.
const crypto = require("node:crypto");
const { safeEqual } = require("./crypto");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FIELD = "_csrf";
const HEADER = "x-csrf-token";

// Issues a token for this session, reusing the one it already has.
//
// Per session rather than per form: a new token for every page breaks the back
// button and breaks two tabs, and people work in two tabs. The session's own
// lifetime is the bound that matters.
function tokenFor(req) {
  if (!req.session) return null;
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString("base64url");
  }
  return req.session.csrf;
}

// Makes the token available to every view as `csrfToken`, so a template can
// never forget to render it and a form can never be built without it.
function attach(req, res, next) {
  const token = tokenFor(req);
  res.locals.csrfToken = token;
  next();
}

function originMatches(req) {
  const origin = req.get("origin");
  // A same-origin form navigation often sends no Origin at all. Absence is
  // not evidence of anything, so it falls through to the token check.
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

function protect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  if (!originMatches(req)) {
    return refuse(req, res, "This request came from another site.");
  }

  const expected = req.session && req.session.csrf;
  const given = (req.body && req.body[FIELD]) || req.get(HEADER) || "";
  if (!expected || !given || !safeEqual(expected, given)) {
    return refuse(
      req,
      res,
      "Your session expired while this page was open. Reload it and try again."
    );
  }

  return next();
}

// The message matters more than the status here. "403 invalid CSRF token"
// sends somebody hunting for a bug in their own form; the real cause is almost
// always a page that sat open until the session rolled over.
function refuse(req, res, message) {
  const wantsJson =
    String(req.get("accept") || "").includes("application/json") ||
    String(req.get("content-type") || "").includes("application/json");

  if (wantsJson) {
    return res.status(403).json({ error: { code: "forbidden", message } });
  }
  return res.status(403).render("dashboard/message", {
    title: "That did not go through",
    message,
    backTo: req.get("referer") || "/dashboard",
  });
}

module.exports = { attach, protect, tokenFor, FIELD, HEADER };
