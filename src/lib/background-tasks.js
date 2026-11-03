// WORK THAT HAPPENS AFTER THE RESPONSE.
//
// Some things must not make the buyer wait. Whoever pressed PAY wants the Pix
// code now; taking their cart off the abandoned list can happen half a second
// later.
//
// The obvious way to do that is a bare setImmediate, and the problem with it is
// that NOBODY KNOWS THE WORK EXISTS. It escapes the caller's hand and cannot be
// waited on. That costs twice:
//
//   1. In tests, visibly. The test file ends with the work still in flight,
//      the runner tears the environment down, and the work lands in a module
//      registry that is gone. The suite then exits non-zero while every test
//      passed, and once the exit code always says failure, a real failure is
//      indistinguishable from the noise.
//
//   2. On the server, invisibly. A deploy kills the process; work in flight
//      dies half done, with no trace.
//
// The fix is small: instead of dropping the task, keep its promise in a set and
// remove it when it settles. Whoever wants to wait, waits.
const pending = new Set();

// Runs `task` after the current response has gone out, and returns its promise.
// The error is swallowed on purpose: this is accessory work, and a failure here
// must never bring the process down with an unhandled rejection. Callers log
// their own errors with context.
function inBackground(task) {
  const promise = new Promise((resolve) => setImmediate(resolve))
    .then(task)
    .catch((err) => {
      console.error("[background] Task failed:", err && err.message);
    });

  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

// Waits for whatever is in flight. Used at the end of every test file and
// available for a graceful shutdown.
//
// It loops because one task can spawn another: waiting for the first wave only
// would leave the second behind, which is the same race again.
async function waitForBackgroundTasks() {
  let rounds = 0;
  while (pending.size && rounds < 10) {
    await Promise.all(Array.from(pending));
    rounds += 1;
  }
}

function pendingCount() {
  return pending.size;
}

module.exports = { inBackground, waitForBackgroundTasks, pendingCount };
