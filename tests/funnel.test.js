// Order bump, upsell and downsell: the whole funnel.
//
// The money questions here are the ones that get a merchant a chargeback: did
// the buyer pay what the screen said, were they charged once, and could they
// say no.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let app;
let seed;
let offers;
let orders;
let catalog;
let sessions;

// Built once: the extra things the funnel sells.
let bumpPrice;
let upsellPrice;
let downsellPrice;

const GOOD_CARD = {
  number: "4242424242424242",
  holder_name: "Ada Lovelace",
  expiry: "12/34",
  cvv: "123",
};

const BUYER = {
  email: "funnel@example.com",
  name: "Ada Lovelace",
  document: "52998224725",
  phone: "11988887777",
};

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  app = require("../src/app");
  offers = require("../src/services/offers");
  orders = require("../src/services/orders");
  catalog = require("../src/services/catalog");
  sessions = require("../src/services/checkout-sessions");

  await asMerchant(seed.merchant.id, async () => {
    const extras = [
      ["Templates pack", 2900],
      ["One year of updates", 9700],
      ["Six months of updates", 4700],
    ];
    const prices = [];
    for (const [name, amount] of extras) {
      const product = await catalog.createProduct(seed.merchant.id, { name });
      prices.push(
        await catalog.createPrice(seed.merchant.id, product.public_id, {
          currency: "BRL",
          unitAmountCents: amount,
          compareAtCents: amount * 2,
        })
      );
    }
    [bumpPrice, upsellPrice, downsellPrice] = prices;

    for (const [kind, price, title] of [
      ["bump", bumpPrice, "Add the templates pack"],
      ["upsell", upsellPrice, "Keep it updated for a year"],
      ["downsell", downsellPrice, "Six months instead"],
    ]) {
      await offers.create(seed.merchant.id, {
        kind,
        trigger_product: seed.product.public_id,
        price: price.public_id,
        title,
        description: `A ${kind} for the test`,
      });
    }
  });
});

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

async function bumpIdOf(session) {
  const page = await request(app).get(`/c/${session.id}?k=${session.client_secret}`);
  const match = page.text.match(/data-oc-bump="(off_[a-z0-9]+)"/);
  return match ? match[1] : null;
}

