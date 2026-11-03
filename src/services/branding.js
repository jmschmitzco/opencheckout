// THE WHITE LABEL LAYER.
//
// A merchant should be able to make this checkout look like their own product,
// and a SaaS reselling it should be able to make it look like THEIR customer's
// product. So a theme resolves in three steps, most specific winning:
//
//   merchant default  ->  per product  ->  per checkout session override
//
// The session override is the one that matters for a SaaS: it arrives in the
// API call that creates the session, which means the integrator can pass their
// own customer's logo and colours without creating a merchant for each one.
//
// THE RULE THAT GOVERNS THIS FILE: everything that arrives from outside is
// DATA, never code. A colour has to be a hex triplet. A layout has to be one
// of the known words. A font has to be on the list. Text has a length cap.
// None of it becomes CSS or HTML before passing through here.
//
// The reason is specific, not abstract. This is the page where a person types
// a card number. A "colour" field that accepted arbitrary text would be a way
// to inject CSS, and with CSS you can draw a convincing fake form on top of
// the real one and collect everything typed into it.
const v = require("../lib/validators");

// ---------------------------------------------------------------------------
// Closed lists
// ---------------------------------------------------------------------------

// The frames the checkout can be drawn in.
//   split    product on one side, form on the other. The default.
//   single   one column, summary collapsed above the form. Best on phones and
//            for a single cheap item.
//   compact  form only, no product panel. For a SaaS that already showed the
//            plan on its own page and does not want to show it twice.
const TEMPLATES = ["split", "single", "compact"];

const COLOR_SCHEMES = ["light", "dark", "auto"];

// Font stacks, not font names. An arbitrary family name would be injected into
// CSS, and a font loaded from an arbitrary URL is a request to a third party
// from the page where the card is typed.
const FONTS = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  inter: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  geist: '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  dmsans: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  figtree: '"Figtree", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  mono: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

// Which of those need a stylesheet from Google Fonts. `system`, `serif` and
// `mono` need nothing, which is why they are the fast options.
const WEBFONTS = {
  inter: "Inter:wght@400;500;600;700",
  geist: "Geist:wght@400;500;600;700",
  dmsans: "DM+Sans:wght@400;500;700",
  figtree: "Figtree:wght@400;500;600;700",
};

const BUYER_FIELDS = ["name", "document", "phone", "address", "confirm_email"];
const PAYMENT_METHODS = ["pix", "card", "boleto", "paypal"];

// Text caps, per field. A headline that can be any length is a layout that can
// be broken from the API.
const TEXT_LIMITS = {
  brand_name: 60,
  headline: 120,
  subheadline: 240,
  submit_label: 40,
  support_text: 240,
  top_bar_text: 120,
  secure_badge_text: 60,
  footer_text: 300,
};

// ---------------------------------------------------------------------------
// The defaults
//
// A merchant that never touched the theme gets this, and it has to look
// finished on its own. "Configure me first" is not a starting state anybody
// wants to ship.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  brand_name: null,
  logo_url: null,
  logo_height: 28,
  favicon_url: null,
  hero_image_url: null,
  // Showing where the checkout came from is ON by default and can be turned
  // off, because the licence allows it. It defaults on so the project gets
  // credit from installations that do not care either way.
  powered_by: true,

  accent: "#2c67c5",
  accent_text: "#ffffff",
  page_bg: "#f6f8fb",
  surface: "#ffffff",
  text: "#111827",
  text_muted: "#6b7280",
  border: "#e5e7eb",
  success: "#0f9d58",
  danger: "#d7263d",
  top_bar_bg: null,
  top_bar_text_color: "#ffffff",

  font: "system",
  base_font_size: 16,
  radius_card: 16,
  radius_control: 10,
  radius_button: 10,

  template: "split",
  color_scheme: "light",

  headline: null,
  subheadline: null,
  submit_label: null,
  support_text: null,
  top_bar_text: null,
  secure_badge_text: null,
  footer_text: null,

  show_coupon: true,
  show_order_summary: true,
  show_secure_badge: true,
  show_installments: true,

  custom_css: null,
};

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return "#" + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("");
}

// Darker or lighter by a ratio. Used for the hover and pressed states of the
// button, which must derive from the merchant's own colour: deriving them from
// a fixed token is how a custom accent ends up turning back into the default
// colour the moment the buyer presses it.
function shade(hex, ratio) {
  const { r, g, b } = hexToRgb(hex);
  if (ratio < 0) {
    const k = 1 + ratio;
    return rgbToHex({ r: r * k, g: g * k, b: b * k });
  }
  return rgbToHex({ r: r + (255 - r) * ratio, g: g + (255 - g) * ratio, b: b + (255 - b) * ratio });
}

