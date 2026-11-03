// Pagar.me adapter (API v5, docs.pagar.me).
//
// Base: https://api.pagar.me/core/v5
// Auth: Basic base64(secretKey + ":")
//
// Decisions, all confirmed against the official docs:
//   - Pagar.me works in CENTS, so nothing is converted here.
//   - gatewayChargeId is the CHARGE id (ch_...), because that is what the
//     webhooks reference. The order id (or_...) is not usable for that.
//   - Card: the card is saved on the customer (POST /customers/{id}/cards) and
//     the charge uses card_id. Sensitive data therefore crosses once, and we
//     get a reusable credential for one-click and renewals. The API
//     deduplicates a card that is sent twice.
//   - Pix: the API returns qr_code (the EMV copy and paste string) and
//     qr_code_url (a hosted PNG, not base64). The QR image is generated here
//     from the copy and paste string so every gateway gives the page the same
//     shape.
//   - Webhooks authenticate with Basic auth, using a user and password set in
//     the Pagar.me dashboard.
//
// Never log card data or the secret key, and never echo either in an error.
const QRCode = require("qrcode");
const { fetchWithTimeout, readJsonSafely } = require("../lib/http");
const { safeEqual } = require("../lib/crypto");
const addressLookup = require("../lib/address-lookup");

const BASE_URL = "https://api.pagar.me/core/v5";
const PIX_EXPIRES_SECONDS = 30 * 60;
const BOLETO_DUE_DAYS = 3;

// Charge statuses mapped onto the contract's vocabulary.
//
// "canceled" IS NOT A REFUND, and reading it as one was an expensive mistake
// in the system this was ported from. Pagar.me marks a charge `canceled` both
// when it EXPIRED unpaid and when the merchant cancelled it by hand.
//
// What that cost: a buyer generates a Pix and never pays. Thirty minutes
// later the order became REFUNDED. A refund appeared in the statement for a
// sale that never happened, the "order refunded" event went out to every
// integration, and the refund automation emailed somebody who had never paid
// to say their money was on its way. The order also landed in a final state
// nothing else reaches, so the "cart expired" flow never ran.
//
// Cancelled only means refunded when the charge had been PAID first, and the
// webhook does not say what the previous state was. So the safe reading wins:
// expired. A real refund arrives as charge.refunded, below.
//
// "underpaid", paid for less than the amount, does NOT release the order.
const CHARGE_STATUS = {
  pending: "pending",
  processing: "pending",
  waiting_payment: "pending",
  paid: "paid",
  overpaid: "paid",
  underpaid: "pending",
  failed: "refused",
  canceled: "expired",
  chargedback: "chargeback",
  expired: "expired",
};

// Webhook event types mapped onto a status change. Anything absent here is
// informational (charge.created, charge.updated, order.*) and moves nothing.
const EVENT_STATUS = {
  "charge.paid": "paid",
  "charge.overpaid": "paid",
  "charge.payment_failed": "refused",
  "charge.antifraud_reproved": "refused",
  "charge.refunded": "refunded",
  "charge.chargedback": "chargeback",
  "chargeback.received": "chargeback",
};

function digits(value) {
  return String(value == null ? "" : value).replace(/\D+/g, "");
}

function normalizeStatus(status) {
  const normalized = CHARGE_STATUS[status];
  if (!normalized) {
    // Unknown is pending, never paid. A status Pagar.me adds tomorrow must not
    // release a product today.
    console.warn(`[pagarme] Unknown charge status "${status}", treating it as pending.`);
    return "pending";
  }
  return normalized;
}

// { document, document_type, type } from a CPF or CNPJ.
function documentFields(document) {
  const doc = digits(document);
  const isCompany = doc.length === 14;
  return {
    document: doc,
    document_type: isCompany ? "CNPJ" : "CPF",
    type: isCompany ? "company" : "individual",
  };
}

// A Brazilian phone in Pagar.me's shape. Omitted entirely when unusable,
// because a malformed phone is refused by the API and would fail the sale.
function phoneFields(phone) {
  const d = digits(phone);
  if (d.length < 10 || d.length > 11) return undefined;
  return {
    mobile_phone: { country_code: "55", area_code: d.slice(0, 2), number: d.slice(2) },
  };
}