// ===========================================================================
describe("creating an offer", () => {
  test("refuses a recurring price", async () => {
    // A one click button that starts a subscription, with no second
    // confirmation, is a chargeback waiting to be written.
    await asMerchant(seed.merchant.id, async () => {
      await expect(
        offers.create(seed.merchant.id, {
          kind: "upsell",
          trigger_product: seed.product.public_id,
          price: seed.recurringPrice.public_id,
          title: "Subscribe in one click",
        })
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  test("refuses an unknown product or price", async () => {
    await asMerchant(seed.merchant.id, async () => {
      await expect(
        offers.create(seed.merchant.id, {
          kind: "bump",
          trigger_product: "prod_nope",
          price: bumpPrice.public_id,
          title: "x",
        })
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  test("is listed through the API", async () => {
    const response = await request(app)
      .get("/v1/offers")
      .set("authorization", `Bearer ${seed.secretKey}`);
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBe(3);
    expect(response.body.data.map((o) => o.kind).sort()).toEqual(["bump", "downsell", "upsell"]);
  });
});

// ===========================================================================
describe("the order bump", () => {
  test("appears on the checkout that triggers it", async () => {
    const session = await newSession();
    const page = await request(app).get(`/c/${session.id}?k=${session.client_secret}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Add the templates pack");
    expect(page.text).toMatch(/data-oc-bump="off_/);
  });

  test("ticking it raises the total, by the amount on the offer", async () => {
    const session = await newSession();
    const offerId = await bumpIdOf(session);

    const response = await request(app)
      .post(`/c/${session.id}/bump`)
      .query({ k: session.client_secret })
      .send({ offer: offerId, accepted: true });

    expect(response.status).toBe(200);
    expect(response.body.bump_cents).toBe(2900);
    expect(response.body.total_cents).toBe(9900 + 2900);
    expect(response.body.accepted_bumps).toEqual([offerId]);
  });

  test("unticking it puts the total back", async () => {
    const session = await newSession();
    const offerId = await bumpIdOf(session);

    await request(app)
      .post(`/c/${session.id}/bump`)
      .query({ k: session.client_secret })
      .send({ offer: offerId, accepted: true });

    const off = await request(app)
      .post(`/c/${session.id}/bump`)
      .query({ k: session.client_secret })
      .send({ offer: offerId, accepted: false });

    expect(off.body.bump_cents).toBe(0);
    expect(off.body.total_cents).toBe(9900);
  });

  test("the page cannot name its own price", async () => {
    // The amount comes from the offer's row. Anything in the body is ignored.
    const session = await newSession();
    const offerId = await bumpIdOf(session);

    const response = await request(app)
      .post(`/c/${session.id}/bump`)
      .query({ k: session.client_secret })
      .send({ offer: offerId, accepted: true, amount_cents: 1, bump_cents: 1 });

    expect(response.body.bump_cents).toBe(2900);
  });

  test("an offer that is not on this checkout is refused", async () => {
    const session = await newSession();
    const response = await request(app)
      .post(`/c/${session.id}/bump`)
      .query({ k: session.client_secret })
      .send({ offer: "off_somethingelse", accepted: true });
    expect(response.status).toBe(400);
  });

  test("the charge is for the raised total, and the bump is a line on it", async () => {
    const session = await newSession();
    const offerId = await bumpIdOf(session);
    await request(app)
      .post(`/c/${session.id}/bump`)
      .query({ k: session.client_secret })
      .send({ offer: offerId, accepted: true });

    const paid = await pay(session, { method: "card", buyer: BUYER, card: GOOD_CARD });
    expect(paid.body.status).toBe("paid");

    const order = await request(app)
      .get(`/v1/orders/${paid.body.order_id}`)
      .set("authorization", `Bearer ${seed.secretKey}`);

    expect(order.body.amount_cents).toBe(12800);
    const kinds = order.body.items.map((item) => item.kind).sort();
    expect(kinds).toEqual(["bump", "main"]);
    const bump = order.body.items.find((item) => item.kind === "bump");
    expect(bump.amount_cents).toBe(2900);
  });

  describe("with a coupon", () => {
    beforeAll(async () => {
      await asMerchant(seed.merchant.id, () =>
        require("../src/services/coupons").create(seed.merchant.id, {
          code: "BUMPHALF",
          kind: "percent",
          value: 50,
        })
      );
    });

    test("the discount applies to the product, NOT to the bump", async () => {
      // A coupon is for the thing being sold. A bump is an add-on the buyer
      // chose after seeing the price, and halving it was never what the
      // merchant meant by "50% off".
      const session = await newSession();
      const offerId = await bumpIdOf(session);

      await request(app)
        .post(`/c/${session.id}/coupon`)
        .query({ k: session.client_secret })
        .send({ code: "BUMPHALF", email: "coupon-bump@example.com" });

      const withBump = await request(app)
        .post(`/c/${session.id}/bump`)
        .query({ k: session.client_secret })
        .send({ offer: offerId, accepted: true });

      // 9900 halved is 4950, plus the full 2900 bump.
      expect(withBump.body.total_cents).toBe(4950 + 2900);
    });

    test("clearing the coupon keeps the bump", async () => {
      const session = await newSession();
      const offerId = await bumpIdOf(session);

      await request(app)
        .post(`/c/${session.id}/bump`)
        .query({ k: session.client_secret })
        .send({ offer: offerId, accepted: true });

      const cleared = await request(app)
        .post(`/c/${session.id}/coupon`)
        .query({ k: session.client_secret })
        .send({ code: "" });

      expect(cleared.body.total_cents).toBe(9900 + 2900);
    });
  });
});

// ===========================================================================
describe("the post purchase funnel", () => {
  async function payAndGetFunnel(email) {
    const session = await newSession();
    const paid = await pay(session, {
      method: "card",
      buyer: { ...BUYER, email },
      card: GOOD_CARD,
    });
    return { session, paid };
  }

  test("a paid card order is sent to the offer, not to the success page", async () => {
    const { paid } = await payAndGetFunnel("funnel1@example.com");
    expect(paid.body.status).toBe("paid");
    expect(paid.body.next_url).toMatch(/^\/u\/ord_/);
    expect(paid.body.next_url).not.toContain("acme.test");
  });

  test("the page shows the upsell and names the card it will charge", async () => {
    const { paid } = await payAndGetFunnel("funnel2@example.com");
    const page = await request(app).get(paid.body.next_url);

    expect(page.status).toBe(200);
    expect(page.text).toContain("Keep it updated for a year");
    // The confirmation of what they already bought comes first.
    expect(page.text).toMatch(/pagamento está confirmado|payment is confirmed/i);
    // And the card is named, because "one click" is only fair if they can see
    // what the click charges.
    expect(page.text).toContain("4242");
    // Never framed: this page spends money with one click.
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });

  test("the order token is required, not just the order id", async () => {
    const { paid } = await payAndGetFunnel("funnel3@example.com");
    const withoutToken = await request(app).get(`/u/${paid.body.order_id}`);
    expect(withoutToken.status).toBe(404);

    const wrongToken = await request(app).get(`/u/${paid.body.order_id}?t=nonsense`);
    expect(wrongToken.status).toBe(404);
  });

  test("accepting charges the saved card and links the child order", async () => {
    const { paid } = await payAndGetFunnel("funnel4@example.com");
    const base = paid.body.next_url;

    const accepted = await request(app)
      .post(`/u/${paid.body.order_id}/accept`)
      .set("x-order-token", paid.body.token)
      .send({ offer: await currentOfferId(base) });

    expect(accepted.status).toBe(200);
    expect(accepted.body.accepted).toBe(true);
    expect(accepted.body.order_id).toMatch(/^ord_/);

    await asMerchant(seed.merchant.id, async () => {
      const parent = await orders.findByPublicId(seed.merchant.id, paid.body.order_id);
      const child = await orders.findByPublicId(seed.merchant.id, accepted.body.order_id);

      expect(child.parent_order_id).toBe(parent.id);
      expect(child.kind).toBe("upsell");
      expect(child.amount_cents).toBe(9700);
      expect(child.status).toBe("paid");
      // Charged against the credential the first sale produced, not a new one.
      expect(child.card_token).toBe(parent.card_token);
    });
  });

  test("accepting twice does not charge twice", async () => {
    // This is the screen people reload.
    const { paid } = await payAndGetFunnel("funnel5@example.com");
    const offerId = await currentOfferId(paid.body.next_url);

    const first = await request(app)
      .post(`/u/${paid.body.order_id}/accept`)
      .set("x-order-token", paid.body.token)
      .send({ offer: offerId });

    const second = await request(app)
      .post(`/u/${paid.body.order_id}/accept`)
      .set("x-order-token", paid.body.token)
      .send({ offer: offerId });

    expect(first.status).toBe(200);
    // The second answer is either the same order back, or the funnel having
    // moved on. Neither creates a second charge.
    expect([200, 409]).toContain(second.status);

    await asMerchant(seed.merchant.id, async () => {
      const parent = await orders.findByPublicId(seed.merchant.id, paid.body.order_id);
      const children = await db.query(
        `select count(*)::int as n from orders
          where merchant_id = $1 and parent_order_id = $2 and kind = 'upsell'`,
        [seed.merchant.id, parent.id]
      );
      expect(children.rows[0].n).toBe(1);
    });
  });

  test("declining the upsell offers the downsell", async () => {
    const { paid } = await payAndGetFunnel("funnel6@example.com");
    const declined = await request(app)
      .post(`/u/${paid.body.order_id}/decline`)
      .set("x-order-token", paid.body.token)
      .send({ offer: await currentOfferId(paid.body.next_url) });

    expect(declined.status).toBe(200);
    expect(declined.body.done).toBe(false);
    expect(declined.body.next_url).toMatch(/^\/u\/ord_/);

    const page = await request(app).get(declined.body.next_url);
    expect(page.text).toContain("Six months instead");
  });

  test("declining the downsell finishes at the merchant's success page", async () => {
    const { paid } = await payAndGetFunnel("funnel7@example.com");

    await request(app)
      .post(`/u/${paid.body.order_id}/decline`)
      .set("x-order-token", paid.body.token)
      .send({ offer: await currentOfferId(paid.body.next_url) });

    const second = await request(app)
      .post(`/u/${paid.body.order_id}/decline`)
      .set("x-order-token", paid.body.token)
      .send({ offer: await currentOfferId(paid.body.next_url) });

    expect(second.body.done).toBe(true);
    expect(second.body.next_url).toContain("https://acme.test/thanks");
  });

  test("a declined offer is not offered again on a refresh", async () => {
    const { paid } = await payAndGetFunnel("funnel8@example.com");
    const firstOffer = await currentOfferId(paid.body.next_url);

    await request(app)
      .post(`/u/${paid.body.order_id}/decline`)
      .set("x-order-token", paid.body.token)
      .send({ offer: firstOffer });

    const secondOffer = await currentOfferId(paid.body.next_url);
    expect(secondOffer).not.toBe(firstOffer);
  });

  test("a stale tab cannot buy an offer the funnel has moved past", async () => {
    const { paid } = await payAndGetFunnel("funnel9@example.com");
    const staleOffer = await currentOfferId(paid.body.next_url);

    await request(app)
      .post(`/u/${paid.body.order_id}/decline`)
      .set("x-order-token", paid.body.token)
      .send({ offer: staleOffer });

    const stale = await request(app)
      .post(`/u/${paid.body.order_id}/accept`)
      .set("x-order-token", paid.body.token)
      .send({ offer: staleOffer });

    expect(stale.status).toBe(409);
  });

  test("a Pix order gets no funnel, because there is no card to charge", async () => {
    // A one click button with no saved credential would be a lie.
    const session = await newSession();
    const pending = await pay(session, {
      method: "pix",
      buyer: { ...BUYER, email: "pixfunnel@example.com" },
    });
    expect(pending.body.status).toBe("pending");

    await asMerchant(seed.merchant.id, async () => {
      const order = await orders.findByPublicId(seed.merchant.id, pending.body.order_id);
      expect(orders.orderCanFunnel(order)).toBe(false);
      expect(await offers.nextFunnelStep(seed.merchant.id, order, {})).toBeNull();
    });
  });

  test("the funnel does not follow an unpaid order", async () => {
    const session = await newSession();
    const declinedCard = await pay(session, {
      method: "card",
      buyer: { ...BUYER, email: "refusedfunnel@example.com" },
      card: { ...GOOD_CARD, number: "4000000000000002" },
    });
    expect(declinedCard.body.status).toBe("refused");

    await asMerchant(seed.merchant.id, async () => {
      const order = await orders.findByPublicId(seed.merchant.id, declinedCard.body.order_id);
      expect(orders.orderCanFunnel(order)).toBe(false);
    });
  });
});

// Reads which offer the funnel is currently showing, the way the page does.
async function currentOfferId(url) {
  const page = await request(app).get(url);
  const match = page.text.match(/"offerId":"(off_[a-z0-9]+)"/);
  return match ? match[1] : null;
}
