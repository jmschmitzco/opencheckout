// PayPal adapter (Orders v2).
//
// PayPal does not fit the shape of the other three, and pretending otherwise
// is how integrations break. The flow is:
//
//   1. We create an ORDER and get an approval link.
//   2. The buyer leaves for PayPal and approves there.
//   3. They come back, and WE CAPTURE. Only the capture is money.
//
// So a PayPal charge comes back `pending` with a redirect, never paid, and the
// return route captures. APPROVED means "the buyer agreed", not "we were
// paid": treating APPROVED as paid releases products that were never charged.
//
// Facts this file depends on:
//   - Base: https://api-m.paypal.com, sandbox https://api-m.sandbox.paypal.com
//   - Auth: OAuth2 client credentials, cached until shortly before expiry
//   - The approval link arrives as rel "payer-action" OR "approve". The docs
//     use both names, and looking for only one returns undefined and stalls
//     the checkout.
//   - Webhook signatures are verified LOCALLY against PayPal's certificate,
//     over `transmissionId|transmissionTime|webhookId|crc32(rawBody)`.
//
// Never log the client secret or an access token.
const crypto = require("crypto");
const { fetchWithTimeout, readJsonSafely } = require("../lib/http");

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  production: "https://api-m.paypal.com",
};

// Where a webhook certificate may come from.
//
// WITHOUT THIS LIST an attacker points paypal-cert-url at their own server,
// signs the body with their own key, and verification passes. This constraint
// is not in PayPal's documentation; it has to be added by whoever implements
// the check.
const CERT_HOSTS = [
  "api.paypal.com",
  "api-m.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.sandbox.paypal.com",
];

// APPROVED is NOT paid. Only a capture is.
const ORDER_STATUS = {
  CREATED: "pending",
  SAVED: "pending",
  PAYER_ACTION_REQUIRED: "pending",
  APPROVED: "pending",
  COMPLETED: "paid",
  VOIDED: "expired",
};

const CAPTURE_STATUS = {
  COMPLETED: "paid",
  PENDING: "pending",
  DECLINED: "refused",
  FAILED: "refused",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "refunded",
};

const EVENT_STATUS = {
  "PAYMENT.CAPTURE.COMPLETED": "paid",
  "PAYMENT.CAPTURE.DENIED": "refused",
  "PAYMENT.CAPTURE.DECLINED": "refused",
  "PAYMENT.CAPTURE.REFUNDED": "refunded",
  "PAYMENT.CAPTURE.REVERSED": "chargeback",
  "CUSTOMER.DISPUTE.CREATED": "chargeback",
  // Approved is not paid: the capture is what pays.
  "CHECKOUT.ORDER.APPROVED": null,
};

// The OAuth token and the fetched certificates live at MODULE level, because
// the registry builds a new adapter instance per call and keeping them on
// `this` would mean one OAuth round trip per charge.
const tokens = new Map();
const certificates = new Map();

