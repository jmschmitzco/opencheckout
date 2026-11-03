// Mercado Pago adapter, using the Orders API (v1/orders).
//
// WHY IT IS HERE: it is the only one of these gateways that creates a Pix
// asking for nothing but an email address. Asaas will not create a customer
// without a tax id for any method, and Pagar.me wants name, email, document
// and phone even for Pix. For a merchant selling something cheap to someone
// who just wants to pay and leave, that difference is measurable.
//
// Endpoints:
//   Create:  POST /v1/orders          (X-Idempotency-Key header)
//   Read:    GET  /v1/orders/{id}
//   Refund:  POST /v1/orders/{id}/refund   (no amount = full)
//   Webhook: x-signature "ts=...,v1=..." plus x-request-id. The signed
//            manifest is `id:{data.id};request-id:{x-request-id};ts:{ts};`
//
// What each method requires, per the documentation:
//   Pix:     payer.email. That is all.
//   Boleto:  payer.email, a CPF, and a COMPLETE address.
//   Card:    a token generated IN THE BROWSER with the public key. The card
//            number never reaches this process, which is excellent, and which
//            is also why card is not in supportedMethods yet. See below.
//
// ONE PAYMENT PER ORDER: the Orders API reference says transactions.payments
// "can contain only one transaction". Split payments do not exist here.
//
// Never log the access token or card data.
const crypto = require("crypto");
const { centsToDecimal } = require("../lib/money");
const { fetchWithTimeout, readJsonSafely } = require("../lib/http");
const { safeEqual } = require("../lib/crypto");
const addressLookup = require("../lib/address-lookup");

const BASE_URL = "https://api.mercadopago.com";

// Order status mapped onto the contract's vocabulary.
const STATUS_MAP = {
  processed: "paid", // processed and credited
  created: "pending",
  processing: "pending",
  action_required: "pending", // waiting for the buyer to pay
  failed: "refused",
  refunded: "refunded",
  canceled: "expired", // cancelled, so it will never be paid
  expired: "expired",
  charged_back: "chargeback",
};

function mapStatus(status, detail) {
  const value = String(status || "").toLowerCase();
  // A partial refund is still money received. What was given back is the
  // refund service's business, not the order's status.
  if (value === "processed" && String(detail || "").toLowerCase() === "partially_refunded") {
    return "paid";
  }
  return STATUS_MAP[value] || "pending";
}

function digits(value) {
  return String(value == null ? "" : value).replace(/\D+/g, "");
}

// THE REFUSAL REASON, EXTRACTED CLEANLY.
//
// The Orders API scatters the reason across three places and none of them is a
// field that only holds the reason:
//   errors[].details: ["PAY01ABC: high_risk"]   (the payment id in front)
//   transactions.payments[].status_detail: "cc_rejected_high_risk"
//   errors[].code: "invalid_transaction_amount"
//
// Without isolating the code, anyone wanting to explain a decline to a buyer
// had to hunt for a word inside a sentence. This returns the code alone, with
// no payment id and nobody's data in it.
function extractRefusalCode(data) {
  const payments =
    (data && data.transactions && Array.isArray(data.transactions.payments) && data.transactions.payments) ||
    [];
  for (const payment of payments) {
    if (payment && payment.status_detail) return String(payment.status_detail);
  }

  const errors = (data && Array.isArray(data.errors) && data.errors) || [];
  for (const error of errors) {
    const details = (error && Array.isArray(error.details) ? error.details : []).filter(Boolean);
    for (const detail of details) {
      const parts = String(detail).split(":");
      const tail = parts[parts.length - 1].trim();
      if (tail && /^[a-z0-9_]+$/i.test(tail)) return tail;
    }
    if (error && error.code) return String(error.code);
  }
  return "";
}

class MercadoPagoGateway {
  constructor(credentials = {}) {
    this.accessToken = credentials.accessToken || "";
    this.publicKey = credentials.publicKey || "";
    this.webhookSecret = credentials.webhookSecret || "";
    this.fetchImpl = credentials.fetchImpl || globalThis.fetch;
  }

  get name() {
    return "mercadopago";
  }

