// Isolates the tests from the developer's .env.
//
// WHY THIS EXISTS: src/config.js calls require("dotenv").config(), so without
// this the tests would read whatever is in the local .env. The day somebody
// fills in a real gateway key, tests that assert "no gateway configured" start
// failing with nobody having touched the code. The reverse is worse: a test
// that passes on one machine and fails on another, because of a file that is
// not even in git.
//
// The rule: a test that needs a credential sets it itself.
const NEUTRALIZED = [
  "ASAAS_API_KEY",
  "PAGARME_SECRET_KEY",
  "MERCADOPAGO_ACCESS_TOKEN",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_SECRET",
  "DATABASE_URL",
  "BASE_URL",
  "DASHBOARD_BASE_URL",
  "EMBED_EXTRA_ORIGINS",
];

// Emptied, not deleted. dotenv only fills in keys that do not already exist,
// so deleting one gives it permission to load the value from .env after all.
// An empty string still counts as present, and is falsy for the config.
for (const name of NEUTRALIZED) process.env[name] = "";

process.env.NODE_ENV = "test";
// A fixed secret, so the config does not generate a random one and print a
// warning for every suite. Encrypted values stay readable across the run.
process.env.APP_SECRET = process.env.APP_SECRET || "a-test-secret-with-more-than-32-characters";
// Deterministic URLs in assertions.
process.env.BASE_URL = "http://localhost:3000";
// The tests run against the simulated gateway. A test must never be able to
// reach a real payment processor.
process.env.OPENCHECKOUT_DEMO = "1";
process.env.TRUSTED_PROXY_HOPS = "0";