// Cents to "49.90", computed with integers so no float ever touches an amount.
function toDecimal(cents) {
  const value = Math.max(0, Math.trunc(Number(cents) || 0));
  return `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function toCents(decimal) {
  const text = String(decimal == null ? "" : decimal).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// A stable idempotency key per order and step. The same key on a retry means
// PayPal returns the existing order instead of creating a second one.
function idempotencyKey(orderId, step) {
  return `oc-${step}-${crypto.createHash("sha256").update(String(orderId)).digest("hex").slice(0, 24)}`;
}

// CRC32, needed for the webhook signature. PayPal signs the CRC of the raw
// body rather than the body itself.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

class PaypalGateway {
  constructor(credentials = {}) {
    this.clientId = credentials.clientId || "";
    this.secret = credentials.secret || "";
    this.webhookId = credentials.webhookId || "";
    this.environment = credentials.environment === "sandbox" ? "sandbox" : "production";
    this.baseUrl = BASE_URLS[this.environment];
    this.fetchImpl = credentials.fetchImpl || globalThis.fetch;
    // Where the buyer comes back to. The adapter is handed this rather than
    // reading the config, so it stays testable and so a host can route the
    // return through its own URL.
    this.returnUrl = credentials.returnUrl || null;
    this.cancelUrl = credentials.cancelUrl || null;
  }

  get name() {
    return "paypal";
  }

  get supportedMethods() {
    return ["paypal"];
  }

  // The subset of PayPal's settlement currencies this project formats. BRL is
  // only held by a Brazilian account; others receive it converted.
  get supportedCurrencies() {
    return ["BRL", "USD", "EUR", "GBP", "CAD", "AUD", "MXN"];
  }

  // PayPal will not charge again without the buyer approving. Brazil is not on
  // the list of countries with "save payment method", and merchant-initiated
  // billing needs manual approval of the account. So no renewals and no
  // one-click upsells through this gateway.
  get supportsRecurring() {
    return false;
  }

  // The buyer leaves the checkout and comes back. The caller has to know, so
  // it can send them and so it does not treat the pending answer as a failure.
  get usesRedirect() {
    return true;
  }

  get isConfigured() {
    return Boolean(this.clientId && this.secret);
  }

  // -------------------------------------------------------------------
  // Auth and requests
  // -------------------------------------------------------------------

  async _accessToken() {
    if (!this.isConfigured) {
      const error = new Error("PayPal is not configured: add the client id and secret.");
      error.httpStatus = 500;
      throw error;
    }

    const key = `${this.environment}:${crypto
      .createHash("sha256")
      .update(this.clientId)
      .digest("hex")
      .slice(0, 12)}`;
    const cached = tokens.get(key);
    if (cached && cached.validUntil > Date.now()) return cached.token;

    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString("base64");
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
      { gateway: "PayPal" }
    );

    const data = await readJsonSafely(response);
    if (!response.ok || !data || !data.access_token) {
      const error = new Error(`PayPal rejected the credentials (HTTP ${response.status}).`);
      error.httpStatus = response.status;
      throw error;
    }

    // Renewed five minutes early, so no call ever picks up a dead token.
    const lifetime = Math.max(60, Number(data.expires_in) || 32400) - 300;
    tokens.set(key, { token: data.access_token, validUntil: Date.now() + lifetime * 1000 });
    return data.access_token;
  }

  // A 401 means the token aged out: renew and repeat ONCE, with the SAME
  // idempotency key, or the retry becomes a second order.
  async _request(method, path, body, { requestId = null } = {}, retried = false) {
    const token = await this._accessToken();
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      { gateway: "PayPal" }
    );

    if (response.status === 401 && !retried) {
      tokens.clear();
      return this._request(method, path, body, { requestId }, true);
    }

    const data = await readJsonSafely(response);

    if (!response.ok) {
      const detail =
        data && Array.isArray(data.details) && data.details[0]
          ? data.details[0].issue || data.details[0].description
          : (data && data.message) || "no description given";
      const error = new Error(`PayPal answered HTTP ${response.status}: ${detail}`);
      error.httpStatus = response.status;
      error.issue =
        data && Array.isArray(data.details) && data.details[0] ? data.details[0].issue : null;
      throw error;
    }
    return data;
  }

  // PayPal has no customer registry. A local identifier keeps the contract
  // honest without inventing one.
  async ensureCustomer(customer) {
    const email = String((customer && customer.email) || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    return { customerId: `pp_${email}`.slice(0, 60) };
  }

  // -------------------------------------------------------------------
  // Charging
  // -------------------------------------------------------------------

  async createCharge({ order }) {
    if (order.method !== "paypal") {
      throw new Error(`PayPal cannot take "${order.method}".`);
    }

    const returnUrl = this._url(this.returnUrl, order);
    const cancelUrl = this._url(this.cancelUrl, order);
    if (!returnUrl) {
      throw new Error("PayPal needs a return URL. Set returnUrl on the gateway credentials.");
    }

    const created = await this._request(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            // Ties the PayPal order to OURS, which is what lets a notification
            // be reconciled without trusting a query string the buyer can edit.
            reference_id: String(order.publicId),
            custom_id: String(order.publicId),
            description: String(order.description || "").slice(0, 127),
            amount: {
              currency_code: order.currency || "USD",
              value: toDecimal(order.amountCents),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: "PAY_NOW",
              return_url: returnUrl,
              cancel_url: cancelUrl || returnUrl,
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
      { requestId: idempotencyKey(order.publicId, "create") }
    );

    // The docs use both names for this link, and looking for only one returns
    // undefined and stalls the checkout with no error anybody can read.
    const link = (created.links || []).find(
      (l) => l.rel === "payer-action" || l.rel === "approve"
    );
    if (!link || !link.href) {
      const error = new Error("PayPal did not return an approval link.");
      error.httpStatus = 502;
      throw error;
    }

    return {
      gatewayChargeId: created.id,
      // Always pending: the buyer has not approved anything yet, let alone
      // paid. Anything else here releases products for free.
      status: ORDER_STATUS[created.status] || "pending",
      redirect: { url: link.href, paypalOrderId: created.id },
    };
  }

  _url(template, order) {
    if (!template) return null;
    try {
      const url = new URL(template);
      url.searchParams.set("order", order.publicId);
      return url.toString();
    } catch {
      return null;
    }
  }

  async chargeWithToken() {
    const error = new Error(
      "PayPal does not support one-click charging: the buyer has to approve each purchase."
    );
    error.httpStatus = 400;
    throw error;
  }

  // THIS IS WHERE THE MONEY EXISTS. Called by the return route once the buyer
  // comes back approved.
  async captureIfApproved(gatewayChargeId) {
    try {
      const captured = await this._request(
        "POST",
        `/v2/checkout/orders/${encodeURIComponent(gatewayChargeId)}/capture`,
        {},
        { requestId: idempotencyKey(gatewayChargeId, "capture") }
      );
      return this._readCapture(captured);
    } catch (err) {
      // Already captured, because the return and the webhook raced. That is
      // the outcome we wanted, not an error.
      if (err.httpStatus === 422 && /ALREADY_CAPTURED/i.test(String(err.issue || err.message))) {
        const order = await this._request(
          "GET",
          `/v2/checkout/orders/${encodeURIComponent(gatewayChargeId)}`
        );
        return this._readCapture(order);
      }
      // The buyer still has something to do at PayPal, for instance a card
      // declined on their side. Not a final refusal of the order.
      if (err.httpStatus === 422) {
        return { status: "pending", reason: err.issue || "buyer_action_required" };
      }
      throw err;
    }
  }

  _readCapture(order) {
    const unit = (order.purchase_units || [])[0] || {};
    const capture = ((unit.payments || {}).captures || [])[0] || null;
    if (!capture) return { status: ORDER_STATUS[order.status] || "pending" };

    const breakdown = capture.seller_receivable_breakdown || {};
    return {
      status: CAPTURE_STATUS[capture.status] || "pending",
      captureId: capture.id || null,
      paidAt: capture.create_time || null,
      amountCents: breakdown.gross_amount ? toCents(breakdown.gross_amount.value) : null,
      feeCents: breakdown.paypal_fee ? toCents(breakdown.paypal_fee.value) : null,
      currency: breakdown.gross_amount ? breakdown.gross_amount.currency_code : null,
    };
  }

  // A pure read that captures nothing. Used by reconciliation and polling.
  async getChargeStatus(gatewayChargeId) {
    if (!gatewayChargeId) return { status: "pending", paidAt: null, amountCents: null };
    try {
      const order = await this._request(
        "GET",
        `/v2/checkout/orders/${encodeURIComponent(gatewayChargeId)}`
      );
      const capture = this._readCapture(order);
      return {
        status: capture.status || ORDER_STATUS[order.status] || "pending",
        paidAt: capture.paidAt || null,
        amountCents: capture.amountCents || null,
        currency: capture.currency || null,
        // "Approved with no capture" is money authorized and waiting for
        // somebody to take it. Reconciliation uses this to capture for a buyer
        // who approved and never came back to the site.
        approvedNotCaptured: order.status === "APPROVED" && !capture.captureId,
      };
    } catch (err) {
      // An unapproved order disappears after a few hours. For PayPal it
      // expired.
      if (err.httpStatus === 404) return { status: "expired", paidAt: null, amountCents: null };
      // Network, timeout, 5xx. NEVER say paid without knowing.
      console.error("[paypal] Could not read the order:", err.message);
      return { status: "pending", paidAt: null, amountCents: null };
    }
  }

  async refund(gatewayCaptureId, { amountCents = null, currency = "USD" } = {}) {
    if (!gatewayCaptureId) throw new Error("PayPal needs the capture id to refund.");
    const body = amountCents
      ? { amount: { value: toDecimal(amountCents), currency_code: currency } }
      : undefined;
    const response = await this._request(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(gatewayCaptureId)}/refund`,
      body,
      { requestId: idempotencyKey(`${gatewayCaptureId}-${amountCents || "full"}`, "refund") }
    );
    return {
      ok: true,
      refundId: (response && response.id) || null,
      refundStatus: (response && response.status) || null,
    };
  }

  // -------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------

  // Verified LOCALLY and cryptographically, so there is no call back to
  // PayPal in the path of every event, and so it works offline in a test.
  //
  // With no webhook id configured this REFUSES, in every environment. Same
  // lesson as the other adapters: without that rule, anybody who finds the URL
  // can mark an order paid.
  async verifyWebhook(req) {
    try {
      if (!this.webhookId) return false;
      if (!req || !req.rawBody || !req.rawBody.length) return false;

      const headers = req.headers || {};
      const transmissionId = headers["paypal-transmission-id"];
      const transmissionTime = headers["paypal-transmission-time"];
      const signature = headers["paypal-transmission-sig"];
      const certUrl = headers["paypal-cert-url"];
      const algorithm = headers["paypal-auth-algo"];
      if (!transmissionId || !transmissionTime || !signature || !certUrl || !algorithm) return false;

      let url;
      try {
        url = new URL(String(certUrl));
      } catch {
        return false;
      }
      if (url.protocol !== "https:" || !CERT_HOSTS.includes(url.hostname)) return false;

      const pem = await this._certificate(url.toString());
      if (!pem) return false;

      const message = `${transmissionId}|${transmissionTime}|${this.webhookId}|${crc32(req.rawBody)}`;
      const verifier = crypto.createVerify("SHA256");
      verifier.update(message);
      return verifier.verify(pem, Buffer.from(String(signature), "base64"));
    } catch (err) {
      console.error("[paypal] Could not verify the webhook:", err.message);
      return false;
    }
  }

  async _certificate(url) {
    if (certificates.has(url)) return certificates.get(url);
    const response = await fetchWithTimeout(this.fetchImpl, url, { method: "GET" }, { gateway: "PayPal" });
    if (!response.ok) return null;
    const pem = await response.text();
    certificates.set(url, pem);
    return pem;
  }

  // THE RESOURCE CHANGES SHAPE PER EVENT, and that is where refunds and
  // disputes get lost:
  //   PAYMENT.CAPTURE.*          resource is the CAPTURE; resource.id is the
  //                              capture, custom_id is our order, and the
  //                              order id hides in supplementary_data
  //   PAYMENT.CAPTURE.REFUNDED   resource is the REFUND; resource.id is the
  //                              refund id, and the capture is only in the
  //                              link with rel "up"
  //   CUSTOMER.DISPUTE.CREATED   resource is the DISPUTE, with no order id at
  //                              all; the capture is in disputed_transactions
  //
  // So the parse returns three identifiers and lets the handler try each.
  async parseWebhook(req) {
    const body = (req && req.body) || {};
    const type = String(body.event_type || "");
    const resource = body.resource || {};
    const disputed = Array.isArray(resource.disputed_transactions)
      ? resource.disputed_transactions
      : [];

    const externalReference =
      resource.custom_id ||
      ((resource.purchase_units || [])[0] || {}).custom_id ||
      ((resource.purchase_units || [])[0] || {}).reference_id ||
      (disputed[0] || {}).custom_id ||
      null;

    let captureId = null;
    if (/^PAYMENT\.CAPTURE\.(REFUNDED|REVERSED)$/.test(type)) {
      const up = (resource.links || []).find((l) => l.rel === "up");
      const match = up && up.href ? String(up.href).match(/\/captures\/([^/?]+)/) : null;
      captureId = match ? match[1] : null;
    } else if (type === "CUSTOMER.DISPUTE.CREATED") {
      captureId = (disputed[0] || {}).seller_transaction_id || null;
    } else if (/^PAYMENT\.CAPTURE\./.test(type)) {
      captureId = resource.id || null;
    }

    const orderId =
      ((resource.supplementary_data || {}).related_ids || {}).order_id ||
      (type.startsWith("CHECKOUT.ORDER.") ? resource.id : null) ||
      null;

    const breakdown = resource.seller_receivable_breakdown || {};

    return {
      eventId: body.id || null,
      eventType: type,
      gatewayChargeId: orderId,
      gatewayCaptureId: captureId,
      externalReference: externalReference ? String(externalReference) : null,
      status: Object.prototype.hasOwnProperty.call(EVENT_STATUS, type) ? EVENT_STATUS[type] : null,
      paidAt: type === "PAYMENT.CAPTURE.COMPLETED" ? resource.create_time || null : null,
      // Only on a completed capture, where the gross amount is what arrived.
      amountCents:
        type === "PAYMENT.CAPTURE.COMPLETED" && breakdown.gross_amount
          ? toCents(breakdown.gross_amount.value)
          : null,
      currency:
        (breakdown.gross_amount && breakdown.gross_amount.currency_code) ||
        (resource.amount && resource.amount.currency_code) ||
        null,
      feeCents:
        type === "PAYMENT.CAPTURE.COMPLETED" && breakdown.paypal_fee
          ? toCents(breakdown.paypal_fee.value)
          : null,
      // A PARTIAL refund reports what was given back. Without it, returning
      // 10% would mark the whole order refunded.
      refundCents:
        type === "PAYMENT.CAPTURE.REFUNDED" && resource.amount
          ? toCents(resource.amount.value)
          : null,
    };
  }
}

module.exports = PaypalGateway;
module.exports.toDecimal = toDecimal;
module.exports.toCents = toCents;
module.exports.crc32 = crc32;
module.exports.idempotencyKey = idempotencyKey;
module.exports.ORDER_STATUS = ORDER_STATUS;
module.exports.CAPTURE_STATUS = CAPTURE_STATUS;
module.exports.EVENT_STATUS = EVENT_STATUS;
