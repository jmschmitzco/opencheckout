// Whose request is this?
//
// One installation serves many merchants, so every query needs to know who the
// data belongs to. Threading a merchant id through hundreds of calls by hand
// would guarantee that one of them gets forgotten, and one forgotten filter
// means one merchant seeing another merchant's customers.
//
// So the merchant travels on its own, attached to the request, and the query
// wrapper checks it. AsyncLocalStorage is part of Node itself: no dependency,
// and it survives await, promises and callbacks without any discipline from
// the caller.
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

// Run `fn` for one merchant. Everything it calls, at any depth, sees it.
function withMerchant(merchantId, fn) {
  const id = Number(merchantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid merchant in context: ${merchantId}`);
  }
  return storage.run({ merchantId: id, reason: null, assumed: false }, fn);
}

// A merchant that is a GUESS rather than a fact.
//
// The hosted checkout page resolves its merchant from the session in the URL,
// and until that lookup happens there is no proven owner. Code that filters by
// "the current merchant" in that window would silently return nothing, or
// worse, the wrong thing. So the context records how it was obtained, and code
// that needs a PROVEN merchant asks for `provenMerchant()`.
function withAssumedMerchant(merchantId, fn) {
  const id = Number(merchantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid merchant in context: ${merchantId}`);
  }
  return storage.run({ merchantId: id, reason: null, assumed: true }, fn);
}

// A declared escape hatch for code that runs outside any merchant: migrations,
// the key lookup that resolves a merchant, background loops that are about to
// pick one. The reason is required and shows up in the error when someone uses
// this to dodge the rule.
function withoutMerchant(reason, fn) {
  const text = String(reason || "").trim();
  if (!text) throw new Error("withoutMerchant() requires a short, explicit reason.");
  return storage.run({ merchantId: null, reason: text, assumed: false }, fn);
}

function currentMerchant() {
  const store = storage.getStore();
  return store ? store.merchantId : null;
}

// The current merchant, but only when it was proven. Returns null on a public
// route where the merchant is still a guess.
function provenMerchant() {
  const store = storage.getStore();
  if (!store || store.assumed) return null;
  return store.merchantId;
}

function hasContext() {
  return Boolean(storage.getStore());
}

function currentReason() {
  const store = storage.getStore();
  return store ? store.reason : null;
}

// The current merchant, or an error. Used by every query that has to filter:
// if nobody opened the context, that is a programming mistake, not missing
// data, and throwing here is far better than returning someone else's rows.
function requireMerchant() {
  const id = currentMerchant();
  if (!id) {
    throw new Error(
      "No merchant in context. Wrap the call in withMerchant(id, fn), or declare " +
        'the exception with withoutMerchant("reason", fn).'
    );
  }
  return id;
}

module.exports = {
  withMerchant,
  withAssumedMerchant,
  withoutMerchant,
  currentMerchant,
  provenMerchant,
  requireMerchant,
  hasContext,
  currentReason,
};
