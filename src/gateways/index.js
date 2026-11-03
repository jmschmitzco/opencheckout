// Gateway registry.
//
// The adapter layer is what lets a merchant switch processors by changing
// configuration, and what lets the test suite run the whole checkout without
// an account anywhere. The contract every adapter implements is in
// contract.md, next to this file.
const { isDemo } = require("../config");
const gatewayConfig = require("../services/gateway-config");

const ADAPTERS = {
  asaas: () => require("./asaas"),
  pagarme: () => require("./pagarme"),
  mercadopago: () => require("./mercadopago"),
  paypal: () => require("./paypal"),
  demo: () => require("./demo"),
};

const GATEWAYS = Object.keys(ADAPTERS).filter((name) => name !== "demo");

// Which gateways can take Pix, card and boleto, in the order they are tried
// when a merchant has more than one configured. PayPal is absent on purpose:
// it is an alternative instrument, not a replacement processor.
const ROUTABLE = ["asaas", "pagarme", "mercadopago"];

// Returns the adapter for a method, with this merchant's own credentials
// already loaded.
//
// Demo mode short circuits everything: a simulated gateway, no external call,
// no real money. It is enabled only by `npm run demo` and the config refuses
// to start the server with it set in production.
async function getGateway({ merchantId, gateway = null, method = null, livemode = false } = {}) {
  if (isDemo()) {
    const DemoGateway = ADAPTERS.demo();
    return new DemoGateway();
  }

  const chosen = gateway || (await gatewayConfig.gatewayForMethod({ merchantId, method, livemode }));
  const factory = ADAPTERS[chosen];
  if (!factory) throw new Error(`Unknown gateway: ${chosen}`);

  const credentials = await gatewayConfig.credentialsFor({ merchantId, gateway: chosen, livemode });
  if (!credentials) {
    throw new Error(
      `Gateway ${chosen} is not configured for this merchant. Add its API keys in the dashboard.`
    );
  }
  const Adapter = factory();
  return new Adapter(credentials);
}

module.exports = { GATEWAYS, ROUTABLE, getGateway };