// "MM/YY" or "MM/YYYY" -> { exp_month, exp_year }
function expiryFields(expiry) {
  const match = /^(\d{2})\s*\/\s*(\d{2}|\d{4})$/.exec(String(expiry || "").trim());
  if (!match) throw new Error("The card expiry date is not in MM/YY format.");
  let year = Number(match[2]);
  if (year < 100) year += 2000;
  return { exp_month: Number(match[1]), exp_year: year };
}

class PagarmeGateway {
  constructor(credentials = {}) {
    this.secretKey = credentials.secretKey || null;
    this.publicKey = credentials.publicKey || null;
    this.webhookUser = credentials.webhookUser || null;
    this.webhookPassword = credentials.webhookPassword || null;
    this.fetchImpl = credentials.fetchImpl || globalThis.fetch;
  }

  get name() {
    return "pagarme";
  }

  get supportedMethods() {
    return ["pix", "card", "boleto"];
  }

  get supportedCurrencies() {
    return ["BRL"];
  }

  get supportsRecurring() {
    return true;
  }

  async _request(method, path, body, extraHeaders = null) {
    if (!this.secretKey) {
      throw new Error("Pagar.me is not configured: add the account's secret key before taking payments.");
    }
    const auth = Buffer.from(`${this.secretKey}:`).toString("base64");

    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${BASE_URL}${path}`,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(extraHeaders || {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      { gateway: "Pagar.me" }
    );

    const data = await readJsonSafely(response);

    if (!response.ok) {
      // Error shape: { message, errors: { field: ["message"] } }. Only the
      // messages are read, never the values, which can hold card data.
      const parts = [];
      if (data && data.message) parts.push(String(data.message));
      if (data && data.errors && typeof data.errors === "object") {
        for (const messages of Object.values(data.errors)) {
          if (Array.isArray(messages)) parts.push(...messages.map(String));
        }
      }
      const error = new Error(
        `Pagar.me answered HTTP ${response.status}: ${parts.length ? parts.join(" | ") : "no detail given"}`
      );
      error.httpStatus = response.status;
      throw error;
    }
    return data;
  }

  // -------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------

  // A REGISTERED boleto needs the payer's name, document and full address, so
  // the address is built from the postal code and house number the checkout
  // collected.
  async ensureCustomer(customer) {
    const payload = {
      name: customer.name || customer.email,
      email: customer.email,
      ...documentFields(customer.document),
    };
    const phones = phoneFields(customer.phone);
    if (phones) payload.phones = phones;

    const address = await this._buildAddress(customer);
    if (address) payload.address = address;

    const created = await this._request("POST", "/customers", payload);
    return { customerId: created.id };
  }

  async _buildAddress(customer) {
    const postalCode = digits(customer && customer.postal_code);
    const number = String((customer && customer.address_number) || "").trim();
    if (postalCode.length !== 8 || !number) return null;

    const found = await addressLookup.lookup(postalCode, this.fetchImpl);
    if (!found) return null;

    return {
      line_1: [number, found.street, found.district].filter(Boolean).join(", "),
      zip_code: postalCode,
      city: found.city,
      state: found.state,
      country: "BR",
    };
  }

  // UPDATES THE ADDRESS OF A CUSTOMER THAT ALREADY EXISTS.
  //
  // The scenario: someone pays by Pix, where the checkout does not ask for an
  // address, so the Pagar.me customer is created without one. Weeks later they
  // come back and choose boleto, the checkout now asks, they fill it in, and
  // the value is written to OUR database and never leaves it, because the
  // gateway customer already exists and ensureCustomer never runs again.
  //
  // A registered boleto needs the payer's address, so they read "the payment
  // could not be started" and would read it forever, because retrying does not
  // fix it.
  //
  // IT NEVER FAILS A SALE: if the update fails, the order goes on with the
  // record that was already there.
  async updateCustomerAddress(customerId, customer) {
    if (!customerId) return false;
    const address = await this._buildAddress(customer);
    if (!address) return false;
    try {
      await this._request("PUT", `/customers/${encodeURIComponent(customerId)}`, { address });
      return true;
    } catch (err) {
      console.error("[pagarme] Could not update the customer address:", err.message);
      return false;
    }
  }

  // Saves the card on the customer and returns the card_id. The API
  // deduplicates, so sending the same card twice returns the existing id.
  async _saveCard(customerId, card) {
    const { exp_month, exp_year } = expiryFields(card.expiry);
    const saved = await this._request("POST", `/customers/${encodeURIComponent(customerId)}/cards`, {
      number: digits(card.number),
      holder_name: String(card.holderName || "").trim(),
      exp_month,
      exp_year,
      cvv: String(card.cvv || "").trim(),
    });
    return saved.id;
  }

  // -------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------

  async _createOrder({ order, customerId, payment }) {
    // The idempotency key is the order's public id: the same request repeated,
    // by a network retry or our own timeout, returns the same order for 24
    // hours instead of charging the card twice.
    const created = await this._request(
      "POST",
      "/orders",
      {
        code: order.publicId,
        closed: true,
        customer_id: customerId,
        items: [
          {
            amount: order.amountCents, // cents, no conversion
            description: order.description,
            quantity: 1,
            code: order.publicId,
          },
        ],
        payments: [payment],
      },
      { "Idempotency-key": String(order.publicId) }
    );

    const charge = (created.charges && created.charges[0]) || null;
    if (!charge) {
      const error = new Error("Pagar.me returned an order with no charge on it.");
      error.httpStatus = 502;
      throw error;
    }
    return charge;
  }

  async _toCharge(charge, { cardToken, method } = {}) {
    const transaction = charge.last_transaction || {};
    const status = normalizeStatus(charge.status);
    const result = { gatewayChargeId: charge.id, status };

    if (status === "refused") {
      result.refusalReason =
        transaction.acquirer_message || transaction.gateway_response_message || "The card was declined.";
    }

    if (method === "card") {
      result.cardToken = cardToken || (transaction.card && transaction.card.id) || undefined;
      if (transaction.card) {
        result.cardBrand = String(transaction.card.brand || "").toLowerCase() || undefined;
        result.cardLast4 = transaction.card.last_four_digits || undefined;
      }
    }

    if (method === "pix") {
      // v5 does not return the QR as base64, only a hosted URL, so it is drawn
      // here from the copy and paste string. Every adapter hands the page the
      // same thing, which is what keeps the page free of per-gateway branches.
      let qrCodeBase64 = null;
      if (transaction.qr_code) {
        try {
          const dataUrl = await QRCode.toDataURL(transaction.qr_code, { margin: 1, width: 440 });
          qrCodeBase64 = dataUrl.split(",")[1] || null;
        } catch (err) {
          console.warn("[pagarme] Could not draw the Pix QR code:", err.message);
        }
      }
      result.pix = {
        qrCodeBase64,
        copyPaste: transaction.qr_code || null,
        expiresAt:
          transaction.expires_at || new Date(Date.now() + PIX_EXPIRES_SECONDS * 1000).toISOString(),
      };
    }

    if (method === "boleto") {
      result.boleto = {
        url: transaction.url || transaction.pdf || null,
        // `line` is the typeable line, which is what a buyer copies; `barcode`
        // is the machine readable one.
        barcode: transaction.line || transaction.barcode || null,
        dueDate: transaction.due_at ? String(transaction.due_at).slice(0, 10) : null,
      };
    }

    return result;
  }

  async createCharge({ order, customer, customerId, card }) {
    let payment;
    let cardToken;

    if (order.method === "card") {
      // Save the card first, then charge with the id alone, so the number and
      // CVV cross once rather than being part of the order payload.
      cardToken = await this._saveCard(customerId, card);
      payment = {
        payment_method: "credit_card",
        credit_card: { installments: order.installments || 1, card_id: cardToken },
      };
    } else if (order.method === "pix") {
      payment = { payment_method: "pix", pix: { expires_in: PIX_EXPIRES_SECONDS } };
    } else if (order.method === "boleto") {
      // The customer may predate the address the checkout just collected.
      await this.updateCustomerAddress(customerId, customer);
      const dueAt = new Date(Date.now() + BOLETO_DUE_DAYS * 24 * 60 * 60 * 1000);
      payment = { payment_method: "boleto", boleto: { due_at: dueAt.toISOString() } };
    } else {
      throw new Error(`Pagar.me cannot take this payment method: ${order.method}`);
    }

    const charge = await this._createOrder({ order, customerId, payment });
    return this._toCharge(charge, { cardToken, method: order.method });
  }

  async chargeWithToken({ order, customerId, cardToken }) {
    const payment = {
      payment_method: "credit_card",
      credit_card: { installments: order.installments || 1, card_id: cardToken },
    };
    const charge = await this._createOrder({ order, customerId, payment });
    return this._toCharge(charge, { cardToken, method: "card" });
  }

  async getChargeStatus(gatewayChargeId) {
    const charge = await this._request("GET", `/charges/${encodeURIComponent(gatewayChargeId)}`);
    // paid_amount is what ARRIVED; amount is what was asked for. The first is
    // the honest answer when both exist, and it is what catches an underpaid
    // charge.
    const paid = typeof charge.paid_amount === "number" ? charge.paid_amount : null;
    const asked = typeof charge.amount === "number" ? charge.amount : null;
    return {
      status: normalizeStatus(charge.status),
      paidAt: charge.paid_at || null,
      amountCents: paid !== null ? paid : asked,
      currency: String(charge.currency || "BRL").toUpperCase(),
    };
  }

  // DELETE /charges/{id}, optional body { amount }. Without an amount Pagar.me
  // refunds in full. As everywhere else, this only sends the order: the
  // charge.refunded webhook is what closes the loop.
  async refund(gatewayChargeId, { amountCents = null } = {}) {
    const body = amountCents ? { amount: Math.round(Number(amountCents)) } : undefined;
    const response = await this._request(
      "DELETE",
      `/charges/${encodeURIComponent(gatewayChargeId)}`,
      body
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

  // Basic auth, with a user and password set in the Pagar.me dashboard.
  //
  // With nothing configured this REFUSES, in every environment. An earlier
  // version of this returned true outside production, which meant a deploy
  // that forgot NODE_ENV accepted any POST to the webhook URL and let anybody
  // mark an order paid without paying.
  verifyWebhook(req) {
    if (!this.webhookUser && !this.webhookPassword) return false;
    const expected = `Basic ${Buffer.from(
      `${this.webhookUser || ""}:${this.webhookPassword || ""}`
    ).toString("base64")}`;
    const given = (req && req.headers && req.headers.authorization) || "";
    return safeEqual(given, expected);
  }

  // Body shape: { id: "hook_...", type: "charge.paid", data: { ...charge } }
  parseWebhook(req) {
    let body = req ? req.body : null;
    if ((!body || !body.type) && req && req.rawBody) {
      try {
        body = JSON.parse(req.rawBody);
      } catch {
        return null;
      }
    }
    if (!body || !body.id || !body.type) return null;

    const eventType = String(body.type);
    const data = body.data || {};
    const isCharge = eventType.startsWith("charge.");

    // chargeback.received carries the charge under one of three shapes; the
    // exact one is not documented, so all three are covered.
    const chargebackChargeId =
      eventType === "chargeback.received"
        ? data.charge_id || (data.charge && data.charge.id) || data.id || null
        : null;

    // OUR id comes back, because the order and its item were both created with
    // `code: order.publicId`. It is the rescue path for a charge whose
    // creation response was lost: without it the buyer pays, the money lands
    // in the merchant's account, and the order stays pending forever with
    // nothing to link the two.
    const ourId =
      data.code ||
      (data.order && data.order.code) ||
      (Array.isArray(data.items) && data.items[0] && data.items[0].code) ||
      null;

    const amount =
      typeof data.paid_amount === "number"
        ? data.paid_amount
        : typeof data.amount === "number"
        ? data.amount
        : null;

    return {
      eventId: String(body.id),
      eventType,
      gatewayChargeId: isCharge && data.id ? String(data.id) : chargebackChargeId ? String(chargebackChargeId) : null,
      externalReference: ourId ? String(ourId) : null,
      status: EVENT_STATUS[eventType] || null,
      amountCents: amount,
      currency: String(data.currency || "BRL").toUpperCase(),
    };
  }
}

module.exports = PagarmeGateway;
module.exports.CHARGE_STATUS = CHARGE_STATUS;
module.exports.EVENT_STATUS = EVENT_STATUS;
