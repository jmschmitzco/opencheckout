// Money is ALWAYS an integer number of cents inside the system. Conversion to
// a decimal happens at the edge only: when formatting for a human, or when a
// gateway API insists on decimals.
//
// This is not style. A float turns 19.90 into 19.899999999999999, and a sum of
// a hundred of those does not match the invoice.

// Currencies the checkout can present. `decimals` matters because not every
// currency has two: JPY has none, so 1000 cents would mean 1000 yen, not 10.
const CURRENCIES = {
  BRL: { label: "Brazilian real", locale: "pt-BR", decimals: 2 },
  USD: { label: "US dollar", locale: "en-US", decimals: 2 },
  EUR: { label: "Euro", locale: "de-DE", decimals: 2 },
  GBP: { label: "Pound sterling", locale: "en-GB", decimals: 2 },
  CAD: { label: "Canadian dollar", locale: "en-CA", decimals: 2 },
  AUD: { label: "Australian dollar", locale: "en-AU", decimals: 2 },
  MXN: { label: "Mexican peso", locale: "es-MX", decimals: 2 },
  ARS: { label: "Argentine peso", locale: "es-AR", decimals: 2 },
  CLP: { label: "Chilean peso", locale: "es-CL", decimals: 0 },
  COP: { label: "Colombian peso", locale: "es-CO", decimals: 2 },
  JPY: { label: "Japanese yen", locale: "ja-JP", decimals: 0 },
};

const DEFAULT_CURRENCY = "BRL";

function isValidCurrency(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, String(code || "").toUpperCase());
}

function normalizeCurrency(code) {
  const upper = String(code || "").toUpperCase();
  return isValidCurrency(upper) ? upper : DEFAULT_CURRENCY;
}

// Formats cents the way a speaker of that currency expects: US$ 19.90 for
// dollars, 19,90 € for euros. An unknown currency falls back to the default
// rather than throwing, because a formatting problem must never take a
// checkout page down.
//
// `locale` overrides the currency's own locale. That is what the checkout
// passes, so a Brazilian buying in dollars reads the price in the layout they
// are used to.
function formatMoney(cents, currency, locale) {
  const code = normalizeCurrency(currency);
  const spec = CURRENCIES[code];
  const amount = Math.trunc(Number(cents) || 0) / Math.pow(10, spec.decimals);
  try {
    return amount.toLocaleString(locale || spec.locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: spec.decimals,
      maximumFractionDigits: spec.decimals,
    });
  } catch {
    return `${code} ${amount.toFixed(spec.decimals)}`;
  }
}

// Some gateway APIs take a decimal amount instead of cents.
function centsToDecimal(cents, currency) {
  const spec = CURRENCIES[normalizeCurrency(currency)];
  return Math.trunc(Number(cents) || 0) / Math.pow(10, spec.decimals);
}

// THE INSTALMENT FLOOR.
//
// Card processors reject a transaction whose instalment is too small, and they
// reject the WHOLE transaction, not just the extra instalments. A 4.90 product
// offered in 12 instalments means 40 cents each, which comes back as an
// invalid amount, and the buyer is told the bank declined when no bank was
// ever asked. So the offer itself has to be possible before it is made.
const MIN_INSTALLMENT_CENTS = 500;

// How many instalments the amount actually allows. One is always possible:
// refusing a sale because the product is cheap would be worse than the bug.
function maxInstallmentsFor(totalCents, maxInstallments) {
  const ceiling = Math.max(1, Math.trunc(Number(maxInstallments) || 1));
  const total = Math.trunc(Number(totalCents) || 0);
  if (total <= 0) return ceiling;
  const fit = Math.max(1, Math.floor(total / MIN_INSTALLMENT_CENTS));
  return Math.min(ceiling, fit);
}

function normalizeInstallments(installments, maxInstallments, totalCents) {
  const n = parseInt(installments, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, maxInstallmentsFor(totalCents, maxInstallments));
}

// Value of each instalment, with no interest. The last one absorbs the
// remainder, which is why this floors instead of rounding.
function installmentAmount(totalCents, installments) {
  const n = Math.max(1, Math.trunc(Number(installments) || 1));
  return Math.floor(Math.trunc(Number(totalCents) || 0) / n);
}

// Parses a human written amount into cents. Returns NaN when it cannot.
//
// Accepts "97", "97.00", "97,00", "1,234.56" and "1.234,56". The ambiguous
// case is a lone separator followed by exactly three digits: "1.997" is one
// thousand nine hundred ninety seven in pt-BR and one point nine nine seven in
// en-US. We read it as a thousands separator, because nobody prices anything
// at 2 cents.
function parseAmountToCents(text, currency) {
  if (text == null) return NaN;
  const cleaned = String(text)
    .trim()
    .replace(/[^\d.,-]/g, "");
  if (!cleaned) return NaN;

  let normalized;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the rightmost one is the decimal separator.
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandSep = decimalSep === "," ? "." : ",";
    normalized = cleaned.split(thousandSep).join("").replace(decimalSep, ".");
  } else if (lastComma >= 0) {
    // Only commas. Three digits after a single comma reads as thousands.
    normalized = /^\d{1,3}(,\d{3})+$/.test(cleaned)
      ? cleaned.split(",").join("")
      : cleaned.replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    normalized = cleaned.split(".").join("");
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return NaN;
  const spec = CURRENCIES[normalizeCurrency(currency)];
  return Math.round(value * Math.pow(10, spec.decimals));
}

module.exports = {
  CURRENCIES,
  DEFAULT_CURRENCY,
  MIN_INSTALLMENT_CENTS,
  isValidCurrency,
  normalizeCurrency,
  formatMoney,
  centsToDecimal,
  maxInstallmentsFor,
  normalizeInstallments,
  installmentAmount,
  parseAmountToCents,
};
