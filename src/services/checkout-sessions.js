// CHECKOUT SESSIONS: the integration point.
//
// This is the whole product in one object. An integrator's backend says what
// is being sold and where to send the buyer afterwards; it gets back a URL.
// The buyer opens that URL, pays on a page wearing the integrator's brand, and
// the integrator learns the outcome from a signed webhook.
//
// TWO PROPERTIES MAKE IT SAFE, and they are the reason the flow looks like
// this rather than "post a form to a pay endpoint":
//
//   1. THE AMOUNTS ARE FROZEN AT CREATION. Everything the page needs is
//      resolved and written down when the session is made, by a caller holding
//      a secret key. The browser is never asked what something costs, so it
//      can never answer.
//
//   2. THE REDIRECT TARGETS ARE DECLARED AT CREATION. success_url and
//      cancel_url come from the same trusted call, which is what stops a
//      tampered link from sending a paying customer somewhere else.
//
// `client_secret` is what the hosted page and the embedded widget authenticate
// with. It lives in the URL, so it is treated as a bearer token for exactly one
// session and grants nothing beyond it.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const money = require("../lib/money");
const { randomUrlToken } = require("../lib/crypto");
const { config } = require("../config");
const { badRequest, notFound, conflict } = require("../lib/errors");
const catalog = require("./catalog");
const customers = require("./customers");
const coupons = require("./coupons");
const merchants = require("./merchants");
const branding = require("./branding");

const MODES = ["payment", "subscription"];
const STATUSES = ["open", "completed", "expired", "canceled"];

const MAX_LINE_ITEMS = 20;
const MAX_QUANTITY = 999;

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

