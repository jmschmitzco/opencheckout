// The guard that keeps one merchant out of another's data.
//
// It is the single most important rule in the codebase, because the failure
// mode is not a broken page, it is one business reading, or being charged for,
// another business's customers.
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");
const ctx = require("../src/db/merchant-context");
const { tablesIn, OWNED_TABLES } = require("../src/db/owned-tables");

beforeAll(() => {
  createMemoryDb();
});

describe("owned-tables", () => {
  test("recognises an owned table in a statement", () => {
    expect(tablesIn("select * from orders where id = 1")).toEqual(["orders"]);
    expect(tablesIn("select 1")).toEqual([]);
  });

  test("does not mistake order_items for orders", () => {
    // Longest match first, or every query on order_items would be reported as
    // a query on orders and the error message would send people to the wrong
    // place.
    expect(tablesIn("select * from order_items")).toEqual(["order_items"]);
  });

  test("the tables without an owner are listed deliberately", () => {
    for (const unowned of ["merchants", "api_keys", "idempotency_keys", "gateway_events"]) {
      expect(OWNED_TABLES).not.toContain(unowned);
    }
  });
});

describe("the query guard", () => {
  test("refuses a query on an owned table that does not name the merchant", async () => {
    await expect(db.query("select * from orders")).rejects.toMatchObject({
      code: "NO_MERCHANT_SCOPE",
    });
  });

  test("allows it when the statement filters by merchant_id", async () => {
    await expect(db.query("select * from orders where merchant_id = $1", [1])).resolves.toBeDefined();
  });

  test("allows a declared exception", async () => {
    await expect(
      db.query("select * from orders", [], { withoutMerchant: "a maintenance sweep" })
    ).resolves.toBeDefined();
  });

  test("applies inside a transaction too", async () => {
    // Without this the guard would have a hole the size of the system: an
    // order is born inside a transaction.
    await expect(
      db.transaction(async (client) => client.query("select * from orders"))
    ).rejects.toMatchObject({ code: "NO_MERCHANT_SCOPE" });
  });
});

describe("merchant context", () => {
  test("requireMerchant throws when nobody opened a context", () => {
    expect(() => ctx.requireMerchant()).toThrow(/No merchant in context/);
  });

  test("withoutMerchant demands a reason", () => {
    expect(() => ctx.withoutMerchant("", () => null)).toThrow(/reason/);
  });

  test("an assumed merchant is not a proven one", async () => {
    // A public route resolves its merchant from the URL. Until that lookup
    // happens the merchant is a guess, and code that filters by "the current
    // merchant" there would silently return the wrong thing.
    await ctx.withAssumedMerchant(1, async () => {
      expect(ctx.currentMerchant()).toBe(1);
      expect(ctx.provenMerchant()).toBeNull();
    });
    await ctx.withMerchant(1, async () => {
      expect(ctx.provenMerchant()).toBe(1);
    });
  });

  test("the context survives await", async () => {
    await ctx.withMerchant(42, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ctx.currentMerchant()).toBe(42);
    });
  });
});

describe("isolation between two merchants", () => {
  let one;
  let two;

  beforeAll(async () => {
    one = await seedMerchant({ name: "One", slug: "one" });
    two = await seedMerchant({ name: "Two", slug: "two" });
  });

  test("they get different merchants", () => {
    expect(one.merchant.id).not.toBe(two.merchant.id);
  });

  test("a product of one is invisible to the other", async () => {
    const catalog = require("../src/services/catalog");

    const mine = await asMerchant(one.merchant.id, () =>
      catalog.findProduct(one.merchant.id, one.product.public_id)
    );
    expect(mine).toBeTruthy();

    // Same public id, asked for as the other merchant.
    const theirs = await asMerchant(two.merchant.id, () =>
      catalog.findProduct(two.merchant.id, one.product.public_id)
    );
    expect(theirs).toBeNull();
  });

  test("a key of one never resolves to the other", async () => {
    const apiKeys = require("../src/services/api-keys");
    const resolved = await ctx.withoutMerchant("resolving a key discovers the merchant", () =>
      apiKeys.resolve(one.secretKey)
    );
    expect(resolved.merchantId).toBe(one.merchant.id);
    expect(resolved.merchantId).not.toBe(two.merchant.id);
  });
});
