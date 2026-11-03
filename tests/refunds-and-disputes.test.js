// Money going back: refunds the merchant chooses to give, and disputes the
// card network takes without asking.
//
// Every test here guards one of the three rules in src/services/refunds.js.
// They are not hypothetical: each of them, got wrong, either tells a buyer
// their money is on the way when it is not, revokes access somebody paid for,
// or sends the same money back twice.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");
const DemoGateway = require("../src/gateways/demo");

let app;
let seed;
let other;
let orders;
let refunds;
let disputes;
let events;
// The simulated gateway's own refund, kept before it is replaced below.
let realDemoRefund;

const GOOD_CARD = {
  number: "4242424242424242",
  holder_name: "Ada Lovelace",
  expiry: "12/34",
  cvv: "123",
};

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant({ name: "Refunds", slug: "refunds-co" });
  other = await seedMerchant({ name: "Nosy", slug: "nosy-co" });
  app = require("../src/app");
  orders = require("../src/services/orders");
  refunds = require("../src/services/refunds");
  disputes = require("../src/services/disputes");
  events = require("../src/services/events");

  // MOST OF THIS FILE IS ABOUT THE PENDING PATH, which is what nearly every
  // processor answers: asked, not done. The simulated gateway answers DONE to
  // a card refund, so it is replaced here and the tests that want an immediate
  // settlement say so themselves with gatewayAnswers(). The real one is
  // exercised in its own describe at the end.
  realDemoRefund = DemoGateway.prototype.refund;
  DemoGateway.prototype.refund = async () => ({
    ok: true,
    refundId: `demo_re_${Math.random().toString(36).slice(2, 8)}`,
    refundStatus: "PENDING",
  });
});

afterAll(() => {
  DemoGateway.prototype.refund = realDemoRefund;
});

// A paid card order, which is the only state any of this applies to.
async function paidOrder(email = "ada@example.com", amountCents = null) {
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
      method: "card",
      buyer: { email, name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
      card: GOOD_CARD,
    });

  expect(paid.body.status).toBe("paid");
  const order = await asMerchant(seed.merchant.id, () =>
    orders.findByPublicId(seed.merchant.id, paid.body.order_id)
  );

  if (amountCents != null) {
    // Some tests need a round number to reason about. The order is rewritten
    // rather than a second price created, because the amount is all that the
    // refund rules look at.
    await asMerchant(seed.merchant.id, () =>
      db.query(`update orders set amount_cents = $2 where merchant_id = $1 and id = $3`, [
        seed.merchant.id,
        amountCents,
        order.id,
      ])
    );
    return reload(order.id);
  }

  return order;
}

function reload(orderId) {
  return asMerchant(seed.merchant.id, () => orders.findById(seed.merchant.id, orderId));
}

// Replaces what the simulated gateway answers to a refund, for one test.
//
// The default demo answer is the honest common case: "asked, not done". These
// tests need the other answers too, and a gateway that refuses outright.
function gatewayAnswers(answer) {
  const original = DemoGateway.prototype.refund;
  DemoGateway.prototype.refund = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return () => {
    DemoGateway.prototype.refund = original;
  };
}

// The event types recorded for one thing, found by the public id its payload
// carries. Reading "the last N events" instead would pick up the previous
// test's order, which is how an assertion passes for the wrong reason.
async function typesFor(publicId) {
  const rows = await asMerchant(seed.merchant.id, () =>
    db.query(
      `select type from events where merchant_id = $1 and payload like $2 order by id`,
      [seed.merchant.id, `%${publicId}%`]
    )
  );
  return rows.rows.map((row) => row.type);
}

// ===========================================================================
describe("how much is still refundable", () => {
  test("all of a paid order, and nothing of a pending one", async () => {
    const order = await paidOrder("refundable@example.com", 10000);
    expect(await asMerchant(seed.merchant.id, () => refunds.refundableCents(seed.merchant.id, order))).toBe(
      10000
    );

    const pending = { ...order, status: "pending" };
    expect(
      await asMerchant(seed.merchant.id, () => refunds.refundableCents(seed.merchant.id, pending))
    ).toBe(0);
  });

  test("a request still in flight is already spoken for", async () => {
    // THE RULE THAT STOPS THE DOUBLE REFUND. A request we have sent and not
    // yet heard back about is money that is probably already gone. Counting
    // only what has settled would let a second tab send it again.
    const order = await paidOrder("inflight@example.com", 10000);
    await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, amountCents: 4000 })
    );

    const left = await asMerchant(seed.merchant.id, async () =>
      refunds.refundableCents(seed.merchant.id, await reload(order.id))
    );
    expect(left).toBe(6000);
  });
});

