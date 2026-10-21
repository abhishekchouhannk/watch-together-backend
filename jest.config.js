// jest.config.js
// Backend unit tests live in tests/unit/**/*.test.js.
// (The older scripts in tests/*.js — login.js, register.js, … — are manual
// smoke-test scripts, not Jest suites, so the testMatch below ignores them.)
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/unit/**/*.test.js"],

  // Each suite boots its own in-memory MongoDB (mongodb-memory-server).
  // The very first run downloads a mongod binary, which can take a while —
  // hence the generous timeout. Subsequent runs reuse the cached binary.
  testTimeout: 30000,

  // Make sure JWT secrets etc. exist before any app module is required.
  setupFiles: ["<rootDir>/tests/unit/helpers/setupEnv.js"],

  // The suites close their sockets / servers / DB connections themselves;
  // verbose output makes the permission matrix easy to read in CI logs.
  verbose: true,
};
