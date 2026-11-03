// The customer portal pages.
//
//   GET  /portal/:token   consumes the link and redirects to /portal
//   GET  /portal          the page, read from the cookie
//   POST /portal/cancel   cancels a subscription
//   POST /portal/resume   undoes a cancellation
//
// The token in the link is exchanged for a cookie on first use, and then the
// link is dead. That way the credential stops travelling in the URL after one
// hop, so it never reaches a referrer header, a server log on the integrator's
// side, or a screenshot the customer sends to support.
const express = require("express");
const rateLimit = require("express-rate-limit");
const ctx = require("../db/merchant-context");
const { isDemo } = require("../config");
const portal = require("../services/portal");
const merchants = require("../services/merchants");
const themes = require("../services/themes");
const branding = require("../services/branding");
const subscriptions = require("../services/subscriptions");
const money = require("../lib/money");

const router = express.Router();

const limit = rateLimit({ windowMs: 60_000, max: 60, skip: () => isDemo(), standardHeaders: true });

// The cookie that holds the portal session. httpOnly so no script can read
// it, sameSite lax so it survives the redirect in from the integrator's app,
// and secure outside development.
function setPortalCookie(req, res, session) {
  req.session.portal = {
    merchantId: session.merchantId,
    customerId: session.customerId,
    returnUrl: session.returnUrl,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function readPortalCookie(req) {
  const data = req.session && req.session.portal;
  if (!data) return null;
  if (!data.expiresAt || new Date(data.expiresAt) <= new Date()) return null;
  return data;
}

router.get("/portal/:token", limit, async (req, res, next) => {
  try {
    const session = await portal.consume(req.params.token);
    if (!session) {
      return res.status(410).render("error", {
        title: "This link has expired",
        message: "Portal links are single use and short lived. Ask for a new one.",
      });
    }
    setPortalCookie(req, res, session);
    // Redirect so the token leaves the address bar immediately.
    return res.redirect("/portal");
  } catch (err) {
    return next(err);
  }
});

async function renderPortal(req, res, next) {
  try {
    const data = readPortalCookie(req);
    if (!data) {
      return res.status(401).render("error", {
        title: "Session expired",
        message: "Your portal session has ended. Open a new link to continue.",
      });
    }

    return ctx.withMerchant(data.merchantId, async () => {
      const merchant = await merchants.findById(data.merchantId);
      const theme = await themes.resolveFor({ merchant });
      const overview = await portal.overview(data.merchantId, data.customerId);

      return res.render("portal", {
        merchant,
        theme,
        themeStyle: branding.themeStyleAttribute(theme),
        webfontHref: branding.webfontHref(theme),
        copy: branding.copyFor(theme, { locale: "pt-BR" }),
        overview,
        returnUrl: data.returnUrl,
        format: (cents, currency) => money.formatMoney(cents, currency),
      });
    });
  } catch (err) {
    return next(err);
  }
}

router.get("/portal", limit, renderPortal);

router.post("/portal/cancel", limit, async (req, res, next) => {
  try {
    const data = readPortalCookie(req);
    if (!data) return res.status(401).json({ error: { message: "Session expired." } });

    return ctx.withMerchant(data.merchantId, async () => {
      const id = String((req.body && req.body.subscription) || "");
      const subscription = await subscriptions.findByPublicId(data.merchantId, id);
      // The cookie says who this is, and the subscription has to belong to
      // them. Without this check, a valid portal session could cancel anybody's
      // subscription by id.
      if (!subscription || subscription.customer_id !== data.customerId) {
        return res.status(404).json({ error: { message: "Subscription not found." } });
      }
      const updated = await subscriptions.cancel(data.merchantId, id, { atPeriodEnd: true });
      return res.json(subscriptions.toApi(updated));
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/portal/resume", limit, async (req, res, next) => {
  try {
    const data = readPortalCookie(req);
    if (!data) return res.status(401).json({ error: { message: "Session expired." } });

    return ctx.withMerchant(data.merchantId, async () => {
      const id = String((req.body && req.body.subscription) || "");
      const subscription = await subscriptions.findByPublicId(data.merchantId, id);
      if (!subscription || subscription.customer_id !== data.customerId) {
        return res.status(404).json({ error: { message: "Subscription not found." } });
      }
      const updated = await subscriptions.resume(data.merchantId, id);
      return res.json(subscriptions.toApi(updated));
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
