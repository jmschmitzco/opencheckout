// What is for sale: products and their prices, the funnel offers, and coupons.
const express = require("express");
const db = require("../../db");
const catalog = require("../../services/catalog");
const offers = require("../../services/offers");
const coupons = require("../../services/coupons");
const sessions = require("../../services/checkout-sessions");
const money = require("../../lib/money");
const { config } = require("../../config");
const { badRequest } = require("../../lib/errors");
const { withMerchant, formPost, formatDate } = require("./_shared");

const router = express.Router();

// A price typed by a person, turned into cents.
//
// The form takes "97,00" or "97.00" or "1.234,56", because that is what people
// type, and a form that demands cents gets a product priced at ninety seven
// cents sooner or later.
function amountFromForm(value, currency) {
  const cents = money.parseAmountToCents(value, currency);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw badRequest("Enter a price, like 97,00.", { amount: "Invalid." });
  }
  return cents;
}

// ---------------------------------------------------------------------------
// Products and prices
// ---------------------------------------------------------------------------

router.get(
  "/products",
  withMerchant(async (req, res) => {
    const products = await catalog.listProducts(req.merchantId, { limit: 200 });
    const prices = await catalog.listPrices(req.merchantId, { activeOnly: false });

    const byProduct = new Map();
    for (const price of prices) {
      if (!byProduct.has(price.product_public_id)) byProduct.set(price.product_public_id, []);
      byProduct.get(price.product_public_id).push(price);
    }

    res.render("dashboard/products", {
      title: "Products",
      products: products.map((product) => ({
        ...product,
        prices: byProduct.get(product.public_id) || [],
      })),
      currencies: Object.keys(money.CURRENCIES),
      fmt: (cents, currency) => money.formatMoney(cents, currency),
      formatDate,
    });
  })
);

router.post(
  "/products",
  formPost(async (req, res) => {
    const body = req.body || {};
    const product = await catalog.createProduct(req.merchantId, {
      name: body.name,
      description: body.description,
      imageUrl: body.image_url,
    });

    // A product with no price cannot be sold, so the form asks for both and
    // the first price is created here. Splitting them across two screens is
    // how catalogues end up full of things nobody can buy.
    if (body.amount) {
      await catalog.createPrice(req.merchantId, product.public_id, {
        currency: body.currency,
        unitAmountCents: amountFromForm(body.amount, body.currency),
        compareAtCents: body.compare_at ? amountFromForm(body.compare_at, body.currency) : null,
        type: body.type === "recurring" ? "recurring" : "one_time",
        interval: body.interval,
        trialDays: body.trial_days,
        maxInstallments: body.max_installments,
      });
    }

    res.flash("ok", `${product.name} is ready to sell.`);
    res.redirect("/dashboard/products");
  })
);

router.post(
  "/products/:id/prices",
  formPost(async (req, res) => {
    const body = req.body || {};
    await catalog.createPrice(req.merchantId, req.params.id, {
      currency: body.currency,
      unitAmountCents: amountFromForm(body.amount, body.currency),
      compareAtCents: body.compare_at ? amountFromForm(body.compare_at, body.currency) : null,
      type: body.type === "recurring" ? "recurring" : "one_time",
      interval: body.interval,
      trialDays: body.trial_days,
      maxInstallments: body.max_installments,
    });
    res.flash("ok", "Price added.");
    res.redirect("/dashboard/products");
  })
);

router.post(
  "/prices/:id/archive",
  formPost(async (req, res) => {
    // Deactivated, never deleted: an order points at this row, and a receipt
    // that cannot name what was bought is worse than a stale row.
    await catalog.deactivatePrice(req.merchantId, req.params.id);
    res.flash("ok", "That price is no longer offered. Existing orders keep it.");
    res.redirect("/dashboard/products");
  })
);

router.post(
  "/products/:id/archive",
  formPost(async (req, res) => {
    await catalog.updateProduct(req.merchantId, req.params.id, { active: false });
    res.flash("ok", "Archived.");
    res.redirect("/dashboard/products");
  })
);