// ===========================================================================
describe("asking for a refund", () => {
  test("a request is not a refund: the order does not move", async () => {
    const order = await paidOrder("asked@example.com", 10000);
    const refund = await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, reason: "Changed their mind" })
    );

    expect(refund.public_id).toMatch(/^re_/);
    expect(refund.status).toBe("requested");
    expect(refund.amount_cents).toBe(10000);

    const after = await reload(order.id);
    expect(after.status).toBe("paid");
    expect(after.refunded_cents).toBe(0);
  });

  test("no amount means all of what is left", async () => {
    const order = await paidOrder("whole@example.com", 7500);
    await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, amountCents: 2500 })
    );
    const rest = await asMerchant(seed.merchant.id, async () =>
      refunds.request({ merchant: seed.merchant, order: await reload(order.id) })
    );
    expect(rest.amount_cents).toBe(5000);
  });

  test("more than is left is refused, and the message says how much is left", async () => {
    const order = await paidOrder("toomuch@example.com", 10000);
    await expect(
      asMerchant(seed.merchant.id, () =>
        refunds.request({ merchant: seed.merchant, order, amountCents: 10001 })
      )
    ).rejects.toMatchObject({ status: 400 });

    try {
      await asMerchant(seed.merchant.id, () =>
        refunds.request({ merchant: seed.merchant, order, amountCents: 10001 })
      );
    } catch (err) {
      expect(err.message).toContain("100,00");
    }
  });

  test("zero, a negative, and a fraction of a cent are all refused", async () => {
    const order = await paidOrder("fractions@example.com", 10000);
    for (const amount of [0, -500, 10.5, "abc"]) {
      await expect(
        asMerchant(seed.merchant.id, () =>
          refunds.request({ merchant: seed.merchant, order, amountCents: amount })
        )
      ).rejects.toMatchObject({ status: 400 });
    }
    expect((await reload(order.id)).refunded_cents).toBe(0);
  });

  test("once everything is asked for, there is nothing left to ask for", async () => {
    const order = await paidOrder("empty@example.com", 10000);
    await asMerchant(seed.merchant.id, () => refunds.request({ merchant: seed.merchant, order }));
    await expect(
      asMerchant(seed.merchant.id, async () =>
        refunds.request({ merchant: seed.merchant, order: await reload(order.id) })
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  test("a charged back order says the money has already gone", async () => {
    const order = await paidOrder("gone@example.com", 10000);
    await asMerchant(seed.merchant.id, () =>
      orders.markStatus(seed.merchant.id, order.id, "chargeback", "test")
    );

    try {
      await asMerchant(seed.merchant.id, async () =>
        refunds.request({ merchant: seed.merchant, order: await reload(order.id) })
      );
      throw new Error("it should have refused");
    } catch (err) {
      expect(err.status).toBe(409);
      expect(err.message).toContain("charged back");
    }
  });

  test("a PayPal order with no capture cannot be refunded, and the row says so", async () => {
    // PayPal refunds a CAPTURE, not the order we created. An order that never
    // reached a capture has nothing to refund against, and saying "done"
    // because a charge id exists would be a lie.
    const order = await paidOrder("paypal@example.com", 10000);
    await asMerchant(seed.merchant.id, () =>
      db.query(
        `update orders set gateway = 'paypal', gateway_capture_id = null
          where merchant_id = $1 and id = $2`,
        [seed.merchant.id, order.id]
      )
    );

    await expect(
      asMerchant(seed.merchant.id, async () =>
        refunds.request({ merchant: seed.merchant, order: await reload(order.id) })
      )
    ).rejects.toMatchObject({ status: 409 });

    const rows = await asMerchant(seed.merchant.id, () =>
      refunds.listForOrder(seed.merchant.id, order.id)
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].failure_reason).toBeTruthy();
    expect((await reload(order.id)).refunded_cents).toBe(0);
  });

  test("a gateway that refuses leaves the row failed and the order untouched", async () => {
    const order = await paidOrder("refused@example.com", 10000);
    const restore = gatewayAnswers(new Error("Insufficient balance"));
    try {
      await expect(
        asMerchant(seed.merchant.id, () => refunds.request({ merchant: seed.merchant, order }))
      ).rejects.toMatchObject({ status: 502 });
    } finally {
      restore();
    }

    const rows = await asMerchant(seed.merchant.id, () =>
      refunds.listForOrder(seed.merchant.id, order.id)
    );
    expect(rows[0].status).toBe("failed");
    expect((await reload(order.id)).refunded_cents).toBe(0);
    expect(await typesFor(order.public_id)).toContain("refund.failed");
  });

  test("the gateway's own message never reaches the merchant verbatim", async () => {
    // A processor's error text can carry an account identifier or a token.
    // What comes back is our sentence, not theirs.
    const order = await paidOrder("scrubbed@example.com", 10000);
    const restore = gatewayAnswers(new Error("card 4242424242424242 declined for acct_secret"));
    try {
      await asMerchant(seed.merchant.id, () => refunds.request({ merchant: seed.merchant, order }));
      throw new Error("it should have failed");
    } catch (err) {
      expect(err.message).not.toContain("4242424242424242");
      expect(err.message).not.toContain("acct_secret");
    } finally {
      restore();
    }
  });

  test("a gateway that settles on the spot is believed, and only when it says DONE", async () => {
    const order = await paidOrder("instant@example.com", 10000);
    const restore = gatewayAnswers({ ok: true, refundId: "demo_re_done", refundStatus: "DONE" });
    let refund;
    try {
      refund = await asMerchant(seed.merchant.id, () =>
        refunds.request({ merchant: seed.merchant, order })
      );
    } finally {
      restore();
    }

    expect(refund.status).toBe("succeeded");
    expect((await reload(order.id)).status).toBe("refunded");
  });

  test('"PENDING" is not DONE, however much it looks like an answer', async () => {
    const order = await paidOrder("pending-answer@example.com", 10000);
    const restore = gatewayAnswers({ ok: true, refundId: "demo_re_wait", refundStatus: "PENDING" });
    let refund;
    try {
      refund = await asMerchant(seed.merchant.id, () =>
        refunds.request({ merchant: seed.merchant, order })
      );
    } finally {
      restore();
    }

    expect(refund.status).toBe("requested");
    expect((await reload(order.id)).status).toBe("paid");
  });
});

// ===========================================================================
describe("when the gateway confirms", () => {
  test("a full refund reverses the order", async () => {
    const order = await paidOrder("full@example.com", 10000);
    const refund = await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order })
    );
    const settled = await asMerchant(seed.merchant.id, () =>
      refunds.applySucceeded({ merchantId: seed.merchant.id, refundId: refund.id })
    );

    expect(settled.status).toBe("succeeded");
    const after = await reload(order.id);
    expect(after.status).toBe("refunded");
    expect(after.refunded_cents).toBe(10000);
    expect(await typesFor(order.public_id)).toContain("refund.succeeded");
  });

  test("a partial refund leaves a PAID order and says so with its own event", async () => {
    // THE RULE THAT KEEPS ACCESS. The buyer still has what they bought. An
    // integrator reading order.refunded here would revoke an entitlement
    // somebody is entitled to.
    const order = await paidOrder("partial@example.com", 10000);
    const refund = await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, amountCents: 3000 })
    );
    await asMerchant(seed.merchant.id, () =>
      refunds.applySucceeded({ merchantId: seed.merchant.id, refundId: refund.id })
    );

    const after = await reload(order.id);
    expect(after.status).toBe("paid");
    expect(after.refunded_cents).toBe(3000);

    const types = await typesFor(order.public_id);
    expect(types).toContain("order.partially_refunded");
    expect(types).not.toContain("order.refunded");
  });

  test("two partial refunds that add up reverse the order between them", async () => {
    const order = await paidOrder("adds-up@example.com", 10000);
    for (const amount of [6000, 4000]) {
      const refund = await asMerchant(seed.merchant.id, async () =>
        refunds.request({ merchant: seed.merchant, order: await reload(order.id), amountCents: amount })
      );
      await asMerchant(seed.merchant.id, () =>
        refunds.applySucceeded({ merchantId: seed.merchant.id, refundId: refund.id })
      );
    }

    const after = await reload(order.id);
    expect(after.refunded_cents).toBe(10000);
    expect(after.status).toBe("refunded");
  });

  test("a confirmation arriving twice moves the money once", async () => {
    // Gateways resend. The second copy must find the row already settled and
    // leave the running total alone.
    const order = await paidOrder("twice@example.com", 10000);
    const refund = await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, amountCents: 2500 })
    );

    await asMerchant(seed.merchant.id, () =>
      refunds.applySucceeded({ merchantId: seed.merchant.id, refundId: refund.id })
    );
    await asMerchant(seed.merchant.id, () =>
      refunds.applySucceeded({ merchantId: seed.merchant.id, refundId: refund.id })
    );

    expect((await reload(order.id)).refunded_cents).toBe(2500);
  });
});

