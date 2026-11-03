// Input validation. Everything that crosses the boundary from a browser or
// from an integrator's server passes through here first.
//
// The rule that holds this file together: a validator REFUSES, it does not
// repair. Quietly "fixing" a value means the system acts on something the
// caller never sent, and the bug surfaces somewhere else entirely.

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Trimmed text, capped, or null when empty. The cap is not cosmetic: a name
// field with no limit is a way to push a megabyte into every webhook payload.
function text(value, maxLength = 200) {
  const t = String(value == null ? "" : value).trim();
  if (!t) return null;
  return t.slice(0, maxLength);
}

// A value from a closed list, or null. Used for every mode, status and kind in
// the system, which is why none of them is a database CHECK constraint.
function oneOf(value, allowed) {
  const v = String(value == null ? "" : value).trim();
  return allowed.includes(v) ? v : null;
}

function integerInRange(value, min, max, fallback = null) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

// Non-negative integer cents. Rejects floats, negatives and anything that is
// not a number, because a price is the last place to be generous.
function amountCents(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

// Deliberately permissive on the local part and strict on the shape. The only
// real test of an address is sending to it; this just catches typos and
// refuses anything that could not be an address at all.
function email(value) {
  const t = String(value == null ? "" : value).trim().toLowerCase();
  if (!t || t.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(t)) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Brazilian documents. Kept because the gateways this version ships with are
// Brazilian and require them for Pix and registered boleto.
// ---------------------------------------------------------------------------

function digitsOnly(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function isValidCpf(value) {
  const d = digitsOnly(value);
  if (d.length !== 11) return false;
  // All eleven digits the same passes the arithmetic but is never a real CPF.
  if (/^(\d)\1{10}$/.test(d)) return false;
  for (const [length, start] of [[9, 10], [10, 11]]) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(d[i]) * (start - i);
    const remainder = (sum * 10) % 11;
    const check = remainder === 10 ? 0 : remainder;
    if (check !== Number(d[length])) return false;
  }
  return true;
}

function isValidCnpj(value) {
  const d = digitsOnly(value);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const length of [12, 13]) {
    const slice = weights.slice(weights.length - length);
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(d[i]) * slice[i];
    const remainder = sum % 11;
    const check = remainder < 2 ? 0 : 11 - remainder;
    if (check !== Number(d[length])) return false;
  }
  return true;
}

// Accepts either, returns digits only, or null.
function taxId(value) {
  const d = digitsOnly(value);
  if (d.length === 11 && isValidCpf(d)) return d;
  if (d.length === 14 && isValidCnpj(d)) return d;
  return null;
}

// Brazilian mobile or landline, digits only, with area code.
function phoneBr(value) {
  const d = digitsOnly(value);
  const local = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
  if (local.length < 10 || local.length > 11) return null;
  return local;
}

function postalCodeBr(value) {
  const d = digitsOnly(value);
  return d.length === 8 ? d : null;
}

// ---------------------------------------------------------------------------
// Colours, used by the white label theme
// ---------------------------------------------------------------------------

// Only #rgb or #rrggbb. Anything else (rgb(), var(), url(), a semicolon) is
// REFUSED, not corrected. This matters more than it looks: the checkout is the
// page where someone types a card number, and a colour field that accepted
// arbitrary text would be a way to inject CSS, and with CSS you can draw a
// convincing fake form on top of the real one.
function hexColor(value) {
  const t = String(value == null ? "" : value).trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return null;
  return t.toLowerCase();
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

// An https URL (http allowed only outside production, for local development).
// Refuses credentials in the URL, and refuses anything that is not http(s),
// which rules out javascript: and data:.
function httpUrl(value, { allowHttp = false, maxLength = 2048 } = {}) {
  const t = String(value == null ? "" : value).trim();
  if (!t || t.length > maxLength) return null;
  let url;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

// A redirect target the integrator declared. On top of being a valid URL it
// must live on a host the merchant allows, so a stolen API key cannot point
// paying customers at an attacker's page.
//
// `allowedHosts` empty means the merchant has not restricted anything yet, and
// the caller decides whether that is acceptable.
function redirectUrl(value, allowedHosts, { allowHttp = false } = {}) {
  const normalized = httpUrl(value, { allowHttp });
  if (!normalized) return null;
  const hosts = (allowedHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) return normalized;
  const host = new URL(normalized).hostname.toLowerCase();
  const allowed = hosts.some((h) => host === h || host.endsWith(`.${h}`));
  return allowed ? normalized : null;
}

// ---------------------------------------------------------------------------
// Card data. NEVER logged, never stored, never put in an error message.
// ---------------------------------------------------------------------------

// Luhn. Catches a mistyped digit before a request is spent on the gateway, and
// before the buyer is told their bank declined something no bank ever saw.
function isValidCardNumber(value) {
  const d = digitsOnly(value);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let digit = Number(d[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// "MM/YY" or "MM/YYYY", and it must not be in the past. Returns
// { month, year } with a four digit year, or null.
function cardExpiry(value) {
  const match = /^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/.exec(String(value == null ? "" : value).trim());
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  const now = new Date();
  // A card is valid through the LAST day of its month, so compare month ends.
  const endOfMonth = new Date(year, month, 0, 23, 59, 59);
  if (endOfMonth < now) return null;
  return { month, year };
}

function cardCvv(value) {
  const d = digitsOnly(value);
  return d.length === 3 || d.length === 4 ? d : null;
}

// The brand, guessed from the leading digits. Display only: the gateway is the
// authority on whether a card is accepted.
function cardBrand(value) {
  const d = digitsOnly(value);
  if (/^4/.test(d)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(d)) return "mastercard";
  if (/^3[47]/.test(d)) return "amex";
  if (/^(36|38|30[0-5])/.test(d)) return "diners";
  if (/^(6011|65|64[4-9])/.test(d)) return "discover";
  if (/^(606282|3841)/.test(d)) return "hipercard";
  if (/^(4011|4312|4389|5041|5067|509|6277|6363|650)/.test(d)) return "elo";
  return "unknown";
}

module.exports = {
  text,
  oneOf,
  integerInRange,
  amountCents,
  email,
  digitsOnly,
  isValidCpf,
  isValidCnpj,
  taxId,
  phoneBr,
  postalCodeBr,
  hexColor,
  httpUrl,
  redirectUrl,
  isValidCardNumber,
  cardExpiry,
  cardCvv,
  cardBrand,
};
