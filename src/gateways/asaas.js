// Asaas adapter (API v3, docs.asaas.com).
//
// Facts this file depends on, all confirmed against the official docs:
//   - Base URL: https://api.asaas.com/v3, sandbox https://api-sandbox.asaas.com/v3
//   - Auth: an `access_token` header carrying the account's API key
//   - Amounts are DECIMAL REAIS (19.9), not cents. Converted at this boundary
//     and nowhere else.
//   - Card: POST /payments with billingType CREDIT_CARD, creditCard,
//     creditCardHolderInfo and remoteIp. remoteIp is the BUYER's address and
//     is required. The response carries creditCard.creditCardToken for reuse.
//   - Pix: POST /payments billingType PIX, then
//     GET /payments/{id}/pixQrCode -> { encodedImage, payload, expirationDate }
//   - Boleto: POST /payments billingType BOLETO, then
//     GET /payments/{id}/identificationField for the typeable line
//   - Webhook: an `asaas-access-token` header carrying the token configured in
//     the Asaas dashboard; body { id, event, payment: { id, value, ... } }
//
// Card data goes straight through to Asaas. It is never logged, never stored,
// and never included in an error message.
const { centsToDecimal } = require("../lib/money");
const { fetchWithTimeout, readJsonSafely } = require("../lib/http");
const { safeEqual } = require("../lib/crypto");

const BASE_URLS = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};

// Asaas charge statuses mapped onto the contract's vocabulary.
// Source: the `status` filter of the payments listing endpoint.
const STATUS_MAP = {
  PENDING: "pending",
  AWAITING_RISK_ANALYSIS: "pending", // card held for manual review
  CONFIRMED: "paid", // confirmed, funds not yet available
  RECEIVED: "paid", // received, funds available
  RECEIVED_IN_CASH: "paid", // marked as received by hand
  DUNNING_RECEIVED: "paid", // recovered through collections
  OVERDUE: "expired",
  DUNNING_REQUESTED: "expired",
  // A refund REQUESTED is not a refund. Asaas can still deny it, for instance
  // a Pix refund when the seller has no balance. The order stays paid until
  // the real REFUNDED arrives; marking it earlier would cut off a buyer's
  // access for a refund that may never happen.
  REFUND_REQUESTED: "paid",
  REFUND_IN_PROGRESS: "paid",
  REFUNDED: "refunded",
  CHARGEBACK_REQUESTED: "chargeback",
  CHARGEBACK_DISPUTE: "chargeback",
  AWAITING_CHARGEBACK_REVERSAL: "chargeback",
};

// Webhook events mapped onto a status change.
// `null` means the event is informational and must not move the order.
// Source: docs.asaas.com/docs/payment-events.
const EVENT_STATUS_MAP = {
  PAYMENT_CREATED: null,
  PAYMENT_AWAITING_RISK_ANALYSIS: null,
  PAYMENT_APPROVED_BY_RISK_ANALYSIS: null, // the confirmation arrives separately
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: "refused",
  PAYMENT_AUTHORIZED: null, // authorized, awaiting capture
  PAYMENT_UPDATED: null,
  PAYMENT_CONFIRMED: "paid",
  PAYMENT_RECEIVED: "paid",
  PAYMENT_ANTICIPATED: null, // receivable sold early; the order was already paid
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: "refused",
  PAYMENT_OVERDUE: "expired",
  PAYMENT_DELETED: "expired", // a deleted charge will never be paid
  PAYMENT_RESTORED: null,
  PAYMENT_REFUNDED: "refunded",
  // A partial refund does NOT reverse the order: the buyer still has what they
  // bought. It is reported through `refundedCents` instead of a status.
  PAYMENT_PARTIALLY_REFUNDED: null,
  PAYMENT_REFUND_IN_PROGRESS: null, // can still be denied; only REFUNDED is final
  PAYMENT_REFUND_DENIED: null, // the order never left paid, so nothing to do
  PAYMENT_RECEIVED_IN_CASH_UNDONE: null, // paid -> pending is not a legal move
  PAYMENT_CHARGEBACK_REQUESTED: "chargeback",
  PAYMENT_CHARGEBACK_DISPUTE: "chargeback",
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: "chargeback",
  PAYMENT_DUNNING_REQUESTED: null,
  PAYMENT_DUNNING_RECEIVED: "paid",
  PAYMENT_BANK_SLIP_CANCELLED: null, // expiry is handled by PAYMENT_OVERDUE
  PAYMENT_BANK_SLIP_VIEWED: null,
  PAYMENT_CHECKOUT_VIEWED: null,
};

