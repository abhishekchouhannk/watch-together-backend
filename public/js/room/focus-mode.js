/* public/js/room/focus-mode.js
 * ─────────────────────────────────────────────────────────────
 * MOBILE FOCUS VIEW — pull up from the bottom of the stacked
 * layout to pin the player to the top and let the side panel
 * fill the rest of the screen. Escape / the header chevron exit.
 *
 *   wireFocusMode()   gesture + exit button + escape + breakpoint guard
 *
 * Adds:  #roomPage.focus-mode   and   <html>.room-focus
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { $, dom } from "./dom.js";
const MOBILE_MQ = window.matchMedia("(max-width:768px)");
const SLACK     = 26;          // dead-zone before the bubble shows
const THRESHOLD = 88;          // pull this far past the dead-zone to commit
const RISE_RATE = 1.6;         // bubble px per pull px
const HIDE_Y    = 80;          // resting (hidden) offset — keep in sync with room.css
const RISE_CAP  = HIDE_Y + 26;
let hint = null, ring = null, ringLen = 151;
let tracking = false, capturing = false, startY = 0, pull = 0, maxScroll = 0;
const reduced  = () => window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const inFocus  = () => document.documentElement.classList.contains("room-focus");
const atBottom = () => window.scrollY >= maxScroll - 2;
function scrollableBelow(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") &&
        el.scrollHeight - el.clientHeight - el.scrollTop > 1) return true;
  }
  return false;
}
function modalOpen() {
  if (dom.container && dom.container.classList.contains("pseudo-fs")) return true;
  return [dom.cfgSheet, dom.profCard, dom.vcCard]
    .some((el) => el && el.getAttribute("aria-hidden") === "false");
}
/* ── bubble ── */
function showBubble() {
  hint.classList.remove("resetting");
  hint.classList.add("active");
  ring.style.transition = "";
}
function moveBubble(p) {
  const rise = Math.min(p * RISE_RATE, RISE_CAP);
  hint.style.transform = "translate(-50%," + (HIDE_Y - rise) + "px)";
  const prog = Math.min(p / THRESHOLD, 1);
  ring.style.strokeDashoffset = String(ringLen * (1 - prog));
  hint.classList.toggle("ready", prog >= 1);
}
function cancelBubble() {
  hint.classList.add("resetting");
  hint.classList.remove("active", "ready");
  hint.style.transform = "";
  ring.style.transition = "stroke-dashoffset .26s ease";
  ring.style.strokeDashoffset = String(ringLen);
  window.setTimeout(() => {
    if (hint.classList.contains("resetting")) clearBubble();
  }, 420);
}
function commitBubble() {
  hint.classList.remove("active");
  window.setTimeout(clearBubble, 260);
}
function clearBubble() {
  hint.classList.remove("active", "ready", "resetting");
  hint.style.transform = "";
  ring.style.transition = "";
  ring.style.strokeDashoffset = String(ringLen);
}
/* ── mode switch (FLIP on the player + panel block) ── */
function switchMode(toFocus) {
  const willAnimate = MOBILE_MQ.matches && !reduced();
  const block = document.querySelector(".room-content");
  const before = (willAnimate && block) ? block.getBoundingClientRect().top : 0;
  document.documentElement.classList.toggle("room-focus", toFocus);
  dom.root.classList.toggle("focus-mode", toFocus);
  if (!willAnimate || !block || !block.animate) return;
  const dy = before - block.getBoundingClientRect().top;
  if (Math.abs(dy) > 1 && Math.abs(dy) < 200) {
    block.animate(
      [{ transform: "translateY(" + dy + "px)" }, { transform: "translateY(0)" }],
      { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" }
    );
  }
}
export function enterFocus() { if (!inFocus() && MOBILE_MQ.matches) switchMode(true); }
export function exitFocus()  { if (inFocus()) switchMode(false); }
/* ── touch gesture ── */
function onStart(e) {
  if (!MOBILE_MQ.matches || inFocus() || e.touches.length !== 1) return;
  const t = e.target;
  if (t && t.closest && t.closest("input,textarea,[contenteditable]")) return;
  if (modalOpen()) return;
  tracking = true; capturing = false; pull = 0;
  startY = e.touches[0].clientY;
  maxScroll = document.documentElement.scrollHeight - window.innerHeight;
}
function onMove(e) {
  if (!tracking) return;
  const dy = startY - e.touches[0].clientY;        // finger up → positive
  if (!capturing) {
    if (dy > SLACK && atBottom() && !scrollableBelow(e.target)) {
      capturing = true;
      showBubble();
    } else {
      if (dy < -4) tracking = false;               // headed back up the page
      return;
    }
  }
  e.preventDefault();
  pull = Math.max(0, dy - SLACK);
  moveBubble(pull);
}
function onEnd() {
  if (!tracking) return;
  tracking = false;
  if (!capturing) return;
  capturing = false;
  if (pull >= THRESHOLD) { commitBubble(); enterFocus(); }
  else                   { cancelBubble(); }
}
export function wireFocusMode() {
  hint = $("pullHint");
  ring = hint && hint.querySelector(".pr-prog");
  if (!hint || !ring) return;
  let r = 24;
  try { r = ring.r.baseVal.value || 24; } catch (_) {}
  ringLen = 2 * Math.PI * r;
  ring.style.strokeDasharray = String(ringLen);
  ring.style.strokeDashoffset = String(ringLen);
  hint.addEventListener("transitionend", (e) => {
    if (e.target === hint && e.propertyName === "transform" &&
        hint.classList.contains("resetting")) clearBubble();
  });
  dom.root.addEventListener("touchstart",  onStart, { passive: true });
  dom.root.addEventListener("touchmove",   onMove,  { passive: false });
  dom.root.addEventListener("touchend",    onEnd);
  dom.root.addEventListener("touchcancel", onEnd);
  const exitBtn = $("focusExitBtn");
  if (exitBtn) exitBtn.addEventListener("click", exitFocus);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inFocus()) exitFocus();
  });
  MOBILE_MQ.addEventListener("change", (e) => { if (!e.matches) exitFocus(); });
}