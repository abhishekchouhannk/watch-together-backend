/* public/js/dom.js
 * ─────────────────────────────────────────────────────────────
 * CACHED DOM LOOKUPS. `$(id)` is the raw getElementById helper;
 * `dom` is the eagerly-cached map of the long-lived elements.
 *
 * IMPORTANT: element IDs are NOT renamed — the keys here are the
 * original (sometimes inconsistent) names from room.js.
 *
 * Caching happens at module-evaluation time. ES modules are deferred,
 * so the document is fully parsed before this runs — same guarantee the
 * original bottom-of-body <script> had. Elements created later (e.g.
 * #videoEl, #ytPlayerDiv, queue rows) are still looked up via $() at
 * point of use, exactly as before.
 * ───────────────────────────────────────────────────────────── */
"use strict";
export const $ = (id) => document.getElementById(id);
export const dom = {
  root: $("roomPage"), sky: $("skyBg"),
  details: $("roomDetails"), hdrName: $("hdrName"), hdrBadge: $("hdrBadge"), hdrDot: $("hdrDot"),
  videoWrap: $("videoWrapper"), placeholder: $("videoPlaceholder"),
  controls: $("videoControls"), container: $("videoContainer"),
  chatMsgs: $("chatMessages"), chatInput: $("chatInput"), chatOnline: $("chatOnline"),
  toasts: $("toastWrap"),
  themeSwitcher: $("themeSwitcher"), themeBtn: $("themeBtn"), themeBtnIcon: $("themeBtnIcon"), themeMenu: $("themeMenu"),
  fxLayer: $("fxLayer"),
  reactRail: $("reactRail"), reactToggle: $("reactToggle"), reactStrip: $("reactStrip"),
  reactHub: $("reactHub"),
  shield: $("playerShield"), vcLock: $("vcLock"),
  configBtn: $("configBtn"), gearBadge: $("gearBadge"),
  cfgSheet: $("cfgSheet"), cfgBackdrop: $("cfgBackdrop"), cfgBody: $("cfgBody"),
  tabChat: $("tabChat"), tabQueue: $("tabQueue"),
  paneChat: $("paneChat"), paneQueue: $("paneQueue"),
  chatUnread: $("chatUnread"), chatJump: $("chatJump"), chatJumpN: $("chatJumpN"),
  profCard: $("profCard"), profBackdrop: $("profBackdrop"), profBody: $("profBody"), profClose: $("profClose"),
};