// A line item is either a reference to a catalogue price, or an ad hoc item
// described inline. Both are supported on purpose: the catalogue serves the
// SaaS selling the same three plans forever, and ad hoc serves usage based
// billing, where the amount is only known at the moment of the sale.
async function resolveLineItems(merchantId, rawItems, { mode }) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw badRequest("line_items must be a non-empty array.", { line_items: "Required." });
  }
  if (rawItems.length > MAX_LINE_ITEMS) {
    throw badRequest(`line_items takes at most ${MAX_LINE_ITEMS} entries.`);
  }

  const resolved = [];
  for (const [index, raw] of rawItems.entries()) {
    const where = `line_items[${index}]`;
    const item = raw && typeof raw === "object" ? raw : {};
    const quantity = v.integerInRange(item.quantity == null ? 1 : item.quantity, 1, MAX_QUANTITY, null);
    if (quantity == null) throw badRequest(`${where}.quantity must be between 1 and ${MAX_QUANTITY}.`);

    if (item.price) {
      const price = await catalog.findPrice(merchantId, String(item.price));
      if (!price) throw badRequest(`${where}.price does not exist: ${item.price}.`);
      if (!price.active) throw badRequest(`${where}.price is no longer active: ${item.price}.`);
      if (!price.product_active) {
        throw badRequest(`${where}.price belongs to an inactive product.`);
      }
      if (price.unit_amount_cents <= 0) {
        // A zero price in the catalogue means "not priced yet", which is a
        // normal state while a merchant sets things up and never a thing to
        // charge for.
        throw badRequest(`${where}.price has no amount set yet: ${item.price}.`);
      }
      resolved.push({
        price_id: price.id,
        price: price.public_id,
        product_id: price.product_id,
        product: price.product_public_id,
        description: price.product_name,
        image_url: price.product_image_url,
        currency: price.currency,
        unit_amount_cents: price.unit_amount_cents,
        compare_at_cents: price.compare_at_cents,
        quantity,
        amount_cents: price.unit_amount_cents * quantity,
        type: price.type,
        interval: price.interval,
        interval_count: price.interval_count,
        trial_days: price.trial_days,
        max_installments: price.max_installments,
      });
      continue;
    }

    // Ad hoc item.
    const description = v.text(item.name || item.description, 200);
    if (!description) {
      throw badRequest(`${where} needs either a price or a name.`, {
        [where]: "Give a price id or a name and amount.",
      });
    }
    const amount = v.amountCents(item.amount_cents);
    if (amount == null || amount <= 0) {
      throw badRequest(`${where}.amount_cents must be a whole number of cents above zero.`);
    }
    if (item.currency && !money.isValidCurrency(item.currency)) {
      throw badRequest(`${where}.currency is not supported.`);
    }
    if (mode === "subscription") {
      // A recurring charge needs an interval, and an ad hoc item has no place
      // to carry one. Forcing a catalogue price here also means every
      // subscription in the system points at something a human named.
      throw badRequest("Subscription mode requires a recurring price, not an ad hoc item.");
    }
    resolved.push({
      price_id: null,
      price: null,
      product_id: null,
      product: null,
      description,
      image_url: v.httpUrl(item.image_url, { allowHttp: process.env.NODE_ENV !== "production" }),
      currency: money.normalizeCurrency(item.currency),
      unit_amount_cents: amount,
      compare_at_cents: null,
      quantity,
      amount_cents: amount * quantity,
      type: "one_time",
      interval: null,
      interval_count: 1,
      trial_days: 0,
      max_installments: 1,
    });
  }

  // One currency per session. Mixing them would mean a total that is not a
  // number in any currency, and no gateway can charge it.
  const currencies = Array.from(new Set(resolved.map((i) => i.currency)));
  if (currencies.length > 1) {
    throw badRequest(`All line items must share one currency. Got: ${currencies.join(", ")}.`);
  }

  if (mode === "subscription") {
    const recurring = resolved.filter((i) => i.type === "recurring");
    if (recurring.length !== 1) {
      throw badRequest("Subscription mode takes exactly one recurring price.");
    }
    const extras = resolved.filter((i) => i.type !== "recurring");
    if (extras.length) {
      // One time items alongside a subscription (a setup fee) are a real need,
      // but charging them correctly means two charges and two refund paths.
      // Refusing now is honest; silently folding them into the first period
      // would overcharge every renewal.
      throw badRequest("Mix of one time and recurring items is not supported yet.");
    }
  } else {
    const recurring = resolved.filter((i) => i.type === "recurring");
    if (recurring.length) {
      throw badRequest('A recurring price needs mode "subscription".');
    }
  }

  return { items: resolved, currency: currencies[0] };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