function digits(value) {
  return String(value == null ? "" : value).replace(/\D+/g, "");
}

// Local date as YYYY-MM-DD, optionally N days ahead.
function isoDate(daysAhead = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// "MM/YY" or "MM/YYYY" -> { expiryMonth, expiryYear } with a four digit year.
function splitExpiry(expiry) {
  const [month, year] = String(expiry || "").split("/");
  const cleanMonth = String(month || "").trim().padStart(2, "0");
  const cleanYear = String(year || "").trim();
  return {
    expiryMonth: cleanMonth,
    expiryYear: cleanYear.length === 2 ? `20${cleanYear}` : cleanYear,
  };
}

class AsaasGateway {
  // credentials come resolved from gateway-config:
  // { apiKey, webhookToken, environment?, fetchImpl? }
  constructor(credentials = {}) {
    this.apiKey = credentials.apiKey || null;
    this.webhookToken = credentials.webhookToken || null;
    // Sandbox is a first class option here, unlike in a closed product that
    // only ever runs its own account: anyone evaluating this project needs to
    // make a charge before they have a production account.
    this.environment = credentials.environment === "sandbox" ? "sandbox" : "production";
    this.fetchImpl = credentials.fetchImpl || globalThis.fetch;
    this.baseUrl = BASE_URLS[this.environment];
  }

  get name() {
    return "asaas";
  }

  get supportedMethods() {
    return ["pix", "card", "boleto"];
  }

  // Asaas settles in reais only. Declaring it stops a session priced in
  // another currency from being routed here and charged as if the number were
  // reais, which is the same amount at a completely different price.
  get supportedCurrencies() {
    return ["BRL"];
  }

  get supportsRecurring() {
    return true;
  }

  // -------------------------------------------------------------------
  // Request plumbing
  // -------------------------------------------------------------------

  async _request(method, path, body) {
    if (!this.apiKey) {
      throw new Error(
        "Asaas is not configured: add the account's API key before taking payments."
      );
    }

    const options = {
      method,
      headers: {
        access_token: this.apiKey,
        "content-type": "application/json",
        "user-agent": "OpenCheckout",
      },
    };
    // A GET must go with no body at all. Asaas answers 403 to a GET that
    // carries one.
    if (body !== undefined) options.body = JSON.stringify(body);

    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}${path}`, options, {
      gateway: "Asaas",
    });
    const data = await readJsonSafely(response);

    if (!response.ok) {
      // Asaas error shape: { errors: [{ code, description }] }
      const description =
        data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].description
          ? data.errors[0].description
          : "no description given";
      const error = new Error(`Asaas answered HTTP ${response.status}: ${description}`);
      error.httpStatus = response.status;
      error.gatewayCode =
        (data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].code) || null;
      throw error;
    }
    return data;
  }

  // -------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------

  // Looks the customer up by tax id before creating one, so a returning buyer
  // does not accumulate duplicates in the merchant's Asaas account.
  async ensureCustomer(customer) {
    const cpfCnpj = digits(customer && customer.document);

    // WITHOUT a tax id there is nothing to search by. "?cpfCnpj=" is an empty
    // filter, and Asaas answers with the account's entire customer list, so
    // taking the first row would attach this order to a stranger's record.
    if (cpfCnpj) {
      const found = await this._request("GET", `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}`);
      if (found && Array.isArray(found.data) && found.data.length > 0) {
        return { customerId: found.data[0].id };
      }
    }

    const created = await this._request("POST", "/customers", {
      name: customer.name || customer.email,
      cpfCnpj: cpfCnpj || undefined,
      email: customer.email,
      mobilePhone: digits(customer.phone) || undefined,
      externalReference: customer.public_id || undefined,
    });
    return { customerId: created.id };
  }

  // -------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------

  async createCharge({ order, customer, customerId, card }) {
    if (order.method === "card") {
      // Already tokenized: the number never reached this process.
      if (card && card.token) {
        return this.chargeWithToken({ order, customer, customerId, cardToken: card.token });
      }
      return this._cardCharge({ order, customer, customerId, card });
    }
    if (order.method === "pix") return this._pixCharge({ order, customerId });
    if (order.method === "boleto") return this._boletoCharge({ order, customerId });
    throw new Error(`Asaas cannot take this payment method: ${order.method}`);
  }

  async _cardCharge({ order, customer, customerId, card }) {
    const { expiryMonth, expiryYear } = splitExpiry(card.expiry);

    const body = {
      customer: customerId,
      billingType: "CREDIT_CARD",
      dueDate: isoDate(0),
      description: order.description,
      externalReference: order.publicId,
      // The BUYER's address, which Asaas requires for card risk analysis.
      remoteIp: order.remoteIp || undefined,
      creditCard: {
        holderName: card.holderName,
        number: card.number,
        expiryMonth,
        expiryYear,
        ccv: card.cvv,
      },
      creditCardHolderInfo: {
        name: customer.name,
        email: customer.email,
        cpfCnpj: digits(customer.document),
        phone: digits(customer.phone) || undefined,
        postalCode: digits(customer.postal_code) || undefined,
        addressNumber: customer.address_number || undefined,
      },
    };

    // Instalments: Asaas wants the TOTAL and the count, and divides it itself.
    // Sending `value` with a count would mean that amount PER instalment,
    // which multiplies the sale by the number of instalments.
    if (order.installments > 1) {
      body.installmentCount = order.installments;
      body.totalValue = centsToDecimal(order.amountCents, order.currency);
    } else {
      body.value = centsToDecimal(order.amountCents, order.currency);
    }

    const payment = await this._request("POST", "/payments", body);
    const status = this._mapStatus(payment.status);

    return {
      gatewayChargeId: payment.id,
      status,
      refusalReason: status === "refused" ? this._refusalReason(payment) : undefined,
      cardToken:
        payment.creditCard && payment.creditCard.creditCardToken
          ? payment.creditCard.creditCardToken
          : undefined,
      cardBrand: payment.creditCard
        ? String(payment.creditCard.creditCardBrand || "").toLowerCase() || undefined
        : undefined,
      cardLast4: payment.creditCard
        ? String(payment.creditCard.creditCardNumber || "").slice(-4) || undefined
        : undefined,
    };
  }

  // Pix, with the dynamic QR code fetched straight afterwards.
  //
  // IT EXPIRES IN TWO DAYS, not today. Somebody who generates a Pix at 11pm
  // and goes to bed came back to "payment expired", while the copy and paste
  // code still worked in their bank app, because an Asaas Pix QR only really
  // dies twelve months after the due date. An expired order also drops out of
  // the recovery queue. A due date of today only served to kill late night
  // sales. Card stays due today because it is charged immediately, and boleto
  // keeps its three days; this is a Pix-only deadline.
  async _pixCharge({ order, customerId }) {
    const payment = await this._request("POST", "/payments", {
      customer: customerId,
      billingType: "PIX",
      value: centsToDecimal(order.amountCents, order.currency),
      dueDate: isoDate(2),
      description: order.description,
      externalReference: order.publicId,
    });

    // The copy and paste code is CHECKED before it reaches the screen. A
    // truncated or empty payload, from a partial network failure, would go out
    // as it is and the buyer would only find out in their bank app, reading
    // "invalid code". A real BR Code is well over a hundred characters; under
    // forty is certainly rubbish. One retry fixes the rare case, and failing
    // loudly after that is better than showing a broken code.
    const usable = (qr) =>
      qr && typeof qr.payload === "string" && qr.payload.length >= 40 && qr.encodedImage;

    let qr = await this._request("GET", `/payments/${encodeURIComponent(payment.id)}/pixQrCode`);
    if (!usable(qr)) {
      qr = await this._request("GET", `/payments/${encodeURIComponent(payment.id)}/pixQrCode`);
    }
    if (!usable(qr)) {
      throw new Error("Asaas returned an incomplete Pix code. Please try again in a moment.");
    }

    return {
      gatewayChargeId: payment.id,
      status: this._mapStatus(payment.status),
      pix: {
        qrCodeBase64: qr.encodedImage, // base64, no data: prefix
        copyPaste: qr.payload,
        expiresAt: qr.expirationDate || null,
      },
    };
  }

  async _boletoCharge({ order, customerId }) {
    const dueDate = isoDate(3);
    const payment = await this._request("POST", "/payments", {
      customer: customerId,
      billingType: "BOLETO",
      value: centsToDecimal(order.amountCents, order.currency),
      dueDate,
      description: order.description,
      externalReference: order.publicId,
    });

    // The typeable line comes from its own endpoint. A failure here must not
    // lose the charge that already exists, so the boleto goes out with its URL
    // and no line rather than throwing.
    let identification = null;
    try {
      identification = await this._request(
        "GET",
        `/payments/${encodeURIComponent(payment.id)}/identificationField`
      );
    } catch (err) {
      console.warn(`[asaas] Could not read the boleto line for ${payment.id}:`, err.message);
    }

    return {
      gatewayChargeId: payment.id,
      status: this._mapStatus(payment.status),
      boleto: {
        url: payment.bankSlipUrl || null,
        barcode: (identification && identification.identificationField) || null,
        dueDate: payment.dueDate || dueDate,
      },
    };
  }

  // One click charge against a saved credential. This is what an upsell and a
  // subscription renewal use.
  async chargeWithToken({ order, customerId, cardToken }) {
    const body = {
      customer: customerId,
      billingType: "CREDIT_CARD",
      dueDate: isoDate(0),
      description: order.description,
      externalReference: order.publicId,
      creditCardToken: cardToken,
      remoteIp: order.remoteIp || undefined,
    };

    if (order.installments > 1) {
      body.installmentCount = order.installments;
      body.totalValue = centsToDecimal(order.amountCents, order.currency);
    } else {
      body.value = centsToDecimal(order.amountCents, order.currency);
    }

    const payment = await this._request("POST", "/payments", body);
    const status = this._mapStatus(payment.status);

    return {
      gatewayChargeId: payment.id,
      status,
      refusalReason: status === "refused" ? this._refusalReason(payment) : undefined,
      cardToken: (payment.creditCard && payment.creditCard.creditCardToken) || cardToken,
    };
  }

  // -------------------------------------------------------------------
  // Reading and reversing
  // -------------------------------------------------------------------

  async getChargeStatus(gatewayChargeId) {
    const payment = await this._request(
      "GET",
      `/payments/${encodeURIComponent(gatewayChargeId)}`
    );
    const paidAt =
      payment.paymentDate || payment.clientPaymentDate || payment.confirmedDate || null;

    return {
      status: this._mapStatus(payment.status),
      paidAt: paidAt || null,
      // How much actually arrived, in cents, so the caller can compare it
      // against the order before releasing anything.
      //
      // ON AN INSTALMENT PLAN Asaas reports `value` PER INSTALMENT, so a
      // comparison would fail on every legitimate instalment sale. Null means
      // "do not compare", which is the honest answer.
      amountCents: this._comparableAmountCents(payment),
      currency: "BRL",
    };
  }

  // POST /payments/{id}/refund, body { value?, description? }. Without a value
  // Asaas refunds in full; with one it refunds partially. The amount is in
  // reais, like the rest of the API.
  //
  // THIS ONLY SENDS THE ORDER. What says the money came back is the
  // PAYMENT_REFUNDED webhook, as everywhere else in this system. The response
  // here usually reports the refund as PENDING and Asaas can still deny it, so
  // marking the order refunded now would remove a buyer's access over a refund
  // that may never happen.
  async refund(gatewayChargeId, { amountCents = null, reason = null } = {}) {
    const body = {};
    if (amountCents != null) body.value = centsToDecimal(amountCents, "BRL");
    if (reason) body.description = String(reason).slice(0, 500);

    const response = await this._request(
      "POST",
      `/payments/${encodeURIComponent(gatewayChargeId)}/refund`,
      body
    );

    const refunds = Array.isArray(response && response.refunds) ? response.refunds : [];
    const latest = refunds.length ? refunds[refunds.length - 1] : null;
    return {
      // "DONE" means already returned, "PENDING" means in flight at the
      // buyer's bank, "CANCELLED" means Asaas gave up.
      ok: true,
      refundId: (latest && latest.id) || null,
      refundStatus: (latest && latest.status) || "PENDING",
      chargeStatus: this._mapStatus(response && response.status),
    };
  }

  // -------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------

  // Asaas sends the token configured in its dashboard as an
  // `asaas-access-token` header. With no token configured on our side there is
  // nothing to compare, so everything is rejected: an unverifiable
  // notification is not a notification.
  verifyWebhook(req) {
    if (!this.webhookToken) return false;
    const given = req && req.headers ? req.headers["asaas-access-token"] : null;
    if (!given) return false;
    return safeEqual(given, this.webhookToken);
  }

  parseWebhook(req) {
    let body = req ? req.body : null;
    if ((!body || !body.event) && req && req.rawBody) {
      try {
        body = JSON.parse(req.rawBody);
      } catch {
        return null;
      }
    }
    if (!body || !body.id || !body.event) return null;

    const event = String(body.event);
    const payment = body.payment || {};

    return {
      eventId: String(body.id),
      eventType: event,
      gatewayChargeId: payment.id ? String(payment.id) : null,
      // OUR id, which Asaas echoes back from externalReference.
      //
      // It is the rescue path for an orphan charge: if the response to a
      // charge creation is lost in transit, the order has no charge id and the
      // payment notification has no order. Money in the merchant's account, an
      // order pending forever, and nobody alerted. With this, the processor
      // can still find it.
      externalReference: payment.externalReference ? String(payment.externalReference) : null,
      status: EVENT_STATUS_MAP[event] !== undefined ? EVENT_STATUS_MAP[event] : null,
      amountCents: this._comparableAmountCents(payment),
      currency: "BRL",
      // How much went back in THIS event, when Asaas says. Null means "it did
      // not say", which the caller reads as "match it against what we asked
      // for" rather than guessing an amount.
      refundedCents: this._refundedCents(payment),
      partialRefund: event === "PAYMENT_PARTIALLY_REFUNDED",
      // Asaas numbers each refund on the payment, which is what makes a
      // resent notification recognisable as the same refund.
      gatewayRefundId: this._refundId(payment),
      // Asaas has no dispute resource of its own: a chargeback is reported on
      // the payment, so there is no id to carry and the event id identifies
      // the delivery instead.
      disputeId: null,
      disputeReason:
        payment && payment.chargeback && payment.chargeback.reason
          ? String(payment.chargeback.reason).slice(0, 300)
          : null,
    };
  }

  // The newest refund's own id, or null.
  _refundId(payment) {
    const refunds = payment && Array.isArray(payment.refunds) ? payment.refunds : [];
    const latest = refunds.length ? refunds[refunds.length - 1] : null;
    return latest && latest.id ? String(latest.id) : null;
  }

  // The newest refund on the payment, in cents, or null.
  _refundedCents(payment) {
    const refunds = payment && Array.isArray(payment.refunds) ? payment.refunds : [];
    const latest = refunds.length ? refunds[refunds.length - 1] : null;
    if (!latest || typeof latest.value !== "number") return null;
    return Math.round(latest.value * 100);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  // The amount to compare against the order, or null when a comparison would
  // be wrong. Asaas reports `value` per instalment on an instalment plan, so
  // comparing it to the order total would flag every legitimate one.
  _comparableAmountCents(payment) {
    if (!payment || typeof payment.value !== "number") return null;
    const installments = Number(payment.installmentCount || 0);
    if (installments > 1 || payment.installment) return null;
    return Math.round(payment.value * 100);
  }

  // A sentence the buyer can act on. Asaas puts the issuer's reason in
  // creditCard.creditCardMessage or in the top level description.
  _refusalReason(payment) {
    const message =
      (payment && payment.creditCard && payment.creditCard.creditCardMessage) ||
      (payment && payment.description) ||
      null;
    return message ? String(message).slice(0, 200) : "The card was declined.";
  }

  _mapStatus(status) {
    const normalized = STATUS_MAP[status];
    if (normalized) return normalized;
    // An unknown status is treated as pending, never as paid. A new Asaas
    // status that we happen not to know about must not release a product.
    console.warn(`[asaas] Unknown status "${status}", treating it as pending.`);
    return "pending";
  }
}

module.exports = AsaasGateway;
module.exports.STATUS_MAP = STATUS_MAP;
module.exports.EVENT_STATUS_MAP = EVENT_STATUS_MAP;
