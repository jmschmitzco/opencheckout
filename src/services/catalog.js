// Products and prices.
//
// A product is the thing being sold. A price is how much it costs, in which
// currency, once or on a recurring basis. Keeping them apart is what lets one
// product carry a monthly price, a yearly price and a separate BRL price
// without being duplicated three times, and it is the model every billing API
// converged on for that reason.
//
// A SaaS does not have to use this catalogue at all: a session can be created
// with ad hoc line items. The catalogue exists for the common case, where the
// same three plans are sold over and over and the integrator would rather not
// repeat the amounts in every call.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const money = require("../lib/money");
const { badRequest, notFound } = require("../lib/errors");

const PRICE_TYPES = ["one_time", "recurring"];
const INTERVALS = ["day", "week", "month", "year"];

function parseMetadata(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Metadata is the integrator's own field, and it comes back on every webhook.
// Capped because it is copied into every event payload: unbounded metadata
// means an unbounded webhook body for every order forever.
function serializeMetadata(value) {
  if (value == null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("metadata must be an object.");
  }
  const text = JSON.stringify(value);
  if (text.length > 4000) throw badRequest("metadata must be under 4000 characters when serialized.");
  return text;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

async function createProduct(merchantId, { name, description, imageUrl, metadata } = {}) {
  const cleanName = v.text(name, 200);
  if (!cleanName) throw badRequest("A product needs a name.", { name: "Required." });

  const result = await db.query(
    `insert into products (merchant_id, public_id, name, description, image_url, metadata)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      merchantId,
      ids.publicId("product"),
      cleanName,
      v.text(description, 2000),
      v.httpUrl(imageUrl, { allowHttp: process.env.NODE_ENV !== "production" }),
      serializeMetadata(metadata),
    ]
  );
  return result.rows[0];
}

async function findProduct(merchantId, publicId) {
  const result = await db.query(
    `select * from products where merchant_id = $1 and public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

async function listProducts(merchantId, { activeOnly = false, limit = 50 } = {}) {
  const result = await db.query(
    `select * from products
      where merchant_id = $1 ${activeOnly ? "and active = true" : ""}
      order by created_at desc
      limit $2`,
    [merchantId, v.integerInRange(limit, 1, 200, 50)]
  );
  return result.rows;
}

async function updateProduct(merchantId, publicId, patch) {
  const fields = [];
  const params = [merchantId, publicId];
  const push = (column, value) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };

  if ("name" in patch) {
    const name = v.text(patch.name, 200);
    if (!name) throw badRequest("A product needs a name.", { name: "Required." });
    push("name", name);
  }
  if ("description" in patch) push("description", v.text(patch.description, 2000));
  if ("imageUrl" in patch) {
    push("image_url", v.httpUrl(patch.imageUrl, { allowHttp: process.env.NODE_ENV !== "production" }));
  }
  if ("metadata" in patch) push("metadata", serializeMetadata(patch.metadata));
  if ("active" in patch) push("active", Boolean(patch.active));
  if (!fields.length) return findProduct(merchantId, publicId);

  push("updated_at", new Date());
  const result = await db.query(
    `update products set ${fields.join(", ")}
      where merchant_id = $1 and public_id = $2
      returning *`,
    params
  );
  if (!result.rows[0]) throw notFound("Product not found.");
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

async function createPrice(merchantId, productPublicId, input = {}) {
  const product = await findProduct(merchantId, productPublicId);
  if (!product) throw notFound("Product not found.");

  const currency = money.normalizeCurrency(input.currency);
  if (input.currency && !money.isValidCurrency(input.currency)) {
    throw badRequest(
      `Unsupported currency. Supported: ${Object.keys(money.CURRENCIES).join(", ")}.`,
      { currency: "Unsupported." }
    );
  }

  const amount = v.amountCents(input.unitAmountCents);
  if (amount == null) {
    throw badRequest("unit_amount_cents must be a whole number of cents, zero or more.", {
      unit_amount_cents: "Whole number of cents.",
    });
  }

  const type = v.oneOf(input.type || "one_time", PRICE_TYPES);
  if (!type) throw badRequest(`Price type must be one of: ${PRICE_TYPES.join(", ")}.`);

  let interval = null;
  let intervalCount = 1;
  let trialDays = 0;
  if (type === "recurring") {
    interval = v.oneOf(input.interval || "month", INTERVALS);
    if (!interval) throw badRequest(`interval must be one of: ${INTERVALS.join(", ")}.`);
    intervalCount = v.integerInRange(input.intervalCount, 1, 12, 1);
    trialDays = v.integerInRange(input.trialDays, 0, 365, 0);
  }

  // The anchor price, shown struck through. Refused when it is not actually
  // higher: a "discount" that is not a discount is the kind of thing that gets
  // a merchant fined, and we are the ones rendering the claim.
  let compareAt = null;
  if (input.compareAtCents != null) {
    compareAt = v.amountCents(input.compareAtCents);
    if (compareAt == null) throw badRequest("compare_at_cents must be a whole number of cents.");
    if (compareAt <= amount) {
      throw badRequest("compare_at_cents must be higher than unit_amount_cents.", {
        compare_at_cents: "Must be higher than the price.",
      });
    }
  }

  // Instalments are a card feature of the Brazilian market, and only BRL
  // gateways here support them.
  const maxInstallments =
    currency === "BRL" && type === "one_time"
      ? v.integerInRange(input.maxInstallments, 1, 12, 1)
      : 1;

  const result = await db.query(
    `insert into prices
       (merchant_id, product_id, public_id, currency, unit_amount_cents, compare_at_cents,
        type, interval, interval_count, trial_days, max_installments)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      merchantId,
      product.id,
      ids.publicId("price"),
      currency,
      amount,
      compareAt,
      type,
      interval,
      intervalCount,
      trialDays,
      maxInstallments,
    ]
  );
  return result.rows[0];
}

async function findPrice(merchantId, publicId) {
  const result = await db.query(
    `select p.*, pr.name as product_name, pr.description as product_description,
            pr.image_url as product_image_url, pr.public_id as product_public_id,
            pr.active as product_active, pr.metadata as product_metadata
       from prices p
       join products pr on pr.id = p.product_id and pr.merchant_id = p.merchant_id
      where p.merchant_id = $1 and p.public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

async function listPrices(merchantId, { productPublicId = null, activeOnly = true } = {}) {
  const params = [merchantId];
  const where = ["p.merchant_id = $1"];
  if (activeOnly) where.push("p.active = true");
  if (productPublicId) {
    params.push(productPublicId);
    where.push(`pr.public_id = $${params.length}`);
  }
  const result = await db.query(
    `select p.*, pr.name as product_name, pr.public_id as product_public_id
       from prices p
       join products pr on pr.id = p.product_id and pr.merchant_id = p.merchant_id
      where ${where.join(" and ")}
      order by p.created_at desc`,
    params
  );
  return result.rows;
}

async function deactivatePrice(merchantId, publicId) {
  // Prices are never deleted. An order points at one, and a receipt that
  // cannot name what was bought is worse than a stale row.
  const result = await db.query(
    `update prices set active = false, updated_at = now()
      where merchant_id = $1 and public_id = $2
      returning *`,
    [merchantId, publicId]
  );
  if (!result.rows[0]) throw notFound("Price not found.");
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// API shapes. Defined here so every route answers with the same object and a
// column rename never changes the contract an integrator depends on.
// ---------------------------------------------------------------------------

function productToApi(row) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "product",
    name: row.name,
    description: row.description,
    image_url: row.image_url,
    active: row.active,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
  };
}

function priceToApi(row) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "price",
    product: row.product_public_id || null,
    currency: row.currency,
    unit_amount_cents: row.unit_amount_cents,
    compare_at_cents: row.compare_at_cents,
    type: row.type,
    interval: row.interval,
    interval_count: row.interval_count,
    trial_days: row.trial_days,
    max_installments: row.max_installments,
    active: row.active,
    created_at: row.created_at,
  };
}

module.exports = {
  PRICE_TYPES,
  INTERVALS,
  parseMetadata,
  serializeMetadata,
  createProduct,
  findProduct,
  listProducts,
  updateProduct,
  createPrice,
  findPrice,
  listPrices,
  deactivatePrice,
  productToApi,
  priceToApi,
};
