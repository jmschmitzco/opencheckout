// The hosted checkout page, and the small API the page itself talks to.
//
// Routes:
//   GET  /c/:id            the page
//   POST /c/:id/pay        creates the order and charges it
//   GET  /c/:id/status     what the waiting screen polls
//   POST /c/:id/coupon     applies a coupon
//   POST /c/:id/contact    records an abandoned cart as soon as there is an email
//   GET  /c/:id/embed      the same page, framed, for the widget
//
// AUTHENTICATION. The session's client_secret arrives as ?k=. It is a bearer
// token for exactly one session, and it is compared in constant time. Nothing
// here accepts an API key: a page the buyer can read must never hold one.
//
// The merchant is resolved FROM the session, so the context opened here is
// marked as assumed until that lookup is done. See db/merchant-context.js.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../db/merchant-context");
const { safeEqual } = require("../lib/crypto");
const { isDemo, config } = require("../config");
const money = require("../lib/money");
const sessions = require("../services/checkout-sessions");
const orders = require("../services/orders");
const merchants = require("../services/merchants");
const themes = require("../services/themes");
const branding = require("../services/branding");
const carts = require("../services/carts");
const gatewayConfig = require("../services/gateway-config");
const idempotency = require("../services/idempotency");
const { ApiError, badRequest, notFound } = require("../lib/errors");

const router = express.Router();

const skipInDemo = () => isDemo();

// A page view is cheap; a charge attempt is not. The create-order limit is the
// one that matters, because an unlimited one is a free card testing service.
const pageLimit = rateLimit({ windowMs: 60_000, max: 120, skip: skipInDemo, standardHeaders: true });
const payLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, skip: skipInDemo, standardHeaders: true });
const couponLimit = rateLimit({ windowMs: 60_000, max: 20, skip: skipInDemo, standardHeaders: true });
const statusLimit = rateLimit({ windowMs: 60_000, max: 240, skip: skipInDemo, standardHeaders: true });

// Loads the session, checks the secret, opens the merchant context.
//
// The secret is required even for the page itself. Without it, a session id,
// which is short and appears in logs and referrers, would be enough to read
// what somebody is buying and the email it was created with.
async function loadSession(req, res, next) {
  try {
    const session = await sessions.findForPage(req.params.id);
    if (!session) throw notFound("This checkout link is not valid.");

    const given = String(req.query.k || req.get("x-checkout-key") || "");
    if (!given || !safeEqual(session.client_secret, given)) {
      throw notFound("This checkout link is not valid.");
    }

    req.session_ = session;
    req.merchantId = session.merchant_id;
    // Proven: the secret matched, so this request genuinely belongs to that
    // merchant.
    return ctx.withMerchant(session.merchant_id, async () => {
      req.merchant = await merchants.findById(session.merchant_id);
      if (!req.merchant || !req.merchant.active) throw notFound("This checkout is not available.");
      return next();
    });
  } catch (err) {
    return next(err);
  }
}

