// Regression tests for the money audit.
//
// Every test here names a way the system could have taken the wrong amount,
// taken it twice, or lost a sale. They exist because the bug existed.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let app;
let seed;
let orders;
let sessions;
let coupons;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  app = require("../src/app");
  orders = require("../src/services/orders");
  sessions = require("../src/services/checkout-sessions");
  coupons = require("../src/services/coupons");
});

const GOOD_CARD = {
  number: "4242424242424242",
  holder_name: "Ada Lovelace",
  expiry: "12/34",
  cvv: "123",
};
const DECLINED_CARD = { ...GOOD_CARD, number: "4000000000000002" };

const BUYER = {
  email: "audit@example.com",
  name: "Ada Lovelace",
  document: "52998224725",
  phone: "11988887777",
};

async function newSession(overrides = {}) {
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

function pay(session, body) {
  return request(app).post(`/c/${session.id}/pay`).query({ k: session.client_secret }).send(body);
}

// ===========================================================================
describe("one charge per session", () => {
  test("two tabs pressing pay at the same time produce ONE order", async () => {
    // Two tabs is normal human behaviour. Without a claim, both requests pass
    // the "is it still open?" check and both reach the gateway, and the buyer
    // is charged twice for one purchase.
    const session = await newSession();

    const [first, second] = await Promise.all([
      pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD }),
      pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const created = await asMerchant(seed.merchant.id, async () => {
      const row = await sessions.findByPublicId(seed.merchant.id, session.id);
      return db.query(`select count(*)::int as n from orders where merchant_id = $1 and session_id = $2`, [
        seed.merchant.id,
        row.id,
      ]);
    });
    expect(created.rows[0].n).toBe(1);
  });

  test("the loser is told a payment is in progress, not that the link is dead", async () => {
    const session = await newSession();
    const results = await Promise.all([
      pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD }),
      pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD }),
    ]);
    const refused = results.find((r) => r.status === 409);
    expect(refused.body.error.message).toMatch(/already being processed|completed/i);
  });

  test("a stale claim does not lock a session forever", async () => {
    // A process that dies mid-charge must not take the sale with it.
    const session = await newSession();

    await asMerchant(seed.merchant.id, async () => {
      const row = await sessions.findByPublicId(seed.merchant.id, session.id);
      const longAgo = new Date(Date.now() - (sessions.CHARGE_CLAIM_SECONDS + 60) * 1000);
      await db.query(
        `update checkout_sessions set charging_at = $3 where merchant_id = $1 and id = $2`,
        [seed.merchant.id, row.id, longAgo]
      );
      const claimed = await sessions.claimForCharge(seed.merchant.id, row.id);
      expect(claimed).toBeTruthy();
    });
  });
});

// ===========================================================================
describe("a decline does not end the checkout", () => {
  test("the buyer can try another card on the same link", async () => {
    // This was the worst conversion bug in the system: a mistyped security
    // code closed the session, and the link the buyer was looking at no
    // longer worked.
    const session = await newSession();

    const declined = await pay(session, { method: "card", buyer: BUYER, card: DECLINED_CARD });
    expect(declined.status).toBe(201);
    expect(declined.body.status).toBe("refused");

    const retry = await pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD });
    expect(retry.status).toBe(201);
    expect(retry.body.status).toBe("paid");
  });

  test("the session is still open between the two attempts", async () => {
    const session = await newSession();
    await pay(session, { method: "card", buyer: BUYER, card: DECLINED_CARD });

    await asMerchant(seed.merchant.id, async () => {
      const row = await sessions.findByPublicId(seed.merchant.id, session.id);
      expect(sessions.effectiveStatus(row)).toBe("open");
      // And the claim was released, or the retry would be told a payment is
      // already in progress.
      expect(row.charging_at).toBeFalsy();
    });
  });

  test("a successful payment DOES end it", async () => {
    const session = await newSession();
    await pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD });
    const again = await pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD });
    expect(again.status).toBe(409);
  });
});

