// Regression tests for the contract and resilience audit.
//
// These ask what happens when something is broken: a gateway that is not
// configured, a database that is gone, an endpoint that stopped answering, a
// charge that never completed. The answer has to be useful to whoever can fix
// it, and it has to not take everything else down with it.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let app;
let seed;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  app = require("../src/app");
});

// ===========================================================================
describe("a misconfigured gateway explains itself", () => {
  test("the error names the gateway and what to do, instead of a 500", async () => {
    // A bare Error became "something went wrong on our side", which is both
    // untrue and useless: the merchant is the only person who can fix it and
    // they were told nothing.
    const previous = process.env.OPENCHECKOUT_DEMO;
    process.env.OPENCHECKOUT_DEMO = "";
    try {
      const { getGateway } = require("../src/gateways");
      await asMerchant(seed.merchant.id, async () => {
        await expect(
          getGateway({ merchantId: seed.merchant.id, gateway: "paypal", livemode: false })
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringMatching(/paypal is not configured/i),
        });
      });
    } finally {
      process.env.OPENCHECKOUT_DEMO = previous;
    }
  });

  test("a merchant with no gateway at all is told at session creation", async () => {
    const previous = process.env.OPENCHECKOUT_DEMO;
    process.env.OPENCHECKOUT_DEMO = "";
    try {
      const gatewayConfig = require("../src/services/gateway-config");
      gatewayConfig.clearCache();
      const empty = await seedMerchant({ name: "Bare", slug: "bare" });
      await asMerchant(empty.merchant.id, async () => {
        await db.query(`update gateway_credentials set active = false where merchant_id = $1`, [
          empty.merchant.id,
        ]);
      });
      gatewayConfig.clearCache();

      const response = await request(app)
        .post("/v1/checkout/sessions")
        .set("authorization", `Bearer ${empty.secretKey}`)
        .send({
          line_items: [{ price: empty.price.public_id }],
          success_url: "https://acme.test/thanks",
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/no payment gateway is configured/i);
    } finally {
      process.env.OPENCHECKOUT_DEMO = previous;
      require("../src/services/gateway-config").clearCache();
    }
  });
});

// ===========================================================================
describe("the health check tells the truth", () => {
  test("it is green when the database answers", async () => {
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.database).toBe("ok");
  });

  test("it is 503 when the database is gone", async () => {
    // Answering 200 with a dead database is worse than having no health check:
    // a load balancer keeps sending buyers to an instance that cannot take a
    // single payment.
    const spy = jest.spyOn(db, "query").mockRejectedValueOnce(new Error("connection refused"));
    try {
      const response = await request(app).get("/healthz");
      expect(response.status).toBe(503);
      expect(response.body.ok).toBe(false);
      expect(response.body.database).toBe("unreachable");
    } finally {
      spy.mockRestore();
    }
  });
});