  // CARD IS ABSENT ON PURPOSE, and it is not a limitation of this adapter.
  //
  // Mercado Pago requires the card to be tokenized in the BROWSER with their
  // public key, so the number never reaches any server of ours. That is the
  // better design, and it means the checkout page needs their SDK and a
  // gateway-specific step before submitting. Until the page has that, offering
  // card here would mean a buyer choosing it, filling the form in, and only
  // then finding out.
  //
  // _cardPayment below is already written, so the day the page tokenizes, this
  // list is the only thing that changes.
  get supportedMethods() {
    return ["pix", "boleto"];
  }

  // Pix and boleto are Brazilian instruments. A Mercado Pago account in
  // another country sells other things through other methods, and that is a
  // different adapter's job, not a silently wrong currency here.
  get supportedCurrencies() {
    return ["BRL"];
  }

  // A Mercado Pago card token is SINGLE USE, so there is no saved credential
  // to charge again. That rules out renewals and one-click upsells through
  // this gateway, whatever the page does later.
  get supportsRecurring() {
    return false;
  }

  // THE NOTIFICATION CARRIES NO STATUS. Mercado Pago sends "something changed
  // on resource X" and expects you to ask. This flag is what makes the webhook
  // handler go and ask rather than quietly accepting a notification that says
  // nothing.
  get statusFromQuery() {
    return true;
  }

