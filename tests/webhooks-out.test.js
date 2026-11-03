// Outbound webhooks: the half of the product that tells an integrator that
// money moved.
const crypto = require("crypto");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");

let seed;
let webhooksOut;
let events;

beforeAll(async () => {
  createMemoryDb();
  seed = await seedMerchant();
  webhooksOut = require("../src/services/webhooks-out");
  events = require("../src/services/events");
});

// Verifies the way an integrator's server would, straight from the docs: rebuild
// "timestamp.body", recompute the HMAC, compare.
function verifyAsReceiver({ body, headers, secret, toleranceSeconds = 300 }) {
  const timestamp = Number(headers["OpenCheckout-Timestamp"]);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const given = headers["OpenCheckout-Signature"];
  if (expected.length !== String(given).length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(given)));
}

describe("endpoints", () => {
  test("the secret is shown once and stored encrypted", async () => {
    const endpoint = await asMerchant(seed.merchant.id, () =>
      webhooksOut.createEndpoint(seed.merchant.id, { url: "https://acme.test/hooks" })
    );
    expect(endpoint.secret).toMatch(/^whsec_/);

    const stored = await db.query(`select secret from webhook_endpoints where merchant_id = $1 and id = $2`, [
      seed.merchant.id,
      endpoint.id,
    ]);
    // Encrypted at rest: a database leak hands out no usable signing secret.
    expect(stored.rows[0].secret).not.toContain(endpoint.secret);
  });

  test("refuses a URL that is not http(s)", async () => {
    await expect(
      asMerchant(seed.merchant.id, () =>
        webhooksOut.createEndpoint(seed.merchant.id, { url: "javascript:alert(1)" })
      )
    ).rejects.toMatchObject({ status: 400 });
  });

  test("refuses an event type nobody emits", async () => {
    await expect(
      asMerchant(seed.merchant.id, () =>
        webhooksOut.createEndpoint(seed.merchant.id, {
          url: "https://acme.test/hooks",
          events: ["order.levitated"],
        })
      )
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("delivery", () => {
  test("signs the body so a receiver can verify it", async () => {
    const endpoint = await asMerchant(seed.merchant.id, () =>
      webhooksOut.createEndpoint(seed.merchant.id, { url: "https://acme.test/hooks" })
    );

    const captured = [];
    const fakeFetch = async (url, options) => {
      captured.push({ url, options });
      return { status: 200 };
    };

    await asMerchant(seed.merchant.id, async () => {
      const event = await events.record(
        seed.merchant.id,
        "order.paid",
        { order: { id: "ord_test", amount_cents: 9900 } },
        { livemode: false }
      );
      await webhooksOut.enqueue(seed.merchant.id, event);
      await webhooksOut.dispatchPending({ fetchImpl: fakeFetch });
    });

    expect(captured.length).toBeGreaterThan(0);
    const sent = captured[captured.length - 1];
    expect(sent.url).toBe("https://acme.test/hooks");
    expect(sent.options.headers["OpenCheckout-Event"]).toBe("order.paid");
    expect(
      verifyAsReceiver({
        body: sent.options.body,
        headers: sent.options.headers,
        secret: endpoint.secret,
      })
    ).toBe(true);
  });

  test("a captured delivery cannot be replayed later", async () => {
    // The timestamp is part of the signed material, which is what makes a
    // replay fail instead of succeeding forever.
    const endpoint = await asMerchant(seed.merchant.id, () =>
      webhooksOut.createEndpoint(seed.merchant.id, { url: "https://acme.test/replay" })
    );

    let sent = null;
    const fakeFetch = async (_url, options) => {
      sent = options;
      return { status: 200 };
    };

    await asMerchant(seed.merchant.id, async () => {
      const event = await events.record(seed.merchant.id, "order.paid", { order: {} }, {});
      await webhooksOut.enqueue(seed.merchant.id, event);
      await webhooksOut.dispatchPending({ fetchImpl: fakeFetch });
    });

    const stale = { ...sent.headers };
    stale["OpenCheckout-Timestamp"] = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyAsReceiver({ body: sent.body, headers: stale, secret: endpoint.secret })).toBe(false);
  });

  test("a wrong secret does not verify", async () => {
    let sent = null;
    await asMerchant(seed.merchant.id, async () => {
      await webhooksOut.createEndpoint(seed.merchant.id, { url: "https://acme.test/wrong" });
      const event = await events.record(seed.merchant.id, "order.paid", { order: {} }, {});
      await webhooksOut.enqueue(seed.merchant.id, event);
      await webhooksOut.dispatchPending({
        fetchImpl: async (_url, options) => {
          sent = options;
          return { status: 200 };
        },
      });
    });

    expect(
      verifyAsReceiver({ body: sent.body, headers: sent.headers, secret: "whsec_not_the_one" })
    ).toBe(false);
  });

  test("a failure is retried later, not dropped", async () => {
    await asMerchant(seed.merchant.id, async () => {
      const endpoint = await webhooksOut.createEndpoint(seed.merchant.id, {
        url: "https://acme.test/down",
      });
      const event = await events.record(seed.merchant.id, "order.refused", { order: {} }, {});
      await webhooksOut.enqueue(seed.merchant.id, event);

      await webhooksOut.dispatchPending({ fetchImpl: async () => ({ status: 500 }) });

      const rows = await db.query(
        `select status, attempts, next_attempt_at, last_status_code
           from webhook_deliveries
          where merchant_id = $1 and endpoint_id = $2`,
        [seed.merchant.id, endpoint.id]
      );
      const delivery = rows.rows[0];
      expect(delivery.status).toBe("pending");
      expect(delivery.attempts).toBe(1);
      expect(delivery.last_status_code).toBe(500);
      // Scheduled into the future, so the next pass does not hammer a server
      // that is genuinely down.
      expect(new Date(delivery.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  test("an endpoint only gets the events it subscribed to", async () => {
    const calls = [];
    await asMerchant(seed.merchant.id, async () => {
      await webhooksOut.createEndpoint(seed.merchant.id, {
        url: "https://acme.test/only-refunds",
        events: ["order.refunded"],
      });

      const event = await events.record(seed.merchant.id, "cart.abandoned", { cart: {} }, {});
      await webhooksOut.enqueue(seed.merchant.id, event);
      await webhooksOut.dispatchPending({
        fetchImpl: async (url) => {
          calls.push(url);
          return { status: 200 };
        },
      });
    });

    expect(calls).not.toContain("https://acme.test/only-refunds");
  });

  test("a network error is translated into something a merchant can act on", () => {
    expect(webhooksOut.translateNetworkError({ code: "ENOTFOUND" })).toMatch(/Host not found/);
    expect(webhooksOut.translateNetworkError({ name: "AbortError" })).toMatch(/did not answer/);
  });
});
