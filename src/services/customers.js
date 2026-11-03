// Customers: the people who pay.
//
// `external_id` is the most important column here. It holds the integrator's
// OWN user id, which is what turns this from a payment log into something a
// SaaS can ask questions of: "is user 4821 paid?" needs no mapping table on
// their side.
//
// Email is the natural key within a merchant, stored lowercased. Two merchants
// on the same installation can both have alice@example.com and they are
// different people, which is why the unique index covers the merchant too.
const db = require("../db");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const { badRequest, notFound } = require("../lib/errors");
const { parseMetadata, serializeMetadata } = require("./catalog");

// Fills in the blanks from what we already know about this email.
//
// This is what makes it safe for a merchant to hide the document or phone
// field on the checkout: a returning buyer already has them on file, and the
// gateway still gets what it requires. The flip side is the rule that goes
// with it: a hidden field may only be hidden if it can be filled from here.
//
// It never overwrites something the buyer typed. They may be correcting it.
async function completeFromRecord(merchantId, buyer) {
  const email = v.email(buyer && buyer.email);
  if (!email) return { ...buyer };

  const result = await db.query(
    `select name, document, phone, postal_code, address_number, country
       from customers where merchant_id = $1 and email = $2`,
    [merchantId, email]
  );
  const known = result.rows[0];
  if (!known) return { ...buyer, email };

  return {
    email,
    name: v.text(buyer.name, 120) || known.name,
    document: v.taxId(buyer.document) || known.document,
    phone: v.phoneBr(buyer.phone) || known.phone,
    postalCode: v.postalCodeBr(buyer.postalCode) || known.postal_code,
    addressNumber: v.text(buyer.addressNumber, 20) || known.address_number,
    country: v.text(buyer.country, 2) || known.country || "BR",
  };
}

// Creates or updates by email, and returns the row.
//
// Fields are only ever filled in, never blanked. A second purchase that omits
// the phone must not erase the phone from the first one, because the gateway
// may need it on a later renewal and nobody will know why it disappeared.
async function upsert(merchantId, input = {}) {
  const email = v.email(input.email);
  if (!email) throw badRequest("A valid email is required.", { email: "Invalid." });

  const name = v.text(input.name, 120);
  const document = v.taxId(input.document);
  const phone = v.phoneBr(input.phone);
  const postalCode = v.postalCodeBr(input.postalCode);
  const addressNumber = v.text(input.addressNumber, 20);
  const country = (v.text(input.country, 2) || "BR").toUpperCase();
  const externalId = v.text(input.externalId, 120);

  const existing = await db.query(
    `select * from customers where merchant_id = $1 and email = $2`,
    [merchantId, email]
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const result = await db.query(
      `update customers
          set name           = coalesce($3, name),
              document       = coalesce($4, document),
              phone          = coalesce($5, phone),
              postal_code    = coalesce($6, postal_code),
              address_number = coalesce($7, address_number),
              country        = coalesce($8, country),
              external_id    = coalesce($9, external_id),
              metadata       = coalesce($10, metadata),
              updated_at     = now()
        where merchant_id = $1 and id = $2
        returning *`,
      [
        merchantId,
        row.id,
        name,
        document,
        phone,
        postalCode,
        addressNumber,
        country,
        externalId,
        input.metadata === undefined ? null : serializeMetadata(input.metadata),
      ]
    );
    return result.rows[0];
  }

  const result = await db.query(
    `insert into customers
       (merchant_id, public_id, external_id, email, name, document, phone,
        postal_code, address_number, country, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      merchantId,
      ids.publicId("customer"),
      externalId,
      email,
      name,
      document,
      phone,
      postalCode,
      addressNumber,
      country,
      serializeMetadata(input.metadata),
    ]
  );
  return result.rows[0];
}

async function findById(merchantId, id) {
  const result = await db.query(`select * from customers where merchant_id = $1 and id = $2`, [
    merchantId,
    id,
  ]);
  return result.rows[0] || null;
}

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(
    `select * from customers where merchant_id = $1 and public_id = $2`,
    [merchantId, publicId]
  );
  return result.rows[0] || null;
}

async function findByEmail(merchantId, email) {
  const clean = v.email(email);
  if (!clean) return null;
  const result = await db.query(
    `select * from customers where merchant_id = $1 and email = $2`,
    [merchantId, clean]
  );
  return result.rows[0] || null;
}

async function findByExternalId(merchantId, externalId) {
  const clean = v.text(externalId, 120);
  if (!clean) return null;
  const result = await db.query(
    `select * from customers where merchant_id = $1 and external_id = $2 order by id limit 1`,
    [merchantId, clean]
  );
  return result.rows[0] || null;
}

// Accepts a public id, an email or an external id, in that order of
// specificity. The API takes any of the three so an integrator can look a
// customer up with whatever they happen to have in hand.
async function resolve(merchantId, { customer, email, externalId } = {}) {
  if (customer) {
    const found = await findByPublicId(merchantId, customer);
    if (!found) throw notFound(`No customer with id ${customer}.`);
    return found;
  }
  if (externalId) {
    const found = await findByExternalId(merchantId, externalId);
    if (found) return found;
  }
  if (email) return findByEmail(merchantId, email);
  return null;
}

function toApi(row) {
  if (!row) return null;
  return {
    id: row.public_id,
    object: "customer",
    external_id: row.external_id,
    email: row.email,
    name: row.name,
    // The tax id is masked on the way out. An integrator that never needs the
    // full value should not be handed it on every read, and most never do.
    document: row.document ? `***${String(row.document).slice(-4)}` : null,
    phone: row.phone,
    country: row.country,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
  };
}

module.exports = {
  completeFromRecord,
  upsert,
  findById,
  findByPublicId,
  findByEmail,
  findByExternalId,
  resolve,
  toApi,
};