// ===========================================================================
describe("a notification from the gateway", () => {
  test("settles the request that was waiting", async () => {
    const order = await paidOrder("notified@example.com", 10000);
    const refund = await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, amountCents: 4000 })
    );

    const applied = await asMerchant(seed.merchant.id, async () =>
      refunds.applyFromGateway({
        merchantId: seed.merchant.id,
        order: await reload(order.id),
        amountCents: 4000,
      })
    );

    expect(applied.public_id).toBe(refund.public_id);
    expect(applied.status).toBe("succeeded");
    expect((await reload(order.id)).refunded_cents).toBe(4000);
  });

  test("the gateway's amount wins over what we asked for", async () => {
    // We asked for 40,00 and 25,00 moved. The statement will say 25,00, so
    // that is what the row has to say.
    const order = await paidOrder("their-amount@example.com", 10000);
    await asMerchant(seed.merchant.id, () =>
      refunds.request({ merchant: seed.merchant, order, amountCents: 4000 })
    );

    const applied = await asMerchant(seed.merchant.id, async () =>
      refunds.applyFromGateway({
        merchantId: seed.merchant.id,
        order: await reload(order.id),
        amountCents: 2500,
      })
    );

    expect(applied.amount_cents).toBe(2500);
    expect((await reload(order.id)).refunded_cents).toBe(2500);
  });

  test("a refund made in the processor's own dashboard gets a row of its own", async () => {
    // Nobody touched this system. The money is just as gone, and an order that
    // still says 100,00 received would be wrong on the one screen a merchant
    // checks.
    const order = await paidOrder("elsewhere@example.com", 10000);
    const applied = await asMerchant(seed.merchant.id, () =>
      refunds.applyFromGateway({
        merchantId: seed.merchant.id,
        order,
        amountCents: 3000,
        gatewayRefundId: "gw_re_outside",
      })
    );

    expect(applied.source).toBe("gateway");
    expect(applied.status).toBe("succeeded");
    expect(applied.amount_cents).toBe(3000);
    expect((await reload(order.id)).refunded_cents).toBe(3000);
  });

  test("the same notification twice does not refund twice", async () => {
    const order = await paidOrder("resent@example.com", 10000);
    for (let i = 0; i < 2; i += 1) {
      await asMerchant(seed.merchant.id, async () =>
        refunds.applyFromGateway({
          merchantId: seed.merchant.id,
          order: await reload(order.id),
          amountCents: 3000,
          gatewayRefundId: "gw_re_same",
        })
      );
    }

    const rows = await asMerchant(seed.merchant.id, () =>
      refunds.listForOrder(seed.merchant.id, order.id)
    );
    expect(rows).toHaveLength(1);
    expect((await reload(order.id)).refunded_cents).toBe(3000);
  });

  test("a notification for more than the order cannot overdraw it", async () => {
    const order = await paidOrder("overdraw@example.com", 10000);
    await asMerchant(seed.merchant.id, () =>
      refunds.applyFromGateway({ merchantId: seed.merchant.id, order, amountCents: 999999 })
    );
    expect((await reload(order.id)).refunded_cents).toBe(10000);
  });
});

