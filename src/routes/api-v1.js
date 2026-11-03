// The public API, version 1. Mounted at /v1.
//
// Authentication: Authorization: Bearer sk_live_... or sk_test_...
// The key resolves the merchant, and the router opens that merchant's context,
// so from here on every query sees only their data. It is the same guard the
// dashboard uses.
//
// The shape follows what an integrator already expects: JSON, money in CENTS,
// dates in ISO-8601, lists with `has_more` and a cursor, errors as
// { error: { code, message, fields? } }.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../db/merchant-context");
const apiKeys = require("../services/api-keys");
const merchants = require("../services/merchants");
const catalog = require("../services/catalog");
const customers = require("../services/customers");
const coupons = require("../services/coupons");
const sessions = require("../services/checkout-sessions");
const orders = require("../services/orders");
const subscriptions = require("../services/subscriptions");
const events = require("../services/events");
const webhooksOut = require("../services/webhooks-out");
const gatewayConfig = require("../services/gateway-config");
const themes = require("../services/themes");
const idempotency = require("../services/idempotency");
const { isDemo } = require("../config");
const { unauthorized, forbidden, notFound, badRequest } = require("../lib/errors");

const router = express.Router();

// A per-key limit on top of the per-IP one every /v1 route already has, so one
// runaway integration cannot starve the others.
const perKeyLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDemo(),
  keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.keyId}` : req.ip),
});

// Bearer key to merchant context.
router.use(async (req, res, next) => {
  try {
    const header = String(req.get("authorization") || "");
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!key) {
      throw unauthorized("Send your key as Authorization: Bearer sk_live_... or sk_test_...");
    }
    const resolved = await ctx.withoutMerchant("validating the API key is what discovers the merchant", () =>
      apiKeys.resolve(key)
    );
    if (!resolved) throw unauthorized("That API key is not valid.");

    req.apiKey = resolved;
    req.merchantId = resolved.merchantId;
    req.livemode = resolved.livemode;
    return ctx.withMerchant(resolved.merchantId, () => next());
  } catch (err) {
    return next(err);
  }
});

router.use(perKeyLimit);

// A publishable key is meant to sit in a browser, so it may only do the two
// things a browser needs: read the session it already holds, and nothing else.
function secretKeyOnly(req, _res, next) {
  if (req.apiKey.kind !== "secret") {
    return next(forbidden("This endpoint needs a secret key (sk_...), not a publishable one."));
  }
  return next();
}

function listEnvelope(rows, mapper, { limit }) {
  // `has_more` is derived by asking for one more row than requested, so a
  // caller paginating never has to guess whether the last page was full.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    object: "list",
    data: page.map(mapper),
    has_more: hasMore,
    next_cursor: hasMore && page.length ? mapper(page[page.length - 1]).id : null,
  };
}

function limitOf(req, fallback = 25) {
  const n = parseInt(req.query.limit, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

// ---------------------------------------------------------------------------
// Who am I. The smoke test of every new integration.
// ---------------------------------------------------------------------------
router.get("/me", async (req, res, next) => {
  try {
    const merchant = await merchants.current();
    const methods = await gatewayConfig.availableMethods({
      merchantId: req.merchantId,
      livemode: req.livemode,
    });
    res.json({
      object: "merchant",
      id: merchant.public_id,
      name: merchant.name,
      livemode: req.livemode,
      key: { id: req.apiKey.keyId, kind: req.apiKey.kind, label: req.apiKey.label },
      payment_methods: methods,
      demo_mode: isDemo(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Checkout sessions. The endpoint that matters.
// ---------------------------------------------------------------------------

router.post(
  "/checkout/sessions",
  secretKeyOnly,
  idempotency.middleware("checkout_session"),
  async (req, res, next) => {
    try {
      const session = await sessions.create(req.merchantId, req.body || {}, { livemode: req.livemode });
      const body = sessions.toApi(session, { includeSecret: true });

      const event = await events.record(
        req.merchantId,
        "checkout.session.created",
        { session: sessions.toApi(session) },
        { livemode: req.livemode }
      );
      await webhooksOut.enqueue(req.merchantId, event);

      if (req.idempotency) await req.idempotency.complete(201, body);
      res.status(201).json(body);
    } catch (err) {
      // A rejected request must leave the key reusable: the caller fixes the
      // payload and retries with the same key.
      if (req.idempotency) await req.idempotency.release().catch(() => {});
      next(err);
    }
  }
);

router.get("/checkout/sessions/:id", async (req, res, next) => {
  try {
    const session = await sessions.findByPublicId(req.merchantId, req.params.id);
    if (!session) throw notFound("Session not found.");
    res.json(sessions.toApi(session));
  } catch (err) {
    next(err);
  }
});

router.post("/checkout/sessions/:id/cancel", secretKeyOnly, async (req, res, next) => {
  try {
    const session = await sessions.cancel(req.merchantId, req.params.id);
    res.json(sessions.toApi(session));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

router.get("/orders", secretKeyOnly, async (req, res, next) => {
  try {
    const limit = limitOf(req);
    const rows = await orders.list(req.merchantId, {
      status: req.query.status || null,
      before: req.query.cursor || null,
      limit: limit + 1,
    });
    res.json(listEnvelope(rows, (row) => orders.toApi(row), { limit }));
  } catch (err) {
    next(err);
  }
});

router.get("/orders/:id", secretKeyOnly, async (req, res, next) => {
  try {
    const order = await orders.findByPublicId(req.merchantId, req.params.id);
    if (!order) throw notFound("Order not found.");
    const [items, customer] = await Promise.all([
      orders.itemsOf(req.merchantId, order.id),
      order.customer_id ? customers.findById(req.merchantId, order.customer_id) : null,
    ]);
    res.json(orders.toApi(order, { items, customer }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Customers and entitlements
//
// The entitlement endpoint is the one a SaaS calls on login. It answers the
// only question that matters to them: may this user in?
// ---------------------------------------------------------------------------

router.post("/customers", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const customer = await customers.upsert(req.merchantId, {
      email: body.email,
      name: body.name,
      document: body.document,
      phone: body.phone,
      externalId: body.external_id,
      metadata: body.metadata,
    });
    res.status(201).json(customers.toApi(customer));
  } catch (err) {
    next(err);
  }
});

router.get("/customers/:id", secretKeyOnly, async (req, res, next) => {
  try {
    const customer = await customers.findByPublicId(req.merchantId, req.params.id);
    if (!customer) throw notFound("Customer not found.");
    res.json(customers.toApi(customer));
  } catch (err) {
    next(err);
  }
});

router.get("/entitlements", secretKeyOnly, async (req, res, next) => {
  try {
    const customer = await customers.resolve(req.merchantId, {
      customer: req.query.customer,
      email: req.query.email,
      externalId: req.query.external_id,
    });
    if (!customer) {
      // Not found is a legitimate answer to "is this user paid?", and it is
      // "no". A 404 would make every integrator write an exception branch for
      // the most common case there is.
      return res.json({ object: "entitlements", customer: null, active: false, items: [] });
    }
    const entitlements = await subscriptions.entitlementsFor(req.merchantId, customer.id);
    res.json({
      object: "entitlements",
      customer: customers.toApi(customer),
      active: entitlements.active,
      items: entitlements.items,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

router.get("/subscriptions", secretKeyOnly, async (req, res, next) => {
  try {
    const limit = limitOf(req);
    const rows = await subscriptions.list(req.merchantId, {
      status: req.query.status || null,
      limit: limit + 1,
    });
    res.json(listEnvelope(rows, (row) => subscriptions.toApi(row), { limit }));
  } catch (err) {
    next(err);
  }
});

router.get("/subscriptions/:id", secretKeyOnly, async (req, res, next) => {
  try {
    const row = await subscriptions.findByPublicId(req.merchantId, req.params.id);
    if (!row) throw notFound("Subscription not found.");
    res.json(subscriptions.toApi(row));
  } catch (err) {
    next(err);
  }
});

router.post("/subscriptions/:id/cancel", secretKeyOnly, async (req, res, next) => {
  try {
    const row = await subscriptions.cancel(req.merchantId, req.params.id, {
      // Cancelling at the end of the period is the default, because the
      // customer paid for the period they are in. Immediate cancellation has
      // to be asked for.
      atPeriodEnd: req.body && req.body.at_period_end === false ? false : true,
    });
    res.json(subscriptions.toApi(row));
  } catch (err) {
    next(err);
  }
});

router.post("/subscriptions/:id/resume", secretKeyOnly, async (req, res, next) => {
  try {
    const row = await subscriptions.resume(req.merchantId, req.params.id);
    res.json(subscriptions.toApi(row));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Customer portal
// ---------------------------------------------------------------------------

router.post("/portal/sessions", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const customer = await customers.resolve(req.merchantId, {
      customer: body.customer,
      email: body.customer_email,
      externalId: body.customer_external_id,
    });
    if (!customer) throw notFound("No such customer.");
    const portal = require("../services/portal");
    const session = await portal.createSession(req.merchantId, customer.id, {
      returnUrl: body.return_url,
    });
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

router.get("/products", secretKeyOnly, async (req, res, next) => {
  try {
    const limit = limitOf(req, 50);
    const rows = await catalog.listProducts(req.merchantId, { limit: limit + 1 });
    res.json(listEnvelope(rows, catalog.productToApi, { limit }));
  } catch (err) {
    next(err);
  }
});

router.post("/products", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const product = await catalog.createProduct(req.merchantId, {
      name: body.name,
      description: body.description,
      imageUrl: body.image_url,
      metadata: body.metadata,
    });
    res.status(201).json(catalog.productToApi(product));
  } catch (err) {
    next(err);
  }
});

router.get("/products/:id", secretKeyOnly, async (req, res, next) => {
  try {
    const product = await catalog.findProduct(req.merchantId, req.params.id);
    if (!product) throw notFound("Product not found.");
    res.json(catalog.productToApi(product));
  } catch (err) {
    next(err);
  }
});

router.patch("/products/:id", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    if ("name" in body) patch.name = body.name;
    if ("description" in body) patch.description = body.description;
    if ("image_url" in body) patch.imageUrl = body.image_url;
    if ("metadata" in body) patch.metadata = body.metadata;
    if ("active" in body) patch.active = body.active;
    const product = await catalog.updateProduct(req.merchantId, req.params.id, patch);
    res.json(catalog.productToApi(product));
  } catch (err) {
    next(err);
  }
});

router.get("/prices", secretKeyOnly, async (req, res, next) => {
  try {
    const limit = limitOf(req, 50);
    const rows = await catalog.listPrices(req.merchantId, {
      productPublicId: req.query.product || null,
      activeOnly: req.query.active !== "false",
    });
    res.json(listEnvelope(rows, catalog.priceToApi, { limit }));
  } catch (err) {
    next(err);
  }
});

router.post("/prices", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.product) throw badRequest("product is required.", { product: "Required." });
    const price = await catalog.createPrice(req.merchantId, body.product, {
      currency: body.currency,
      unitAmountCents: body.unit_amount_cents,
      compareAtCents: body.compare_at_cents,
      type: body.type,
      interval: body.interval,
      intervalCount: body.interval_count,
      trialDays: body.trial_days,
      maxInstallments: body.max_installments,
    });
    res.status(201).json(catalog.priceToApi(price));
  } catch (err) {
    next(err);
  }
});

router.delete("/prices/:id", secretKeyOnly, async (req, res, next) => {
  try {
    const price = await catalog.deactivatePrice(req.merchantId, req.params.id);
    res.json(catalog.priceToApi(price));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

router.get("/coupons", secretKeyOnly, async (req, res, next) => {
  try {
    const rows = await coupons.list(req.merchantId);
    res.json({ object: "list", data: rows.map(coupons.toApi), has_more: false });
  } catch (err) {
    next(err);
  }
});

router.post("/coupons", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const coupon = await coupons.create(req.merchantId, {
      code: body.code,
      kind: body.kind,
      value: body.value,
      currency: body.currency,
      maxRedemptions: body.max_redemptions,
      oncePerEmail: body.once_per_email,
      expiresAt: body.expires_at,
    });
    res.status(201).json(coupons.toApi(coupon));
  } catch (err) {
    next(err);
  }
});

router.delete("/coupons/:code", secretKeyOnly, async (req, res, next) => {
  try {
    const coupon = await coupons.deactivate(req.merchantId, req.params.code);
    res.json(coupons.toApi(coupon));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

router.get("/branding", secretKeyOnly, async (req, res, next) => {
  try {
    const merchant = await merchants.current();
    const theme = await themes.resolveFor({ merchant });
    res.json({
      object: "branding",
      theme,
      presets: Object.entries(themes.PRESETS).map(([id, preset]) => ({ id, name: preset.name })),
      // Handing back the editable surface means an integrator can build their
      // own theme editor without reading our source.
      editable: {
        templates: require("../services/branding").TEMPLATES,
        fonts: Object.keys(require("../services/branding").FONTS),
        buyer_fields: require("../services/branding").BUYER_FIELDS,
        payment_methods: require("../services/branding").PAYMENT_METHODS,
        text_limits: require("../services/branding").TEXT_LIMITS,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put("/branding", secretKeyOnly, async (req, res, next) => {
  try {
    const merchant = await merchants.current();
    const body = req.body || {};
    const tokens = body.preset && themes.PRESETS[body.preset]
      ? { ...themes.PRESETS[body.preset].tokens, ...(body.theme || {}) }
      : body.theme || body;
    await themes.save(req.merchantId, {
      scope: body.scope || "merchant",
      productId: body.product_id,
      tokens,
      allowCustomCss: Boolean(merchant.allow_custom_css),
    });
    const theme = await themes.resolveFor({ merchant });
    res.json({ object: "branding", theme });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Events and webhook endpoints
// ---------------------------------------------------------------------------

router.get("/events", secretKeyOnly, async (req, res, next) => {
  try {
    const limit = limitOf(req);
    const rows = await events.list(req.merchantId, {
      type: req.query.type || null,
      before: req.query.cursor || null,
      limit,
    });
    res.json({ object: "list", data: rows, has_more: rows.length === limit });
  } catch (err) {
    next(err);
  }
});

router.get("/webhook-endpoints", secretKeyOnly, async (req, res, next) => {
  try {
    const rows = await webhooksOut.listEndpoints(req.merchantId);
    res.json({
      object: "list",
      data: rows.map((row) => ({
        id: row.public_id,
        object: "webhook_endpoint",
        url: row.url,
        events: String(row.events || "").split(",").filter(Boolean),
        livemode: row.livemode,
        active: row.active,
        failures: row.failures,
        disabled_at: row.disabled_at,
        created_at: row.created_at,
      })),
      has_more: false,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/webhook-endpoints", secretKeyOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const endpoint = await webhooksOut.createEndpoint(req.merchantId, {
      url: body.url,
      events: body.events,
      livemode: req.livemode,
    });
    res.status(201).json({
      id: endpoint.public_id,
      object: "webhook_endpoint",
      url: endpoint.url,
      events: String(endpoint.events || "").split(",").filter(Boolean),
      livemode: endpoint.livemode,
      active: endpoint.active,
      // Shown once. We keep only an encrypted copy, because we need it to
      // sign; the integrator needs it to verify.
      secret: endpoint.secret,
      created_at: endpoint.created_at,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/webhook-endpoints/:id", secretKeyOnly, async (req, res, next) => {
  try {
    await webhooksOut.deleteEndpoint(req.merchantId, req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.get("/event-types", async (_req, res) => {
  res.json({ object: "list", data: events.EVENT_TYPES, groups: events.EVENT_GROUPS });
});

module.exports = router;