async function create(merchantId, input = {}, { livemode = false } = {}) {
  const merchant = await merchants.findById(merchantId);
  if (!merchant) throw notFound("Merchant not found.");
  if (!merchant.active) throw conflict("This merchant is not active.");

  const mode = v.oneOf(input.mode || "payment", MODES);
  if (!mode) throw badRequest(`mode must be one of: ${MODES.join(", ")}.`);

  const { items, currency } = await resolveLineItems(merchantId, input.line_items, { mode });

  // URLs are checked against the merchant's declared hosts. An installation
  // that has not declared any is accepting its first integration, so any https
  // target is allowed and the dashboard asks for the list. Refusing outright
  // would block the very first thing anybody tries.
  const allowHttp = process.env.NODE_ENV !== "production";
  const hosts = merchants.allowedHosts(merchant);

  const successUrl = v.redirectUrl(input.success_url, hosts, { allowHttp });
  if (!successUrl) {
    throw badRequest(
      hosts.length
        ? `success_url must be an https URL on one of your allowed hosts: ${hosts.join(", ")}.`
        : "success_url must be a valid https URL.",
      { success_url: "Invalid." }
    );
  }
  const cancelUrl = input.cancel_url ? v.redirectUrl(input.cancel_url, hosts, { allowHttp }) : null;
  if (input.cancel_url && !cancelUrl) {
    throw badRequest("cancel_url must be an https URL on one of your allowed hosts.", {
      cancel_url: "Invalid.",
    });
  }

  // The buyer, if the integrator already knows them. Pre-filling the email is
  // worth real money: it is the field people abandon on.
  let customerRow = null;
  if (input.customer || input.customer_external_id || input.customer_email) {
    customerRow = await customers.resolve(merchantId, {
      customer: input.customer,
      email: input.customer_email,
      externalId: input.customer_external_id,
    });
    if (!customerRow && (input.customer_email || input.customer_external_id)) {
      // Not found is not an error here: the session can carry an email for a
      // buyer who does not exist yet, and they become a customer when they pay.
      customerRow = null;
    }
  }
  const customerEmail = v.email(input.customer_email) || (customerRow ? customerRow.email : null);

  const subtotal = items.reduce((sum, item) => sum + item.amount_cents, 0);

  // A coupon handed in at creation is applied immediately, so the buyer sees
  // the discounted price on arrival. That is how a "40% off" email should
  // work: the link already carries the discount.
  let couponCode = null;
  let discount = 0;
  if (input.coupon) {
    const applied = await coupons.apply(merchantId, {
      code: input.coupon,
      subtotalCents: subtotal,
      currency,
      email: customerEmail,
      locale: input.locale,
    });
    if (!applied.ok) throw badRequest(`Coupon refused: ${applied.reason}`, { coupon: applied.reason });
    couponCode = applied.coupon.code;
    discount = applied.discountCents;
  }

  // Narrowed to what a configured gateway can actually take.
  //
  // Doing it here rather than at render time means the API answer is honest:
  // a session that says it offers PayPal when no PayPal credentials exist is a
  // lie the integrator will believe. It also moves the failure to the
  // integrator's own server, where somebody can read the message, instead of
  // to a buyer who has already filled the form in.
  const configured = await require("./gateway-config").availableMethods({
    merchantId,
    livemode,
  });
  const methods = normalizeMethods(input.payment_methods, { currency, mode, configured });
  const buyerFields = normalizeBuyerFields(input.buyer_fields);

  // The per-session brand override: the layer that lets a SaaS dress the page
  // as its own customer. Sanitised here so a bad value can never reach the
  // page, and stored already clean.
  const brandingOverride = input.branding
    ? branding.sanitizeTokens(input.branding, { allowCustomCss: Boolean(merchant.allow_custom_css) })
    : null;

  const ttlMinutes = v.integerInRange(
    input.expires_in_minutes == null ? config.sessionTtlMinutes : input.expires_in_minutes,
    5,
    7 * 24 * 60,
    config.sessionTtlMinutes
  );
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const result = await db.query(
    `insert into checkout_sessions
       (merchant_id, public_id, livemode, mode, status, customer_id, customer_email,
        customer_external_id, success_url, cancel_url, line_items, currency,
        subtotal_cents, discount_cents, total_cents, coupon_code, allow_coupon,
        payment_methods, buyer_fields, branding_override, locale, external_reference,
        metadata, client_secret, expires_at)
     values ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24)
     returning *`,
    [
      merchantId,
      ids.publicId("session"),
      Boolean(livemode),
      mode,
      customerRow ? customerRow.id : null,
      customerEmail,
      // Kept even when no customer exists yet: the buyer who pays becomes that
      // user, and without this the integrator's own id would be lost between
      // the call that created the session and the sale that followed it.
      v.text(input.customer_external_id, 120) || (customerRow ? customerRow.external_id : null),
      successUrl,
      cancelUrl,
      JSON.stringify(items),
      currency,
      subtotal,
      discount,
      Math.max(0, subtotal - discount),
      couponCode,
      input.allow_coupon === undefined ? true : Boolean(input.allow_coupon),
      methods.join(","),
      buyerFields.join(","),
      brandingOverride ? JSON.stringify(brandingOverride) : null,
      normalizeLocale(input.locale),
      v.text(input.external_reference, 200),
      catalog.serializeMetadata(input.metadata),
      randomUrlToken(24),
      expiresAt,
    ]
  );

  if (couponCode) await coupons.registerRedemption(merchantId, couponCode);

  return result.rows[0];
}

