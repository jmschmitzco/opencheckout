// The post-purchase funnel: the one click upsell, and the downsell behind it.
//
//   GET  /u/:orderId?t=<checkout_token>   the offer
//   POST /u/:orderId/accept               charge it against the saved card
//   POST /u/:orderId/decline              say no, and move on
//
// AUTHENTICATION is the order's own checkout_token, the same one the waiting
// screen polls with. It grants this one order and nothing else, so there is no
// API key on a page the buyer can read, and a stranger with an order id alone
// cannot spend somebody else's card.
//
// THE PAGE IS REFRESHABLE. Every offer is answered exactly once, accepted or
// declined, and a second answer returns the first one's result rather than
// charging again. That is not a nicety: this is the screen people reload.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../db/merchant-context");
const db = require("../db");
const { isDemo } = require("../config");
const { safeEqual } = require("../lib/crypto");
const money = require("../lib/money");
const orders = require("../services/orders");
const offers = require("../services/offers");
const merchants = require("../services/merchants");
const themes = require("../services/themes");
const branding = require("../services/branding");
const { ApiError, notFound, conflict } = require("../lib/errors");

const router = express.Router();

const skipInDemo = () => isDemo();
const pageLimit = rateLimit({ windowMs: 60_000, max: 60, skip: skipInDemo, standardHeaders: true });
const actionLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  skip: skipInDemo,
  standardHeaders: true,
});

// Loads the order by its public id and its own token, and opens the merchant
// context. The order id alone is not enough, deliberately.
async function loadOrder(req, _res, next) {
  try {
    const publicId = String(req.params.orderId || "");
    if (!/^ord_[a-z0-9]{8,40}$/.test(publicId)) throw notFound("That link is not valid.");

    const result = await db.query(
      `select * from orders where public_id = $1`,
      [publicId],
      { withoutMerchant: "the funnel link carries only the order id; the merchant comes from it" }
    );
    const order = result.rows[0];
    if (!order) throw notFound("That link is not valid.");

    const token = String(req.query.t || req.get("x-order-token") || "");
    if (!token || !safeEqual(order.checkout_token, token)) {
      throw notFound("That link is not valid.");
    }

    req.order = order;
    req.merchantId = order.merchant_id;
    return ctx.withMerchant(order.merchant_id, async () => {
      req.merchant = await merchants.findById(order.merchant_id);
      if (!req.merchant || !req.merchant.active) throw notFound("That link is not valid.");
      return next();
    });
  } catch (err) {
    return next(err);
  }
}

// Where the buyer goes when the funnel has nothing more to offer.
async function finishUrl(merchantId, order) {
  const rootId = order.parent_order_id || order.id;
  const result = await db.query(
    `select s.success_url from checkout_sessions s
      join orders o on o.session_id = s.id and o.merchant_id = s.merchant_id
     where s.merchant_id = $1 and o.id = $2`,
    [merchantId, rootId]
  );
  const url = result.rows[0] && result.rows[0].success_url;
  if (!url) return null;
  try {
    const target = new URL(url);
    target.searchParams.set("order_id", order.public_id);
    target.searchParams.set("status", order.status);
    return target.toString();
  } catch {
    return url;
  }
}

// The URL of the next step, or the finish line. One function, and it takes no
// "what just happened": the step is deduced from what is recorded, so the
// page, the accept and the decline cannot disagree about where a buyer goes.
async function nextStepUrl(merchantId, merchant, order) {
  const offer = await offers.nextFunnelStep(merchantId, order);
  if (!offer) return { done: true, url: await finishUrl(merchantId, order) };

  const root = order.parent_order_id
    ? await orders.findById(merchantId, order.parent_order_id)
    : order;
  return {
    done: false,
    offer,
    url: `/u/${root.public_id}?t=${encodeURIComponent(root.checkout_token)}`,
  };
}

router.get("/u/:orderId", pageLimit, loadOrder, async (req, res, next) => {
  try {
    const step = await nextStepUrl(req.merchantId, req.merchant, req.order);
    if (step.done) {
      return step.url
        ? res.redirect(step.url)
        : res.render("error", {
            title: "All done",
            message: "Your purchase is complete.",
          });
    }

    const theme = await themes.resolveFor({
      merchant: req.merchant,
      productId: step.offer.product_id,
    });
    const locale = "pt-BR";

    // Never framed: this page spends money with one click, which is precisely
    // what clickjacking is for.
    res.set("X-Frame-Options", "DENY");

    return res.render("upsell", {
      merchant: req.merchant,
      theme,
      themeStyle: branding.themeStyleAttribute(theme),
      webfontHref: branding.webfontHref(theme),
      copy: branding.copyFor(theme, { locale }),
      locale,
      order: req.order,
      offer: offers.toView(step.offer, { locale }),
      card: {
        brand: req.order.card_brand,
        last4: req.order.card_last4,
      },
      publicConfig: {
        orderId: req.order.public_id,
        token: req.order.checkout_token,
        offerId: step.offer.public_id,
        locale,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/u/:orderId/accept", actionLimit, loadOrder, async (req, res, next) => {
  try {
    const step = await nextStepUrl(req.merchantId, req.merchant, req.order);
    if (step.done) {
      return res.json({ accepted: false, done: true, next_url: step.url });
    }
    // The page says which offer it is showing, and it has to be the one the
    // server would show. Without that check a stale tab could buy an offer the
    // funnel has already moved past.
    if (String(req.body && req.body.offer) !== step.offer.public_id) {
      throw conflict("That offer is no longer the current one.");
    }

    const child = await orders.acceptOffer({
      merchant: req.merchant,
      parentOrder: req.order,
      offer: step.offer,
      remoteIp: req.ip,
    });

    const after = await nextStepUrl(req.merchantId, req.merchant, req.order);
    return res.json({
      accepted: child.status === "paid",
      status: child.status,
      order_id: child.public_id,
      amount_formatted: money.formatMoney(child.amount_cents, child.currency, "pt-BR"),
      message:
        child.status === "paid"
          ? null
          : child.refusal_reason || "The card was declined for the extra item.",
      done: after.done,
      next_url: after.url,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/u/:orderId/decline", actionLimit, loadOrder, async (req, res, next) => {
  try {
    const step = await nextStepUrl(req.merchantId, req.merchant, req.order);
    if (step.done) return res.json({ done: true, next_url: step.url });

    await orders.declineOffer({
      merchant: req.merchant,
      parentOrder: req.order,
      offer: step.offer,
    });

    // A decline on an upsell is what a downsell is for. On a downsell, it is
    // the end.
    const after = await nextStepUrl(req.merchantId, req.merchant, req.order);
    return res.json({ done: after.done, next_url: after.url });
  } catch (err) {
    return next(err);
  }
});

// A buyer who hits a dead funnel link reads a sentence, not a blob.
router.use((err, req, res, next) => {
  const wantsJson =
    req.method !== "GET" || String(req.get("accept") || "").includes("application/json");
  if (wantsJson) return next(err);

  const status = err instanceof ApiError ? err.status : 500;
  return res.status(status).render("error", {
    title: status === 404 ? "Link not found" : "Something went wrong",
    message:
      err instanceof ApiError ? err.message : "We could not open this page. Your purchase is safe.",
  });
});

module.exports = { router, loadOrder, nextStepUrl, finishUrl };
