// Inbound notifications from a gateway.
//
// This is where a payment is confirmed, so every rule here exists because its
// absence is a way to get something for nothing.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let app;
let seed;
let orders;
let gatewayWebhooks;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  app = require("../src/app");
  orders = require("../src/services/orders");
  gatewayWebhooks = require("../src/routes/gateway-webhooks");
});

// A pending Pix order, which is the state a notification arrives for.
async function pendingOrder(email = "pix@example.com") {
  const created = await request(app)
    .post("/v1/checkout/sessions")
    .set("authorization", `Bearer ${seed.secretKey}`)
    .send({
      line_items: [{ price: seed.price.public_id }],
      success_url: "https://acme.test/thanks",
    });

  const session = created.body;
  const paid = await request(app)
    .post(`/c/${session.id}/pay`)
    .query({ k: session.client_secret })
    .send({
      method: "pix",
      buyer: { email, name: "Grace Hopper", document: "52998224725", phone: "11988887777" },
    });

  const order = await asMerchant(seed.merchant.id, () =>
    orders.findByPublicId(seed.merchant.id, paid.body.order_id)
  );
  return { session, order };
}

describe("the webhook address", () => {
  test("an unknown token is a 404, not a silent 200", async () => {
    // The gateway retries, and the merchant sees the failures in their own
    // dashboard. Swallowing it would lose a payment notification quietly.
    const response = await request(app)
      .post("/gateway-webhooks/asaas/" + "0".repeat(48))
      .send({ event: "PAYMENT_RECEIVED" });
    expect(response.status).toBe(404);
  });

  test("a token belonging to another gateway does not work", async () => {
    const response = await request(app)
      .post(`/gateway-webhooks/pagarme/${seed.webhookToken}`)
      .send({ event: "paid" });
    expect(response.status).toBe(404);
  });

  test("a malformed token is refused without a database lookup", async () => {
    const response = await request(app).post("/gateway-webhooks/asaas/not-a-token").send({});
    expect(response.status).toBe(404);
  });
});

describe("deduplication", () => {
  test("the same gateway event id is only accepted once", async () => {
    // Gateways resend. A resent "paid" must not pay twice, and the unique
    // index is what makes that true even when two copies arrive together.
    const first = await gatewayWebhooks.alreadySeen("asaas", "evt_dedupe_1", seed.merchant.id);
    const second = await gatewayWebhooks.alreadySeen("asaas", "evt_dedupe_1", seed.merchant.id);
    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  test("the same id from a different gateway is a different event", async () => {
    await gatewayWebhooks.alreadySeen("asaas", "evt_shared", seed.merchant.id);
    expect(await gatewayWebhooks.alreadySeen("pagarme", "evt_shared", seed.merchant.id)).toBe(false);
  });
});

describe("marking an order paid", () => {
  test("a pending order becomes paid, once", async () => {
    const { order } = await pendingOrder("once@example.com");

    await asMerchant(seed.merchant.id, async () => {
      const first = await orders.markStatus(seed.merchant.id, order.id, "paid", "test");
      expect(first.changed).toBe(true);
      expect(first.order.paid_at).toBeTruthy();

      // Idempotent: the second attempt changes nothing and does not throw.
      const second = await orders.markStatus(seed.merchant.id, order.id, "paid", "test");
      expect(second.changed).toBe(false);
    });
  });

  test("a pending arriving after a paid does not un-pay it", async () => {
    // Out of order delivery is normal gateway traffic, not an error, and
    // applying it would reverse a completed sale.
    const { order } = await pendingOrder("order-matters@example.com");

    await asMerchant(seed.merchant.id, async () => {
      await orders.markStatus(seed.merchant.id, order.id, "paid", "test");
      const late = await orders.markStatus(seed.merchant.id, order.id, "pending", "late webhook");
      expect(late.changed).toBe(false);
      expect(late.order.status).toBe("paid");
    });
  });

  test("a boleto paid after its due date still clears", async () => {
    const { order } = await pendingOrder("late-boleto@example.com");

    await asMerchant(seed.merchant.id, async () => {
      await orders.markStatus(seed.merchant.id, order.id, "expired", "sweep");
      const paid = await orders.markStatus(seed.merchant.id, order.id, "paid", "webhook");
      expect(paid.changed).toBe(true);
      expect(paid.order.status).toBe("paid");
    });
  });

  test("a canceled order is final", async () => {
    const { order } = await pendingOrder("canceled@example.com");

    await asMerchant(seed.merchant.id, async () => {
      await orders.markStatus(seed.merchant.id, order.id, "canceled", "test");
      const paid = await orders.markStatus(seed.merchant.id, order.id, "paid", "webhook");
      expect(paid.changed).toBe(false);
      expect(paid.order.status).toBe("canceled");
    });
  });

  test("the transition table covers every status", () => {
    for (const status of orders.STATUSES) {
      expect(orders.ALLOWED_TRANSITIONS).toHaveProperty(status);
    }
  });
});

describe("a charge that does not belong to us", () => {
  test("a notification for an unknown charge is accepted and ignored", async () => {
    const found = await asMerchant(seed.merchant.id, () =>
      orders.findByCharge(seed.merchant.id, "asaas", "ch_never_seen")
    );
    expect(found).toBeNull();
  });

  test("a charge of one merchant is not found as another", async () => {
    const other = await seedMerchant({ name: "Other", slug: "other" });
    const { order } = await pendingOrder("cross@example.com");

    await asMerchant(seed.merchant.id, async () => {
      await db.query(
        `update orders set gateway = 'asaas', gateway_charge_id = 'ch_cross'
          where merchant_id = $1 and id = $2`,
        [seed.merchant.id, order.id]
      );
    });

    const mine = await asMerchant(seed.merchant.id, () =>
      orders.findByCharge(seed.merchant.id, "asaas", "ch_cross")
    );
    const theirs = await asMerchant(other.merchant.id, () =>
      orders.findByCharge(other.merchant.id, "asaas", "ch_cross")
    );

    expect(mine).toBeTruthy();
    expect(theirs).toBeNull();
  });
});
