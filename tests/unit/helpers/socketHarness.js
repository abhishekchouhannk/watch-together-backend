// tests/unit/helpers/socketHarness.js
// Boots the REAL socket stack — socket/authenticateSocket.js +
// socket/roomHandlers.js — on an ephemeral port, and gives tests typed
// helpers to connect authenticated clients and await specific events.
// Nothing in the production socket code is stubbed: clients authenticate
// with a genuine accessToken cookie, and every perm-* event runs the same
// guard → mutate → save → broadcast path it runs in production.
"use strict";
const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const authenticateSocket = require("../../../socket/authenticateSocket");
const registerRoomHandlers = require("../../../socket/roomHandlers");
const { generateAccessToken } = require("../../../utils/jwtUtils");

/** Start the app's socket server exactly like socket/index.js does. */
async function startServer() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  io.use(authenticateSocket);
  io.on("connection", (socket) => registerRoomHandlers(io, socket));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;

  return {
    io,
    port,
    async close() {
      io.close(); // closes every socket + the underlying engine
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

/** Connect as `userDoc`, authenticating with a real accessToken cookie. */
function connectAs(port, userDoc) {
  const token = generateAccessToken(userDoc._id.toString());
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { cookie: `accessToken=${token}` },
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

/**
 * Resolve with the first `event` payload that satisfies `predicate`
 * (events that don't match are ignored — broadcasts like room-permissions
 * fire several times, so tests wait for the exact state they care about).
 */
function waitFor(socket, event, predicate = () => true, { timeout = 5000, label = event } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out after ${timeout}ms waiting for "${label}"`));
    }, timeout);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

/** Shorthand: wait for a room-permissions broadcast matching a perms predicate. */
const waitForPerms = (socket, predicate, opts = {}) =>
  waitFor(socket, "room-permissions", (p) => predicate(p.perms, p), {
    label: "room-permissions (matching predicate)",
    ...opts,
  });

/** Shorthand: wait for a perm-toast whose message contains `text`. */
const waitForToast = (socket, text, opts = {}) =>
  waitFor(socket, "perm-toast", (p) => p.message && p.message.includes(text), {
    label: `perm-toast containing "${text}"`,
    ...opts,
  });

/** Join a room through the real "join-room" event; resolves with room-state. */
async function joinRoomViaSocket(socket, roomId) {
  const state = waitFor(socket, "room-state", () => true, { label: `room-state for ${roomId}` });
  socket.emit("join-room", { roomId });
  return state;
}

/** Disconnect a batch of clients and wait until the server saw them go.
 *  Sequential on purpose: two simultaneous disconnects make handleLeave()
 *  save the same room document in parallel, which mongoose reports as a
 *  VersionError (the server catches it, but it spams the test output). */
async function disconnectAll(clients) {
  for (const c of clients) {
    if (c && c.connected) c.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

module.exports = {
  startServer,
  connectAs,
  waitFor,
  waitForPerms,
  waitForToast,
  joinRoomViaSocket,
  disconnectAll,
};
