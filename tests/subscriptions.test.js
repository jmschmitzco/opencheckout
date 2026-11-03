// Subscriptions: the recurring half, which is why a SaaS would use this at
// all.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let app;
let seed;
let subscriptions;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant({ recurringAmountCents: 4900 });
  app = require("../src/app");
  subscriptions = require("../src/services/subscriptions");
});

const GOOD_CARD = {
  number: "4242424242424242",
  holder_name: "Ada Lovelace",
  expiry: "12/34",
  cvv: "123",
};

const BUYER = {
  email: "sub@example.com",
  name: "Ada Lovelace",
  document: "52998224725",
  phone: "11988887777",
};

async function subscribe(email = BUYER.email) {
  const created = await request(app)
    .post("/v1/checkout/sessions")
    .set("authorization", `Bearer ${seed.secretKey}`)
    .send({
      mode: "subscription",
      line_items: [{ price: seed.recurringPrice.public_id }],
      success_url: "https://acme.test/welcome",
      customer_external_id: "user-4821",
    });

  const session = created.body;
  const paid = await request(app)
    .post(`/c/${session.id}/pay`)
    .query({ k: session.client_secret })
    .send({ method: "card", buyer: { ...BUYER, email }, card: GOOD_CARD });

  return { session, paid };
}

describe("interval arithmetic", () => {
  test("adds a month", () => {
    const next = subscriptions.addInterval(new Date("2026-01-15T00:00:00Z"), "month", 1);
    expect(next.getMonth()).toBe(1);
  });

  test("the 31st plus one month clamps to the end of February", () => {
    // The edge every billing system eventually hits. Without clamping, a
    // subscription started on 31 January silently jumps to 3 March.
    const next = subscriptions.addInterval(new Date(2026, 0, 31), "month", 1);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(28);
  });

  test("adds a year and a week", () => {
    expect(subscriptions.addInterval(new Date(2026, 0, 1), "year", 1).getFullYear()).toBe(2027);
    expect(subscriptions.addInterval(new Date(2026, 0, 1), "week", 2).getDate()).toBe(15);
  });
});