// ===========================================================================
describe("coupon redemptions", () => {
  test("typing a code does not spend a redemption", async () => {
    // One buyer trying three codes used to burn three redemptions of a
    // limited coupon, and an abandoned cart burned one forever.
    await asMerchant(seed.merchant.id, () =>
      coupons.create(seed.merchant.id, { code: "LIMITED", kind: "percent", value: 10, maxRedemptions: 1 })
    );

    const session = await newSession();
    await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "LIMITED", email: "typing@example.com" });
    await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "LIMITED", email: "typing@example.com" });

    const coupon = await asMerchant(seed.merchant.id, () =>
      coupons.findByCode(seed.merchant.id, "LIMITED")
    );
    expect(coupon.redemptions).toBe(0);
  });

  test("a paid order spends exactly one", async () => {
    const session = await newSession();
    await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "LIMITED", email: BUYER.email });

    const paid = await pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD });
    expect(paid.body.status).toBe("paid");

    const coupon = await asMerchant(seed.merchant.id, () =>
      coupons.findByCode(seed.merchant.id, "LIMITED")
    );
    expect(coupon.redemptions).toBe(1);
  });

  test("a declined attempt spends none", async () => {
    await asMerchant(seed.merchant.id, () =>
      coupons.create(seed.merchant.id, { code: "DECLINE", kind: "percent", value: 10 })
    );
    const session = await newSession();
    await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "DECLINE", email: "nope@example.com" });

    await pay(session, {
      method: "card",
      buyer: { ...BUYER, email: "nope@example.com" },
      card: DECLINED_CARD,
    });

    const coupon = await asMerchant(seed.merchant.id, () =>
      coupons.findByCode(seed.merchant.id, "DECLINE")
    );
    expect(coupon.redemptions).toBe(0);
  });
});

// ===========================================================================
describe("the charge uses the session as it is NOW", () => {
  test("a coupon applied in another tab is honoured", async () => {
    // The request loads the session at the start. Charging from that stale row
    // meant the buyer saw the discounted price and was charged the full one.
    await asMerchant(seed.merchant.id, () =>
      coupons.create(seed.merchant.id, { code: "RACE", kind: "percent", value: 50 })
    );
    const session = await newSession();

    // The page the buyer is on knows nothing about this.
    await request(app)
      .post(`/c/${session.id}/coupon`)
      .query({ k: session.client_secret })
      .send({ code: "RACE", email: "race@example.com" });

    const paid = await pay(session, {
      method: "card",
      buyer: { ...BUYER, email: "race@example.com" },
      card: GOOD_CARD,
    });

    const order = await request(app)
      .get(`/v1/orders/${paid.body.order_id}`)
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(order.body.amount_cents).toBe(4950);
    expect(order.body.coupon).toBe("RACE");
  });
});

