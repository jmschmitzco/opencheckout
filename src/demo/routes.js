// The demo's own pages.
//
// They mint a checkout session with NO API KEY, which is exactly the thing a
// real installation must never do. That is why they live here, behind
// isDemo(), and why app.js only mounts this router in demo mode.
const express = require("express");
const ctx = require("../db/merchant-context");
const { config } = require("../config");
const sessions = require("../services/checkout-sessions");
const { getDemoState } = require("./state");

const router = express.Router();

function demo() {
  const state = getDemoState();
  if (!state) throw new Error("The demo routes were mounted before the demo was seeded.");
  return state;
}

async function openSession(res, body) {
  const state = demo();
  const session = await ctx.withMerchant(state.merchant.id, () =>
    sessions.create(state.merchant.id, body, { livemode: false })
  );
  res.redirect(sessions.url(session));
}

router.get("/demo", (_req, res) => {
  res.type("html").send(page("OpenCheckout demo", index()));
});

router.get("/demo/payment", (_req, res, next) => {
  const state = demo();
  openSession(res, {
    mode: "payment",
    line_items: [
      { price: state.price.public_id, quantity: 1 },
      { price: state.extraPrice.public_id, quantity: 1 },
    ],
    success_url: `${config.baseUrl}/demo/done`,
    cancel_url: `${config.baseUrl}/demo`,
    locale: "pt-BR",
    metadata: { demo: true },
  }).catch(next);
});

router.get("/demo/subscription", (_req, res, next) => {
  const state = demo();
  openSession(res, {
    mode: "subscription",
    line_items: [{ price: state.recurringPrice.public_id, quantity: 1 }],
    success_url: `${config.baseUrl}/demo/done`,
    cancel_url: `${config.baseUrl}/demo`,
    locale: "pt-BR",
    customer_external_id: "user-demo-1",
  }).catch(next);
});

// The per-session brand override: the feature that makes this white label
// rather than merely themeable. Same merchant, dressed as somebody else.
router.get("/demo/white-label", (_req, res, next) => {
  const state = demo();
  openSession(res, {
    mode: "payment",
    line_items: [{ price: state.price.public_id, quantity: 1 }],
    success_url: `${config.baseUrl}/demo/done`,
    cancel_url: `${config.baseUrl}/demo`,
    locale: "en-US",
    branding: {
      brand_name: "Globex",
      accent: "#f59e0b",
      page_bg: "#fffbeb",
      surface: "#ffffff",
      border: "#f0e2c0",
      text: "#1c1917",
      font: "figtree",
      radius_button: 999,
      radius_card: 22,
      template: "single",
      headline: "One last step",
      subheadline: "Billed once. No subscription.",
      submit_label: "Complete order",
      top_bar_text: null,
    },
  }).catch(next);
});

router.get("/demo/dark", (_req, res, next) => {
  const state = demo();
  openSession(res, {
    mode: "payment",
    line_items: [{ price: state.price.public_id, quantity: 1 }],
    success_url: `${config.baseUrl}/demo/done`,
    cancel_url: `${config.baseUrl}/demo`,
    locale: "en-US",
    branding: {
      brand_name: "Initech",
      accent: "#22d3ee",
      page_bg: "#0b0e14",
      surface: "#141924",
      text: "#f3f4f6",
      text_muted: "#9aa3b2",
      border: "#232a36",
      color_scheme: "dark",
      font: "geist",
      headline: "Upgrade to Initech Pro",
      top_bar_text: null,
    },
  }).catch(next);
});

router.get("/demo/embed", (_req, res, next) => {
  const state = demo();
  ctx
    .withMerchant(state.merchant.id, () =>
      sessions.create(
        state.merchant.id,
        {
          mode: "payment",
          line_items: [{ price: state.price.public_id, quantity: 1 }],
          success_url: `${config.baseUrl}/demo/done`,
          cancel_url: `${config.baseUrl}/demo`,
          locale: "pt-BR",
        },
        { livemode: false }
      )
    )
    .then((session) => {
      res.type("html").send(page("Embedded checkout", embed(sessions.url(session))));
    })
    .catch(next);
});

router.get("/demo/done", (req, res) => {
  res.type("html").send(page("Done", done(req.query)));
});

// ---------------------------------------------------------------------------
// The pages. Plain strings: the demo index is not part of the product, and
// giving it a template would imply that it is.
// ---------------------------------------------------------------------------

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="/static/css/demo.css"></head>
<body>${body}</body></html>`;
}

function index() {
  const state = demo();
  return `<h1>OpenCheckout</h1>
    <p class="lead">A simulated gateway and an in-memory database. No real money can move here.</p>
    <a class="card" href="/demo/payment"><strong>One-off payment</strong>
      <span>Two line items, an anchor price, card or Pix or boleto.</span></a>
    <a class="card" href="/demo/subscription"><strong>Subscription</strong>
      <span>Monthly plan, card only, renewed by the background loop.</span></a>
    <a class="card" href="/demo/white-label"><strong>White label</strong>
      <span>The same merchant wearing another brand, passed per session.</span></a>
    <a class="card" href="/demo/dark"><strong>Dark theme</strong>
      <span>The same page again, themed from the API.</span></a>
    <a class="card" href="/demo/embed"><strong>Embedded widget</strong>
      <span>The checkout in an overlay on somebody else's page.</span></a>
    <a class="card" href="/dashboard"><strong>The merchant dashboard</strong>
      <span>Sign in as ${state.demoLogin.email} with ${state.demoLogin.password}</span></a>
    <h2>From your terminal</h2>
    <pre><code>curl -H "Authorization: Bearer ${state.secretKey}" \\
  ${config.baseUrl}/v1/me</code></pre>
    <p class="lead">Card <code>4242 4242 4242 4242</code> approves.
      <code>4000 0000 0000 0002</code> declines.
      Pix and boleto settle on their own after about 12 seconds.</p>`;
}

function embed(sessionUrl) {
  return `<h1>Your own page</h1>
    <p class="lead">The button opens the checkout in an overlay. The card fields stay on the
    checkout's origin, so this page never touches them and its stylesheet cannot reach inside
    the form.</p>
    <button class="card card--button" data-opencheckout-url="${sessionUrl}">
      <strong>Subscribe to Northwind Pro</strong><span>Opens the overlay</span></button>
    <p class="lead"><a href="/demo">Back to the demo</a></p>
    <script src="/embed.js"></script>`;
}

function done(query) {
  return `<h1>Back on your own site</h1>
    <p class="lead">This is the success_url the session was created with. The order id and status
    arrive as query parameters; the authoritative answer arrives separately, as a signed webhook.</p>
    <pre><code>order_id=${String(query.order_id || "")}
status=${String(query.status || "")}</code></pre>
    <a class="card" href="/demo"><strong>Run another one</strong><span>Back to the demo</span></a>`;
}

module.exports = router;