describe("a paid subscription checkout", () => {
  test("creates the subscription and the first invoice", async () => {
    const { paid } = await subscribe();
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe("paid");

    const list = await request(app)
      .get("/v1/subscriptions")
      .set("authorization", `Bearer ${seed.secretKey}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const subscription = list.body.data[0];
    expect(subscription.status).toBe("active");
    expect(subscription.amount_cents).toBe(4900);
    expect(subscription.current_period_end).toBeTruthy();
  });

  test("the entitlement endpoint answers the only question a SaaS asks", async () => {
    const response = await request(app)
      .get("/v1/entitlements?external_id=user-4821")
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.items.length).toBeGreaterThan(0);
  });

  test("an unknown customer is not an error, it is a no", async () => {
    // A 404 here would make every integrator write an exception branch for the
    // most common case there is.
    const response = await request(app)
      .get("/v1/entitlements?email=nobody@example.com")
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);
    expect(response.body.customer).toBeNull();
  });

  test("subscribing twice to the same price does not create two", async () => {
    const before = await request(app)
      .get("/v1/subscriptions")
      .set("authorization", `Bearer ${seed.secretKey}`);

    await subscribe("twice@example.com");
    await subscribe("twice@example.com");

    const after = await request(app)
      .get("/v1/subscriptions")
      .set("authorization", `Bearer ${seed.secretKey}`);

    // One more than before, not two: the second attempt found the active one.
    expect(after.body.data.length).toBe(before.body.data.length + 1);
  });
});

describe("renewal", () => {
  test("charges the saved card and moves the period forward", async () => {
    await subscribe("renew@example.com");

    const list = await request(app)
      .get("/v1/subscriptions")
      .set("authorization", `Bearer ${seed.secretKey}`);
    const target = list.body.data.find((s) => s.status === "active");

    await asMerchant(seed.merchant.id, async () => {
      const row = await subscriptions.findByPublicId(seed.merchant.id, target.id);
      // Pretend the period ended. The loop picks rows by date, so moving the
      // date is how a test reaches the renewal path without waiting a month.
      const past = new Date(Date.now() - 1000);
      await db.query(
        `update subscriptions set current_period_end = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, past]
      );

      const fresh = await subscriptions.findByPublicId(seed.merchant.id, target.id);
      const result = await subscriptions.renew(seed.merchant.id, fresh);
      expect(result.ok).toBe(true);

      const after = await subscriptions.findByPublicId(seed.merchant.id, target.id);
      expect(after.status).toBe("active");
      expect(new Date(after.current_period_end).getTime()).toBeGreaterThan(Date.now());

      const invoices = await subscriptions.invoicesFor(seed.merchant.id, after.id);
      expect(invoices.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("a subscription asked to stop is not charged again", async () => {
    // The single worst bug this file could have.
    await subscribe("stopping@example.com");

    await asMerchant(seed.merchant.id, async () => {
      const rows = await subscriptions.list(seed.merchant.id, { status: "active" });
      const row = rows[rows.length - 1];

      await subscriptions.cancel(seed.merchant.id, row.public_id, { atPeriodEnd: true });
      await db.query(
        `update subscriptions set current_period_end = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, new Date(Date.now() - 1000)]
      );

      const due = await subscriptions.findByPublicId(seed.merchant.id, row.public_id);
      const result = await subscriptions.renew(seed.merchant.id, due);
      expect(result.status).toBe("canceled");

      const invoicesBefore = await subscriptions.invoicesFor(seed.merchant.id, row.id);
      expect(invoicesBefore.length).toBe(1);
    });
  });

  test("a failed charge schedules a retry rather than cancelling", async () => {
    await subscribe("failing@example.com");

    await asMerchant(seed.merchant.id, async () => {
      const rows = await subscriptions.list(seed.merchant.id, { status: "active" });
      const row = rows[rows.length - 1];

      // No saved card is the simplest way to fail a renewal without reaching
      // into the gateway.
      await db.query(
        `update subscriptions set card_token = null, current_period_end = $3
          where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, new Date(Date.now() - 1000)]
      );

      const due = await subscriptions.findByPublicId(seed.merchant.id, row.public_id);
      const result = await subscriptions.renew(seed.merchant.id, due);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("past_due");

      const after = await subscriptions.findByPublicId(seed.merchant.id, row.public_id);
      expect(after.attempt_count).toBe(1);
      expect(new Date(after.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      // Still entitled: a card that failed this morning is not a customer who
      // stopped paying, and locking them out before the retries run loses more
      // than it saves.
      expect(subscriptions.ENTITLED_STATUSES).toContain("past_due");
    });
  });

  test("gives up after the last retry and says so", async () => {
    await subscribe("giving-up@example.com");

    await asMerchant(seed.merchant.id, async () => {
      const rows = await subscriptions.list(seed.merchant.id, { status: "active" });
      const row = rows[rows.length - 1];
      await db.query(
        `update subscriptions set card_token = null, attempt_count = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, subscriptions.RETRY_DAYS.length]
      );

      const due = await subscriptions.findByPublicId(seed.merchant.id, row.public_id);
      const result = await subscriptions.markPaymentFailed(seed.merchant.id, due, "declined");
      expect(result.status).toBe("unpaid");
    });
  });
});

describe("cancelling", () => {
  test("cancels at period end by default, so the paid period is kept", async () => {
    await subscribe("cancel-me@example.com");
    const list = await request(app)
      .get("/v1/subscriptions?status=active")
      .set("authorization", `Bearer ${seed.secretKey}`);
    const target = list.body.data[list.body.data.length - 1];

    const response = await request(app)
      .post(`/v1/subscriptions/${target.id}/cancel`)
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.cancel_at_period_end).toBe(true);
    expect(response.body.status).toBe("active");
  });

  test("resume undoes it", async () => {
    const list = await request(app)
      .get("/v1/subscriptions")
      .set("authorization", `Bearer ${seed.secretKey}`);
    const target = list.body.data.find((s) => s.cancel_at_period_end);

    const response = await request(app)
      .post(`/v1/subscriptions/${target.id}/resume`)
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.cancel_at_period_end).toBe(false);
  });

  test("an immediate cancel is possible but has to be asked for", async () => {
    await subscribe("now@example.com");
    const list = await request(app)
      .get("/v1/subscriptions?status=active")
      .set("authorization", `Bearer ${seed.secretKey}`);
    const target = list.body.data[list.body.data.length - 1];

    const response = await request(app)
      .post(`/v1/subscriptions/${target.id}/cancel`)
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({ at_period_end: false });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("canceled");
  });
});

describe("the customer portal", () => {
  test("mints a single use link", async () => {
    const response = await request(app)
      .post("/v1/portal/sessions")
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({ customer_email: BUYER.email, return_url: "https://acme.test/account" });

    expect(response.status).toBe(201);
    expect(response.body.url).toContain("/portal/");

    const path = new URL(response.body.url).pathname;

    // First use works and redirects, so the token leaves the address bar.
    const first = await request(app).get(path);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/portal");

    // Second use does not.
    const second = await request(app).get(path);
    expect(second.status).toBe(410);
  });
});
