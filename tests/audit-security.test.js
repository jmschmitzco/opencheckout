// Regression tests for the security audit.
//
// Each one names a way somebody could have reached data that was not theirs,
// or made this server do something on their behalf.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");
const { scrub, scrubDeep } = require("../src/lib/scrub");
const safeUrl = require("../src/lib/safe-url");

let app;
let one;
let two;

beforeAll(async () => {
  createMemoryDb();
  one = await seedMerchant({ name: "One", slug: "one-sec" });
  two = await seedMerchant({ name: "Two", slug: "two-sec" });
  app = require("../src/app");
});

// ===========================================================================
describe("outbound address guard", () => {
  // A resolver that answers whatever the test needs, so no DNS is used.
  const resolverFor = (address) => ({ lookup: async () => [{ address, family: 4 }] });

  // The suite as a whole runs with the bypass on, because its fixtures use
  // .test hostnames that resolve nowhere. This block is the one place that
  // tests the guard itself, so it turns the bypass off.
  const bypass = process.env.OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS;
  beforeEach(() => {
    process.env.OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS = "";
  });
  afterAll(() => {
    process.env.OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS = bypass;
  });

  test("refuses the cloud metadata address", async () => {
    // The one that turns a webhook into a credential thief.
    const result = await safeUrl.isPubliclyRoutable("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
  });

  test.each([
    "http://127.0.0.1:5432/",
    "http://localhost/hooks",
    "http://10.0.0.5/hooks",
    "http://192.168.1.10/hooks",
    "http://172.16.0.1/hooks",
    "http://[::1]/hooks",
    "https://db.internal/hooks",
    "https://something.localhost/hooks",
  ])("refuses %s", async (url) => {
    const result = await safeUrl.isPubliclyRoutable(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test("accepts a public address", async () => {
    const result = await safeUrl.isPubliclyRoutable("https://hooks.example.com/x", {
      resolver: resolverFor("93.184.216.34"),
    });
    expect(result.ok).toBe(true);
  });

  test("refuses a public name that resolves somewhere private", async () => {
    // The interesting case: nothing about the URL looks wrong.
    const result = await safeUrl.isPubliclyRoutable("https://totally-normal.example.com/x", {
      resolver: resolverFor("127.0.0.1"),
    });
    expect(result.ok).toBe(false);
  });

  test("refuses a name that resolves to one public AND one private address", async () => {
    // A name that can be made to reach the private one is a name that will be.
    const resolver = {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
    };
    const result = await safeUrl.isPubliclyRoutable("https://split.example.com/x", { resolver });
    expect(result.ok).toBe(false);
  });

  test("an IPv4 address wearing an IPv6 hat is still private", () => {
    expect(safeUrl.isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(safeUrl.isPrivateIPv6("::ffff:93.184.216.34")).toBe(false);
  });

  test("the webhook endpoint route actually uses it", async () => {
    // Proves the wiring, not just the helper.
    const response = await request(app)
      .post("/v1/webhook-endpoints")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({ url: "http://169.254.169.254/" });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/cannot be used/i);
  });

  test("a single tenant installation can opt out", async () => {
    process.env.OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS = "1";
    const result = await safeUrl.isPubliclyRoutable("http://127.0.0.1/hooks");
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
  });
});

// ===========================================================================
describe("nothing sensitive is written down", () => {
  test("a card number inside a gateway message is redacted", () => {
    const message = "Declined for card 4242 4242 4242 4242 at issuer";
    expect(scrub(message)).not.toContain("4242 4242 4242 4242");
    expect(scrub(message)).toContain("[redacted-16-digits]");
  });

  test.each([
    "4242424242424242",
    "4242-4242-4242-4242",
    "378282246310005",
    "4111 1111 1111 1111",
  ])("redacts %s in any shape", (number) => {
    expect(scrub(`error with ${number} here`)).not.toContain(number.replace(/\D/g, ""));
  });

  test("an API key that leaked into a message is redacted", () => {
    expect(scrub("auth failed for sk_live_abcdefghijklmnop")).toContain("[redacted-token]");
    expect(scrub("Bearer eyJhbGciOiJIUzI1NiJ9abc")).toContain("[redacted-token]");
  });

  test("a security code is redacted when it is labelled", () => {
    expect(scrub("cvv: 123 was wrong")).toContain("[redacted-cvv]");
    // A bare three digit number is left alone: redacting it would mangle every
    // amount and status code in the log.
    expect(scrub("status 402 amount 123")).toContain("402");
  });

  test("an order id survives, because a diagnostic has to stay readable", () => {
    expect(scrub("order ord_abc123 failed")).toContain("ord_abc123");
  });

  test("a field whose NAME says card is dropped whole", () => {
    const scrubbed = scrubDeep({ number: "4242424242424242", cvv: "123", brand: "visa" });
    expect(scrubbed.number).toBe("[redacted]");
    expect(scrubbed.cvv).toBe("[redacted]");
    expect(scrubbed.brand).toBe("visa");
  });

  test("a declined charge stores no card digits", async () => {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });

    const paid = await request(app)
      .post(`/c/${session.body.id}/pay`)
      .query({ k: session.body.client_secret })
      .send({
        method: "card",
        buyer: {
          email: "scrub@example.com",
          name: "Ada Lovelace",
          document: "52998224725",
          phone: "11988887777",
        },
        card: {
          number: "4000000000000002",
          holder_name: "Ada Lovelace",
          expiry: "12/34",
          cvv: "123",
        },
      });
    expect(paid.body.status).toBe("refused");

    const rows = await asMerchant(one.merchant.id, () =>
      db.query(`select detail, status from charges where merchant_id = $1`, [one.merchant.id])
    );
    const everything = JSON.stringify(rows.rows);
    expect(everything).not.toContain("4000000000000002");
    expect(everything).not.toContain("4000 0000 0000 0002");
  });
});

// ===========================================================================
describe("one merchant cannot reach another", () => {
  test("a secret key only opens its own orders", async () => {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });

    const paid = await request(app)
      .post(`/c/${session.body.id}/pay`)
      .query({ k: session.body.client_secret })
      .send({
        method: "card",
        buyer: {
          email: "isolated@example.com",
          name: "Ada Lovelace",
          document: "52998224725",
          phone: "11988887777",
        },
        card: { number: "4242424242424242", holder_name: "Ada Lovelace", expiry: "12/34", cvv: "123" },
      });

    const mine = await request(app)
      .get(`/v1/orders/${paid.body.order_id}`)
      .set("authorization", `Bearer ${one.secretKey}`);
    expect(mine.status).toBe(200);

    const theirs = await request(app)
      .get(`/v1/orders/${paid.body.order_id}`)
      .set("authorization", `Bearer ${two.secretKey}`);
    expect(theirs.status).toBe(404);
  });

  test("a session of one is not readable by the other", async () => {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });

    const theirs = await request(app)
      .get(`/v1/checkout/sessions/${session.body.id}`)
      .set("authorization", `Bearer ${two.secretKey}`);
    expect(theirs.status).toBe(404);
  });

  test("a price of one cannot be sold by the other", async () => {
    const response = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${two.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });
    expect(response.status).toBe(400);
  });
});