// ===========================================================================
describe("the API", () => {
  test("a secret key can ask for a refund and read it back", async () => {
    const order = await paidOrder("api@example.com", 10000);

    const asked = await request(app)
      .post(`/v1/orders/${order.public_id}/refund`)
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({ amount_cents: 2500, reason: "Partial, by agreement" });

    expect(asked.status).toBe(201);
    expect(asked.body.object).toBe("refund");
    expect(asked.body.id).toMatch(/^re_/);
    expect(asked.body.status).toBe("requested");
    expect(asked.body.amount_cents).toBe(2500);

    const listed = await request(app)
      .get(`/v1/orders/${order.public_id}/refunds`)
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    // The number an integrator needs before offering a refund button.
    expect(listed.body.refundable_cents).toBe(7500);
  });

  test("a publishable key may not refund anything", async () => {
    // A key that sits in a browser must never be able to move money out.
    const order = await paidOrder("pk@example.com", 10000);
    const response = await request(app)
      .post(`/v1/orders/${order.public_id}/refund`)
      .set("authorization", `Bearer ${seed.publishableKey}`)
      .send({});
    expect(response.status).toBe(403);
  });

  test("another merchant's key cannot see or refund this order", async () => {
    const order = await paidOrder("mine@example.com", 10000);

    const refund = await request(app)
      .post(`/v1/orders/${order.public_id}/refund`)
      .set("authorization", `Bearer ${other.secretKey}`)
      .send({});
    expect(refund.status).toBe(404);

    const listed = await request(app)
      .get("/v1/refunds")
      .set("authorization", `Bearer ${other.secretKey}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(0);
  });

  test("disputes are read only, because the money has already gone", async () => {
    const order = await paidOrder("disputed-api@example.com", 10000);
    await asMerchant(seed.merchant.id, () =>
      disputes.open({
        merchantId: seed.merchant.id,
        order,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_api",
        amountCents: 10000,
        reason: "Not as described",
      })
    );

    const listed = await request(app)
      .get("/v1/disputes")
      .set("authorization", `Bearer ${seed.secretKey}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data[0].id).toMatch(/^dp_/);
    expect(listed.body.data[0].object).toBe("dispute");

    // There is no endpoint to open, answer or close one.
    const posted = await request(app)
      .post("/v1/disputes")
      .set("authorization", `Bearer ${seed.secretKey}`)
      .send({ order: order.public_id });
    expect(posted.status).toBe(404);
  });
});