// ===========================================================================
describe("publishable keys work from a browser", () => {
  test("a preflight is answered for a publishable key", async () => {
    // The documentation said these were safe in a browser. Without this they
    // were unusable from one, which made the claim false.
    const response = await request(app)
      .options("/v1/me")
      .set("origin", "https://app.acme.test")
      .set("authorization", `Bearer ${seed.publishableKey}`);

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.acme.test");
    expect(response.headers.vary).toContain("Origin");
  });

  test("a secret key gets no cross-origin access at all", async () => {
    // So a secret key that leaks into a page still cannot be used from one.
    const response = await request(app)
      .get("/v1/me")
      .set("origin", "https://app.acme.test")
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a publishable key may read but not write", async () => {
    const read = await request(app)
      .get("/v1/me")
      .set("origin", "https://app.acme.test")
      .set("authorization", `Bearer ${seed.publishableKey}`);
    expect(read.status).toBe(200);

    const write = await request(app)
      .post("/v1/customers")
      .set("origin", "https://app.acme.test")
      .set("authorization", `Bearer ${seed.publishableKey}`)
      .send({ email: "nope@example.com" });
    expect(write.status).toBe(403);
  });

  test("credentials are never allowed, so this is not a forgery surface", async () => {
    const response = await request(app)
      .options("/v1/me")
      .set("origin", "https://app.acme.test")
      .set("authorization", `Bearer ${seed.publishableKey}`);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

// ===========================================================================
describe("a bad cursor is an error, not an empty page", () => {
  test("an invalid order cursor is refused", async () => {
    // The subquery compares against null and returns nothing, which reads
    // exactly like "you have no more data" and hides the caller's mistake.
    const response = await request(app)
      .get("/v1/orders?cursor=nonsense")
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(response.status).toBe(400);
    expect(response.body.error.fields.cursor).toBeTruthy();
  });

  test("no cursor is still fine", async () => {
    const response = await request(app)
      .get("/v1/orders")
      .set("authorization", `Bearer ${seed.secretKey}`);
    expect(response.status).toBe(200);
  });
});

// ===========================================================================
describe("one broken endpoint does not stall the others", () => {
  test("a dead endpoint is skipped after its first failure in a pass", async () => {
    // Each attempt waits up to ten seconds. Fifty rows queued behind one
    // endpoint that stopped answering meant eight minutes, every tick, in
    // which nobody else's webhook moved.
    const webhooksOut = require("../src/services/webhooks-out");
    const events = require("../src/services/events");

    await asMerchant(seed.merchant.id, async () => {
      await webhooksOut.createEndpoint(seed.merchant.id, { url: "https://dead.test/hooks" });
      await webhooksOut.createEndpoint(seed.merchant.id, { url: "https://alive.test/hooks" });

      for (let i = 0; i < 3; i++) {
        const event = await events.record(seed.merchant.id, "order.paid", { order: { n: i } }, {});
        await webhooksOut.enqueue(seed.merchant.id, event);
      }
    });

    const attempts = [];
    const fetchImpl = async (url) => {
      attempts.push(url);
      if (url.includes("dead.test")) throw Object.assign(new Error("timeout"), { name: "AbortError" });
      return { status: 200 };
    };

    const results = await webhooksOut.dispatchPending({ fetchImpl, concurrency: 1 });

    const deadAttempts = attempts.filter((url) => url.includes("dead.test")).length;
    const aliveAttempts = attempts.filter((url) => url.includes("alive.test")).length;

    // The dead one is tried once and then left for the next tick.
    expect(deadAttempts).toBe(1);
    // The live one still gets all of its deliveries.
    expect(aliveAttempts).toBe(3);
    expect(results.some((r) => r && r.skipped)).toBe(true);
  });

  test("the skipped rows stay pending, so nothing is lost", async () => {
    const rows = await db.query(
      `select d.status, e.url from webhook_deliveries d
         join webhook_endpoints e on e.id = d.endpoint_id and e.merchant_id = d.merchant_id
        where d.merchant_id = $1 and e.url like '%dead.test%'`,
      [seed.merchant.id]
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) expect(row.status).toBe("pending");
  });
});

// ===========================================================================
describe("an order that never reached the gateway", () => {
  test("is written off after a day, as EXPIRED so a late payment still lands", async () => {
    const carts = require("../src/services/carts");
    const orders = require("../src/services/orders");

    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({
        line_items: [{ price: seed.price.public_id }],
        success_url: "https://acme.test/thanks",
      });

    const paid = await request(app)
      .post(`/c/${session.body.id}/pay`)
      .query({ k: session.body.client_secret })
      .send({
        method: "pix",
        buyer: {
          email: "stranded@example.com",
          name: "Ada Lovelace",
          document: "52998224725",
          phone: "11988887777",
        },
      });

    await asMerchant(seed.merchant.id, async () => {
      const order = await orders.findByPublicId(seed.merchant.id, paid.body.order_id);
      // The shape of a charge whose creation response was lost: an order with
      // no charge id, created long enough ago that nothing is coming.
      await db.query(
        `update orders set gateway_charge_id = null, created_at = $3
          where merchant_id = $1 and id = $2`,
        [seed.merchant.id, order.id, new Date(Date.now() - (carts.STRAND_AFTER_HOURS + 1) * 3600 * 1000)]
      );
    });

    const swept = await carts.expireStrandedOrders({ limit: 10 });
    expect(swept).toBeGreaterThan(0);

    await asMerchant(seed.merchant.id, async () => {
      const after = await orders.findByPublicId(seed.merchant.id, paid.body.order_id);
      expect(after.status).toBe("expired");

      // THE POINT OF CHOOSING "expired": if the charge did exist on the
      // gateway's side and the answer was lost, a notification arriving later
      // can still rescue the sale. "canceled" is final and would close that
      // door on a buyer whose money already moved.
      const rescued = await orders.markStatus(seed.merchant.id, after.id, "paid", "late webhook");
      expect(rescued.changed).toBe(true);
      expect(rescued.order.status).toBe("paid");
    });
  });

  test("a recent order is left alone", async () => {
    const carts = require("../src/services/carts");
    const before = await db.query(
      `select count(*)::int as n from orders where merchant_id = $1 and status = 'pending'`,
      [seed.merchant.id]
    );
    await carts.expireStrandedOrders({ limit: 10 });
    const after = await db.query(
      `select count(*)::int as n from orders where merchant_id = $1 and status = 'pending'`,
      [seed.merchant.id]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

// ===========================================================================
describe("the documentation matches the code", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

  test("every event type the README mentions actually exists", () => {
    const events = require("../src/services/events");
    const readme = read("README.md");
    const mentioned = readme.match(/\b(order|checkout\.session|subscription|cart)\.[a-z_.]+/g) || [];
    for (const type of new Set(mentioned)) {
      expect(events.EVENT_TYPES).toContain(type);
    }
  });

  test("the signature header names in the README are the ones that are sent", () => {
    const readme = read("README.md");
    const source = read("src/services/webhooks-out.js");
    for (const header of ["OpenCheckout-Timestamp", "OpenCheckout-Signature", "OpenCheckout-Event"]) {
      expect(readme).toContain(header);
      expect(source).toContain(header);
    }
  });

  test("every environment variable the code reads is in .env.example", () => {
    // A variable nobody documents is a variable nobody sets, and the failure
    // shows up in production.
    const example = read(".env.example");
    const sources = ["src/config.js", "src/app.js", "src/server.js", "src/lib/safe-url.js"];
    const names = new Set();
    for (const file of sources) {
      for (const match of read(file).matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        names.add(match[1]);
      }
    }
    // Set by the demo and the test harness, never by an operator.
    const internal = new Set(["NODE_ENV", "OPENCHECKOUT_DEMO"]);
    for (const name of names) {
      if (internal.has(name)) continue;
      expect(example).toContain(name);
    }
  });

  test("the scripts the README tells people to run exist", () => {
    const pkg = JSON.parse(read("package.json"));
    for (const script of ["demo", "test", "start", "db:migrate"]) {
      expect(pkg.scripts[script]).toBeTruthy();
    }
  });
});