// ===========================================================================
describe("API key scope", () => {
  test("a publishable key cannot create a session", async () => {
    const response = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.publishableKey}`)
      .send({ line_items: [], success_url: "https://acme.test/x" });
    expect(response.status).toBe(403);
  });

  test("a publishable key cannot list orders or events", async () => {
    for (const path of ["/v1/orders", "/v1/events", "/v1/branding", "/v1/subscriptions"]) {
      const response = await request(app)
        .get(path)
        .set("authorization", `Bearer ${one.publishableKey}`);
      expect(response.status).toBe(403);
    }
  });

  test("a revoked key stops working immediately", async () => {
    const apiKeys = require("../src/services/api-keys");
    const created = await asMerchant(one.merchant.id, () =>
      apiKeys.create(one.merchant.id, { label: "Throwaway" })
    );

    const before = await request(app).get("/v1/me").set("authorization", `Bearer ${created.key}`);
    expect(before.status).toBe(200);

    await asMerchant(one.merchant.id, () => apiKeys.revoke(one.merchant.id, created.public_id));

    const after = await request(app).get("/v1/me").set("authorization", `Bearer ${created.key}`);
    expect(after.status).toBe(401);
  });

  test("the full key is never stored", async () => {
    const apiKeys = require("../src/services/api-keys");
    const created = await asMerchant(one.merchant.id, () =>
      apiKeys.create(one.merchant.id, { label: "Stored?" })
    );
    const rows = await db.query(`select * from api_keys where merchant_id = $1`, [one.merchant.id], {
      withoutMerchant: "reading the key table is the point of this test",
    });
    expect(JSON.stringify(rows.rows)).not.toContain(created.key);
  });
});

// ===========================================================================
describe("the checkout page's own credential", () => {
  test("a session cannot be opened with another session's secret", async () => {
    const first = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({ line_items: [{ price: one.price.public_id }], success_url: "https://acme.test/t" });
    const second = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({ line_items: [{ price: one.price.public_id }], success_url: "https://acme.test/t" });

    const crossed = await request(app).get(
      `/c/${first.body.id}?k=${second.body.client_secret}`
    );
    expect(crossed.status).toBe(404);
  });

  test("paying needs the secret too, not just the session id", async () => {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({ line_items: [{ price: one.price.public_id }], success_url: "https://acme.test/t" });

    const response = await request(app).post(`/c/${session.body.id}/pay`).send({ method: "pix" });
    expect(response.status).toBe(404);
  });
});

// ===========================================================================
describe("idempotency keys are namespaced per merchant", () => {
  test("the same key used by two merchants does not collide", async () => {
    // Keys are chosen by the caller. Without namespacing, one merchant picking
    // "order-1" makes another merchant's "order-1" come back as a conflict, or
    // worse, returns the stored answer of a request that was never theirs.
    const body = (merchant) => ({
      line_items: [{ price: merchant.price.public_id }],
      success_url: "https://acme.test/thanks",
    });

    const first = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .set("idempotency-key", "shared-key-value-1")
      .send(body(one));

    const second = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${two.secretKey}`)
      .set("idempotency-key", "shared-key-value-1")
      .send(body(two));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers["idempotent-replay"]).toBeUndefined();
  });
});