// ===========================================================================
describe("disputes", () => {
  test("opening one records the amount at stake", async () => {
    const order = await paidOrder("dispute@example.com", 10000);
    const dispute = await asMerchant(seed.merchant.id, () =>
      disputes.open({
        merchantId: seed.merchant.id,
        order,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_1",
        amountCents: 10000,
        reason: "Unrecognised",
      })
    );

    expect(dispute.public_id).toMatch(/^dp_/);
    expect(dispute.status).toBe("open");
    expect(dispute.amount_cents).toBe(10000);
    expect(await typesFor(dispute.public_id)).toContain("dispute.opened");
  });

  test("the same notification twice is one dispute, not two", async () => {
    // Two rows would double the amount the dashboard says is at stake.
    const order = await paidOrder("dispute-twice@example.com", 10000);
    const first = await asMerchant(seed.merchant.id, () =>
      disputes.open({
        merchantId: seed.merchant.id,
        order,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_2",
        amountCents: 10000,
      })
    );
    const second = await asMerchant(seed.merchant.id, () =>
      disputes.open({
        merchantId: seed.merchant.id,
        order,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_2",
        amountCents: 10000,
      })
    );

    expect(second.id).toBe(first.id);
    const rows = await asMerchant(seed.merchant.id, () =>
      disputes.listForOrder(seed.merchant.id, order.id)
    );
    expect(rows).toHaveLength(1);
  });

  test("one without an order still gets recorded", async () => {
    // A dispute can arrive for a charge made elsewhere in the same gateway
    // account. Dropping it would hide money the merchant has lost.
    const dispute = await asMerchant(seed.merchant.id, () =>
      disputes.open({
        merchantId: seed.merchant.id,
        order: null,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_orphan",
        amountCents: 4200,
        currency: "BRL",
      })
    );
    expect(dispute.order_id).toBeNull();
    expect(dispute.amount_cents).toBe(4200);
  });

  test("closing one moves it out of open, and only once", async () => {
    const order = await paidOrder("dispute-close@example.com", 10000);
    const dispute = await asMerchant(seed.merchant.id, () =>
      disputes.open({
        merchantId: seed.merchant.id,
        order,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_3",
        amountCents: 10000,
      })
    );

    const won = await asMerchant(seed.merchant.id, () =>
      disputes.close({ merchantId: seed.merchant.id, disputeId: dispute.id, status: "won" })
    );
    expect(won.status).toBe("won");
    expect(won.resolved_at).toBeTruthy();
    expect(await typesFor(dispute.public_id)).toContain("dispute.closed");

    const again = await asMerchant(seed.merchant.id, () =>
      disputes.close({ merchantId: seed.merchant.id, disputeId: dispute.id, status: "lost" })
    );
    expect(again).toBeNull();
    expect(
      (await asMerchant(seed.merchant.id, () => disputes.findByPublicId(seed.merchant.id, dispute.public_id)))
        .status
    ).toBe("won");
  });

  test("the open amount counts only the ones still being argued over", async () => {
    const fresh = await seedMerchant({ name: "Stakes", slug: "stakes-co" });
    const openBefore = await asMerchant(fresh.merchant.id, () =>
      disputes.openAmount(fresh.merchant.id)
    );
    expect(openBefore).toEqual({ cents: 0, count: 0 });

    await asMerchant(fresh.merchant.id, async () => {
      const kept = await disputes.open({
        merchantId: fresh.merchant.id,
        order: null,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_stake_1",
        amountCents: 5000,
      });
      const closed = await disputes.open({
        merchantId: fresh.merchant.id,
        order: null,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_stake_2",
        amountCents: 7000,
      });
      await disputes.close({
        merchantId: fresh.merchant.id,
        disputeId: closed.id,
        status: "won",
      });
      return kept;
    });

    expect(await asMerchant(fresh.merchant.id, () => disputes.openAmount(fresh.merchant.id))).toEqual({
      cents: 5000,
      count: 1,
    });
  });

  test("one merchant's disputes are invisible to another", async () => {
    const mine = await asMerchant(seed.merchant.id, () => disputes.list(seed.merchant.id));
    const theirs = await asMerchant(other.merchant.id, () => disputes.list(other.merchant.id));
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs).toHaveLength(0);
  });
});

