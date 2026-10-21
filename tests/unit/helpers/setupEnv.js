// tests/unit/helpers/setupEnv.js
// Runs before every test file (jest `setupFiles`).
// The socket auth middleware (socket/authenticateSocket.js) and
// utils/jwtUtils.js read these at call time — they just need to exist
// and to agree with each other so the tests can mint valid cookies.
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "unit-test-access-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "unit-test-refresh-secret";
process.env.NODE_ENV = "test";