// ===========================================================================
describe("the customer portal", () => {
  test("a link cannot be used twice, even by two requests at once", async () => {
    const portal = require("../src/services/portal");
    const customers = require("../src/services/customers");

    const session = await asMerchant(one.merchant.id, async () => {
      const customer = await customers.upsert(one.merchant.id, { email: "portal@example.com" });
      return portal.createSession(one.merchant.id, customer.id, {});
    });

    const token = new URL(session.url).pathname.split("/").pop();
    const [first, second] = await Promise.all([portal.consume(token), portal.consume(token)]);

    const used = [first, second].filter(Boolean);
    expect(used.length).toBe(1);
  });

  test("an unknown or malformed token is refused without a lookup", async () => {
    const portal = require("../src/services/portal");
    expect(await portal.consume("short")).toBeNull();
    expect(await portal.consume("../../etc/passwd")).toBeNull();
    expect(await portal.consume("")).toBeNull();
  });

  test("a cross-site POST is refused", async () => {
    // SameSite=lax is the real defence; this is the second one.
    const response = await request(app)
      .post("/portal/cancel")
      .set("origin", "https://evil.test")
      .send({ subscription: "sub_whatever" });
    expect(response.status).toBe(403);
  });
});

// ===========================================================================
describe("security headers", () => {
  test("the checkout forbids inline script", async () => {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({ line_items: [{ price: one.price.public_id }], success_url: "https://acme.test/t" });

    const page = await request(app).get(
      `/c/${session.body.id}?k=${session.body.client_secret}`
    );
    const policy = page.headers["content-security-policy"];

    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("object-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    // And the page genuinely has no inline SCRIPT to need it. The one inline
    // block it does carry is type="application/json", which the browser does
    // not execute and the policy does not have to allow: that is exactly why
    // the page passes its configuration as data rather than as code.
    const executableInline = page.text.match(
      /<script(?![^>]*\ssrc=)(?![^>]*type=["']application\/json["'])[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i
    );
    expect(executableInline).toBeNull();
    expect(page.text).toContain('<script type="application/json" id="oc-config">');
  });

  test("a checkout page is never indexed", async () => {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({ line_items: [{ price: one.price.public_id }], success_url: "https://acme.test/t" });
    const page = await request(app).get(`/c/${session.body.id}?k=${session.body.client_secret}`);
    expect(page.text).toContain('name="robots" content="noindex');
  });
});
