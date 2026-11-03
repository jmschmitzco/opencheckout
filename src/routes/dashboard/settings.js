// Settings: the gateway keys, the look of the checkout, the API keys, the
// webhooks, and the account itself.
const express = require("express");
const db = require("../../db");
const { config } = require("../../config");
const gatewayConfig = require("../../services/gateway-config");
const { capabilitiesOf, GATEWAYS } = require("../../gateways");
const themes = require("../../services/themes");
const branding = require("../../services/branding");
const apiKeys = require("../../services/api-keys");
const webhooksOut = require("../../services/webhooks-out");
const merchants = require("../../services/merchants");
const merchantUsers = require("../../services/merchant-users");
const catalog = require("../../services/catalog");
const sessions = require("../../services/checkout-sessions");
const events = require("../../services/events");
const money = require("../../lib/money");
const { badRequest } = require("../../lib/errors");
const { withMerchant, formPost, formatDate } = require("./_shared");

const router = express.Router();

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

router.get(
  "/settings/gateways",
  withMerchant(async (req, res) => {
    const [live, test] = await Promise.all([
      gatewayConfig.listConfigured({ merchantId: req.merchantId, livemode: true }),
      gatewayConfig.listConfigured({ merchantId: req.merchantId, livemode: false }),
    ]);

    const configured = new Map();
    for (const row of [...live, ...test]) {
      configured.set(`${row.gateway}:${row.livemode ? "live" : "test"}`, row);
    }

    res.render("dashboard/gateways", {
      title: "Gateways",
      gateways: GATEWAYS.map((name) => ({
        name,
        capabilities: capabilitiesOf(name),
        shape: gatewayConfig.SHAPES[name],
        hasSandbox: gatewayConfig.HAS_SANDBOX.includes(name),
        live: configured.get(`${name}:live`) || null,
        test: configured.get(`${name}:test`) || null,
      })),
      formatDate,
    });
  })
);

router.post(
  "/settings/gateways",
  formPost(async (req, res) => {
    const body = req.body || {};
    const gateway = String(body.gateway || "");
    const shape = gatewayConfig.SHAPES[gateway];
    if (!shape) throw badRequest("Unknown gateway.");

    const livemode = String(body.mode || "test") === "live";
    const credentials = {};
    for (const field of [...shape.required, ...(shape.verification || []), "publicKey", "clientId"]) {
      if (body[field] !== undefined && String(body[field]).trim()) {
        credentials[field] = String(body[field]).trim();
      }
    }
    if (body.environment) credentials.environment = String(body.environment);

    const saved = await gatewayConfig.save({
      merchantId: req.merchantId,
      gateway,
      livemode,
      credentials,
    });

    // Saying what is still missing beats refusing the save. The gateway
    // dashboards are filled in in this order too: keys first, webhook second,
    // and refusing the first half would mean nobody could do the second.
    if (saved.missingVerification && saved.missingVerification.length) {
      res.flash(
        "warn",
        `Saved. Without ${saved.missingVerification.join(" and ")}, every notification ${gateway} ` +
          `sends will be discarded unverified, so a paid order would never confirm. Add it, and set ` +
          `the callback URL below in the ${gateway} dashboard.`
      );
    } else {
      res.flash("ok", `${gateway} saved. Set the callback URL below in their dashboard.`);
    }
    res.redirect("/dashboard/settings/gateways");
  })
);

router.post(
  "/settings/gateways/disable",
  formPost(async (req, res) => {
    const body = req.body || {};
    await gatewayConfig.deactivate({
      merchantId: req.merchantId,
      gateway: String(body.gateway || ""),
      livemode: String(body.mode || "test") === "live",
    });
    res.flash("ok", "Turned off. Nothing new will be charged through it.");
    res.redirect("/dashboard/settings/gateways");
  })
);

// ---------------------------------------------------------------------------
// Branding
//
// The page that sells this project. It writes the theme and shows a REAL
// checkout beside the form, because a colour picker with a drawing of a
// checkout next to it is a promise, and a live one is the thing itself.
// ---------------------------------------------------------------------------

async function previewSession(merchantId) {
  // Reuses the merchant's own first product when there is one, so the preview
  // shows their words rather than a stranger's.
  //
  // The OLDEST price, not the newest: prices come back newest first, and the
  // newest is usually the add-on somebody created a minute ago, not the thing
  // they actually sell.
  const prices = await catalog.listPrices(merchantId, { activeOnly: true });
  const usable = prices
    .filter((price) => price.type === "one_time" && price.unit_amount_cents > 0)
    .pop();

  const lineItems = usable
    ? [{ price: usable.public_id, quantity: 1 }]
    : [{ name: "Your product", amount_cents: 9900, currency: "BRL" }];

  return sessions.create(
    merchantId,
    {
      mode: "payment",
      line_items: lineItems,
      success_url: `${config.baseUrl}/dashboard/settings/branding`,
      expires_in_minutes: 30,
      // The preview must never take money, so it asks for the least it can and
      // lives for half an hour.
      allow_coupon: false,
    },
    { livemode: false }
  );
}

router.get(
  "/settings/branding",
  withMerchant(async (req, res) => {
    const theme = await themes.resolveFor({ merchant: req.merchant });
    const preview = await previewSession(req.merchantId);

    res.render("dashboard/branding", {
      title: "Branding",
      theme,
      presets: themes.PRESETS,
      fonts: Object.keys(branding.FONTS),
      templates: branding.TEMPLATES,
      schemes: branding.COLOR_SCHEMES,
      limits: branding.TEXT_LIMITS,
      buyerFields: branding.BUYER_FIELDS,
      previewUrl: `/c/${preview.public_id}/embed?k=${preview.client_secret}&preview=1`,
      allowCustomCss: Boolean(req.merchant.allow_custom_css),
    });
  })
);

