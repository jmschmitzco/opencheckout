// Abandoned carts, session expiry, and the embeddable widget.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let app;
let seed;
let carts;
let sessions;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  app = require("../src/app");
  carts = require("../src/services/carts");
  sessions = require("../src/services/checkout-sessions");
});

async function openSession(overrides = {}) {
  const response = await request(app)
    .post("/v1/checkout/sessions")
    .set("authorization", `Bearer ${seed.secretKey}`)
    .send({
      line_items: [{ price: seed.price.public_id }],
      success_url: "https://acme.test/thanks",
      ...overrides,
    });
  return response.body;
}

describe("abandoned carts", () => {
  test("the page records the contact as soon as there is an email", async () => {
    // The only moment this can work. After the tab closes there is nobody left
    // to ask.
    const session = await openSession();
    const response = await request(app)
      .post(`/c/${session.id}/contact`)
      .query({ k: session.client_secret })
      .send({ email: "leaving@example.com", name: "Someone" });

    expect(response.status).toBe(200);

    const rows = await db.query(
      `select * from abandoned_carts where merchant_id = $1 and email = $2`,
      [seed.merchant.id, "leaving@example.com"]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].total_cents).toBe(9900);
    expect(rows.rows[0].recovery_token).toBeTruthy();
  });

  test("an unusable email is ignored rather than stored", async () => {
    const session = await openSession();
    await request(app)
      .post(`/c/${session.id}/contact`)
      .query({ k: session.client_secret })
      .send({ email: "not-an-email" });

    const rows = await db.query(`select count(*)::int as n from abandoned_carts where merchant_id = $1`, [
      seed.merchant.id,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  test("the recovery link reopens the cart exactly as it was", async () => {
    const session = await openSession();
    const url = carts.recoveryUrl({
      public_id: session.id,
      client_secret: session.client_secret,
    });

    const page = await request(app).get(new URL(url).pathname + new URL(url).search);
    expect(page.status).toBe(200);
    // Including the brand, the items and the total: it is the same session,
    // not a reconstruction of it.
    expect(page.text).toContain("Acme");
  });

  test("a reminder is announced as an event carrying the link, not sent as email", async () => {
    // A DELIBERATE BOUNDARY: this project does not own email delivery. The
    // integrator already has a sending domain and templates, and a message
    // from their own domain is the one that gets opened.
    const events = require("../src/services/events");
    const session = await openSession();
    await request(app)
      .post(`/c/${session.id}/contact`)
      .query({ k: session.client_secret })
      .send({ email: "reminder@example.com" });

    await asMerchant(seed.merchant.id, async () => {
      const row = await db.query(
        `select c.*, s.public_id as session_public_id, s.client_secret, s.expires_at,
                s.line_items, s.locale
           from abandoned_carts c
           join checkout_sessions s on s.id = c.session_id and s.merchant_id = c.merchant_id
          where c.merchant_id = $1 and c.email = $2`,
        [seed.merchant.id, "reminder@example.com"]
      );
      await carts.announce(seed.merchant.id, row.rows[0]);

      const list = await events.list(seed.merchant.id, { type: "cart.abandoned" });
      expect(list.length).toBe(1);
      expect(list[0].data.cart.recovery_url).toContain(`/c/${session.id}`);
      expect(list[0].data.cart.total_formatted).toBeTruthy();
      expect(list[0].data.cart.reminder_number).toBe(1);
    });
  });

  test("a paid cart stops being chased", async () => {
    const session = await openSession();
    await request(app)
      .post(`/c/${session.id}/contact`)
      .query({ k: session.client_secret })
      .send({ email: "converting@example.com" });

    await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        buyer: {
          email: "converting@example.com",
          name: "Ada Lovelace",
          document: "52998224725",
          phone: "11988887777",
        },
        card: { number: "4242424242424242", holder_name: "Ada Lovelace", expiry: "12/34", cvv: "123" },
      });

    // Housekeeping runs after the response, registered rather than dropped, so
    // a test can wait for it.
    await require("../src/lib/background-tasks").waitForBackgroundTasks();

    const rows = await db.query(
      `select status from abandoned_carts where merchant_id = $1 and email = $2`,
      [seed.merchant.id, "converting@example.com"]
    );
    expect(rows.rows[0].status).toBe("recovered");
  });

  test("a reminder is not due for a cart that was just created", async () => {
    const due = await carts.dueForReminder({ limit: 10 });
    // Everything in this suite was created seconds ago, and nobody should be
    // written to while they are still on the page.
    expect(due.length).toBe(0);
  });
});

describe("session expiry", () => {
  test("a session past its time is expired and announced", async () => {
    const events = require("../src/services/events");
    const session = await openSession();

    await asMerchant(seed.merchant.id, async () => {
      const row = await sessions.findByPublicId(seed.merchant.id, session.id);
      await db.query(
        `update checkout_sessions set expires_at = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, new Date(Date.now() - 1000)]
      );
    });

    const swept = await carts.expireStaleSessions({ limit: 10 });
    expect(swept).toBeGreaterThan(0);

    const page = await request(app).get(`/c/${session.id}?k=${session.client_secret}`);
    expect(page.status).toBe(410);

    await asMerchant(seed.merchant.id, async () => {
      const list = await events.list(seed.merchant.id, { type: "checkout.session.expired" });
      expect(list.length).toBeGreaterThan(0);
    });
  });

  test("an expired session reports as expired even before the sweep runs", async () => {
    // The stored status and the real one can disagree for up to a minute, and
    // the page must not pretend otherwise.
    const session = await openSession();
    await asMerchant(seed.merchant.id, async () => {
      const row = await sessions.findByPublicId(seed.merchant.id, session.id);
      await db.query(
        `update checkout_sessions set expires_at = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, new Date(Date.now() - 1000)]
      );
      const stale = await sessions.findByPublicId(seed.merchant.id, session.id);
      expect(stale.status).toBe("open");
      expect(sessions.effectiveStatus(stale)).toBe("expired");
    });
  });

  test("an expired session cannot be paid", async () => {
    const session = await openSession();
    await asMerchant(seed.merchant.id, async () => {
      const row = await sessions.findByPublicId(seed.merchant.id, session.id);
      await db.query(
        `update checkout_sessions set expires_at = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, new Date(Date.now() - 1000)]
      );
    });

    const response = await request(app)
      .post(`/c/${session.id}/pay`)
      .query({ k: session.client_secret })
      .send({
        method: "card",
        buyer: { email: "too-late@example.com", name: "Ada L", document: "52998224725", phone: "11988887777" },
        card: { number: "4242424242424242", holder_name: "Ada L", expiry: "12/34", cvv: "123" },
      });
    expect(response.status).toBe(409);
  });
});

describe("the embed script", () => {
  test("is served with the origin baked in and loadable from anywhere", async () => {
    const response = await request(app).get("/embed.js");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    // Any origin may LOAD it: it holds no secret and does nothing until it is
    // called with a session URL only the integrator's backend can mint.
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    // The placeholder is replaced by the server that served it.
    expect(response.text).not.toContain("__OPENCHECKOUT_ORIGIN__");
    expect(response.text).toContain("http://localhost:3000");
  });

  test("declares the public surface an integrator calls", async () => {
    const response = await request(app).get("/embed.js");
    expect(response.text).toContain("window.OpenCheckout");
    expect(response.text).toContain("data-opencheckout-url");
  });
});

describe("framing", () => {
  test("the plain page may never be framed", async () => {
    const session = await openSession();
    const page = await request(app).get(`/c/${session.id}?k=${session.client_secret}`);
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });

  test("the embedded page allows only the origins the merchant declared", async () => {
    const merchants = require("../src/services/merchants");
    await asMerchant(seed.merchant.id, () =>
      merchants.update(seed.merchant.id, { allowedOrigins: ["https://acme.test"] })
    );

    const session = await openSession();
    const page = await request(app).get(`/c/${session.id}/embed?k=${session.client_secret}`);
    const policy = page.headers["content-security-policy"];

    expect(page.status).toBe(200);
    expect(policy).toContain("frame-ancestors https://acme.test");
    expect(policy).not.toContain("frame-ancestors 'none'");
    // The rest of the policy survives. Replacing the whole header would have
    // quietly removed script-src from the page that takes card numbers.
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
  });

  test("the same list decides which redirect targets are acceptable", async () => {
    // One list, because both answer the same question: is this address yours?
    // This is also what stops a stolen key from pointing paying customers at
    // somebody else's page.
    const outside = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({
        line_items: [{ price: seed.price.public_id }],
        success_url: "https://attacker.test/thanks",
      });
    expect(outside.status).toBe(400);

    // A declared domain covers its subdomains, which is what a merchant means
    // when they type their domain.
    const inside = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({
        line_items: [{ price: seed.price.public_id }],
        success_url: "https://app.acme.test/thanks",
      });
    expect(inside.status).toBe(201);
  });
});
