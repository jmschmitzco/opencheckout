// Coupons.
//
// THE RULE: the browser sends the CODE the buyer typed, and nothing else. The
// discount is always recalculated here, from the stored row. A payload that
// carries its own discount amount is a payload that sets its own price.
const db = require("../db");
const v = require("../lib/validators");
const money = require("../lib/money");
const { badRequest, notFound } = require("../lib/errors");

const KINDS = ["percent", "amount"];

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .slice(0, 40);
}

async function create(merchantId, input = {}) {
  const code = normalizeCode(input.code);
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    throw badRequest("A coupon code uses 3 to 40 letters, digits, hyphens or underscores.", {
      code: "Invalid.",
    });
  }

  const kind = v.oneOf(input.kind || "percent", KINDS);
  if (!kind) throw badRequest(`Coupon kind must be one of: ${KINDS.join(", ")}.`);

  const value =
    kind === "percent"
      ? v.integerInRange(input.value, 1, 100, null)
      : v.amountCents(input.value);
  if (value == null || value <= 0) {
    throw badRequest(
      kind === "percent" ? "A percentage coupon takes 1 to 100." : "An amount coupon takes cents.",
      { value: "Invalid." }
    );
  }

  const currency = money.normalizeCurrency(input.currency);
  let expiresAt = null;
  if (input.expiresAt) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw badRequest("expires_at is not a valid date.");
  }

  try {
    const result = await db.query(
      `insert into coupons
         (merchant_id, code, kind, value, currency, max_redemptions, once_per_email, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [
        merchantId,
        code,
        kind,
        value,
        currency,
        input.maxRedemptions == null ? null : v.integerInRange(input.maxRedemptions, 1, 1000000, null),
        Boolean(input.oncePerEmail),
        expiresAt,
      ]
    );
    return result.rows[0];
  } catch (err) {
    const duplicate = err.code === "23505" || /duplicate|unique/i.test(err.message || "");
    if (duplicate) throw badRequest(`Coupon ${code} already exists.`, { code: "Already in use." });
    throw err;
  }
}

async function findByCode(merchantId, code) {
  const clean = normalizeCode(code);
  if (!clean) return null;
  const result = await db.query(`select * from coupons where merchant_id = $1 and code = $2`, [
    merchantId,
    clean,
  ]);
  return result.rows[0] || null;
}

async function list(merchantId) {
  const result = await db.query(
    `select * from coupons where merchant_id = $1 order by created_at desc limit 200`,
    [merchantId]
  );
  return result.rows;
}

// Why a coupon cannot be used, as a sentence the buyer reads, or null when it
// can. Returned rather than thrown: an expired code is a normal thing for a
// buyer to try, not an exception.
function refusalReason(coupon, { currency, email = null, locale = "pt-BR" }) {
  const pt = String(locale).toLowerCase().startsWith("pt");
  if (!coupon || !coupon.active) return pt ? "Cupom não encontrado." : "Coupon not found.";
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return pt ? "Este cupom expirou." : "This coupon has expired.";
  }
  if (coupon.max_redemptions != null && coupon.redemptions >= coupon.max_redemptions) {
    return pt ? "Este cupom já foi todo utilizado." : "This coupon has been fully redeemed.";
  }
  // A fixed amount coupon only makes sense in its own currency. Converting it
  // silently would mean a 50 BRL discount quietly becoming 50 USD.
  if (coupon.kind === "amount" && coupon.currency !== currency) {
    return pt
      ? "Este cupom não vale para esta moeda."
      : "This coupon does not apply to this currency.";
  }
  if (coupon.once_per_email && !email) {
    return pt ? "Informe o seu e-mail antes de aplicar o cupom." : "Enter your email first.";
  }
  return null;
}

// How much comes off, in cents. Never more than the subtotal: a discount
// bigger than the cart would be a charge of zero, or a negative one, and a
// gateway asked to charge zero returns an error the buyer cannot act on.
function discountFor(coupon, subtotalCents) {
  const subtotal = Math.max(0, Math.trunc(Number(subtotalCents) || 0));
  if (!coupon) return 0;
  const raw =
    coupon.kind === "percent"
      ? Math.round((subtotal * coupon.value) / 100)
      : Math.trunc(coupon.value);
  return Math.min(subtotal, Math.max(0, raw));
}

// Looks a code up and prices it, in one call. Used by the checkout page when
// the buyer applies a coupon, and again by the order creation path, because the
// cart may have changed between the two.
async function apply(merchantId, { code, subtotalCents, currency, email, locale }) {
  const coupon = await findByCode(merchantId, code);
  const reason = refusalReason(coupon, { currency, email, locale });
  if (reason) return { ok: false, reason, discountCents: 0, coupon: null };

  if (coupon.once_per_email) {
    const used = await db.query(
      `select 1
         from orders o
         join customers c on c.id = o.customer_id and c.merchant_id = o.merchant_id
        where o.merchant_id = $1 and o.coupon_code = $2 and c.email = $3
          and o.status in ('paid', 'pending')
        limit 1`,
      [merchantId, coupon.code, v.email(email)]
    );
    if (used.rows.length) {
      const pt = String(locale || "pt-BR").toLowerCase().startsWith("pt");
      return {
        ok: false,
        reason: pt ? "Você já usou este cupom." : "You have already used this coupon.",
        discountCents: 0,
        coupon: null,
      };
    }
  }

  return {
    ok: true,
    reason: null,
    discountCents: discountFor(coupon, subtotalCents),
    coupon,
  };
}

// Counted when an order is CREATED, not when it is paid.
//
// A limited coupon counted only on payment can be spent far past its limit by
// everyone who starts a Pix and waits, and the merchant finds out from the
// report. Counting on creation can overcount when people abandon, which costs
// nothing and is the error worth having.
async function registerRedemption(merchantId, couponCode) {
  const code = normalizeCode(couponCode);
  if (!code) return;
  await db.query(
    `update coupons set redemptions = redemptions + 1 where merchant_id = $1 and code = $2`,
    [merchantId, code]
  );
}

async function deactivate(merchantId, code) {
  const result = await db.query(
    `update coupons set active = false where merchant_id = $1 and code = $2 returning *`,
    [merchantId, normalizeCode(code)]
  );
  if (!result.rows[0]) throw notFound("Coupon not found.");
  return result.rows[0];
}

function toApi(row) {
  if (!row) return null;
  return {
    id: row.code,
    object: "coupon",
    code: row.code,
    kind: row.kind,
    value: row.value,
    currency: row.currency,
    max_redemptions: row.max_redemptions,
    redemptions: row.redemptions,
    once_per_email: row.once_per_email,
    expires_at: row.expires_at,
    active: row.active,
    created_at: row.created_at,
  };
}

module.exports = {
  KINDS,
  normalizeCode,
  create,
  findByCode,
  list,
  refusalReason,
  discountFor,
  apply,
  registerRedemption,
  deactivate,
  toApi,
};
