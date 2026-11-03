// Central configuration. Everything comes from the environment.
//
// Gateway API keys are NOT here. They belong to a merchant, are stored
// encrypted in the database and are read through src/services/gateway-config.js.
// The only thing this file holds is what the installation itself needs to run.
require("dotenv").config();

const crypto = require("crypto");

let appSecret = process.env.APP_SECRET;
if (!appSecret) {
  if ((process.env.NODE_ENV || "development") === "production") {
    throw new Error("APP_SECRET is required in production (32 characters minimum).");
  }
  // Development gets an ephemeral secret so the server starts with no setup.
  // Sessions and encrypted credentials do not survive a restart, which is
  // exactly what you want while developing and never what you want in
  // production.
  appSecret = crypto.randomBytes(32).toString("hex");
  console.warn("[config] APP_SECRET is not set. Using a temporary development secret.");
}

function trimTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

const port = parseInt(process.env.PORT || "3000", 10);

const config = {
  env: process.env.NODE_ENV || "development",
  port,
  appSecret,
  databaseUrl: process.env.DATABASE_URL || null,
  baseUrl: trimTrailingSlash(process.env.BASE_URL || `http://localhost:${port}`),
  dashboardBaseUrl: trimTrailingSlash(process.env.DASHBOARD_BASE_URL || ""),
  // Extra origins allowed to frame the checkout. Development convenience only;
  // in production each merchant declares its own in merchants.embed_origins.
  embedExtraOrigins: String(process.env.EMBED_EXTRA_ORIGINS || "")
    .split(",")
    .map((o) => trimTrailingSlash(o.trim()))
    .filter(Boolean),
  sessionTtlMinutes: Math.max(5, parseInt(process.env.SESSION_TTL_MINUTES || "60", 10) || 60),
};

// Demo mode: in-memory database and a simulated gateway. No real money can
// move, no external call is made, and every byte disappears when the process
// stops. Deliberately impossible to enable in production, because it also
// turns off the rate limits that stop card testing.
function isDemo() {
  return process.env.OPENCHECKOUT_DEMO === "1" && process.env.NODE_ENV !== "production";
}

function assertProductionConfig() {
  if (config.env !== "production") return;

  const missing = [];
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
    missing.push("APP_SECRET (32 characters minimum)");
  }
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!process.env.BASE_URL) missing.push("BASE_URL");
  if (missing.length) {
    throw new Error(`Missing required configuration in production: ${missing.join(", ")}`);
  }
  if (!/^https:\/\//i.test(config.baseUrl)) {
    throw new Error(`BASE_URL must be https in production, got "${config.baseUrl}".`);
  }

  // A demo flag left behind in a production environment is a trap, so the
  // server refuses to start instead of quietly ignoring it. Failing loudly at
  // boot is cheap; a silent hole is not.
  if (process.env.OPENCHECKOUT_DEMO === "1") {
    throw new Error(
      "OPENCHECKOUT_DEMO=1 in production. Demo mode uses a fake gateway and removes " +
        "the fraud rate limits. Remove it from the production environment."
    );
  }
}

module.exports = { config, isDemo, assertProductionConfig };
