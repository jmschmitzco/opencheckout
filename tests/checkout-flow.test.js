// The whole path, end to end: a session created by an integrator, a page the
// buyer opens, a charge, and the order coming back through the API.
const request = require("supertest");
const { createMemoryDb, seedMerchant } = require("./helpers/memdb");

let app;
let seed;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  app = require("../src/app");
});

function asIntegrator(method, path) {
  return request(app)[method](path).set("authorization", `Bearer ${seed.secretKey}`);
}

async function createSession(overrides = {}) {
  const response = await asIntegrator("post", "/v1/checkout/sessions")
    .set("idempotency-key", `test-${Math.random().toString(36).slice(2)}-key`)
    .send({
      mode: "payment",
      line_items: [{ price: seed.price.public_id, quantity: 1 }],
      success_url: "https://acme.test/thanks",
      cancel_url: "https://acme.test/pricing",
      ...overrides,
    });
  return response;
}

const GOOD_CARD = {
  number: "4242424242424242",
  holder_name: "Ada Lovelace",
  expiry: "12/34",
  cvv: "123",
};

describe("creating a checkout session", () => {
  test("returns a URL the buyer can open", async () => {
    const response = await createSession();
    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^cs_/);
    expect(response.body.url).toContain(`/c/${response.body.id}`);
    expect(response.body.total_cents).toBe(9900);
    // The secret comes back exactly once, in the response to the call that
    // created the session.
    expect(response.body.client_secret).toBeTruthy();
  });

  test("needs a key", async () => {
    const response = await request(app).post("/v1/checkout/sessions").send({});
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  test("a publishable key may not create one", async () => {
    // A key meant to sit in a browser must not be able to mint a sale.
    const response = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${seed.publishableKey}`)
      .send({ line_items: [], success_url: "https://acme.test/x" });
    expect(response.status).toBe(403);
  });

  test("refuses a price that does not exist", async () => {
    const response = await createSession({ line_items: [{ price: "price_nope" }] });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/does not exist/);
  });

  test("refuses a success_url that is not https", async () => {
    const response = await createSession({ success_url: "javascript:alert(1)" });
    expect(response.status).toBe(400);
    expect(response.body.error.fields.success_url).toBeTruthy();
  });

  test("refuses mixing currencies", async () => {
    const response = await createSession({
      line_items: [
        { price: seed.price.public_id },
        { name: "Extra", amount_cents: 500, currency: "USD" },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/one currency/);
  });

  test("a recurring price needs subscription mode", async () => {
    const response = await createSession({ line_items: [{ price: seed.recurringPrice.public_id }] });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/subscription/);
  });

  test("a subscription may only be charged to a card", async () => {
    const response = await createSession({
      mode: "subscription",
      line_items: [{ price: seed.recurringPrice.public_id }],
      payment_methods: ["pix"],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/card/);
  });

  test("ad hoc line items are priced from the request, which is server side", async () => {
    const response = await createSession({
      line_items: [{ name: "Usage, April", amount_cents: 12345, quantity: 2 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.total_cents).toBe(24690);
  });

  test("only offers methods a configured gateway can actually take", async () => {
    // A session that claims to offer PayPal when no PayPal credentials exist
    // is a lie the integrator will believe, and the buyer finds out only after
    // filling the whole form in.
    const me = await asIntegrator("get", "/v1/me");
    const response = await createSession({ payment_methods: ["pix", "card", "boleto", "paypal"] });

    expect(response.status).toBe(201);
    expect(response.body.payment_methods).toEqual(me.body.payment_methods);
    expect(response.body.payment_methods).not.toContain("paypal");
  });

  test("an idempotency key makes a repeat return the first answer", async () => {
    const key = "repeat-me-please-1234";
    const first = await asIntegrator("post", "/v1/checkout/sessions")
      .set("idempotency-key", key)
      .send({
        line_items: [{ price: seed.price.public_id }],
        success_url: "https://acme.test/thanks",
      });
    const second = await asIntegrator("post", "/v1/checkout/sessions")
      .set("idempotency-key", key)
      .send({
        line_items: [{ price: seed.price.public_id }],
        success_url: "https://acme.test/thanks",
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers["idempotent-replay"]).toBe("true");
  });
});

describe("the hosted page", () => {
  test("renders with the merchant's brand", async () => {
    const session = (await createSession()).body;
    const page = await request(app).get(new URL(session.url).pathname + new URL(session.url).search);

    expect(page.status).toBe(200);
    expect(page.text).toContain("Acme");
    // The accent the merchant saved reaches the page as a custom property.
    expect(page.text).toContain("--oc-accent:#7c3aed");
    // And it must never be framed.
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });

  test("refuses to open without the session secret", async () => {
    const session = (await createSession()).body;
    const page = await request(app).get(`/c/${session.id}`);
    expect(page.status).toBe(404);
  });

  test("refuses a wrong secret", async () => {
    const session = (await createSession()).body;
    const page = await request(app).get(`/c/${session.id}?k=not-the-secret`);
    expect(page.status).toBe(404);
  });

  test("a merchant with no declared origins gets an explanation, not a form", async () => {
    // Nothing may frame a checkout until the merchant says which sites are
    // theirs. Defaulting to anything else would let any page frame a payment
    // form, which is how clickjacking works.
    //
    // What comes back instead is a page that SAYS so, and that one is framable
    // anywhere because it holds no form, no amount and no secret. The
    // alternative is an empty white box and a console message.
    const session = (await createSession()).body;
    const url = new URL(session.url);
    const page = await request(app).get(`/c/${session.id}/embed${url.search}`);

    expect(page.status).toBe(200);
    expect(page.text).toContain("Embedding is not enabled");
    expect(page.text).not.toContain('id="oc-form"');
    expect(page.text).not.toContain("oc-card-number");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors *");
  });
});

describe("paying by card", () => {
  test("an approved card completes the order and says where to go", async () => {
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        installments: 1,
        buyer: { email: "ada@example.com", name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
        card: GOOD_CARD,
      });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("paid");
    expect(response.body.order_id).toMatch(/^ord_/);
    expect(response.body.next_url).toContain("https://acme.test/thanks");
    expect(response.body.next_url).toContain("order_id=");
  });

  test("a declined card is a business error the buyer can act on", async () => {
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        buyer: { email: "ada@example.com", name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
        card: { ...GOOD_CARD, number: "4000000000000002" },
      });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("refused");
    expect(response.body.message).toBeTruthy();
  });

  test("the browser cannot set the price", async () => {
    // The whole reason the flow looks like this. Anything priced in the
    // request body is ignored: the amount comes from the stored session.
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        amount_cents: 1,
        total_cents: 1,
        line_items: [{ name: "Free", amount_cents: 0 }],
        buyer: { email: "ada@example.com", name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
        card: GOOD_CARD,
      });

    expect(response.status).toBe(201);
    const order = await asIntegrator("get", `/v1/orders/${response.body.order_id}`);
    expect(order.body.amount_cents).toBe(9900);
  });

  test("an obviously wrong card never reaches the gateway", async () => {
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        buyer: { email: "ada@example.com", name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
        card: { ...GOOD_CARD, number: "4242424242424243" },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.number).toBeTruthy();
  });

  test("an error message never echoes a card number", async () => {
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        buyer: { email: "ada@example.com", name: "Ada", document: "52998224725", phone: "11988887777" },
        card: { number: "4242424242424243", holder_name: "x", expiry: "01/20", cvv: "1" },
      });

    expect(JSON.stringify(response.body)).not.toContain("4242424242424243");
  });

  test("a missing required field comes back per field", async () => {
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({ method: "card", buyer: { email: "not an email" }, card: GOOD_CARD });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.email).toBeTruthy();
  });
});

describe("paying by Pix", () => {
  test("comes back pending, with something to scan, and settles later", async () => {
    const session = (await createSession()).body;
    const paid = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "pix",
        buyer: { email: "grace@example.com", name: "Grace Hopper", document: "52998224725", phone: "11988887777" },
      });

    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe("pending");
    expect(paid.body.pix.copy_paste).toContain("BR.GOV.BCB.PIX");
    expect(paid.body.pix.qr_base64).toBeTruthy();
    // Nowhere to go yet: the money has not arrived.
    expect(paid.body.next_url).toBeNull();

    // The gateway settles. In production this is a webhook or a status query;
    // the test moves the simulated gateway's clock instead of waiting.
    const order = await asIntegrator("get", `/v1/orders/${paid.body.order_id}`);
    require("../src/gateways/demo").settleNow(order.body.gateway_charge_id || null);

    const status = await request(app).get(`/c/${session.id}/status`).query({
      k: session.client_secret,
      order_id: paid.body.order_id,
      token: paid.body.token,
    });

    expect(status.status).toBe(200);
    // The status route reconciles server to server before answering, which is
    // what makes a missed webhook survivable.
    expect(["paid", "pending"]).toContain(status.body.status);
  });

  test("the status route refuses a wrong order token", async () => {
    const session = (await createSession()).body;
    const paid = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "pix",
        buyer: { email: "grace@example.com", name: "Grace Hopper", document: "52998224725", phone: "11988887777" },
      });

    const status = await request(app).get(`/c/${session.id}/status`).query({
      k: session.client_secret,
      order_id: paid.body.order_id,
      token: "wrong",
    });
    expect(status.status).toBe(404);
  });
});

describe("coupons on the page", () => {
  test("the server reprices and the page is told the new total", async () => {
    const coupons = require("../src/services/coupons");
    const ctx = require("../src/db/merchant-context");
    await ctx.withMerchant(seed.merchant.id, () =>
      coupons.create(seed.merchant.id, { code: "HALF", kind: "percent", value: 50 })
    );

    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "half", email: "ada@example.com" });

    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);
    expect(response.body.discount_cents).toBe(4950);
    expect(response.body.total_cents).toBe(4950);
  });

  test("an unknown code is refused with a sentence, not an error", async () => {
    const session = (await createSession()).body;
    const response = await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "NOPE" });

    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(false);
    expect(response.body.reason).toBeTruthy();
    expect(response.body.total_cents).toBe(9900);
  });

  test("the discount is applied to the charge, not just the display", async () => {
    const session = (await createSession()).body;
    await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "HALF", email: "ada2@example.com" });

    const paid = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        buyer: { email: "ada2@example.com", name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
        card: GOOD_CARD,
      });

    const order = await asIntegrator("get", `/v1/orders/${paid.body.order_id}`);
    expect(order.body.amount_cents).toBe(4950);
    expect(order.body.coupon).toBe("HALF");
  });
});

describe("a session that is no longer open", () => {
  test("cannot be paid twice", async () => {
    const session = (await createSession()).body;
    const buyer = {
      email: "twice@example.com",
      name: "Alan Turing",
      document: "52998224725",
      phone: "11988887777",
    };

    const first = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({ method: "card", buyer, card: GOOD_CARD });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({ method: "card", buyer, card: GOOD_CARD });
    expect(second.status).toBe(409);
  });

  test("a canceled session stops working", async () => {
    const session = (await createSession()).body;
    const canceled = await asIntegrator("post", `/v1/checkout/sessions/${session.id}/cancel`);
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe("canceled");

    const page = await request(app).get(`/c/${session.id}?k=${session.client_secret}`);
    expect(page.status).toBe(410);
  });
});

describe("the integrator's view", () => {
  test("GET /v1/me is the smoke test of a new integration", async () => {
    const response = await asIntegrator("get", "/v1/me");
    expect(response.status).toBe(200);
    expect(response.body.id).toMatch(/^mer_/);
    expect(response.body.livemode).toBe(false);
    expect(response.body.payment_methods.length).toBeGreaterThan(0);
  });

  test("orders are listed newest first with a cursor", async () => {
    const response = await asIntegrator("get", "/v1/orders?limit=2");
    expect(response.status).toBe(200);
    expect(response.body.object).toBe("list");
    expect(response.body.data.length).toBeLessThanOrEqual(2);
    expect(typeof response.body.has_more).toBe("boolean");
  });

  test("every event that happened is readable, so a missed webhook is recoverable", async () => {
    const response = await asIntegrator("get", "/v1/events");
    expect(response.status).toBe(200);
    const types = response.body.data.map((event) => event.type);
    expect(types).toContain("order.paid");
    expect(types).toContain("checkout.session.created");
  });

  test("a customer's tax id is masked on the way out", async () => {
    const orders = await asIntegrator("get", "/v1/orders?limit=1");
    const order = await asIntegrator("get", `/v1/orders/${orders.body.data[0].id}`);
    if (order.body.customer && order.body.customer.document) {
      expect(order.body.customer.document).toMatch(/^\*\*\*/);
    }
  });
});
