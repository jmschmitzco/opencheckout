// Storage for the white label themes. The rules about what a theme may
// contain live in branding.js; this file only reads and writes them.
const db = require("../db");
const branding = require("./branding");
const v = require("../lib/validators");
const { badRequest } = require("../lib/errors");

const SCOPES = ["merchant", "product"];

function parseTokens(row) {
  if (!row || !row.tokens) return {};
  try {
    const parsed = JSON.parse(row.tokens);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Unreadable JSON means the row is useless, and falling back to the
    // defaults keeps the checkout open. A broken theme must never be a broken
    // sale.
    return {};
  }
}

async function getMerchantTheme(merchantId) {
  const result = await db.query(
    `select * from brand_themes where merchant_id = $1 and scope = 'merchant' and product_id = 0`,
    [merchantId]
  );
  return result.rows[0] || null;
}

async function getProductTheme(merchantId, productId) {
  if (!productId) return null;
  const result = await db.query(
    `select * from brand_themes where merchant_id = $1 and scope = 'product' and product_id = $2`,
    [merchantId, productId]
  );
  return result.rows[0] || null;
}

// The theme a page is actually drawn with.
//
// `sessionOverride` is the layer that makes this white label rather than just
// themeable: it comes from the API call that created the session, which is how
// a SaaS passes its OWN customer's brand without creating a merchant for each
// one.
async function resolveFor({ merchant, productId = null, sessionOverride = null }) {
  const [merchantRow, productRow] = await Promise.all([
    getMerchantTheme(merchant.id),
    getProductTheme(merchant.id, productId),
  ]);

  return branding.resolveTheme(
    [parseTokens(merchantRow), parseTokens(productRow), sessionOverride],
    { allowCustomCss: Boolean(merchant.allow_custom_css) }
  );
}

// Writes a layer. Merges into whatever is stored, so the dashboard can save one
// field at a time without resending the whole theme, and a value explicitly set
// to null falls back to the layer below.
async function save(merchantId, { scope = "merchant", productId = 0, tokens, name, allowCustomCss = false }) {
  const cleanScope = v.oneOf(scope, SCOPES);
  if (!cleanScope) throw badRequest(`Theme scope must be one of: ${SCOPES.join(", ")}.`);
  const product = cleanScope === "product" ? Number(productId) || 0 : 0;
  if (cleanScope === "product" && !product) {
    throw badRequest("A product scoped theme needs a product.");
  }

  const existing =
    cleanScope === "merchant"
      ? await getMerchantTheme(merchantId)
      : await getProductTheme(merchantId, product);

  const incoming = branding.sanitizeTokens(tokens, { allowCustomCss });
  const merged = { ...parseTokens(existing), ...incoming };
  // A null means "fall back to the layer below", so the key is removed rather
  // than stored as null. Keeping it would make "clear this field" and "never
  // set this field" two different states that look identical in the dashboard.
  for (const key of Object.keys(merged)) {
    if (merged[key] === null || merged[key] === undefined) delete merged[key];
  }
  const payload = JSON.stringify(merged);

  if (existing) {
    const result = await db.query(
      `update brand_themes set tokens = $3, name = coalesce($4, name), updated_at = now()
        where merchant_id = $1 and id = $2
        returning *`,
      [merchantId, existing.id, payload, v.text(name, 80)]
    );
    return result.rows[0];
  }

  const result = await db.query(
    `insert into brand_themes (merchant_id, scope, product_id, name, tokens)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [merchantId, cleanScope, product, v.text(name, 80), payload]
  );
  return result.rows[0];
}

// Ready made starting points. A merchant picks one and then adjusts, which is
// a much better first experience than an empty colour picker.
const PRESETS = {
  clean: {
    name: "Clean",
    tokens: { accent: "#2c67c5", page_bg: "#f6f8fb", surface: "#ffffff", font: "inter", template: "split" },
  },
  midnight: {
    name: "Midnight",
    tokens: {
      accent: "#6366f1",
      page_bg: "#0b0e14",
      surface: "#141924",
      text: "#f3f4f6",
      text_muted: "#9aa3b2",
      border: "#232a36",
      color_scheme: "dark",
      font: "geist",
      template: "split",
    },
  },
  mono: {
    name: "Mono",
    tokens: {
      accent: "#111827",
      page_bg: "#ffffff",
      surface: "#ffffff",
      border: "#e5e7eb",
      font: "system",
      radius_card: 4,
      radius_control: 4,
      radius_button: 4,
      template: "single",
    },
  },
  warm: {
    name: "Warm",
    tokens: {
      accent: "#ea580c",
      page_bg: "#fdf8f3",
      surface: "#ffffff",
      border: "#eadfd3",
      font: "figtree",
      radius_card: 20,
      radius_control: 12,
      radius_button: 999,
      template: "split",
    },
  },
};

module.exports = {
  SCOPES,
  PRESETS,
  parseTokens,
  getMerchantTheme,
  getProductTheme,
  resolveFor,
  save,
};
