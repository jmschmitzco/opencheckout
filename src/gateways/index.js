// Gateway registry.
//
// The adapter layer is what lets a merchant switch processors by changing
// configuration, and what lets the test suite run the whole checkout without
// an account anywhere. The contract every adapter implements is in
// contract.md, next to this file.
const { isDemo, config } = require("../config");

const ADAPTERS = {
  asaas: () => require("./asaas"),
  pagarme: () => require("./pagarme"),
  mercadopago: () => require("./mercadopago"),
  paypal: () => require("./paypal"),
  demo: () => require("./demo"),
};

const GATEWAYS = Object.keys(ADAPTERS).filter((name) => name !== "demo");

// Order of preference when a merchant has configured more than one gateway
// that can take the same method. Explicit per-method routing is a dashboard
// feature worth having later; being deterministic now means the behaviour is
// at least predictable and testable.
const PREFERENCE = ["asaas", "pagarme", "mercadopago", "paypal"];

// What a gateway can do, asked of the adapter rather than hardcoded in a
// table that drifts. Building an adapter with no credentials does no I/O, so
// this is cheap enough to call per request.
//
// Cached anyway, because the answer cannot change at runtime.
const capabilityCache = new Map();

function capabilitiesOf(name) {
  if (capabilityCache.has(name)) return capabilityCache.get(name);
  const factory = ADAPTERS[name];
  if (!factory) throw new Error(`Unknown gateway: ${name}`);
  const Adapter = factory();
  const probe = new Adapter({});
  const capabilities = {
    name,
    methods: probe.supportedMethods || [],
    supportsRecurring: Boolean(probe.supportsRecurring),
    usesRedirect: Boolean(probe.usesRedirect),
    statusFromQuery: Boolean(probe.statusFromQuery),
  };
  capabilityCache.set(name, capabilities);
  return capabilities;
}

function gatewaysForMethod(method) {
  return PREFERENCE.filter((name) => capabilitiesOf(name).methods.includes(method));
}

// Returns the adapter for a method, with this merchant's own credentials
// already loaded.
//
// Demo mode short circuits everything: a simulated gateway, no external call,
// no real money. It is enabled only by `npm run demo`, and the config refuses
// to start the server with it set in production.
async function getGateway({ merchantId, gateway = null, method = null, livemode = false } = {}) {
  if (isDemo()) {
    const DemoGateway = ADAPTERS.demo();
    return new DemoGateway();
  }

  // Required here rather than at the top, because gateway-config requires this
  // module back for its capability questions.
  const gatewayConfig = require("../services/gateway-config");

  const chosen = gateway || (await gatewayConfig.gatewayForMethod({ merchantId, method, livemode }));
  const factory = ADAPTERS[chosen];
  if (!factory) throw new Error(`Unknown gateway: ${chosen}`);

  const credentials = await gatewayConfig.credentialsFor({ merchantId, gateway: chosen, livemode });
  if (!credentials) {
    throw new Error(
      `Gateway ${chosen} is not configured for this merchant. Add its API keys in the dashboard.`
    );
  }

  // A redirect gateway needs to know where to send the buyer back to. That is
  // this installation's address, not the merchant's, because the return has to
  // land on the route that performs the capture.
  if (capabilitiesOf(chosen).usesRedirect) {
    credentials.returnUrl = credentials.returnUrl || `${config.baseUrl}/payments/${chosen}/return`;
    credentials.cancelUrl = credentials.cancelUrl || `${config.baseUrl}/payments/${chosen}/cancel`;
  }

  const Adapter = factory();
  return new Adapter(credentials);
}

module.exports = {
  GATEWAYS,
  PREFERENCE,
  ADAPTERS,
  capabilitiesOf,
  gatewaysForMethod,
  getGateway,
};
