/* public/js/room-main.js
 * ─────────────────────────────────────────────────────────────
 * ENTRY POINT / ORCHESTRATOR for the room page.
 *
 * Owns three things and nothing else:
 *   1. the import graph (side-effect imports are what register each feature's
 *      socket listeners and room-state subscriptions),
 *   2. wireEvents() — the truly global/cross-feature listeners plus the
 *      wire*() calls, in the ORIGINAL registration order,
 *   3. the boot sequence, unchanged:
 *        initTheme() → wireEvents() → await fetchMe() → connectSocket()
 *
 * Module graph (one-way, no cycles):
 *   config / svg / state / dom / socket-ref      ← leaves
 *   utils            → config, state, dom
 *   theme            → config, state, dom
 *   room-details     → config, state, dom, utils
 *   socket-core      → config, state, utils, room-details, socket-ref
 *   chat             → config, state, dom, utils, socket-ref, socket-core
 *   player           → config, svg, state, dom, utils, socket-ref, socket-core
 *   reactions        → config, state, dom, socket-ref, socket-core, player
 *   queue            → config, state, dom, utils, socket-ref, socket-core,
 *                      player, chat
 *   permissions      → config, svg, state, dom, utils, socket-ref, socket-core,
 *                      room-details, player, queue, chat
 *   room-main        → everything
 *
 * room-state fan-out phases: 10 permissions · 20 chat (awaited history) ·
 * 30 queue · 35 player.
 *
 * fetchMe() lives here because it is session bootstrap, not a feature:
 * it fills S.userId / S.username, which isMe(), chat, reactions and the
 * profile card all read.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { S } from "./room/state.js";
import { $, dom } from "./room/dom.js";
import { initTheme, closeThemeMenu, wireTheme } from "./room/theme.js";
import { wireRoomDetails } from "./room/room-details.js";
import { connectSocket, leaveRoom } from "./room/socket-core.js";
import { wireChatInput, wireChatUnread } from "./room/chat.js";
import { wirePlayerControls, onFullscreenChange, setPseudoFs } from "./room/player.js";
import { wireReactions, closeRail } from "./room/reactions.js";
import { Q } from "./room/queue.js";
import { wirePermissions, closeConfig } from "./room/permissions.js";
/* ═══════ INIT ═══════ */
document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  wireEvents();
  await fetchMe();
  connectSocket();
});
/* ═══════ EVENT WIRING ═══════ */
function wireEvents() {
  $("backBtn").onclick  = leaveRoom;
  $("leaveBtn").onclick = leaveRoom;
  wireChatInput();
  dom.container.addEventListener("touchstart", () => {
    dom.controls.classList.add("show");
    clearTimeout(dom.controls._t);
    dom.controls._t = setTimeout(() => dom.controls.classList.remove("show"), 3000);
  });
  wireRoomDetails();
  wireTheme();
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeThemeMenu();
    closeRail();
    closeConfig();
    if (dom.container.classList.contains("pseudo-fs")) setPseudoFs(false);
  });
  wireReactions();
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  wirePlayerControls();
  wirePermissions();
  wireChatUnread();
  // add the queue functionality
  Q.wire();
}
/* ═══════ FETCH ME ═══════ */
async function fetchMe() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "include" });
    if (!r.ok) return;
    const d = await r.json(), u = d.user || d;
    S.userId = (u.id || u._id || "").toString();
    S.username = u.username || "You";
  } catch (_) {}
}