// A link that sells one price, with no code on the merchant's side.
//
// It creates a real session, which means it expires. That is the honest
// behaviour and it is worth saying on the page: a link that lives forever
// would be a price somebody could sit on for a year.
router.post(
  "/prices/:id/link",
  formPost(async (req, res) => {
    const price = await catalog.findPrice(req.merchantId, req.params.id);
    if (!price) throw badRequest("That price does not exist.");

    const session = await sessions.create(
      req.merchantId,
      {
        mode: price.type === "recurring" ? "subscription" : "payment",
        line_items: [{ price: price.public_id, quantity: 1 }],
        success_url: `${config.baseUrl}/dashboard/paid`,
        expires_in_minutes: 60 * 24,
      },
      { livemode: false }
    );

    res.flash("ok", `Test link, good for 24 hours: ${sessions.url(session)}`);
    res.redirect("/dashboard/products");
  })
);

// Where a test link lands. It belongs to nobody and says so.
router.get("/paid", (req, res) => {
  res.render("dashboard/message", {
    title: "That went through",
    message:
      "This is where your success_url would be. A real integration sends the buyer to its own page, and finds out for certain from the webhook.",
    backTo: "/dashboard/orders",
  });
});

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

router.get(
  "/offers",
  withMerchant(async (req, res) => {
    const [rows, products, prices] = await Promise.all([
      offers.list(req.merchantId),
      catalog.listProducts(req.merchantId, { activeOnly: true, limit: 200 }),
      catalog.listPrices(req.merchantId, { activeOnly: true }),
    ]);

    res.render("dashboard/offers", {
      title: "Offers",
      rows,
      products,
      // Only one time prices can be an offer: a one click button that starts a
      // subscription, with no second confirmation, is a chargeback waiting to
      // be written.
      prices: prices.filter((price) => price.type === "one_time"),
      kinds: offers.KINDS,
      fmt: (cents, currency) => money.formatMoney(cents, currency),
    });
  })
);

router.post(
  "/offers",
  formPost(async (req, res) => {
    const body = req.body || {};
    await offers.create(req.merchantId, {
      kind: body.kind,
      trigger_product: body.trigger_product,
      price: body.price,
      title: body.title,
      description: body.description,
      image_url: body.image_url,
      sort: body.sort,
    });
    res.flash("ok", "Offer added.");
    res.redirect("/dashboard/offers");
  })
);

router.post(
  "/offers/:id/archive",
  formPost(async (req, res) => {
    await offers.deactivate(req.merchantId, req.params.id);
    res.flash("ok", "That offer is no longer shown.");
    res.redirect("/dashboard/offers");
  })
);

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

router.get(
  "/coupons",
  withMerchant(async (req, res) => {
    const rows = await coupons.list(req.merchantId);
    res.render("dashboard/coupons", {
      title: "Coupons",
      rows,
      currencies: Object.keys(money.CURRENCIES),
      fmt: (cents, currency) => money.formatMoney(cents, currency),
      formatDate,
    });
  })
);

router.post(
  "/coupons",
  formPost(async (req, res) => {
    const body = req.body || {};
    const kind = body.kind === "amount" ? "amount" : "percent";
    await coupons.create(req.merchantId, {
      code: body.code,
      kind,
      value:
        kind === "amount" ? amountFromForm(body.value, body.currency) : parseInt(body.value, 10),
      currency: body.currency,
      maxRedemptions: body.max_redemptions || null,
      oncePerEmail: Boolean(body.once_per_email),
      expiresAt: body.expires_at || null,
    });
    res.flash("ok", "Coupon created.");
    res.redirect("/dashboard/coupons");
  })
);

router.post(
  "/coupons/:code/archive",
  formPost(async (req, res) => {
    await coupons.deactivate(req.merchantId, req.params.code);
    res.flash("ok", "That code no longer works.");
    res.redirect("/dashboard/coupons");
  })
);

module.exports = router;
