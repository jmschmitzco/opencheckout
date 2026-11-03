// In-memory PostgreSQL (pg-mem), shared by the integration tests and by the
// demo server.
//
// createMemoryDb() builds a fresh database, applies db/schema.sql and injects
// the pool into src/db. From then on the whole application talks to it without
// knowing the difference.
//
// This is why the schema has no CHECK constraints and no expression indexes:
// pg-mem does not evaluate them the way Postgres does, and a schema that only
// works in one of the two environments means the tests are not testing what
// runs in production.
const fs = require("fs");
const path = require("path");
const { newDb } = require("pg-mem");
const db = require("../../src/db");
const ctx = require("../../src/db/merchant-context");

const SCHEMA_PATH = path.join(__dirname, "..", "..", "db", "schema.sql");

function createMemoryDb() {
  const mem = newDb();

  // Functions the schema or the queries use that pg-mem does not ship.
  mem.public.registerFunction({
    name: "trim",
    args: ["text"],
    returns: "text",
    implementation: (value) => String(value == null ? "" : value).replace(/^\s+|\s+$/g, ""),
  });

  mem.public.none(fs.readFileSync(SCHEMA_PATH, "utf8"));

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  db._setPool(pool);
  return { mem, pool };
}

// A merchant with a key, a theme, a gateway and a product, which is the state
// every test needs before it can do anything interesting.
async function seedMerchant(options = {}) {
  const merchants = require("../../src/services/merchants");
  const apiKeys = require("../../src/services/api-keys");
  const catalog = require("../../src/services/catalog");
  const themes = require("../../src/services/themes");
  const gatewayConfig = require("../../src/services/gateway-config");

  const merchant = await ctx.withoutMerchant("test setup creates the merchant", () =>
    merchants.create({
      name: options.name || "Acme SaaS",
      slug: options.slug || "acme",
      supportEmail: "support@acme.test",
      allowCustomCss: Boolean(options.allowCustomCss),
    })
  );

  return ctx.withMerchant(merchant.id, async () => {
    const secretKey = await apiKeys.create(merchant.id, { label: "Tests", kind: "secret", livemode: false });
    const publishableKey = await apiKeys.create(merchant.id, {
      label: "Tests",
      kind: "publishable",
      livemode: false,
    });

    // Credentials for a gateway, so availableMethods answers outside demo mode
    // too. The adapter is never reached in a test unless demo mode is on.
    const gateway = await gatewayConfig.save({
      merchantId: merchant.id,
      gateway: options.gateway || "asaas",
      livemode: false,
      credentials: { apiKey: "test-key" },
    });

    const product = await catalog.createProduct(merchant.id, {
      name: options.productName || "Pro plan",
      description: "Everything in Starter, plus the good parts.",
    });

    const price = await catalog.createPrice(merchant.id, product.public_id, {
      currency: options.currency || "BRL",
      unitAmountCents: options.amountCents == null ? 9900 : options.amountCents,
      maxInstallments: options.maxInstallments || 12,
    });

    const recurringPrice = await catalog.createPrice(merchant.id, product.public_id, {
      currency: options.currency || "BRL",
      unitAmountCents: options.recurringAmountCents == null ? 4900 : options.recurringAmountCents,
      type: "recurring",
      interval: "month",
      trialDays: options.trialDays || 0,
    });

    await themes.save(merchant.id, {
      scope: "merchant",
      tokens: { accent: "#7c3aed", brand_name: "Acme" },
    });

    return {
      merchant,
      secretKey: secretKey.key,
      publishableKey: publishableKey.key,
      webhookToken: gateway.webhookToken,
      product,
      price,
      recurringPrice,
    };
  });
}

// Runs `fn` inside a merchant's context, which is what a route would do.
function asMerchant(merchantId, fn) {
  return ctx.withMerchant(merchantId, fn);
}

module.exports = { createMemoryDb, seedMerchant, asMerchant, SCHEMA_PATH };
