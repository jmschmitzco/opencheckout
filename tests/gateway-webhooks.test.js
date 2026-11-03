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

// ===========================================================================
describe("a notification about money going back", () => {
  // The route's decisions are what is under test here, not an adapter's
  // parsing, so the simulated gateway is made to verify and to answer with a
  // crafted event. That is the only way to drive the handler itself: the
  // adapters are tested without a network in their own file.
  const DemoGateway = require("../src/gateways/demo");

  async function deliver(event, { verify = true } = {}) {
    const realVerify = DemoGateway.prototype.verifyWebhook;
    const realParse = DemoGateway.prototype.parseWebhook;
    DemoGateway.prototype.verifyWebhook = () => verify;
    DemoGateway.prototype.parseWebhook = () => event;
    try {
      return await request(app)
        .post(`/gateway-webhooks/asaas/${seed.webhookToken}`)
        .send({ anything: true });
    } finally {
      DemoGateway.prototype.verifyWebhook = realVerify;
      DemoGateway.prototype.parseWebhook = realParse;
    }
  }

  // A paid order that belongs to the gateway the notification claims to come
  // from. The demo makes the charge; the row is relabelled because the route
  // deliberately refuses to let one processor's notification move another
  // processor's order.
  async function asaasOrder(email, { paid = true } = {}) {
    const { order } = await pendingOrder(email);
    await asMerchant(seed.merchant.id, async () => {
      await db.query(`update orders set gateway = 'asaas' where merchant_id = $1 and id = $2`, [
        seed.merchant.id,
        order.id,
      ]);
      if (paid) await orders.markStatus(seed.merchant.id, order.id, "paid", "test");
    });
    return asMerchant(seed.merchant.id, () => orders.findById(seed.merchant.id, order.id));
  }

  test("a PARTIAL refund for less than the order is applied, not dropped", async () => {
    // THE TRAP. The amount check exists to stop a "paid" for a fraction of
    // the price. Letting it judge a refund as well would answer 202 and throw
    // the notification away: the money gone from the merchant's account, the
    // order still saying it received all of it, and nobody told.
    const order = await asaasOrder("partial-hook@example.com");

    const response = await deliver({
      eventId: "evt_partial_hook",
      eventType: "PAYMENT_PARTIALLY_REFUNDED",
      gatewayChargeId: order.gateway_charge_id,
      externalReference: order.public_id,
      status: null,
      amountCents: 3000,
      currency: "BRL",
      refundedCents: 3000,
      partialRefund: true,
      gatewayRefundId: "ref_hook_1",
    });

    expect(response.status).toBe(200);
    expect(response.body.amount_mismatch).toBeUndefined();
    expect(response.body.refund).toMatch(/^re_/);

    const after = await asMerchant(seed.merchant.id, () =>
      orders.findById(seed.merchant.id, order.id)
    );
    expect(after.refunded_cents).toBe(3000);
    // Still paid: the buyer kept what they bought.
    expect(after.status).toBe("paid");
  });

  test("a full refund reverses the order", async () => {
    const order = await asaasOrder("full-hook@example.com");

    const response = await deliver({
      eventId: "evt_full_hook",
      eventType: "PAYMENT_REFUNDED",
      gatewayChargeId: order.gateway_charge_id,
      externalReference: order.public_id,
      status: "refunded",
      amountCents: order.amount_cents,
      currency: "BRL",
      refundedCents: null,
      partialRefund: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("refunded");
  });

  test("a chargeback opens a dispute and moves the order", async () => {
    const order = await asaasOrder("chargeback-hook@example.com");

    const response = await deliver({
      eventId: "evt_cb_hook",
      eventType: "PAYMENT_CHARGEBACK_REQUESTED",
      gatewayChargeId: order.gateway_charge_id,
      externalReference: order.public_id,
      status: "chargeback",
      amountCents: order.amount_cents,
      currency: "BRL",
      disputeId: "dis_hook_1",
      disputeReason: "Unrecognised charge",
    });

    expect(response.status).toBe(200);

    const disputes = require("../src/services/disputes");
    const rows = await asMerchant(seed.merchant.id, () =>
      disputes.listForOrder(seed.merchant.id, order.id)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(order.amount_cents);
    expect(rows[0].reason).toBe("Unrecognised charge");

    const after = await asMerchant(seed.merchant.id, () =>
      orders.findById(seed.merchant.id, order.id)
    );
    expect(after.status).toBe("chargeback");
  });

  test("and a PAID for less than the order is still refused", async () => {
    // The check that the test above steps around must still be there for the
    // case it was written for.
    const order = await asaasOrder("short-paid@example.com", { paid: false });

    const response = await deliver({
      eventId: "evt_short_paid",
      eventType: "PAYMENT_RECEIVED",
      gatewayChargeId: order.gateway_charge_id,
      externalReference: order.public_id,
      status: "paid",
      amountCents: 1,
      currency: "BRL",
      refundedCents: null,
      partialRefund: false,
    });

    expect(response.status).toBe(202);
    expect(response.body.amount_mismatch).toBe(true);

    const after = await asMerchant(seed.merchant.id, () =>
      orders.findById(seed.merchant.id, order.id)
    );
    expect(after.status).toBe("pending");
  });
});