// What the page and the widget both render from. One function, so the framed
// and unframed versions can never drift apart.
async function buildPageModel(req) {
  const session = req.session_;
  const merchant = req.merchant;

  const items = sessions.parseLineItems(session);
  const theme = await themes.resolveFor({
    merchant,
    productId: items.length ? items[0].product_id : null,
    sessionOverride: sessions.parseBrandingOverride(session),
  });

  // Only the methods a configured gateway can actually take. Offering one that
  // cannot be charged is the worst bug on this page: the buyer picks it, fills
  // everything in, and finds out at the end.
  const configured = await gatewayConfig.availableMethods({
    merchantId: merchant.id,
    livemode: session.livemode,
  });
  const methods = String(session.payment_methods || "")
    .split(",")
    .filter(Boolean)
    .filter((method) => configured.includes(method));

  const locale = session.locale;
  const maxInstallments = methods.includes("card")
    ? money.maxInstallmentsFor(session.total_cents, orders.maxInstallmentsForItems(items, session.currency))
    : 1;

  return {
    status: sessions.effectiveStatus(session),
    session,
    merchant,
    theme,
    copy: branding.copyFor(theme, { locale }),
    themeStyle: branding.themeStyleAttribute(theme),
    webfontHref: branding.webfontHref(theme),
    items,
    methods,
    buyerFields: String(session.buyer_fields || "").split(",").filter(Boolean),
    locale,
    maxInstallments,
    // Pre-computed instalment options, so the page renders the real amounts
    // instead of doing money arithmetic in the browser.
    installmentOptions: Array.from({ length: maxInstallments }, (_, index) => {
      const n = index + 1;
      return {
        count: n,
        amount_cents: money.installmentAmount(session.total_cents, n),
        label: money.formatMoney(money.installmentAmount(session.total_cents, n), session.currency, locale),
      };
    }),
    format: (cents) => money.formatMoney(cents, session.currency, locale),
    publicConfig: {
      sessionId: session.public_id,
      clientSecret: session.client_secret,
      currency: session.currency,
      locale,
      total_cents: session.total_cents,
      methods,
      buyer_fields: String(session.buyer_fields || "").split(",").filter(Boolean),
      allow_coupon: session.allow_coupon,
      demo: isDemo(),
      successUrl: session.success_url,
      cancelUrl: session.cancel_url,
    },
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

async function renderCheckout(req, res, next, { framed = false } = {}) {
  try {
    const model = await buildPageModel(req);

    if (model.status === "completed" && req.session_.order_id) {
      const order = await orders.findById(req.merchantId, req.session_.order_id);
      if (order) {
        // Already paid, and the buyer came back to the link. Send them where
        // they were going rather than showing a dead form.
        if (orders.TERMINAL_PAID.includes(order.status)) {
          return res.redirect(withOrderParams(req.session_.success_url, order));
        }
        return res.render("waiting", { ...model, order, orderView: orders.toStatusView(order, model) });
      }
    }
    if (model.status !== "open") {
      return res.status(410).render("closed", model);
    }

    // The widget renders inside the integrator's page, so it may be framed by
    // the origins that merchant declared, and nothing else. The page outside
    // the widget may never be framed at all.
    if (framed) {
      const origins = frameAncestorsFor(req.merchant);

      // No origin declared means nothing may frame this, which is the correct
      // default and a terrible thing to discover as an empty white box. So the
      // widget gets a page that SAYS so instead.
      //
      // That page is framable from anywhere on purpose: it holds no form, no
      // amount, no secret and no brand. Only the real checkout is restricted.
      if (origins.length === 1 && origins[0] === "'none'") {
        allowFramingBy(res, ["*"]);
        return res.status(200).render("embed-blocked", {
          checkoutUrl: `${config.baseUrl}/c/${req.session_.public_id}?k=${req.session_.client_secret}`,
        });
      }

      allowFramingBy(res, origins);
    } else {
      res.set("X-Frame-Options", "DENY");
    }

    return res.render("checkout", { ...model, framed });
  } catch (err) {
    return next(err);
  }
}

// Swaps the frame-ancestors directive, keeping the rest of the policy.
//
// Replacing the whole header would be the obvious thing to write and would
// quietly remove script-src, object-src and the others from the one page in
// the system that takes card numbers. So the existing policy is edited, and
// only that one directive changes.
function allowFramingBy(res, origins) {
  const directive = `frame-ancestors ${origins.join(" ")}`;
  const current = String(res.getHeader("Content-Security-Policy") || "");
  if (!current) {
    res.set("Content-Security-Policy", directive);
    return;
  }
  const parts = current
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors\b/i.test(part));
  parts.push(directive);
  res.set("Content-Security-Policy", parts.join(";"));
}

function frameAncestorsFor(merchant) {
  const declared = String((merchant && merchant.allowed_origins) || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes("://") ? entry : `https://${entry}`));
  const all = [...declared, ...config.embedExtraOrigins];
  // No declared origin means no framing. Defaulting to 'self' here would be a
  // widget that silently does not work; defaulting to '*' would let any site
  // frame a payment form, which is how clickjacking works.
  return all.length ? all : ["'none'"];
}

function withOrderParams(url, order) {
  try {
    const target = new URL(url);
    target.searchParams.set("order_id", order.public_id);
    target.searchParams.set("status", order.status);
    return target.toString();
  } catch {
    return url;
  }
}

router.get("/c/:id", pageLimit, loadSession, (req, res, next) =>
  renderCheckout(req, res, next, { framed: false })
);

router.get("/c/:id/embed", pageLimit, loadSession, (req, res, next) =>
  renderCheckout(req, res, next, { framed: true })
);

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

