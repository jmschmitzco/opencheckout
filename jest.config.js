// setupFiles runs before any application module is loaded. It is the only
// place where the environment can be cleaned up before src/config.js reads
// the developer's .env file.
module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setup-env.js"],
  // Runs after the test environment exists, so it can register a global
  // afterAll: that is what waits for background work before Jest tears
  // everything down. Without it the suite exits non-zero even when green.
  setupFilesAfterEnv: ["<rootDir>/tests/setup-teardown.js"],
  testTimeout: 30000,
};
