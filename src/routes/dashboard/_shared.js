// Helpers every dashboard route uses.
//
// They live here rather than in index.js for a mundane but real reason: index
// mounts these routers, so a router that reached back into index would be
// asking for a module that is still half way through loading, and would get
// an empty object. A leaf module cannot have that problem.
const ctx = require("../../db/merchant-context");
const money = require("../../lib/money");
const { ApiError } = require("../../lib/errors");

// Runs a handler inside the signed in merchant's context.
//
// EVERY dashboard route uses this. It is the single place a dashboard request
// learns whose data it may see, and the merchant comes from the session, never
// from the URL or the body. With the query guard in db/index.js refusing
// anything that does not name a merchant, that combination is what makes a
// cross-merchant read impossible to write by accident.
function withMerchant(handler) {
  return (req, res, next) =>
    ctx.withMerchant(req.merchantId, () => Promise.resolve(handler(req, res, next)).catch(next));
}

// Same, for a form POST that ends in a redirect.
//
// A failed write re-renders nothing: it flashes what went wrong and sends the
// browser back where it came from. That keeps every form in the dashboard to
// one code path instead of each one carrying its own error rendering.
function formPost(handler, { backTo = null } = {}) {
  return withMerchant(async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const fields = err.fields ? Object.values(err.fields).join(" ") : "";
      res.flash("error", [err.message, fields].filter(Boolean).join(" "));
      const target =
        typeof backTo === "function" ? backTo(req) : backTo || req.get("referer") || "/dashboard";
      res.redirect(target);
    }
  });
}

// Money formatting for a view, bound to one currency.
function formatter(currency) {
  return (cents, override) => money.formatMoney(cents, override || currency);
}

// A date a person reads, in the locale the browser asked for. Dates in a
// dashboard are always "when did this happen to me", never a machine field.
function formatDate(value, { withTime = true } = {}) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
}

// Clamps a page number and size coming from a query string.
function paging(req, { perPage = 25, max = 100 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.max(5, Math.min(max, parseInt(req.query.per_page, 10) || perPage));
  return { page, size, offset: (page - 1) * size };
}

module.exports = { withMerchant, formPost, formatter, formatDate, paging };
