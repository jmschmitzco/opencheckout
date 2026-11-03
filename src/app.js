// The Express app, separate from server.js so the tests can mount it with
// supertest without opening a port.
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const cookieSession = require("cookie-session");
const rateLimit = require("express-rate-limit");
const { config, isDemo } = require("./config");
const { keepRawBody } = require("./lib/raw-body");
const { errorHandler } = require("./lib/errors");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.set("x-powered-by", false);

// HOW MANY HOPS TO THE BUYER.
//
// Every rate limit here is counted per IP, so getting this wrong breaks all of
// them at once. Behind a CDN and a reverse proxy, the real address is the one
// the CDN appended, counted from the right. Set it to the number of proxies
// YOU run in front of this app, and no more: a number that is too high lets a
// visitor spoof their own address by sending the header themselves.
//
// 0 is correct for local development and for the demo. 1 for a single reverse
// proxy. 2 for a CDN in front of a reverse proxy.
app.set("trust proxy", Number(process.env.TRUSTED_PROXY_HOPS || 0));

// Security headers. The checkout page is where somebody types a card number,
// so the content policy is strict and the few things that need loosening are
// loosened explicitly, per route.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No inline script anywhere. Every page's JavaScript is a file under
        // public/js, which is what makes this directive possible to keep.
        scriptSrc: ["'self'"],
        // Inline style IS allowed, because the white label theme is applied as
        // a style attribute of validated custom properties. Every value in it
        // passed through branding.js, which accepts only hex colours, integers
        // and names from a closed list.
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        // A merchant's logo and product images come from wherever they host
        // them, and data: is needed for the Pix QR code.
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.env === "production" ? [] : null,
      },
    },
    // The embed widget frames the checkout, and the per-route handler sets the
    // precise ancestor list. A global value here would override it.
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    // The embedded widget is loaded by the integrator's page, so a blanket
    // same-origin resource policy would block it.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: config.env === "production" ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

app.use(
  express.json({
    limit: "256kb",
    // Keeps the exact bytes for the routes that verify a signature. See
    // lib/raw-body.js for why re-serializing breaks verification.
    verify: keepRawBody,
  })
);
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

app.use(
  cookieSession({
    name: "oc_session",
    keys: [config.appSecret],
    httpOnly: true,
    sameSite: "lax",
    secure: config.env === "production",
    maxAge: 2 * 60 * 60 * 1000,
  })
);

// A floor under everything, so a single address cannot flood the process. The
// routes that matter have tighter limits of their own.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 600,
    skip: () => isDemo(),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(
  "/static",
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: config.env === "production" ? "7d" : 0,
    etag: true,
    index: false,
  })
);

// Liveness, and the one call a new operator makes to see if it is up.
//
// IT ASKS THE DATABASE. Answering 200 while the database is unreachable is
// worse than not having a health check at all: a load balancer keeps sending
// buyers to an instance that cannot take a single payment.
app.get("/healthz", async (_req, res) => {
  const body = {
    ok: true,
    service: "opencheckout",
    env: config.env,
    demo: isDemo(),
    version: require("../package.json").version,
    database: "ok",
  };
  try {
    await require("./db").query("select 1 as ok", [], {
      withoutMerchant: "a health check belongs to no merchant",
    });
  } catch (err) {
    body.ok = false;
    body.database = "unreachable";
    return res.status(503).json(body);
  }
  return res.json(body);
});

app.use("/v1", require("./routes/api-v1"));
app.use("/gateway-webhooks", require("./routes/gateway-webhooks").router);
app.use("/", require("./routes/embed"));
app.use("/", require("./routes/payment-return").router);
app.use("/", require("./routes/funnel").router);
app.use("/", require("./routes/hosted-checkout").router);
app.use("/dashboard", require("./routes/dashboard").router);
app.use("/", require("./routes/portal"));

// The demo's own pages, which mint sessions with no API key. Mounted here,
// before the catch-all below, and only in demo mode.
if (isDemo()) {
  app.use("/", require("./demo/routes"));
}

// A bare visit to the root. There is no marketing site here: this is
// infrastructure, and the useful answer is where the docs are.
app.get("/", (_req, res) => {
  res.json({
    service: "opencheckout",
    docs: "https://github.com/jmschmitzco/opencheckout",
    api: `${config.baseUrl}/v1`,
    health: `${config.baseUrl}/healthz`,
  });
});

app.use((req, res) => {
  const wantsJson = String(req.get("accept") || "").includes("application/json") || req.path.startsWith("/v1");
  if (wantsJson) {
    return res.status(404).json({ error: { code: "not_found", message: "No such endpoint." } });
  }
  return res.status(404).render("error", {
    title: "Not found",
    message: "There is nothing at this address.",
  });
});

app.use(errorHandler(console));

module.exports = app;