// ===========================================================================
describe("the simulated gateway's own answer", () => {
  // The demo keeps the difference a merchant will meet for real: a card
  // refund is given back on the same authorization and the processor says so
  // in the response, while a Pix refund is a new transfer to the buyer's bank
  // and is only confirmed later.
  async function demoCharge(method) {
    const gateway = new DemoGateway();
    const charge = await gateway.createCharge({
      order: { method, amountCents: 10000, currency: "BRL", publicId: "ord_demo", buyer: {} },
      card: method === "card" ? { number: "4242424242424242" } : null,
    });
    return { gateway, charge };
  }

  test("a card refund comes back DONE", async () => {
    const { gateway, charge } = await demoCharge("card");
    const answer = await realDemoRefund.call(gateway, charge.gatewayChargeId, { amountCents: 10000 });
    expect(answer.refundStatus).toBe("DONE");
  });

  test("a Pix refund comes back PENDING, because it is a new transfer", async () => {
    const { gateway, charge } = await demoCharge("pix");
    DemoGateway.settleNow(charge.gatewayChargeId);
    await gateway.getChargeStatus(charge.gatewayChargeId);
    const answer = await realDemoRefund.call(gateway, charge.gatewayChargeId, { amountCents: 10000 });
    expect(answer.refundStatus).toBe("PENDING");
  });

  test("a charge it never issued throws instead of reporting success", async () => {
    const gateway = new DemoGateway();
    await expect(realDemoRefund.call(gateway, "demo_ch_nope", {})).rejects.toThrow();
  });
});