// ===========================================================================
describe("currency routing", () => {
  const { gatewaysForMethod, capabilitiesOf } = require("../src/gateways");

  test("a Brazilian gateway is never offered a foreign currency", async () => {
    // Routing a dollar session to a reais-only gateway charges the same figure
    // at a completely different price.
    expect(gatewaysForMethod("card", "BRL")).toContain("asaas");
    expect(gatewaysForMethod("card", "USD")).not.toContain("asaas");
    expect(gatewaysForMethod("card", "USD")).not.toContain("pagarme");
  });

  test("PayPal covers the currencies the Brazilian gateways cannot", () => {
    expect(gatewaysForMethod("paypal", "USD")).toEqual(["paypal"]);
    expect(gatewaysForMethod("paypal", "EUR")).toEqual(["paypal"]);
  });

  test("every gateway declares what it settles in", () => {
    for (const name of ["asaas", "pagarme", "mercadopago", "paypal"]) {
      expect(Array.isArray(capabilitiesOf(name).currencies)).toBe(true);
      expect(capabilitiesOf(name).currencies.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
describe("reconciliation applies the amount check", () => {
  test("a charge that settled for less is not marked paid", async () => {
    // The webhook path checked this and the polling path did not, and polling
    // is the path a Pix actually takes.
    const session = await newSession();
    const pending = await pay(session, { method: "pix", buyer: BUYER });
    expect(pending.body.status).toBe("pending");

    const DemoGateway = require("../src/gateways/demo");
    const spy = jest
      .spyOn(DemoGateway.prototype, "getChargeStatus")
      .mockResolvedValue({ status: "paid", paidAt: new Date(), amountCents: 100, currency: "BRL" });

    try {
      await asMerchant(seed.merchant.id, async () => {
        const order = await orders.findByPublicId(seed.merchant.id, pending.body.order_id);
        const result = await orders.reconcile(seed.merchant.id, order);

        expect(result.amountMismatch).toBe(true);
        expect(result.changed).toBe(false);

        const after = await orders.findByPublicId(seed.merchant.id, pending.body.order_id);
        expect(after.status).toBe("pending");
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a charge that settled for the right amount is marked paid", async () => {
    const session = await newSession();
    const pending = await pay(session, { method: "pix", buyer: BUYER });

    const DemoGateway = require("../src/gateways/demo");
    const spy = jest.spyOn(DemoGateway.prototype, "getChargeStatus").mockResolvedValue({
      status: "paid",
      paidAt: new Date(),
      amountCents: 9900,
      currency: "BRL",
    });

    try {
      await asMerchant(seed.merchant.id, async () => {
        const order = await orders.findByPublicId(seed.merchant.id, pending.body.order_id);
        const result = await orders.reconcile(seed.merchant.id, order);
        expect(result.status).toBe("paid");
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a gateway with no comparable amount is not treated as a mismatch", async () => {
    // An instalment plan reports a per-instalment figure, and null is the
    // honest answer rather than a false alarm on every legitimate sale.
    const session = await newSession();
    const pending = await pay(session, { method: "pix", buyer: BUYER });

    const DemoGateway = require("../src/gateways/demo");
    const spy = jest
      .spyOn(DemoGateway.prototype, "getChargeStatus")
      .mockResolvedValue({ status: "paid", paidAt: new Date(), amountCents: null });

    try {
      await asMerchant(seed.merchant.id, async () => {
        const order = await orders.findByPublicId(seed.merchant.id, pending.body.order_id);
        const result = await orders.reconcile(seed.merchant.id, order);
        expect(result.status).toBe("paid");
      });
    } finally {
      spy.mockRestore();
    }
  });
});

// ===========================================================================
describe("a renewal that never reached the gateway", () => {
  test("does not leave an order pending forever", async () => {
    const subscriptions = require("../src/services/subscriptions");

    const created = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({
        mode: "subscription",
        line_items: [{ price: seed.recurringPrice.public_id }],
        success_url: "https://acme.test/welcome",
      });
    await pay(created.body, {
      method: "card",
      buyer: { ...BUYER, email: "renew-fail@example.com" },
      card: GOOD_CARD,
    });

    const DemoGateway = require("../src/gateways/demo");
    const spy = jest
      .spyOn(DemoGateway.prototype, "chargeWithToken")
      .mockRejectedValue(new Error("gateway is down"));

    try {
      await asMerchant(seed.merchant.id, async () => {
        const list = await subscriptions.list(seed.merchant.id, { status: "active" });
        const subscription = list[list.length - 1];
        await db.query(
          `update subscriptions set current_period_end = $3 where merchant_id = $1 and id = $2`,
          [seed.merchant.id, subscription.id, new Date(Date.now() - 1000)]
        );

        const due = await subscriptions.findByPublicId(seed.merchant.id, subscription.public_id);
        const result = await subscriptions.renew(seed.merchant.id, due);
        expect(result.ok).toBe(false);

        const stranded = await db.query(
          `select count(*)::int as n from orders
            where merchant_id = $1 and customer_id = $2 and status = 'pending'`,
          [seed.merchant.id, due.customer_id]
        );
        expect(stranded.rows[0].n).toBe(0);
      });
    } finally {
      spy.mockRestore();
    }
  });
});