// Which payment methods the page offers.
//
// Filtered by what is actually possible, not just by what was asked for: Pix
// and boleto are Brazilian instruments and exist only in BRL, a subscription
// cannot be charged on an instrument that leaves no credential to charge
// again, and nothing can be charged through a gateway that is not configured.
function normalizeMethods(requested, { currency, mode, configured = null }) {
  const asked = Array.isArray(requested)
    ? requested.map((m) => String(m).trim().toLowerCase())
    : String(requested || "").split(",").map((m) => m.trim().toLowerCase());

  const wanted = asked.filter((m) => branding.PAYMENT_METHODS.includes(m));
  const base = wanted.length ? wanted : branding.PAYMENT_METHODS.slice();

  let allowed = base;
  if (currency !== "BRL") allowed = allowed.filter((m) => m !== "pix" && m !== "boleto");
  if (mode === "subscription") allowed = allowed.filter((m) => m === "card");
  if (configured) allowed = allowed.filter((m) => configured.includes(m));

  if (!allowed.length) {
    if (configured && !configured.length) {
      throw badRequest(
        "No payment gateway is configured for this merchant. Add one before creating a checkout."
      );
    }
    throw badRequest(
      mode === "subscription"
        ? "A subscription can only be charged to a card, and no card gateway is available."
        : `No payment method is available for ${currency}.`
    );
  }
  return Array.from(new Set(allowed));
}

// Which fields the buyer is asked for, beyond the email, which is always asked.
function normalizeBuyerFields(requested) {
  if (requested === undefined) return ["name", "document", "phone"];
  const asked = Array.isArray(requested)
    ? requested.map((f) => String(f).trim())
    : String(requested || "").split(",").map((f) => f.trim());
  return branding.BUYER_FIELDS.filter((field) => asked.includes(field));
}