// Blends two colours. `weight` is how much of the SECOND one to use.
//
// This is what the soft tints are built from, rather than "lighten the
// accent". Lightening works on a white page and fails on a dark one: the
// selected payment method ends up a bright block with light text on it, which
// is unreadable in exactly the place where the buyer is choosing how to pay.
function mix(a, b, weight) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  });
}

// Relative luminance, per WCAG.
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Black or white, whichever is readable on the given background.
//
// This runs even when the merchant chose a text colour, as a check: a yellow
// button with white text is unreadable, and the person who picked it will
// blame the checkout, not their own choice. Below 4.5:1 we override.
function readableTextOn(background, preferred) {
  if (preferred && contrastRatio(background, preferred) >= 4.5) return preferred;
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#111827")
    ? "#ffffff"
    : "#111827";
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

function sanitizeTokens(raw, { allowCustomCss = false } = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const out = {};

  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    if (field in input) out[field] = v.text(input[field], limit);
  }

  for (const field of [
    "accent",
    "accent_text",
    "page_bg",
    "surface",
    "text",
    "text_muted",
    "border",
    "success",
    "danger",
    "top_bar_bg",
    "top_bar_text_color",
  ]) {
    if (field in input) out[field] = v.hexColor(input[field]);
  }

  // Images are URLs, and they are loaded by the browser on the checkout page,
  // so http is refused outside development the same way any other URL is.
  for (const field of ["logo_url", "favicon_url", "hero_image_url"]) {
    if (field in input) {
      out[field] = v.httpUrl(input[field], { allowHttp: process.env.NODE_ENV !== "production" });
    }
  }

  if ("font" in input) out.font = v.oneOf(input.font, Object.keys(FONTS)) || DEFAULTS.font;
  if ("template" in input) out.template = v.oneOf(input.template, TEMPLATES) || DEFAULTS.template;
  if ("color_scheme" in input) {
    out.color_scheme = v.oneOf(input.color_scheme, COLOR_SCHEMES) || DEFAULTS.color_scheme;
  }

  if ("logo_height" in input) out.logo_height = v.integerInRange(input.logo_height, 12, 80, DEFAULTS.logo_height);
  if ("base_font_size" in input) {
    // Never below 16px on the inputs. Mobile Safari zooms the page when it
    // focuses a field with a smaller font, which jumps the layout mid-typing.
    out.base_font_size = v.integerInRange(input.base_font_size, 16, 20, DEFAULTS.base_font_size);
  }
  for (const field of ["radius_card", "radius_control", "radius_button"]) {
    if (field in input) out[field] = v.integerInRange(input[field], 0, 32, DEFAULTS[field]);
  }

  for (const field of ["powered_by", "show_coupon", "show_order_summary", "show_secure_badge", "show_installments"]) {
    if (field in input) out[field] = Boolean(input[field]);
  }

  // Raw CSS is accepted only from an installation that declared itself single
  // tenant (merchants.allow_custom_css). On a shared installation one
  // merchant's CSS would be a tool for drawing a fake form, so it is dropped
  // silently rather than half applied.
  if ("custom_css" in input) {
    out.custom_css = allowCustomCss ? v.text(input.custom_css, 20000) : null;
  }

  // Drop the keys that came in as null from a failed validation, so a bad
  // value falls back to the layer below instead of blanking it.
  for (const key of Object.keys(out)) {
    if (out[key] === null && !(key in TEXT_LIMITS)) delete out[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

// Merges the layers and fills in everything that was left out.
// `layers` is ordered least to most specific.
function resolveTheme(layers, { allowCustomCss = false } = {}) {
  const merged = { ...DEFAULTS };
  for (const layer of layers) {
    if (!layer) continue;
    const clean = sanitizeTokens(layer, { allowCustomCss });
    for (const [key, value] of Object.entries(clean)) {
      if (value !== undefined) merged[key] = value;
    }
  }

  // Derived values. They are computed here, once, so the template and the
  // stylesheet never have to guess.
  const accent = merged.accent || DEFAULTS.accent;
  merged.accent = accent;
  merged.accent_text = readableTextOn(accent, merged.accent_text);
  merged.accent_hover = shade(accent, -0.12);
  merged.accent_active = shade(accent, -0.22);
  // The soft tints blend toward the merchant's own surface rather than toward
  // white, so a dark theme gets a dark tint and the text on it stays readable.
  const surface = merged.surface || DEFAULTS.surface;
  merged.accent_soft = mix(accent, surface, 0.88);
  merged.accent_ring = mix(accent, surface, 0.55);

  if (merged.top_bar_bg) {
    merged.top_bar_text_color = readableTextOn(merged.top_bar_bg, merged.top_bar_text_color);
  }

  merged.font_stack = FONTS[merged.font] || FONTS.system;
  merged.webfont = WEBFONTS[merged.font] || null;

  return merged;
}

// The CSS custom properties the page is rendered with.
//
// Returned as a string of declarations for a style attribute, not as a <style>
// block, so there is no way for a value to close the block and start a new
// rule. Every value in it has already been validated as a colour, an integer
// or a known font stack, and anything unexpected was dropped before here.
function themeStyleAttribute(theme) {
  const declarations = [
    ["--oc-accent", theme.accent],
    ["--oc-accent-text", theme.accent_text],
    ["--oc-accent-hover", theme.accent_hover],
    ["--oc-accent-active", theme.accent_active],
    ["--oc-accent-soft", theme.accent_soft],
    ["--oc-accent-ring", theme.accent_ring],
    ["--oc-page-bg", theme.page_bg],
    ["--oc-surface", theme.surface],
    ["--oc-text", theme.text],
    ["--oc-text-muted", theme.text_muted],
    ["--oc-border", theme.border],
    ["--oc-success", theme.success],
    ["--oc-danger", theme.danger],
    ["--oc-font", theme.font_stack],
    ["--oc-font-size", `${theme.base_font_size}px`],
    ["--oc-radius-card", `${theme.radius_card}px`],
    ["--oc-radius-control", `${theme.radius_control}px`],
    ["--oc-radius-button", `${theme.radius_button}px`],
    ["--oc-logo-height", `${theme.logo_height}px`],
  ];
  if (theme.top_bar_bg) {
    declarations.push(["--oc-top-bar-bg", theme.top_bar_bg]);
    declarations.push(["--oc-top-bar-text", theme.top_bar_text_color]);
  }

  // Final belt and braces. By this point every value is a hex colour, an
  // integer with a unit, or a font stack from the table above, so none of them
  // needs a semicolon, a brace or a parenthesis. If a future change lets one
  // through, it dies here instead of becoming a new CSS rule.
  //
  // Parentheses are excluded deliberately: no declaration written here uses a
  // function, and allowing them would leave url(...) reachable, which is the
  // one thing a value in a style attribute must never be able to express.
  const safe = (value) => String(value == null ? "" : value).replace(/[^a-zA-Z0-9#%,.\-_ ']/g, "");
  return declarations
    .filter(([, value]) => value != null && value !== "")
    .map(([name, value]) => `${name}:${safe(value)}`)
    .join(";");
}

// The Google Fonts stylesheet URL for the chosen font, or null. Built here
// rather than in the template so the font name can never be interpolated from
// user input: it comes from the WEBFONTS table above.
function webfontHref(theme) {
  if (!theme.webfont) return null;
  return `https://fonts.googleapis.com/css2?family=${theme.webfont}&display=swap`;
}

// What the page actually needs, with the copy already defaulted. Keeping the
// fallbacks here means the template has no logic and the API can show an
// integrator exactly what the buyer will read.
function copyFor(theme, { locale = "pt-BR" } = {}) {
  const pt = locale.toLowerCase().startsWith("pt");
  return {
    headline: theme.headline || (pt ? "Finalize sua compra" : "Complete your purchase"),
    subheadline: theme.subheadline || null,
    submitLabel: theme.submit_label || (pt ? "Pagar agora" : "Pay now"),
    supportText: theme.support_text || null,
    topBarText: theme.top_bar_text || null,
    secureBadgeText:
      theme.secure_badge_text || (pt ? "Pagamento seguro" : "Secure payment"),
    footerText: theme.footer_text || null,
  };
}

module.exports = {
  TEMPLATES,
  COLOR_SCHEMES,
  FONTS,
  WEBFONTS,
  BUYER_FIELDS,
  PAYMENT_METHODS,
  TEXT_LIMITS,
  DEFAULTS,
  shade,
  mix,
  luminance,
  contrastRatio,
  readableTextOn,
  sanitizeTokens,
  resolveTheme,
  themeStyleAttribute,
  webfontHref,
  copyFor,
};
