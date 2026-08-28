/* public/js/socket-core.js
 * ─────────────────────────────────────────────────────────────
 * CONNECTION LIFECYCLE + CROSS-CUTTING SESSION EVENTS.
 * Owns the io() instance and the events that belong to no single feature:
 *
 *   'connect'              → emits 'join-room' { roomId }
 *   'connect_error'        → "Session expired" toast, then / after 1.5s
 *   'room-state'           → writes S.room / S.perms, then fans out to
 *                            subscribers (perms UI, chat history, queue, player)
 *   'room-error'           → MERGED handler (was two listeners): fatal →
 *                            bounceToDashboard, otherwise toast + /dashboard
 *   'participants-update'  → merges participants into S.room, re-renders the
 *                            details card, then fans out
 *   'room-kicked'          → bounceToDashboard
 *   'user-joined'/'user-left' → fanned out (the chat module writes the line)
 *
 * OBSERVER PATTERN
 * ----------------
 * socket-core NEVER imports a feature module. Features call
 * onRoomState/onParticipantsUpdate/onUserJoined/onUserLeft/onConnect and
 * receive the raw payload. Callbacks run in *registration order*, which is
 * how the original sequential handler body is preserved; room-state awaits
 * each callback so an async subscriber (chat history fetch) still blocks the
 * ones after it, exactly like the original `await loadInitialMessages()`.
 *
 * Exports: connectSocket, leaveRoom, bounceToDashboard,
 *          onConnect, onConnectError, onRoomState, onRoomError,
 *          onParticipantsUpdate, onUserJoined, onUserLeft, onRoomKicked
 *
 * State touched: S.room (REPLACED on room-state, shallow-MERGED on
 *                participants-update), S.perms (REPLACED on room-state).
 *                Never cache S.room / S.perms in a module-level const.
 * Imports: config (roomId), state, utils (toast), room-details (render),
 *          socket-ref (setSocket/getSocket). All leaves — no cycles.
 * Globals read: io (socket.io client, classic script)
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { roomId } from "./config.js";
import { S } from "./state.js";
import { toast } from "./utils.js";
import { renderRoomDetails } from "./room-details.js";
import { setSocket, getSocket } from "./socket-ref.js";
/* ═══════ tiny ordered pub/sub ═══════
  `order` makes the fan-out sequence independent of module import order.
  Lower runs first; equal orders keep registration order (stable sort).
  Phases used for room-state:
    10 → permissions / room-details render
    20 → chat (joined notice + message history; async, awaited)
    30 → queue + video load
  Anything that doesn't care omits it and lands on the default 50. */
function channel() {
  const subs = [];
  let seq = 0;
  const on = (fn, order) => {
    if (typeof fn !== "function") return () => {};
    const entry = { fn, order: order == null ? 50 : order, seq: seq++ };
    subs.push(entry);
    subs.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));   // stable
    return () => {
      const i = subs.indexOf(entry);
      if (i > -1) subs.splice(i, 1);
    };
  };
  const fire = (payload) => {
    subs.slice().forEach(({ fn }) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  };
  /* sequential + awaited — preserves the original "await loadInitialMessages()" gate */
  const fireSeq = async (payload) => {
    for (const { fn } of subs.slice()) {
      try { await fn(payload); } catch (e) { console.error(e); }
    }
  };
  return { on, fire, fireSeq };
}
const chConnect      = channel();
const chConnectError = channel();
const chRoomState    = channel();
const chRoomError    = channel();
const chParticipants = channel();
const chUserJoined   = channel();
const chUserLeft     = channel();
const chRoomKicked   = channel();
export const onConnect            = chConnect.on;
export const onConnectError       = chConnectError.on;
export const onRoomState          = chRoomState.on;
export const onRoomError          = chRoomError.on;
export const onParticipantsUpdate = chParticipants.on;
export const onUserJoined         = chUserJoined.on;
export const onUserLeft           = chUserLeft.on;
export const onRoomKicked         = chRoomKicked.on;
/* ══════════════════════════════════════
   SOCKET — connection / session
   ══════════════════════════════════════ */
export function connectSocket() {
  const socket = io({ withCredentials: true });
  setSocket(socket);
  socket.on("connect", () => {
    socket.emit("join-room", { roomId });
    chConnect.fire();
  });
  socket.on("connect_error", () => {
    toast("Session expired", "error");
    setTimeout(() => (location.href = "/"), 1500);
    chConnectError.fire();
  });
  /* ── presence ── */
  socket.on("room-state", async (payload) => {
    const { room, perms } = payload;
    S.room = room;                       // ← REPLACES S.room wholesale (as before)
    if (perms) S.perms = perms;          // ← REPLACES S.perms wholesale (as before)
    await chRoomState.fireSeq(payload);  // subscribers run in registration order
  });
  /* ── MERGED room-error (previously two separate listeners) ── */
  socket.on("room-error", (payload) => {
    const { message, fatal } = payload || {};
    if (fatal) {
      bounceToDashboard(message || "You can't join this room");
    } else {
      toast(message || "Error", "error");
      setTimeout(() => (location.href = "/dashboard"), 1500);
    }
    chRoomError.fire(payload);
  });
  /* presence moves the validation floor */
  socket.on("participants-update", (payload) => {
    const { participants } = payload;
    S.room = Object.assign({}, S.room, { participants: participants || [] });
    renderRoomDetails();
    chParticipants.fire(payload);
  });
  socket.on("room-kicked", (payload) => {
    const { message } = payload || {};
    bounceToDashboard(message || "You were removed from this room");
    chRoomKicked.fire(payload);
  });
  socket.on("user-joined", (payload) => chUserJoined.fire(payload));
  socket.on("user-left",   (payload) => chUserLeft.fire(payload));
  return socket;
}
export function leaveRoom() {
  const socket = getSocket();
  if (socket) socket.emit("leave-room");
  location.href = "/dashboard";
}
export function bounceToDashboard(text) {
  try { sessionStorage.setItem("wp:notice", JSON.stringify({ text, type: "error" })); } catch (_) {}
  try { getSocket().disconnect(); } catch (_) {}
  window.location.replace("/dashboard");   // ← adjust if dashboard lives elsewhere
}