router.post(
  "/settings/branding",
  formPost(async (req, res) => {
    const body = req.body || {};

    if (body.preset && themes.PRESETS[body.preset]) {
      await themes.save(req.merchantId, {
        scope: "merchant",
        tokens: themes.PRESETS[body.preset].tokens,
        allowCustomCss: Boolean(req.merchant.allow_custom_css),
      });
      res.flash("ok", `${themes.PRESETS[body.preset].name} applied. Adjust anything below.`);
      return res.redirect("/dashboard/settings/branding");
    }

    // Checkboxes that are off send nothing at all, so every toggle is read as
    // present-or-absent rather than trusting the body to carry a false.
    const toggles = [
      "powered_by",
      "show_coupon",
      "show_order_summary",
      "show_secure_badge",
      "show_installments",
    ];
    const tokens = {};
    for (const field of Object.keys(branding.DEFAULTS)) {
      if (toggles.includes(field)) {
        tokens[field] = Boolean(body[field]);
      } else if (body[field] !== undefined) {
        tokens[field] = body[field] === "" ? null : body[field];
      }
    }

    await themes.save(req.merchantId, {
      scope: "merchant",
      tokens,
      allowCustomCss: Boolean(req.merchant.allow_custom_css),
    });
    res.flash("ok", "Saved. The preview on the right is live.");
    res.redirect("/dashboard/settings/branding");
  })
);

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

router.get(
  "/settings/keys",
  withMerchant(async (req, res) => {
    const keys = await apiKeys.list(req.merchantId);
    res.render("dashboard/keys", {
      title: "API keys",
      keys,
      // Shown once, straight after creation, and never again. It is in the
      // flash rather than the row because the row is all that is stored.
      formatDate,
    });
  })
);

router.post(
  "/settings/keys",
  formPost(async (req, res) => {
    const body = req.body || {};
    const created = await apiKeys.create(req.merchantId, {
      label: body.label,
      kind: body.kind === "publishable" ? "publishable" : "secret",
      livemode: String(body.mode || "test") === "live",
    });
    res.flash(
      "key",
      `${created.key}|This is the only time it is shown. Store it now; we keep only a hash of it.`
    );
    res.redirect("/dashboard/settings/keys");
  })
);

router.post(
  "/settings/keys/:id/revoke",
  formPost(async (req, res) => {
    const revoked = await apiKeys.revoke(req.merchantId, req.params.id);
    res.flash(
      revoked ? "ok" : "error",
      revoked ? "Revoked. It stops working on the next request." : "That key was already revoked."
    );
    res.redirect("/dashboard/settings/keys");
  })
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

router.get(
  "/settings/webhooks",
  withMerchant(async (req, res) => {
    const [endpoints, deliveries] = await Promise.all([
      webhooksOut.listEndpoints(req.merchantId),
      webhooksOut.listDeliveries(req.merchantId, { limit: 25 }),
    ]);

    res.render("dashboard/webhooks", {
      title: "Webhooks",
      endpoints,
      deliveries,
      groups: events.EVENT_GROUPS,
      formatDate,
    });
  })
);

router.post(
  "/settings/webhooks",
  formPost(async (req, res) => {
    const body = req.body || {};
    const selected = body.events
      ? Array.isArray(body.events)
        ? body.events
        : [body.events]
      : [];

    const endpoint = await webhooksOut.createEndpoint(req.merchantId, {
      url: body.url,
      events: selected,
      livemode: String(body.mode || "test") === "live",
    });
    res.flash(
      "key",
      `${endpoint.secret}|Your signing secret, shown once. Verify every delivery with it before you trust one.`
    );
    res.redirect("/dashboard/settings/webhooks");
  })
);

router.post(
  "/settings/webhooks/:id/delete",
  formPost(async (req, res) => {
    await webhooksOut.deleteEndpoint(req.merchantId, req.params.id);
    res.flash("ok", "Removed.");
    res.redirect("/dashboard/settings/webhooks");
  })
);

router.post(
  "/settings/webhooks/:id/enable",
  formPost(async (req, res) => {
    await webhooksOut.reenableEndpoint(req.merchantId, req.params.id);
    res.flash("ok", "Back on, and everything that failed while it was off is queued again.");
    res.redirect("/dashboard/settings/webhooks");
  })
);

// ---------------------------------------------------------------------------
// The account itself
// ---------------------------------------------------------------------------

router.get(
  "/settings/account",
  withMerchant(async (req, res) => {
    const people = await merchantUsers.listForMerchant(req.merchantId);
    res.render("dashboard/account", {
      title: "Account",
      people,
      formatDate,
    });
  })
);

router.post(
  "/settings/account",
  formPost(async (req, res) => {
    const body = req.body || {};
    await merchants.update(req.merchantId, {
      name: body.name,
      statementName: body.statement_name,
      supportEmail: body.support_email,
      supportUrl: body.support_url,
      allowedOrigins: body.allowed_origins,
    });
    res.flash("ok", "Saved.");
    res.redirect("/dashboard/settings/account");
  })
);

router.post(
  "/settings/account/password",
  formPost(async (req, res) => {
    const body = req.body || {};
    await merchantUsers.changePassword(req.user.id, body.current_password, body.password);
    res.flash("ok", "Your password is changed.");
    res.redirect("/dashboard/settings/account");
  })
);

module.exports = router;
