// Public identifiers.
//
// Every object exposed through the API has a prefixed, random public id, and
// the integer primary key never leaves the database. Two reasons, both
// practical:
//
//   1. A sequential id leaks volume and lets anyone walk the neighbours. An
//      order id in a URL is seen by the buyer.
//   2. A prefix makes a wrong id obvious at a glance. Passing a price id where
//      a product id belongs fails with a readable message instead of a
//      confusing 404 three calls later.
const crypto = require("crypto");

const PREFIXES = {
  merchant: "mer",
  apiKey: "ak",
  product: "prod",
  price: "price",
  customer: "cus",
  session: "cs",
  order: "ord",
  subscription: "sub",
  offer: "off",
  refund: "re",
  dispute: "dp",
  event: "evt",
  webhookEndpoint: "we",
};

// Base32 without the characters people misread: no 0/O, no 1/I/L.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

function randomSuffix(length = 20) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function publicId(kind, length = 20) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown public id kind: ${kind}`);
  return `${prefix}_${randomSuffix(length)}`;
}

// Does this id look like one of ours, of the expected kind? A cheap check that
// turns a mistaken argument into a clear 400.
function looksLike(kind, value) {
  const prefix = PREFIXES[kind];
  if (!prefix) return false;
  return new RegExp(`^${prefix}_[${ALPHABET}]{8,40}$`).test(String(value || ""));
}

// The human readable order code, printed on receipts and quoted in support
// conversations. Short, uppercase, unambiguous.
function orderCode() {
  return randomSuffix(10).toUpperCase().replace(/[^0-9A-Z]/g, "");
}

module.exports = { PREFIXES, publicId, looksLike, randomSuffix, orderCode };