  async _request(method, path, body, { idempotencyKey = null } = {}) {
    if (!this.accessToken) {
      throw new Error("Mercado Pago is not configured: add the account's access token.");
    }

    const headers = { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    // Every creation carries an idempotency key, so a network retry or a
    // double click cannot become two charges.
    if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${BASE_URL}${path}`,
      { method, headers, body: body ? JSON.stringify(body) : undefined },
      { gateway: "Mercado Pago" }
    );
    const data = await readJsonSafely(response);

    if (!response.ok) {
      const summary =
        (data && (data.message || data.error)) ||
        (data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message) ||
        `HTTP ${response.status}`;

      // THE REASON, SPELLED OUT. Mercado Pago answers 402 with "The following
      // transactions failed" and puts the actual reason inside errors[]. The
      // summary alone says nothing, and diagnosing a real lost sale from it is
      // guesswork. Only codes and descriptions go in here: no buyer data, no
      // token.
      const details = [];
      for (const error of (data && Array.isArray(data.errors) && data.errors) || []) {
        const parts = [error && error.code, error && error.message, error && error.description].filter(Boolean);
        const extra = error && Array.isArray(error.details) ? error.details.filter(Boolean) : [];
        if (extra.length) parts.push(extra.join(" | "));
        if (parts.length) details.push(parts.join(": "));
      }

      const err = new Error(
        `Mercado Pago refused the call (${response.status}): ${summary}` +
          (details.length ? ` [${details.join(" / ")}]` : "")
      );
      err.httpStatus = response.status;
      err.refusalCode = extractRefusalCode(data);
      throw err;
    }
    return data;
  }

  // The Orders API has no customer registry: the payer travels inside the
  // order. The contract asks for this method, so it answers honestly.
  async ensureCustomer() {
    return { customerId: null };
  }

  _payer(customer) {
    const payer = { email: customer.email };
    const name = String(customer.name || "").trim();
    if (name) {
      const parts = name.split(/\s+/);
      payer.first_name = parts[0];
      if (parts.length > 1) payer.last_name = parts.slice(1).join(" ");
    }
    const document = digits(customer.document);
    if (document) {
      payer.identification = { type: document.length > 11 ? "CNPJ" : "CPF", number: document };
    }
    const phone = digits(customer.phone);
    if (phone.length >= 10) {
      payer.phone = { area_code: phone.slice(0, 2), number: phone.slice(2) };
    }
    return payer;
  }

  _baseBody(order, customer) {
    const amount = centsToDecimal(order.amountCents, order.currency).toFixed(2);
    return {
      type: "online",
      processing_mode: "automatic",
      external_reference: String(order.publicId),
      total_amount: amount,
      description: order.description,
      payer: this._payer(customer),
      transactions: { payments: [{ amount }] },
    };
  }

  async createCharge({ order, customer, card }) {
    const body = this._baseBody(order, customer);
    const payment = body.transactions.payments[0];

    if (order.method === "pix") {
      payment.payment_method = { id: "pix", type: "bank_transfer" };
    } else if (order.method === "boleto") {
      if (!digits(customer.document)) {
        throw new Error("A Mercado Pago boleto requires the buyer's CPF.");
      }
      payment.payment_method = { id: "bolbradesco", type: "ticket" };
      body.payer.address = await this._payerAddress(customer);
    } else if (order.method === "card") {
      this._cardPayment(payment, { order, card });
    } else {
      throw new Error(`Mercado Pago cannot take this payment method: ${order.method}`);
    }

    const created = await this._request("POST", "/v1/orders", body, {
      idempotencyKey: `order-${order.publicId}`,
    });
    return this._toCharge(created);
  }

  // Written and unreachable until the checkout page tokenizes with the public
  // key. See the comment on supportedMethods.
  _cardPayment(payment, { order, card }) {
    const token = card && (card.token || card.cardToken);
    if (!token) {
      throw new Error(
        "A Mercado Pago card must be tokenized in the browser with the public key before it is charged."
      );
    }
    payment.payment_method = {
      id: (card && card.paymentMethodId) || undefined,
      type: "credit_card",
      token,
      installments: Math.max(1, parseInt(order.installments, 10) || 1),
    };
  }

  async chargeWithToken({ order, customer, cardToken }) {
    // A Mercado Pago card token is single use, so this can only ever succeed
    // with a freshly minted token. It exists for completeness, and
    // supportsRecurring says false so nothing relies on it.
    return this.createCharge({ order, customer, card: { token: cardToken } });
  }

  async _payerAddress(customer) {
    const postalCode = digits(customer.postal_code);
    const number = String(customer.address_number || "").trim();
    const found = await addressLookup.lookup(postalCode, this.fetchImpl);
    return {
      zip_code: postalCode,
      street_name: (found && found.street) || "Nao informado",
      street_number: number || "S/N",
      neighborhood: (found && found.district) || "Centro",
      city: (found && found.city) || "",
      state: (found && found.state) || "",
    };
  }

  _firstPayment(order) {
    const transactions = order && order.transactions;
    const list = (transactions && transactions.payments) || [];
    return list[0] || null;
  }

  _toCharge(order) {
    const payment = this._firstPayment(order);
    const method = (payment && payment.payment_method) || {};
    const status = mapStatus(order.status, order.status_detail);
    const result = { gatewayChargeId: String(order.id), status };

    // WHY THE BANK SAID NO. A decline arrives as HTTP 200 with status
    // "rejected", so it never passes through the error path: the reason
    // reached here and was thrown away. Buyers read "try another card" even
    // when the problem was a mistyped security code, and the server log held
    // nothing at all.
    const detail = order.status_detail || (payment && payment.status_detail) || "";
    if (status === "refused") {
      result.refusalReason = detail ? this._refusalSentence(detail) : "The payment was declined.";
    }

    if (method.qr_code || method.qr_code_base64) {
      result.pix = {
        qrCodeBase64: String(method.qr_code_base64 || "").replace(/^data:image\/\w+;base64,/, ""),
        copyPaste: method.qr_code || "",
        expiresAt: method.expiration_date || (payment && payment.expiration_time) || null,
      };
    }

    if (method.ticket_url || method.barcode_content || method.digitable_line) {
      result.boleto = {
        url: method.ticket_url || "",
        barcode: method.digitable_line || method.barcode_content || "",
        dueDate: method.date_of_expiration || method.expiration_date || null,
      };
    }

    return result;
  }

  // Their status codes turned into something a buyer can act on. Anything not
  // listed falls back to a neutral sentence rather than leaking a code.
  _refusalSentence(detail) {
    const sentences = {
      cc_rejected_insufficient_amount: "There were not enough funds on the card.",
      cc_rejected_bad_filled_security_code: "The security code is incorrect.",
      cc_rejected_bad_filled_date: "The expiry date is incorrect.",
      cc_rejected_bad_filled_card_number: "Check the card number.",
      cc_rejected_call_for_authorize: "Your bank needs to authorize this amount.",
      cc_rejected_card_disabled: "The card is not enabled for online purchases.",
      cc_rejected_high_risk: "The payment was declined by risk analysis.",
      cc_rejected_max_attempts: "Too many attempts with this card.",
      cc_rejected_duplicated_payment: "This payment has already been made.",
    };
    return sentences[String(detail)] || "The payment was declined.";
  }

  async getChargeStatus(gatewayChargeId) {
    const order = await this._request("GET", `/v1/orders/${encodeURIComponent(gatewayChargeId)}`);
    const status = mapStatus(order.status, order.status_detail);
    const payment = this._firstPayment(order);
    const paidAt = payment && (payment.date_approved || payment.date_last_updated);
    const amount = Number(order.total_amount);

    return {
      status,
      paidAt: status === "paid" && paidAt ? new Date(paidAt) : null,
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      currency: String(order.currency_id || "BRL").toUpperCase(),
      transactionId: payment && payment.id ? String(payment.id) : null,
    };
  }

  // No amount refunds in full; an amount refunds partially, and a partial
  // refund needs the PAYMENT id alongside it.
  async refund(gatewayChargeId, { amountCents = null } = {}) {
    let body;
    if (amountCents) {
      const current = await this.getChargeStatus(gatewayChargeId);
      if (!current || !current.transactionId) {
        throw new Error("Mercado Pago: could not read the payment needed for a partial refund.");
      }
      body = {
        transactions: [
          { id: current.transactionId, amount: centsToDecimal(amountCents, "BRL").toFixed(2) },
        ],
      };
    }
    const response = await this._request(
      "POST",
      `/v1/orders/${encodeURIComponent(gatewayChargeId)}/refund`,
      body,
      { idempotencyKey: `refund-${gatewayChargeId}-${amountCents || "full"}` }
    );
    return {
      ok: true,
      refundId: (response && response.id) || gatewayChargeId,
      refundStatus: (response && response.status) || null,
    };
  }

  // -------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------

  // HMAC SHA256 over a manifest built from the resource id, the x-request-id
  // header and the timestamp. With no secret configured this REFUSES: a
  // payment notification nobody can verify is money released to whoever calls
  // the URL.
  verifyWebhook(req) {
    if (!this.webhookSecret) return false;

    const header = (req && req.headers && req.headers["x-signature"]) || "";
    const requestId = (req && req.headers && req.headers["x-request-id"]) || "";
    if (!header) return false;

    let ts = "";
    let v1 = "";
    for (const part of String(header).split(",")) {
      const [key, value] = part.split("=");
      const name = String(key || "").trim();
      if (name === "ts") ts = String(value || "").trim();
      if (name === "v1") v1 = String(value || "").trim();
    }
    if (!ts || !v1) return false;

    // REPLAY WINDOW. The timestamp is part of what is signed, so a captured
    // notification stays valid forever unless its age is checked. Ten minutes
    // is generous for a webhook and short enough to matter.
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > 600) return false;

    const query = (req && req.query) || {};
    const body = (req && req.body) || {};
    const id = String(query["data.id"] || query.id || (body.data && body.data.id) || "");
    if (!id) return false;

    const manifest = `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(manifest).digest("hex");
    return safeEqual(expected, v1);
  }

  parseWebhook(req) {
    const body = (req && req.body) || {};
    const type = String(body.type || body.topic || "");
    // Order, payment and chargeback notifications. Anything else is noise.
    if (type && !/^(order|payment|chargebacks?)$/i.test(type)) return null;

    const id = String((body.data && body.data.id) || body.id || "");
    if (!id) return null;

    return {
      // There is no event id in the body, so the resource, the action and the
      // notification's own timestamp identify the delivery. That is what stops
      // a resend being processed twice.
      eventId: `mp-${id}-${body.action || type}-${body.date_created || ""}`,
      eventType: String(body.action || type || "order"),
      gatewayChargeId: id,
      // Deliberately null: the notification does not carry a status, and
      // statusFromQuery tells the handler to ask.
      status: null,
      amountCents: null,
      currency: null,
      refundedCents: null,
      partialRefund: false,
      // Nothing here carries a refund or a dispute id: the notification
      // carries a resource id and an action, and statusFromQuery makes the
      // handler ask Mercado Pago what actually happened.
      gatewayRefundId: null,
      disputeId: null,
      disputeReason: null,
    };
  }
}

module.exports = MercadoPagoGateway;
module.exports.mapStatus = mapStatus;
module.exports.STATUS_MAP = STATUS_MAP;
