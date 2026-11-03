// WHAT HAPPENS AFTER THE LAST TEST IN A FILE.
//
// The checkout answers the buyer and only THEN does its housekeeping, so
// nobody waits for it. In a test, the file ends with that housekeeping still
// in flight: the runner tears the environment down, the task lands in a module
// registry that no longer exists, and the suite EXITS WITH AN ERROR even
// though every test passed.
//
// That is not a cosmetic problem. Once the exit code always says failure,
// a real failure is indistinguishable from the noise, and no automation can
// block a broken deploy.
//
// This file runs for every test (setupFilesAfterEnv) and simply waits for what
// is outstanding. The same registry is what lets the server finish its work
// before shutting down, so this is not a test-only crutch.
afterAll(async () => {
  try {
    await require("../src/lib/background-tasks").waitForBackgroundTasks();
  } catch {
    /* waiting for a task must never fail the suite */
  }
  try {
    require("../src/gateways/demo").reset();
  } catch {
    /* the demo gateway may not have been loaded */
  }
});