router.post(
  "/c/:id/pay",
  payLimit,
  loadSession,
  idempotency.middleware("checkout_pay"),
  async (req, res, next) => {
    try {
      const order = await orders.createFromSession({
        merchant: req.merchant,
        session: req.session_,
        input: req.body || {},
        remoteIp: req.ip,
        userAgent: req.get("user-agent"),
      });

      const body = {
        order_id: order.public_id,
        token: order.checkout_token,
        ...orders.toStatusView(order, { locale: req.session_.locale }),
        // Where to go next. Computed here because only the server knows the
        // declared success_url, and the page must not be able to choose.
        next_url:
          orders.TERMINAL_PAID.includes(order.status)
            ? withOrderParams(req.session_.success_url, order)
            : null,
      };

      if (req.idempotency) await req.idempotency.complete(201, body, order.id);
      res.status(201).json(body);
    } catch (err) {
      // A declined card is a business error, and the key has to stay reusable:
      // the buyer fixes the number and tries again from the same page.
      if (req.idempotency) await req.idempotency.release().catch(() => {});
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Polling
//
// This is how Pix and boleto finish. The page asks; the server asks the
// gateway. The browser is never told "you are paid" by anything other than a
// gateway answer that the server itself read.
// ---------------------------------------------------------------------------

router.get("/c/:id/status", statusLimit, loadSession, async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    const orderId = String(req.query.order_id || "");
    const order = await orders.findByToken(req.merchantId, orderId, token);
    if (!order) throw notFound("Order not found.");

    if (!orders.TERMINAL_PAID.includes(order.status)) {
      await orders.reconcile(req.merchantId, order);
    }
    const fresh = await orders.findById(req.merchantId, order.id);

    res.json({
      ...orders.toStatusView(fresh, { locale: req.session_.locale }),
      next_url: orders.TERMINAL_PAID.includes(fresh.status)
        ? withOrderParams(req.session_.success_url, fresh)
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Coupon
// ---------------------------------------------------------------------------

router.post("/c/:id/coupon", couponLimit, loadSession, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await sessions.applyCoupon(
      req.merchantId,
      req.session_,
      body.code,
      body.email
    );
    const session = result.session;
    const locale = session.locale;

    res.json({
      applied: result.ok && Boolean(session.coupon_code),
      reason: result.reason,
      coupon: session.coupon_code,
      subtotal_cents: session.subtotal_cents,
      discount_cents: session.discount_cents,
      total_cents: session.total_cents,
      subtotal_formatted: money.formatMoney(session.subtotal_cents, session.currency, locale),
      discount_formatted: money.formatMoney(session.discount_cents, session.currency, locale),
      total_formatted: money.formatMoney(session.total_cents, session.currency, locale),
      // The instalment options change with the total, so they come back with it.
      installment_options: Array.from(
        { length: money.maxInstallmentsFor(session.total_cents, 12) },
        (_, index) => {
          const n = index + 1;
          return {
            count: n,
            label: money.formatMoney(
              money.installmentAmount(session.total_cents, n),
              session.currency,
              locale
            ),
          };
        }
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Abandoned cart
//
// Called as soon as the buyer has typed a usable email, before they pay. That
// is the whole mechanism: without this call there is nobody to write to.
// ---------------------------------------------------------------------------

router.post("/c/:id/contact", couponLimit, loadSession, async (req, res, next) => {
  try {
    const body = req.body || {};
    await carts.remember(req.merchantId, req.session_, {
      email: body.email,
      name: body.name,
      phone: body.phone,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Errors on this router render a page, not JSON, when the browser asked for a
// page. A buyer who hits a dead link should read a sentence, not see a blob.
// ---------------------------------------------------------------------------
router.use((err, req, res, next) => {
  const wantsJson =
    req.method !== "GET" || String(req.get("accept") || "").includes("application/json");
  if (wantsJson) return next(err);

  const status = err instanceof ApiError ? err.status : 500;
  return res.status(status).render("error", {
    title: status === 404 ? "Link not found" : "Something went wrong",
    message:
      err instanceof ApiError
        ? err.message
        : "We could not open this checkout. Please try the link again.",
  });
});

module.exports = {
  router,
  loadSession,
  buildPageModel,
  frameAncestorsFor,
  allowFramingBy,
  withOrderParams,
};
