/* public/js/reactions.js
 * ─────────────────────────────────────────────────────────────
 * LIVE EMOJI REACTIONS — rail/popover UI, floating bubbles, throttling.
 *
 *   wireReactions()          toggle button, strip clicks, outside-click close,
 *                            keyboard: 1–7 = react, f/F = toggleFullscreen
 *   openRail()/closeRail()   mobile popover with RAIL_AUTO_CLOSE timer
 *   popBtn(btn)              replay the .pop animation on a strip button
 *   sendReaction(emoji)      whitelist + REACT_COOLDOWN throttle, optimistic
 *                            local bubble, then 'video-reaction' emit
 *   spawnReaction(emoji, u)  one floating .fx bubble (capped at MAX_BUBBLES);
 *                            remote payloads are re-validated against REACTIONS
 *
 * Module-private state (was module-scope `let`s in room.js):
 *   lastReactAt, railCloseTmr
 *
 * Dependencies are strictly one-way: we import toggleFullscreen + playerHooks
 * from player.js and register closeRail into playerHooks so the player can
 * close the rail on fullscreen exit WITHOUT importing us.
 *
 * Network: 'video-reaction' attached on first onConnect. Outbound via sockEmit.
 * DOM: dom.reactRail, dom.reactToggle, dom.reactStrip, dom.fxLayer, dom.container
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { REACTIONS, REACT_COOLDOWN, MAX_BUBBLES, RAIL_AUTO_CLOSE } from "./config.js";
import { S } from "./state.js";
import { dom } from "./dom.js";
import { emit as sockEmit, getSocket } from "./socket-ref.js";
import { onConnect } from "./socket-core.js";
import { toggleFullscreen, playerHooks } from "./player.js";
let lastReactAt   = 0;
let railCloseTmr  = null;
/* ══════════════════════════════════════
   LIVE REACTIONS
   ══════════════════════════════════════ */
export function wireReactions() {
  dom.reactToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.reactRail.classList.contains("open") ? closeRail() : openRail();
  });
  dom.reactStrip.addEventListener("click", (e) => {
    const btn = e.target.closest(".react-btn");
    if (!btn) return;
    sendReaction(btn.dataset.emoji);
    popBtn(btn);
    if (dom.reactRail.classList.contains("open")) openRail(); // reset auto-close
  });
  document.addEventListener("click", (e) => {
    if (!dom.reactRail.contains(e.target)) closeRail();
  });
  /* 1–7 shortcuts (work in fullscreen too) */
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "f" || e.key === "F") { toggleFullscreen(); return; }
    const i = parseInt(e.key, 10);
    if (!i || i < 1 || i > REACTIONS.length) return;
    sendReaction(REACTIONS[i - 1]);
    popBtn(dom.reactStrip.children[i - 1]);
  });
}
export function popBtn(btn) {
  if (!btn) return;
  btn.classList.remove("pop");
  void btn.offsetWidth;            // force reflow → replay animation
  btn.classList.add("pop");
}
export function openRail() {
  dom.reactRail.classList.add("open");
  dom.reactToggle.setAttribute("aria-expanded", "true");
  clearTimeout(railCloseTmr);
  railCloseTmr = setTimeout(closeRail, RAIL_AUTO_CLOSE);
}
export function closeRail() {
  clearTimeout(railCloseTmr);
  dom.reactRail.classList.remove("open");
  dom.reactToggle.setAttribute("aria-expanded", "false");
}
/* the player closes the rail when leaving fullscreen — give it a handle
   without it having to import this module */
playerHooks.closeRail = closeRail;
/* send: optimistic local render + emit */
export function sendReaction(emoji) {
  if (REACTIONS.indexOf(emoji) === -1) return;
  const now = Date.now();
  if (now - lastReactAt < REACT_COOLDOWN) return;   // client-side throttle
  lastReactAt = now;
  spawnReaction(emoji, S.username);
  sockEmit("video-reaction", { emoji });
}
/* render one floating bubble */
export function spawnReaction(emoji, username) {
  if (REACTIONS.indexOf(emoji) === -1) return;      // never trust remote payloads
  const layer = dom.fxLayer;
  if (!layer || document.hidden) return;
  while (layer.childElementCount >= MAX_BUBBLES) layer.firstElementChild.remove();
  const h = dom.container.clientHeight || 300;
  // clear the player's control bar: ours ≈44px, YouTube's ≈48px → start above it
  const bottom = Math.round(Math.max(34, Math.min(58, h * 0.16)));
  const rise   = Math.round(Math.max(80, Math.min(240, h * 0.40)));  // short flight only
  const dur    = 2.3 + Math.random() * 0.9;
  const el = document.createElement("div");
  el.className = "fx";
  el.style.setProperty("--fx-left",   (10 + Math.random() * 80).toFixed(1) + "%");
  el.style.setProperty("--fx-bottom", bottom + "px");
  el.style.setProperty("--fx-rise",   rise + "px");
  el.style.setProperty("--fx-dx",     (Math.random() * 44 - 22).toFixed(0) + "px");
  el.style.setProperty("--fx-rot",    (Math.random() * 24 - 12).toFixed(0) + "deg");
  el.style.setProperty("--fx-size",   (0.95 + Math.random() * 0.35).toFixed(2) + "rem");
  el.style.setProperty("--fx-dur",    dur.toFixed(2) + "s");
  const bub = document.createElement("div");
  bub.className = "fx-bubble";
  bub.textContent = emoji;                          // textContent → no XSS surface
  el.appendChild(bub);
  if (username) {
    const n = document.createElement("span");
    n.className = "fx-name";
    n.textContent = username;
    el.appendChild(n);
  }
  layer.appendChild(el);
  // timeout (not animationend) so reduced-motion users also get cleanup
  setTimeout(() => el.remove(), dur * 1000 + 400);
}
/* ══════════════════════════════════════
   NETWORK
   ══════════════════════════════════════ */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;        // attach once, even across reconnects
  sockWired = true;
  getSocket().on("video-reaction", ({ emoji, userId, username }) => {
    if (userId && S.userId && userId.toString() === S.userId) return; // already rendered locally
    spawnReaction(emoji, username);
  });
});