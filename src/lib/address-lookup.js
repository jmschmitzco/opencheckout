// Postal code lookup, used only where a gateway demands a full address.
//
// A registered boleto needs the payer's street, district, city and state, and
// a checkout that asked for all of those would lose buyers: the whole point of
// asking for a postal code and a house number is that the rest can be looked
// up.
//
// The lookup is pluggable. The default talks to ViaCEP, which is free and
// needs no key, and an installation that would rather not call a third party
// from its checkout can replace it:
//
//   const lookup = require("./lib/address-lookup");
//   lookup.use(async (postalCode) => myOwnDatabase.find(postalCode));
//
// IT NEVER FAILS A PAYMENT. Every error path returns null and the adapter
// carries on with whatever it already has. Losing an address is bad; losing
// the sale because of one is worse.
const TIMEOUT_MS = 4000;

const cache = new Map();
const CACHE_LIMIT = 500;

function digits(value) {
  return String(value == null ? "" : value).replace(/\D+/g, "");
}

async function viaCep(postalCode, fetchImpl) {
  const impl = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await impl(`https://viacep.com.br/ws/${postalCode}/json/`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.erro) return null;
    return {
      postalCode,
      street: data.logradouro || "",
      district: data.bairro || "",
      city: data.localidade || "",
      state: data.uf || "",
      country: "BR",
    };
  } catch {
    // Network down, timeout, unknown code. All the same answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let provider = viaCep;

function use(fn) {
  provider = typeof fn === "function" ? fn : viaCep;
}

async function lookup(postalCode, fetchImpl) {
  const clean = digits(postalCode);
  if (clean.length !== 8) return null;
  if (cache.has(clean)) return cache.get(clean);

  const found = await provider(clean, fetchImpl);
  if (found) {
    // A postal code never changes, so the cache never needs invalidating. It
    // is bounded only so a long-running process cannot grow without limit.
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(clean, found);
  }
  return found;
}

module.exports = { lookup, use, viaCep, TIMEOUT_MS };
