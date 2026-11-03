// The server entry point, and the background loops.
const { config, assertProductionConfig, isDemo } = require("./config");
const { waitForBackgroundTasks } = require("./lib/background-tasks");
const db = require("./db");

// Refuses to start on a misconfigured production environment. Failing loudly
// at boot is cheap; a silent hole costs money later.
assertProductionConfig();

const app = require("./app");

// ---------------------------------------------------------------------------
// Background loops
//
// Three jobs run on a clock. All three are idempotent and pick their own rows,
// so running two instances of this process does duplicate work but does not
// corrupt anything. A deployment with more than one instance should set
// OPENCHECKOUT_WORKER=0 on all but one.
// ---------------------------------------------------------------------------

const LOOPS = [
  {
    name: "webhook deliveries",
    everyMs: 15_000,
    run: () => require("./services/webhooks-out").dispatchPending({ limit: 50 }),
  },
  {
    name: "subscription renewals",
    everyMs: 5 * 60_000,
    run: () => require("./services/subscriptions").runRenewals({ limit: 25 }),
  },
  {
    name: "cart reminders and session expiry",
    everyMs: 60_000,
    run: async () => {
      const carts = require("./services/carts");
      await carts.expireStaleSessions({ limit: 100 });
      await carts.runReminders({ limit: 25 });
    },
  },
];

const timers = [];

function startLoops() {
  if (process.env.OPENCHECKOUT_WORKER === "0") {
    console.log("[server] Background loops are off (OPENCHECKOUT_WORKER=0).");
    return;
  }
  for (const loop of LOOPS) {
    let running = false;
    const tick = async () => {
      // Never two passes of the same loop at once. A slow pass that overlaps
      // itself would charge a renewal twice.
      if (running) return;
      running = true;
      try {
        await loop.run();
      } catch (err) {
        console.error(`[server] Loop "${loop.name}" failed:`, err && err.message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, loop.everyMs);
    // Does not hold the process open by itself.
    timer.unref();
    timers.push(timer);
  }
}

const server = app.listen(config.port, () => {
  console.log(`OpenCheckout is listening on ${config.baseUrl}`);
  if (isDemo()) console.log("Demo mode: simulated gateway, in-memory database, no real money.");
  startLoops();
});

// Finishes what is in flight before letting go. Work started after the
// response went out is registered rather than dropped, which is what makes a
// graceful shutdown possible at all.
async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down.`);
  for (const timer of timers) clearInterval(timer);
  server.close();
  try {
    await waitForBackgroundTasks();
    await db.close();
  } catch (err) {
    console.error("[server] Shutdown was not clean:", err && err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = server;
