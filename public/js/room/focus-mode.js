/* public/js/room/focus-mode.js
 * ─────────────────────────────────────────────────────────────
 * MOBILE FOCUS VIEW — pull up from a settled page-bottom to pin
 * the player to the top and let the side panel fill the screen.
 * Escape / the header chevron exit.
 *
 * The pull only starts from a FRESH swipe: the touch must begin
 * with the page and every scroller under the finger already at
 * rest at the bottom. If a swipe scrolls anything it can't pull.
 *
 *   wireFocusMode()   gesture + exit button + escape + breakpoint guard
 *
 * Adds:  #roomPage.focus-mode   and   <html>.room-focus
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { $, dom } from "./dom.js";
const MOBILE_MQ = window.matchMedia("(max-width:768px)");
const SLACK     = 26;      // total upward travel before the bubble arms
const SLOP      = 6;       // ignore movement smaller than this (taps / tremor)
const THRESHOLD = 88;      // pull this far past SLACK to commit
const RISE_RATE = 1.6;
const HIDE_Y    = 80;      // keep in sync with .pull-hint transform in room.css
const RISE_CAP  = HIDE_Y + 26;
const REST_MS   = 120;     // the page must have been still this long for a fresh swipe
let hint = null, ring = null, ringLen = 151;
/* touch state */
let touchActive = false;       // a finger is down
let eligible    = false;       // this swipe began from a valid resting bottom
let armed       = false;       // the pull is captured; the bubble is on screen
let startY      = 0;
let pull        = 0;
let maxScroll   = 0;
let baseScrollY = 0;
let scroller    = null;        // nearest scrollable ancestor under the touch
let baseScrollerTop = 0;
let lastScrollAt = 0;          // timestamp of the most recent scroll anywhere
const reduced  = () => window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const inFocus  = () => document.documentElement.classList.contains("room-focus");
const atBottom = () => window.scrollY >= maxScroll - 2;
function inspectScrollers(node){
  let nearest = null, allBottom = true;
  for (let el = node; el && el !== document.body && el !== document.documentElement; el = el.parentElement){
    if (!(el instanceof HTMLElement)) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight - el.clientHeight > 1){
      if (!nearest) nearest = el;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) allBottom = false;
    }
  }
  return { nearest, allBottom };
}
function modalOpen(){
  if (dom.container && dom.container.classList.contains("pseudo-fs")) return true;
  return [dom.cfgSheet, dom.profCard, dom.vcCard]
    .some((el) => el && el.getAttribute("aria-hidden") === "false");
}
/* ── bubble (unchanged) ── */
function showBubble(){
  hint.classList.remove("resetting");
  hint.classList.add("active");
  ring.style.transition = "";
}
function moveBubble(p){
  const rise = Math.min(p * RISE_RATE, RISE_CAP);
  hint.style.transform = "translate(-50%," + (HIDE_Y - rise) + "px)";
  const prog = Math.min(p / THRESHOLD, 1);
  ring.style.strokeDashoffset = String(ringLen * (1 - prog));
  hint.classList.toggle("ready", prog >= 1);
}
function cancelBubble(){
  hint.classList.add("resetting");
  hint.classList.remove("active", "ready");
  hint.style.transform = "";
  ring.style.transition = "stroke-dashoffset .26s ease";
  ring.style.strokeDashoffset = String(ringLen);
  window.setTimeout(() => {
    if (hint.classList.contains("resetting")) clearBubble();
  }, 420);
}
function commitBubble(){
  hint.classList.remove("active");
  window.setTimeout(clearBubble, 260);
}
function clearBubble(){
  hint.classList.remove("active", "ready", "resetting");
  hint.style.transform = "";
  ring.style.transition = "";
  ring.style.strokeDashoffset = String(ringLen);
}
/* ── mode switch (unchanged) ── */
function switchMode(toFocus){
  const willAnimate = MOBILE_MQ.matches && !reduced();
  const block = document.querySelector(".room-content");
  const before = (willAnimate && block) ? block.getBoundingClientRect().top : 0;
  document.documentElement.classList.toggle("room-focus", toFocus);
  dom.root.classList.toggle("focus-mode", toFocus);
  if (!willAnimate || !block || !block.animate) return;
  const dy = before - block.getBoundingClientRect().top;
  if (Math.abs(dy) > 1 && Math.abs(dy) < 200){
    block.animate(
      [{ transform: "translateY(" + dy + "px)" }, { transform: "translateY(0)" }],
      { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" }
    );
  }
}
export function enterFocus(){ if (!inFocus() && MOBILE_MQ.matches) switchMode(true); }
export function exitFocus(){ if (inFocus()) switchMode(false); }
/* ── touch gesture ── */
function resetTouch(){
  touchActive = false;
  eligible = false;
  armed = false;
  pull = 0;
  scroller = null;
}
function markScroll(){ lastScrollAt = performance.now(); }
function onStart(e){
  if (armed) cancelBubble();
  resetTouch();
  if (!MOBILE_MQ.matches || inFocus() || e.touches.length !== 1) return;
  const t = e.target;
  if (!t || (t.closest && t.closest("input,textarea,[contenteditable]"))) return;
  if (modalOpen()) return;
  touchActive = true;
  startY      = e.touches[0].clientY;
  baseScrollY = window.scrollY;
  maxScroll   = document.documentElement.scrollHeight - window.innerHeight;
  const info = inspectScrollers(t);
  scroller = info.nearest;
  baseScrollerTop = scroller ? scroller.scrollTop : 0;
  eligible =
    atBottom() &&
    performance.now() - lastScrollAt > REST_MS &&
    info.allBottom;
}
function onMove(e){
  if (!touchActive || !e.touches || !e.touches.length) return;
  const dy = startY - e.touches[0].clientY;      // finger up → positive
  if (armed){
    e.preventDefault();
    pull = Math.max(0, dy - SLACK);
    moveBubble(pull);
    return;
  }
  if (!eligible) return;                          // normal scrolling continues
  if (dy < -SLOP){ eligible = false; return; }    // going down → hand it back to the page
  if (dy < SLOP) return;                          // within tap slop → leave it alone
  if (Math.abs(window.scrollY - baseScrollY) > 1 ||
      (scroller && Math.abs(scroller.scrollTop - baseScrollerTop) > 1)){
    eligible = false;                             // something scrolled under us
    return;
  }
  e.preventDefault();                             // kill the rubber-band from the first real pixel
  if (dy > SLACK){
    armed = true;
    showBubble();
    pull = Math.max(0, dy - SLACK);
    moveBubble(pull);
  }
}
function onEnd(){
  if (!touchActive) return;
  const wasArmed = armed;
  const finalPull = pull;
  resetTouch();
  if (!wasArmed) return;
  if (finalPull >= THRESHOLD){ commitBubble(); enterFocus(); }
  else                       { cancelBubble(); }
}
function onCancel(){
  if (!touchActive) return;
  const wasArmed = armed;
  resetTouch();
  if (wasArmed) cancelBubble();
}
export function wireFocusMode(){
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
  window.addEventListener("scroll", markScroll, { passive: true, capture: true });
  dom.root.addEventListener("touchstart",  onStart,  { passive: true });
  dom.root.addEventListener("touchmove",   onMove,   { passive: false });
  dom.root.addEventListener("touchend",    onEnd);
  dom.root.addEventListener("touchcancel", onCancel);
  const exitBtn = $("focusExitBtn");
  if (exitBtn) exitBtn.addEventListener("click", exitFocus);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inFocus()) exitFocus();
  });
  MOBILE_MQ.addEventListener("change", (e) => { if (!e.matches) exitFocus(); });
}