function normalizeLocale(value) {
  const text = String(value || "pt-BR").trim();
  return /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/i.test(text) ? text : "pt-BR";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parseLineItems(row) {
  try {
    const parsed = JSON.parse(row.line_items || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseBrandingOverride(row) {
  if (!row || !row.branding_override) return null;
  try {
    return JSON.parse(row.branding_override);
  } catch {
    return null;
  }
}

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(
    `select * from checkout_sessions where merchant_id = $1 and public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

// Looks a session up by id alone, which is what the hosted page has before any
// merchant is known. The merchant comes BACK from this call, and the caller
// then opens the context with it.
//
// Scoped by the session's own unique public id, which is the only identifier
// available at this point in the request.
async function findForPage(publicId) {
  const result = await db.query(
    `select * from checkout_sessions where public_id = $1`,
    [String(publicId || "")],
    { withoutMerchant: "the hosted page resolves its merchant FROM the session id in the URL" }
  );
  return result.rows[0] || null;
}

function isExpired(session) {
  return new Date(session.expires_at).getTime() <= Date.now();
}

// The state a page should act on, which is not always the stored one: a
// session stored as open but past its expiry is expired, and saying so without
// waiting for a sweeper to notice keeps the page honest.
function effectiveStatus(session) {
  if (session.status === "open" && isExpired(session)) return "expired";
  return session.status;
}

// Marks the ones whose time ran out. Called by the page when it finds one, and
// by the background sweep.
async function expire(merchantId, sessionId) {
  await db.query(
    `update checkout_sessions set status = 'expired'
      where merchant_id = $1 and id = $2 and status = 'open'`,
    [merchantId, sessionId]
  );
}

async function markCompleted(merchantId, sessionId, orderId) {
  await db.query(
    `update checkout_sessions
        set status = 'completed', completed_at = now(), order_id = $3
      where merchant_id = $1 and id = $2 and status = 'open'`,
    [merchantId, sessionId, orderId]
  );
}

async function cancel(merchantId, publicId) {
  const result = await db.query(
    `update checkout_sessions set status = 'canceled'
      where merchant_id = $1 and public_id = $2 and status = 'open'
      returning *`,
    [merchantId, publicId]
  );
  if (!result.rows[0]) {
    const existing = await findByPublicId(merchantId, publicId);
    if (!existing) throw notFound("Session not found.");
    throw conflict(`A ${existing.status} session cannot be canceled.`);
  }
  return result.rows[0];
}

// Re-prices the session for a coupon the buyer typed on the page.
//
// It writes the new total, which is the point: the page never carries a price
// of its own, so applying a coupon means changing the stored session and
// reading it back.
async function applyCoupon(merchantId, session, code, email) {
  if (!session.allow_coupon) throw conflict("This checkout does not accept coupons.");
  if (effectiveStatus(session) !== "open") throw conflict("This checkout is no longer open.");

  if (!code) {
    const result = await db.query(
      `update checkout_sessions
          set coupon_code = null, discount_cents = 0, total_cents = subtotal_cents
        where merchant_id = $1 and id = $2
        returning *`,
      [merchantId, session.id]
    );
    return { ok: true, session: result.rows[0], reason: null };
  }

  const applied = await coupons.apply(merchantId, {
    code,
    subtotalCents: session.subtotal_cents,
    currency: session.currency,
    email: email || session.customer_email,
    locale: session.locale,
  });
  if (!applied.ok) return { ok: false, session, reason: applied.reason };

  const result = await db.query(
    `update checkout_sessions
        set coupon_code = $3, discount_cents = $4, total_cents = $5
      where merchant_id = $1 and id = $2
      returning *`,
    [
      merchantId,
      session.id,
      applied.coupon.code,
      applied.discountCents,
      Math.max(0, session.subtotal_cents - applied.discountCents),
    ]
  );
  await coupons.registerRedemption(merchantId, applied.coupon.code);
  return { ok: true, session: result.rows[0], reason: null };
}

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

function url(session) {
  return `${config.baseUrl}/c/${session.public_id}?k=${session.client_secret}`;
}

function toApi(session, { includeSecret = false } = {}) {
  if (!session) return null;
  const body = {
    id: session.public_id,
    object: "checkout_session",
    livemode: session.livemode,
    mode: session.mode,
    status: effectiveStatus(session),
    url: url(session),
    customer_email: session.customer_email,
    customer_external_id: session.customer_external_id,
    currency: session.currency,
    subtotal_cents: session.subtotal_cents,
    discount_cents: session.discount_cents,
    total_cents: session.total_cents,
    coupon: session.coupon_code,
    line_items: parseLineItems(session).map((item) => ({
      price: item.price,
      product: item.product,
      description: item.description,
      quantity: item.quantity,
      unit_amount_cents: item.unit_amount_cents,
      amount_cents: item.amount_cents,
    })),
    payment_methods: String(session.payment_methods || "").split(",").filter(Boolean),
    success_url: session.success_url,
    cancel_url: session.cancel_url,
    external_reference: session.external_reference,
    metadata: catalog.parseMetadata(session.metadata),
    expires_at: session.expires_at,
    created_at: session.created_at,
    completed_at: session.completed_at,
  };
  // The secret is handed out exactly once, in the response to the call that
  // created the session, so the integrator can build the URL themselves or
  // hand it to the embedded widget.
  if (includeSecret) body.client_secret = session.client_secret;
  return body;
}

module.exports = {
  MODES,
  STATUSES,
  MAX_LINE_ITEMS,
  create,
  resolveLineItems,
  normalizeMethods,
  normalizeBuyerFields,
  findByPublicId,
  findForPage,
  parseLineItems,
  parseBrandingOverride,
  isExpired,
  effectiveStatus,
  expire,
  markCompleted,
  cancel,
  applyCoupon,
  url,
  toApi,
};
