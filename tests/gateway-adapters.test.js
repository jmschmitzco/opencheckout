// The gateway adapters, tested without a network.
//
// Every one of these asserts a rule that costs money when it is wrong, not
// that the code calls the function it calls. The fake fetch records what was
// sent, because what is sent to a payment processor IS the behaviour.
const crypto = require("crypto");

const AsaasGateway = require("../src/gateways/asaas");
const PagarmeGateway = require("../src/gateways/pagarme");
const MercadoPagoGateway = require("../src/gateways/mercadopago");
const PaypalGateway = require("../src/gateways/paypal");
const { capabilitiesOf, gatewaysForMethod } = require("../src/gateways");

// A fetch that answers from a script of responses and records every call.
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, options = {}) => {
    // Not every body is JSON: an OAuth token request is form encoded.
    let parsed = null;
    if (options.body) {
      try {
        parsed = JSON.parse(options.body);
      } catch {
        parsed = { raw: String(options.body) };
      }
    }
    calls.push({
      url: String(url),
      method: options.method || "GET",
      headers: options.headers || {},
      body: parsed,
      rawBody: options.body || null,
    });
    const entry = script.find((s) => s.match(String(url), options)) || script[script.length - 1];
    if (!entry) throw new Error(`No scripted response for ${url}`);
    return {
      ok: entry.status ? entry.status < 400 : true,
      status: entry.status || 200,
      json: async () => entry.body,
      text: async () => (entry.body === undefined ? "" : JSON.stringify(entry.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

const on = (fragment, body, status) => ({
  match: (url) => url.includes(fragment),
  body,
  status,
});

const CUSTOMER = {
  id: 1,
  public_id: "cus_test",
  name: "Ada Lovelace",
  email: "ada@example.com",
  document: "52998224725",
  phone: "11988887777",
  postal_code: "01310100",
  address_number: "100",
};

const ORDER = {
  id: 1,
  publicId: "ord_abc123xyz",
  amountCents: 9900,
  currency: "BRL",
  description: "Pro plan",
  installments: 1,
  method: "card",
  remoteIp: "203.0.113.9",
};

const CARD = { number: "4242424242424242", holderName: "Ada Lovelace", expiry: "12/34", cvv: "123" };

// ===========================================================================
describe("capabilities", () => {
  test("each adapter declares what it can take", () => {
    expect(capabilitiesOf("asaas").methods).toEqual(["pix", "card", "boleto"]);
    expect(capabilitiesOf("pagarme").methods).toEqual(["pix", "card", "boleto"]);
    expect(capabilitiesOf("paypal").methods).toEqual(["paypal"]);
  });

  test("Mercado Pago does not offer card, because the page cannot tokenize yet", () => {
    // Offering it would mean a buyer choosing card, filling the form in, and
    // only then discovering that the browser never produced a token.
    expect(capabilitiesOf("mercadopago").methods).not.toContain("card");
    expect(capabilitiesOf("mercadopago").methods).toEqual(["pix", "boleto"]);
  });

  test("a gateway that cannot store a credential cannot carry a subscription", () => {
    expect(capabilitiesOf("mercadopago").supportsRecurring).toBe(false);
    expect(capabilitiesOf("paypal").supportsRecurring).toBe(false);
    expect(capabilitiesOf("asaas").supportsRecurring).toBe(true);
    expect(capabilitiesOf("pagarme").supportsRecurring).toBe(true);
  });

  test("only PayPal takes the buyer away", () => {
    expect(capabilitiesOf("paypal").usesRedirect).toBe(true);
    expect(capabilitiesOf("asaas").usesRedirect).toBe(false);
  });

  test("routing picks a gateway that can actually take the method", () => {
    expect(gatewaysForMethod("pix")).toEqual(["asaas", "pagarme", "mercadopago"]);
    expect(gatewaysForMethod("paypal")).toEqual(["paypal"]);
    expect(gatewaysForMethod("card")).toEqual(["asaas", "pagarme"]);
  });
});

// ===========================================================================
describe("Asaas", () => {
  const credentials = { apiKey: "test-key", webhookToken: "token-abc", environment: "sandbox" };

  test("refuses to work without an API key, with a sentence a merchant can act on", async () => {
    const gateway = new AsaasGateway({});
    await expect(gateway.getChargeStatus("pay_1")).rejects.toThrow(/not configured/i);
  });

  test("sandbox and production are different hosts", () => {
    expect(new AsaasGateway({ apiKey: "k", environment: "sandbox" }).baseUrl).toContain("sandbox");
    expect(new AsaasGateway({ apiKey: "k" }).baseUrl).not.toContain("sandbox");
  });

  describe("amounts", () => {
    test("sends decimal reais, not cents", async () => {
      const fetchImpl = fakeFetch([on("/payments", { id: "pay_1", status: "CONFIRMED" })]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      await gateway.createCharge({ order: ORDER, customer: CUSTOMER, customerId: "cus_1", card: CARD });

      const body = fetchImpl.calls[0].body;
      // 9900 cents is 99 reais. Sending 9900 would charge a hundred times too
      // much, and it is the single easiest mistake to make against this API.
      expect(body.value).toBe(99);
    });

    test("an instalment plan sends the TOTAL, not the per-instalment amount", async () => {
      const fetchImpl = fakeFetch([on("/payments", { id: "pay_1", status: "CONFIRMED" })]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      await gateway.createCharge({
        order: { ...ORDER, installments: 3 },
        customer: CUSTOMER,
        customerId: "cus_1",
        card: CARD,
      });

      const body = fetchImpl.calls[0].body;
      // With `value` and a count, Asaas reads it as the amount PER instalment
      // and the buyer is charged three times the price.
      expect(body.totalValue).toBe(99);
      expect(body.value).toBeUndefined();
      expect(body.installmentCount).toBe(3);
    });
  });

  describe("customers", () => {
    test("looks an existing customer up by tax id instead of duplicating", async () => {
      const fetchImpl = fakeFetch([
        on("/customers?cpfCnpj=", { data: [{ id: "cus_existing" }] }),
        on("/customers", { id: "cus_new" }),
      ]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      const result = await gateway.ensureCustomer(CUSTOMER);

      expect(result.customerId).toBe("cus_existing");
      expect(fetchImpl.calls.length).toBe(1);
    });

    test("without a tax id it creates rather than searching", async () => {
      // An empty "?cpfCnpj=" filter makes Asaas return the account's whole
      // customer list, and taking the first row would attach this order to a
      // stranger's record.
      const fetchImpl = fakeFetch([on("/customers", { id: "cus_new" })]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      await gateway.ensureCustomer({ ...CUSTOMER, document: null });

      expect(fetchImpl.calls.length).toBe(1);
      expect(fetchImpl.calls[0].method).toBe("POST");
      expect(fetchImpl.calls[0].url).not.toContain("cpfCnpj=");
    });
  });

  describe("Pix", () => {
    test("checks the copy and paste code before handing it to the page", async () => {
      // A truncated payload would go out as it is, and the buyer would only
      // find out in their bank app, reading "invalid code".
      const fetchImpl = fakeFetch([
        on("/pixQrCode", { payload: "too-short", encodedImage: "x" }),
        on("/payments", { id: "pay_1", status: "PENDING" }),
      ]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      await expect(
        gateway.createCharge({ order: { ...ORDER, method: "pix" }, customer: CUSTOMER, customerId: "c" })
      ).rejects.toThrow(/incomplete Pix code/i);
    });

    test("retries once before giving up", async () => {
      let attempt = 0;
      const fetchImpl = fakeFetch([
        {
          match: (url) => url.includes("/pixQrCode"),
          get body() {
            attempt += 1;
            return attempt === 1
              ? { payload: "short", encodedImage: "x" }
              : { payload: "0".repeat(120), encodedImage: "base64here", expirationDate: "2026-01-01" };
          },
        },
        on("/payments", { id: "pay_1", status: "PENDING" }),
      ]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      const charge = await gateway.createCharge({
        order: { ...ORDER, method: "pix" },
        customer: CUSTOMER,
        customerId: "c",
      });

      expect(charge.pix.copyPaste.length).toBeGreaterThan(100);
      expect(charge.pix.qrCodeBase64).toBe("base64here");
    });

    test("falls due in two days, not today", async () => {
      // A Pix generated at 11pm with a due date of today was dead by morning,
      // and an expired order also drops out of the recovery queue.
      const fetchImpl = fakeFetch([
        on("/pixQrCode", { payload: "0".repeat(120), encodedImage: "x" }),
        on("/payments", { id: "pay_1", status: "PENDING" }),
      ]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      await gateway.createCharge({ order: { ...ORDER, method: "pix" }, customer: CUSTOMER, customerId: "c" });

      const dueDate = new Date(`${fetchImpl.calls[0].body.dueDate}T12:00:00Z`);
      const today = new Date();
      const days = Math.round((dueDate - today) / 86400000);
      expect(days).toBeGreaterThanOrEqual(1);
    });
  });

  test("a boleto still goes out when the typeable line cannot be read", async () => {
    // The charge already exists; throwing here would lose it.
    const fetchImpl = fakeFetch([
      on("/identificationField", { message: "nope" }, 500),
      on("/payments", { id: "pay_1", status: "PENDING", bankSlipUrl: "https://x.test/b" }),
    ]);
    const gateway = new AsaasGateway({ ...credentials, fetchImpl });
    const charge = await gateway.createCharge({
      order: { ...ORDER, method: "boleto" },
      customer: CUSTOMER,
      customerId: "c",
    });

    expect(charge.gatewayChargeId).toBe("pay_1");
    expect(charge.boleto.url).toBe("https://x.test/b");
    expect(charge.boleto.barcode).toBeNull();
  });

  describe("status mapping", () => {
    test.each([
      ["CONFIRMED", "paid"],
      ["RECEIVED", "paid"],
      ["PENDING", "pending"],
      ["OVERDUE", "expired"],
      ["REFUNDED", "refunded"],
      ["CHARGEBACK_REQUESTED", "chargeback"],
    ])("%s is %s", (asaas, expected) => {
      expect(AsaasGateway.STATUS_MAP[asaas]).toBe(expected);
    });

    test("a refund REQUESTED is still paid", () => {
      // Asaas can deny it, for instance a Pix refund with no balance. Marking
      // the order refunded now would cut off a buyer over a refund that may
      // never happen.
      expect(AsaasGateway.STATUS_MAP.REFUND_REQUESTED).toBe("paid");
      expect(AsaasGateway.STATUS_MAP.REFUND_IN_PROGRESS).toBe("paid");
    });

    test("an unknown status is pending, never paid", async () => {
      const fetchImpl = fakeFetch([on("/payments/", { id: "p", status: "SOMETHING_NEW" })]);
      const gateway = new AsaasGateway({ ...credentials, fetchImpl });
      const status = await gateway.getChargeStatus("pay_1");
      expect(status.status).toBe("pending");
    });
  });

  describe("webhooks", () => {
    test("rejects everything when no token is configured", () => {
      const gateway = new AsaasGateway({ apiKey: "k" });
      expect(gateway.verifyWebhook({ headers: { "asaas-access-token": "anything" } })).toBe(false);
    });

    test("accepts only the configured token", () => {
      const gateway = new AsaasGateway(credentials);
      expect(gateway.verifyWebhook({ headers: { "asaas-access-token": "token-abc" } })).toBe(true);
      expect(gateway.verifyWebhook({ headers: { "asaas-access-token": "token-abd" } })).toBe(false);
      expect(gateway.verifyWebhook({ headers: {} })).toBe(false);
    });

    test("carries our own id back, which is the rescue path for an orphan charge", () => {
      const gateway = new AsaasGateway(credentials);
      const event = gateway.parseWebhook({
        body: {
          id: "evt_1",
          event: "PAYMENT_CONFIRMED",
          payment: { id: "pay_1", externalReference: "ord_abc123xyz", value: 99 },
        },
      });

      expect(event.status).toBe("paid");
      expect(event.gatewayChargeId).toBe("pay_1");
      expect(event.externalReference).toBe("ord_abc123xyz");
      expect(event.amountCents).toBe(9900);
    });

    test("does not offer an amount to compare on an instalment plan", () => {
      // Asaas reports `value` PER INSTALMENT there, so comparing it to the
      // order total would flag every legitimate instalment sale.
      const gateway = new AsaasGateway(credentials);
      const event = gateway.parseWebhook({
        body: {
          id: "evt_2",
          event: "PAYMENT_CONFIRMED",
          payment: { id: "pay_2", value: 33, installmentCount: 3 },
        },
      });
      expect(event.amountCents).toBeNull();
    });

    test("an informational event moves nothing", () => {
      const gateway = new AsaasGateway(credentials);
      for (const type of ["PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_BANK_SLIP_VIEWED"]) {
        const event = gateway.parseWebhook({ body: { id: "e", event: type, payment: { id: "p" } } });
        expect(event.status).toBeNull();
      }
    });
  });
});

// ===========================================================================
describe("Pagar.me", () => {
  const credentials = {
    secretKey: "sk_test",
    webhookUser: "hook",
    webhookPassword: "secret",
  };

  test("CANCELED IS NOT A REFUND", () => {
    // The expensive one. Pagar.me marks a charge `canceled` when a Pix simply
    // expired unpaid. Reading that as a refund created refunds in the
    // statement for sales that never happened, told integrations the order was
    // refunded, and emailed people who had never paid to say their money was
    // coming back.
    expect(PagarmeGateway.CHARGE_STATUS.canceled).toBe("expired");
    expect(PagarmeGateway.EVENT_STATUS["charge.refunded"]).toBe("refunded");
  });

  test("underpaid does not release the order", () => {
    expect(PagarmeGateway.CHARGE_STATUS.underpaid).toBe("pending");
    expect(PagarmeGateway.CHARGE_STATUS.overpaid).toBe("paid");
  });

  test("amounts stay in cents, with no conversion", async () => {
    const fetchImpl = fakeFetch([
      on("/cards", { id: "card_1" }),
      on("/orders", { charges: [{ id: "ch_1", status: "paid", last_transaction: {} }] }),
    ]);
    const gateway = new PagarmeGateway({ ...credentials, fetchImpl });
    await gateway.createCharge({ order: ORDER, customer: CUSTOMER, customerId: "cus_1", card: CARD });

    const orderCall = fetchImpl.calls.find((c) => c.url.endsWith("/orders"));
    expect(orderCall.body.items[0].amount).toBe(9900);
  });

  test("the card is saved first, so the number is not part of the order payload", async () => {
    const fetchImpl = fakeFetch([
      on("/cards", { id: "card_1" }),
      on("/orders", { charges: [{ id: "ch_1", status: "paid", last_transaction: {} }] }),
    ]);
    const gateway = new PagarmeGateway({ ...credentials, fetchImpl });
    const charge = await gateway.createCharge({
      order: ORDER,
      customer: CUSTOMER,
      customerId: "cus_1",
      card: CARD,
    });

    const orderCall = fetchImpl.calls.find((c) => c.url.endsWith("/orders"));
    expect(JSON.stringify(orderCall.body)).not.toContain("4242424242424242");
    expect(orderCall.body.payments[0].credit_card.card_id).toBe("card_1");
    expect(charge.cardToken).toBe("card_1");
  });

  test("sends an idempotency key, so a retry is not a second charge", async () => {
    const fetchImpl = fakeFetch([
      on("/cards", { id: "card_1" }),
      on("/orders", { charges: [{ id: "ch_1", status: "paid", last_transaction: {} }] }),
    ]);
    const gateway = new PagarmeGateway({ ...credentials, fetchImpl });
    await gateway.createCharge({ order: ORDER, customer: CUSTOMER, customerId: "c", card: CARD });

    const orderCall = fetchImpl.calls.find((c) => c.url.endsWith("/orders"));
    expect(orderCall.headers["Idempotency-key"]).toBe("ord_abc123xyz");
    expect(orderCall.body.code).toBe("ord_abc123xyz");
  });

  test("draws the Pix QR itself, because v5 only returns a hosted URL", async () => {
    const fetchImpl = fakeFetch([
      on("/orders", {
        charges: [
          {
            id: "ch_1",
            status: "pending",
            last_transaction: { qr_code: "00020126580014BR.GOV.BCB.PIX" + "0".repeat(90) },
          },
        ],
      }),
    ]);
    const gateway = new PagarmeGateway({ ...credentials, fetchImpl });
    const charge = await gateway.createCharge({
      order: { ...ORDER, method: "pix" },
      customer: CUSTOMER,
      customerId: "c",
    });

    expect(charge.pix.copyPaste).toContain("BR.GOV.BCB.PIX");
    expect(charge.pix.qrCodeBase64).toBeTruthy();
    expect(charge.pix.qrCodeBase64).not.toContain("data:");
  });

  test("reports what ARRIVED, not what was asked for", async () => {
    const fetchImpl = fakeFetch([
      on("/charges/", { id: "ch_1", status: "underpaid", amount: 9900, paid_amount: 5000 }),
    ]);
    const gateway = new PagarmeGateway({ ...credentials, fetchImpl });
    const status = await gateway.getChargeStatus("ch_1");

    expect(status.amountCents).toBe(5000);
    expect(status.status).toBe("pending");
  });

  describe("webhooks", () => {
    test("rejects everything when no credentials are configured", () => {
      const gateway = new PagarmeGateway({ secretKey: "sk" });
      expect(gateway.verifyWebhook({ headers: { authorization: "Basic anything" } })).toBe(false);
    });

    test("accepts only the configured Basic auth", () => {
      const gateway = new PagarmeGateway(credentials);
      const good = `Basic ${Buffer.from("hook:secret").toString("base64")}`;
      const bad = `Basic ${Buffer.from("hook:wrong").toString("base64")}`;
      expect(gateway.verifyWebhook({ headers: { authorization: good } })).toBe(true);
      expect(gateway.verifyWebhook({ headers: { authorization: bad } })).toBe(false);
    });

    test("recovers our id from the order, the item or the code", () => {
      const gateway = new PagarmeGateway(credentials);
      const event = gateway.parseWebhook({
        body: {
          id: "hook_1",
          type: "charge.paid",
          data: { id: "ch_1", code: "ord_abc123xyz", amount: 9900, paid_amount: 9900 },
        },
      });
      expect(event.gatewayChargeId).toBe("ch_1");
      expect(event.externalReference).toBe("ord_abc123xyz");
      expect(event.amountCents).toBe(9900);
      expect(event.status).toBe("paid");
    });

    test("a chargeback notification still finds its charge", () => {
      const gateway = new PagarmeGateway(credentials);
      const event = gateway.parseWebhook({
        body: { id: "hook_2", type: "chargeback.received", data: { charge_id: "ch_9" } },
      });
      expect(event.gatewayChargeId).toBe("ch_9");
      expect(event.status).toBe("chargeback");
    });
  });
});

// ===========================================================================
describe("Mercado Pago", () => {
  const credentials = { accessToken: "APP_USR-token", webhookSecret: "hook-secret" };

  test("its notification carries no status, so the handler must ask", () => {
    expect(new MercadoPagoGateway(credentials).statusFromQuery).toBe(true);
    const event = new MercadoPagoGateway(credentials).parseWebhook({
      body: { type: "payment", action: "payment.updated", data: { id: "123" } },
    });
    expect(event.status).toBeNull();
    expect(event.gatewayChargeId).toBe("123");
  });

  test("sends the amount as a decimal string", async () => {
    const fetchImpl = fakeFetch([
      on("/v1/orders", { id: "ord_mp", status: "action_required", transactions: { payments: [{}] } }),
    ]);
    const gateway = new MercadoPagoGateway({ ...credentials, fetchImpl });
    await gateway.createCharge({ order: { ...ORDER, method: "pix" }, customer: CUSTOMER });

    expect(fetchImpl.calls[0].body.total_amount).toBe("99.00");
    expect(fetchImpl.calls[0].headers["X-Idempotency-Key"]).toBe("order-ord_abc123xyz");
  });

  test("a boleto without a CPF is refused before the call is spent", async () => {
    const fetchImpl = fakeFetch([on("/v1/orders", {})]);
    const gateway = new MercadoPagoGateway({ ...credentials, fetchImpl });
    await expect(
      gateway.createCharge({
        order: { ...ORDER, method: "boleto" },
        customer: { ...CUSTOMER, document: null },
      })
    ).rejects.toThrow(/CPF/);
    expect(fetchImpl.calls.length).toBe(0);
  });

  test("a card without a browser token says exactly that", async () => {
    const gateway = new MercadoPagoGateway({ ...credentials, fetchImpl: fakeFetch([on("/", {})]) });
    await expect(
      gateway.createCharge({ order: ORDER, customer: CUSTOMER, card: {} })
    ).rejects.toThrow(/tokenized in the browser/i);
  });

  test("turns a decline code into something a buyer can act on", async () => {
    const fetchImpl = fakeFetch([
      on("/v1/orders", {
        id: "ord_mp",
        status: "failed",
        status_detail: "cc_rejected_bad_filled_security_code",
        transactions: { payments: [{}] },
      }),
    ]);
    const gateway = new MercadoPagoGateway({ ...credentials, fetchImpl });
    const charge = await gateway.createCharge({
      order: { ...ORDER, method: "pix" },
      customer: CUSTOMER,
    });

    expect(charge.status).toBe("refused");
    expect(charge.refusalReason).toBe("The security code is incorrect.");
    // The raw code never reaches the buyer.
    expect(charge.refusalReason).not.toContain("cc_rejected");
  });

  test("a partial refund still counts as paid", () => {
    expect(MercadoPagoGateway.mapStatus("processed", "partially_refunded")).toBe("paid");
    expect(MercadoPagoGateway.mapStatus("processed")).toBe("paid");
    expect(MercadoPagoGateway.mapStatus("canceled")).toBe("expired");
  });

  describe("webhook signature", () => {
    const secret = "hook-secret";

    function signed({ id = "123", ts = Math.floor(Date.now() / 1000), requestId = "req-1" } = {}) {
      const manifest = `id:${id};request-id:${requestId};ts:${ts};`;
      const v1 = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
      return {
        headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
        query: { "data.id": id },
        body: { type: "payment", data: { id } },
      };
    }

    test("accepts a correctly signed notification", () => {
      const gateway = new MercadoPagoGateway(credentials);
      expect(gateway.verifyWebhook(signed())).toBe(true);
    });

    test("rejects a tampered signature", () => {
      const gateway = new MercadoPagoGateway(credentials);
      const req = signed();
      req.headers["x-signature"] = req.headers["x-signature"].replace(/v1=./, "v1=0");
      expect(gateway.verifyWebhook(req)).toBe(false);
    });

    test("rejects a replay from an hour ago", () => {
      // The timestamp is part of what is signed, so without an age check a
      // captured notification stays valid forever.
      const gateway = new MercadoPagoGateway(credentials);
      expect(gateway.verifyWebhook(signed({ ts: Math.floor(Date.now() / 1000) - 3600 }))).toBe(false);
    });

    test("rejects everything when no secret is configured", () => {
      const gateway = new MercadoPagoGateway({ accessToken: "t" });
      expect(gateway.verifyWebhook(signed())).toBe(false);
    });
  });
});

// ===========================================================================
describe("PayPal", () => {
  const credentials = {
    clientId: "client",
    secret: "secret",
    webhookId: "WH-1",
    environment: "sandbox",
    returnUrl: "https://pay.test/payments/paypal/return",
    cancelUrl: "https://pay.test/payments/paypal/cancel",
  };

  const tokenResponse = on("/oauth2/token", { access_token: "tok", expires_in: 32400 });

  test("APPROVED IS NOT PAID", () => {
    // Treating it as paid releases products for an authorization that was
    // never captured, which expires quietly a few days later.
    expect(PaypalGateway.ORDER_STATUS.APPROVED).toBe("pending");
    expect(PaypalGateway.ORDER_STATUS.COMPLETED).toBe("paid");
    expect(PaypalGateway.EVENT_STATUS["CHECKOUT.ORDER.APPROVED"]).toBeNull();
    expect(PaypalGateway.EVENT_STATUS["PAYMENT.CAPTURE.COMPLETED"]).toBe("paid");
  });

  test("amounts are built from integers, never a float", () => {
    expect(PaypalGateway.toDecimal(9900)).toBe("99.00");
    expect(PaypalGateway.toDecimal(1)).toBe("0.01");
    expect(PaypalGateway.toDecimal(100000)).toBe("1000.00");
    expect(PaypalGateway.toCents("99.00")).toBe(9900);
    expect(PaypalGateway.toCents("0.01")).toBe(1);
    expect(PaypalGateway.toCents("not a number")).toBeNull();
  });

  test("a charge comes back pending with a redirect, never paid", async () => {
    const fetchImpl = fakeFetch([
      tokenResponse,
      on("/v2/checkout/orders", {
        id: "PP-1",
        status: "PAYER_ACTION_REQUIRED",
        links: [{ rel: "payer-action", href: "https://paypal.test/approve" }],
      }),
    ]);
    const gateway = new PaypalGateway({ ...credentials, fetchImpl });
    const charge = await gateway.createCharge({ order: { ...ORDER, method: "paypal" } });

    expect(charge.status).toBe("pending");
    expect(charge.redirect.url).toBe("https://paypal.test/approve");
    expect(charge.gatewayChargeId).toBe("PP-1");
  });

  test("finds the approval link under either name the docs use", async () => {
    // Looking for only one returns undefined and stalls the checkout.
    const fetchImpl = fakeFetch([
      tokenResponse,
      on("/v2/checkout/orders", {
        id: "PP-2",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://paypal.test/other" }],
      }),
    ]);
    const gateway = new PaypalGateway({ ...credentials, fetchImpl });
    const charge = await gateway.createCharge({ order: { ...ORDER, method: "paypal" } });
    expect(charge.redirect.url).toBe("https://paypal.test/other");
  });

  test("ties the PayPal order to ours, so a notification can be reconciled", async () => {
    const fetchImpl = fakeFetch([
      tokenResponse,
      on("/v2/checkout/orders", {
        id: "PP-3",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://x.test" }],
      }),
    ]);
    const gateway = new PaypalGateway({ ...credentials, fetchImpl });
    await gateway.createCharge({ order: { ...ORDER, method: "paypal" } });

    const created = fetchImpl.calls.find((c) => c.url.includes("/v2/checkout/orders"));
    expect(created.body.purchase_units[0].custom_id).toBe("ord_abc123xyz");
    expect(created.headers["PayPal-Request-Id"]).toContain("oc-create-");
  });

  test("one click charging is refused outright", async () => {
    const gateway = new PaypalGateway(credentials);
    await expect(gateway.chargeWithToken({})).rejects.toThrow(/one-click/i);
  });

  test("a capture that already happened is a success, not an error", async () => {
    // The return route and the webhook race by design.
    const fetchImpl = fakeFetch([
      tokenResponse,
      {
        match: (url, options) => url.includes("/capture") && options.method === "POST",
        status: 422,
        body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
      },
      on("/v2/checkout/orders/", {
        id: "PP-4",
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: "CAP-1",
                  status: "COMPLETED",
                  create_time: "2026-01-01T00:00:00Z",
                  seller_receivable_breakdown: {
                    gross_amount: { value: "99.00", currency_code: "BRL" },
                    paypal_fee: { value: "4.50", currency_code: "BRL" },
                  },
                },
              ],
            },
          },
        ],
      }),
    ]);
    const gateway = new PaypalGateway({ ...credentials, fetchImpl });
    const captured = await gateway.captureIfApproved("PP-4");

    expect(captured.status).toBe("paid");
    expect(captured.captureId).toBe("CAP-1");
    expect(captured.amountCents).toBe(9900);
    expect(captured.feeCents).toBe(450);
  });

  test("an unreachable gateway is never read as paid", async () => {
    const fetchImpl = fakeFetch([tokenResponse, on("/v2/checkout/orders/", {}, 503)]);
    const gateway = new PaypalGateway({ ...credentials, fetchImpl });
    const status = await gateway.getChargeStatus("PP-5");
    expect(status.status).toBe("pending");
  });

  test("an order PayPal forgot is expired, not paid", async () => {
    const fetchImpl = fakeFetch([tokenResponse, on("/v2/checkout/orders/", {}, 404)]);
    const gateway = new PaypalGateway({ ...credentials, fetchImpl });
    expect((await gateway.getChargeStatus("PP-6")).status).toBe("expired");
  });

  describe("webhook verification", () => {
    test("rejects everything with no webhook id configured", async () => {
      const gateway = new PaypalGateway({ clientId: "c", secret: "s" });
      expect(await gateway.verifyWebhook({ headers: {}, rawBody: "{}" })).toBe(false);
    });

    test("refuses a certificate from a host that is not PayPal", async () => {
      // WITHOUT THIS an attacker points the cert url at their own server,
      // signs with their own key, and verification passes. It is not in the
      // documentation; it has to be added.
      const gateway = new PaypalGateway(credentials);
      const verified = await gateway.verifyWebhook({
        rawBody: "{}",
        headers: {
          "paypal-transmission-id": "t",
          "paypal-transmission-time": "2026-01-01T00:00:00Z",
          "paypal-transmission-sig": "sig",
          "paypal-cert-url": "https://evil.test/cert.pem",
          "paypal-auth-algo": "SHA256withRSA",
        },
      });
      expect(verified).toBe(false);
    });

    test("refuses a cert url that is not https", async () => {
      const gateway = new PaypalGateway(credentials);
      const verified = await gateway.verifyWebhook({
        rawBody: "{}",
        headers: {
          "paypal-transmission-id": "t",
          "paypal-transmission-time": "2026-01-01T00:00:00Z",
          "paypal-transmission-sig": "sig",
          "paypal-cert-url": "http://api.paypal.com/cert.pem",
          "paypal-auth-algo": "SHA256withRSA",
        },
      });
      expect(verified).toBe(false);
    });

    test("verifies a genuinely signed body", async () => {
      // A real RSA key pair, so this exercises the actual signature path
      // rather than a stub of it.
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = publicKey.export({ type: "spki", format: "pem" });

      const rawBody = JSON.stringify({ id: "WH-EVT", event_type: "PAYMENT.CAPTURE.COMPLETED" });
      const transmissionId = "trans-1";
      const transmissionTime = "2026-01-01T00:00:00Z";
      const message = `${transmissionId}|${transmissionTime}|WH-1|${PaypalGateway.crc32(rawBody)}`;
      const signature = crypto.createSign("SHA256").update(message).sign(privateKey, "base64");

      const fetchImpl = async () => ({ ok: true, status: 200, text: async () => pem });
      const gateway = new PaypalGateway({ ...credentials, fetchImpl });

      const verified = await gateway.verifyWebhook({
        rawBody,
        headers: {
          "paypal-transmission-id": transmissionId,
          "paypal-transmission-time": transmissionTime,
          "paypal-transmission-sig": signature,
          "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
          "paypal-auth-algo": "SHA256withRSA",
        },
      });
      expect(verified).toBe(true);
    });

    test("a tampered body does not verify", async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = publicKey.export({ type: "spki", format: "pem" });

      const rawBody = JSON.stringify({ id: "WH-EVT", amount: "1.00" });
      const message = `t|time|WH-1|${PaypalGateway.crc32(rawBody)}`;
      const signature = crypto.createSign("SHA256").update(message).sign(privateKey, "base64");

      const fetchImpl = async () => ({ ok: true, status: 200, text: async () => pem });
      const gateway = new PaypalGateway({ ...credentials, fetchImpl });

      const verified = await gateway.verifyWebhook({
        rawBody: JSON.stringify({ id: "WH-EVT", amount: "9999.00" }),
        headers: {
          "paypal-transmission-id": "t",
          "paypal-transmission-time": "time",
          "paypal-transmission-sig": signature,
          "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
          "paypal-auth-algo": "SHA256withRSA",
        },
      });
      expect(verified).toBe(false);
    });
  });

  describe("webhook parsing", () => {
    test("a capture notification yields the order, the capture and our id", async () => {
      const gateway = new PaypalGateway(credentials);
      const event = await gateway.parseWebhook({
        body: {
          id: "WH-1",
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: {
            id: "CAP-1",
            custom_id: "ord_abc123xyz",
            create_time: "2026-01-01T00:00:00Z",
            supplementary_data: { related_ids: { order_id: "PP-1" } },
            seller_receivable_breakdown: {
              gross_amount: { value: "99.00", currency_code: "BRL" },
              paypal_fee: { value: "4.50", currency_code: "BRL" },
            },
          },
        },
      });

      expect(event.status).toBe("paid");
      expect(event.gatewayChargeId).toBe("PP-1");
      expect(event.gatewayCaptureId).toBe("CAP-1");
      expect(event.externalReference).toBe("ord_abc123xyz");
      expect(event.amountCents).toBe(9900);
      expect(event.feeCents).toBe(450);
    });

    test("a refund names the capture through its up link, not resource.id", async () => {
      // resource.id is the REFUND id there. Using it as the capture sends the
      // handler looking for an order that does not exist anywhere.
      const gateway = new PaypalGateway(credentials);
      const event = await gateway.parseWebhook({
        body: {
          id: "WH-2",
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          resource: {
            id: "REF-1",
            amount: { value: "10.00", currency_code: "BRL" },
            links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP-9" }],
          },
        },
      });

      expect(event.status).toBe("refunded");
      expect(event.gatewayCaptureId).toBe("CAP-9");
      expect(event.refundCents).toBe(1000);
    });

    test("a dispute finds the capture inside the disputed transaction", async () => {
      const gateway = new PaypalGateway(credentials);
      const event = await gateway.parseWebhook({
        body: {
          id: "WH-3",
          event_type: "CUSTOMER.DISPUTE.CREATED",
          resource: {
            dispute_id: "DIS-1",
            disputed_transactions: [{ seller_transaction_id: "CAP-7", custom_id: "ord_abc123xyz" }],
          },
        },
      });

      expect(event.status).toBe("chargeback");
      expect(event.gatewayCaptureId).toBe("CAP-7");
      expect(event.externalReference).toBe("ord_abc123xyz");
    });
  });
});
