const jwt = require("jsonwebtoken");
const cookie = require("cookie"); // already installed as a dep of cookie-parser
const User = require("../models/User");

/**
 * Mirrors middleware/auth.js's authenticateToken exactly:
 * verifies the short-lived accessToken JWT only. It does NOT check
 * user.sessions, so it matches your existing REST behavior — a session
 * revoked via `sessions` won't kill a live socket until the access
 * token naturally expires (same as it wouldn't kill a normal API call
 * either, right now). If you later want instant revocation for sockets,
 * see the commented block below.
 */
module.exports = async function authenticateSocket(socket, next) {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || "");
    const accessToken = cookies.accessToken;

    if (!accessToken) {
      return next(new Error("unauthorized"));
    }

    const decoded = jwt.verify(accessToken, process.env.JWT_ACCESS_SECRET);
    const userId = decoded.userId;

    if (!userId) {
      return next(new Error("unauthorized"));
    }

    const user = await User.findById(userId).select("username email _id isActive").lean();
    if (!user || !user.isActive) {
      return next(new Error("unauthorized"));
    }

    // ---- OPTIONAL stricter check (instant revocation via sessions[]) ----
    // Uncomment if you want a device removed from "active sessions" to
    // immediately drop its socket, instead of waiting for accessToken expiry.
    //
    // const sessionId = cookies.sessionId;
    // const hasValidSession = user.sessions?.some(s =>
    //   s.sessionId === sessionId && s.expiresAt > new Date()
    // );
    // if (!sessionId || !hasValidSession) {
    //   return next(new Error("unauthorized"));
    // }

    socket.data.user = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
    };

    next();
  } catch (error) {
    // covers jwt expiry, bad signature, malformed token, etc.
    next(new Error("unauthorized"));
  }
};