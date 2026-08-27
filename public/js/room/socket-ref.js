/* public/js/socket-ref.js
 * ─────────────────────────────────────────────────────────────
 * THE SOCKET REFERENCE CELL — the one place that holds the live
 * socket.io instance, and the *only* socket-related thing a feature
 * module is allowed to import.
 *
 * Why it exists: `let socket = null` in room.js was read by chat, player,
 * queue, permissions and reactions. Exporting the *value* would freeze
 * `null` into every importer, and having each feature import socket-core.js
 * (which must stay free of feature imports) risks cycles. A tiny ref cell
 * with no imports of its own is the cycle-proof middle ground.
 *
 *   setSocket(s)   called exactly once by socket-core.connectSocket()
 *   getSocket()    live getter — returns null before connect, the instance after
 *   emit(ev, data) convenience no-op-if-null wrapper, mirrors the old
 *                  `socket && socket.emit(...)` guard used everywhere
 *
 * NOTE: feature modules must call getSocket() (or emit()) at call time, never
 * cache the result in a module-level const.
 * ───────────────────────────────────────────────────────────── */
"use strict";
let socket = null;
export function setSocket(s) { socket = s; }
export function getSocket() { return socket; }
/* identical semantics to the old `socket && socket.emit(ev, data)` */
export function emit(ev, data) {
  if (socket) socket.emit(ev, data);
}