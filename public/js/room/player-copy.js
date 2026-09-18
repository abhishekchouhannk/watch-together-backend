/* public/js/player.js
 * ─────────────────────────────────────────────────────────────
 * THE VIDEO ENGINE — direct <video> + YouTube IFrame behind one facade,
 * plus load / controls / sync / fullscreen / letterbox / settings menu.
 *
 *  P                   player facade. type 'direct'|'youtube', el, yt, ready.
 *                      time()/dur()/paused()/play()/pause()/seek()/vol…
 *                      remote(fn)  wraps an action that came from the NETWORK
 *                                  so the resulting native events don't echo
 *                                  back out (isRemote() for REMOTE_COOLDOWN ms)
 *                      startLeader()/stopLeader()  'video-time-sync' heartbeat,
 *                                  only while S.perms.canSync
 *                      startYTPoll()/stopYTPoll()  seek detection for YT
 *  ytLetterbox         crops the YT chrome by oversizing the iframe; owns
 *                      container height on mobile and the --yt-extra CSS var
 *  settingsUI          informative quality menu (YouTube only)
 *  loadVideo(url, fromRemote, opts)   tear down → mount → ready → sync
 *  onPlayerReady()     volume handoff, then autoplay OR late-join sync dance:
 *                      DB snapshot seek → 'video-sync-request' → 2 s fallback
 *  onYTState(e)        YT state → 'video-play'/'video-pause' emits, ENDED → queue
 *  wirePlayerControls()   control bar, keyboard (space/k/←/→/m).
 *                      NOTE: dom.vcLock.onclick was pulled OUT of here (it opens
 *                      the config sheet, which this module must not import);
 *                      wireEvents() in room.js registers it right after calling this.
 *  wireDirectVideoEvents() per-element listeners for the fresh <video>
 *  markLocal(t, playing)   S.video = {currentTime,isPlaying,at} — REPLACES S.video
 *  expectedVideoState()    extrapolates S.video to "now"
 *  revertToRoomState(v?)   snaps a non-controller back to the authoritative state
 *  guardSync()         permission gate with a toast
 *  emitSeek(t)         'video-seek' (controllers only)
 *  fullscreen          fsEl/exitFs/toggleFullscreen/setPseudoFs/onFullscreenChange/setFsIcon
 *
 *  playerHooks         OUTBOUND calls to modules that import US (so we can't
 *                      import them): queue (resetUpNext, render, onEnded, tick)
 *                      and reactions (closeRail). No-op defaults; filled by
 *                      room.js (queue, for now) and reactions.js.
 *
 * Module-private state (was module-scope `let`s in room.js):
 *   volDragging, ytAPIReady, ytAPIProm, pendingAutoplay, uiTick,
 *   progDragging, seekTimer
 * Shared state read/written: S.perms.canSync (read), S.video (REPLACED by
 *   markLocal), S.videoLoaded, S.needsSync, S.initialVideoState,
 *   S.syncFallbackTimer, S.currentItemId
 *
 * Network: 'video-load','video-play','video-pause','video-seek',
 *   'video-time-sync','video-sync-request','video-sync-state' attached on
 *   first onConnect; room-state phase 35 performs the initial load.
 *   Outbound via sockEmit/getSocket only.
 * Globals: YT (IFrame API, loaded on demand by loadYTAPI)
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { SYNC_INTERVAL, DRIFT_THRESHOLD, REMOTE_COOLDOWN, SETTLE_CAP, ACK_TTL } from "./config.js";
import { playSVG, pauseSVG, bigPlay, bigPause, spinnerSVG, volSVG, mutedSVG,
         fsExpandSVG, fsCollapseSVG } from "./svg.js";
import { S } from "./state.js";
import { $, dom } from "./dom.js";
import { toast, fmtTime, fillSlider, extractYT } from "./utils.js";
import { getSocket, emit as sockEmit } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
/* ══════════════════════════════════════
   OUTBOUND HOOKS (filled by importers — see header)
   ══════════════════════════════════════ */
export const playerHooks = {
  queueResetUpNext() {},
  queueRender()      {},
  queueOnEnded()     {},
  queueTick(t, d)    {},
  closeRail()        {},
};
/* ═══════════════════════════════════════════
   PLAYER ABSTRACTION  (direct <video> + YT)
   ═══════════════════════════════════════════ */
export const P = {
  type: null,   // 'direct' | 'youtube'
  el: null,     // HTMLVideoElement
  yt: null,     // YT.Player
  ready: false,
  _rc: 0,       // remote-action counter
  _syncInt: null,
  _ytPoll: null,
  _ytLast: 0,

  /* settlement gag (replaces the pure-timer gag) */
  _settling: false, _settleTick: null, _settleGrace: null,
  _inRemote: false, _settleKind: null, _settleTarget: null,

  /* one-shot echo swallower for explicit UI actions */
  _ack: null,

  /* ── getters ── */
  time() {

  },
  dur() {

  },
  paused() {

  },
  buffering() {

  },
  /* ── actions ── */
  play(t) {

  },
  pause(t) {

  },
  seek(t) {

  },
  /* ── remote-action guard ──
     Gag stays up until the action has SETTLED (buffer filled, target reached,
     desired state achieved) + a grace period, not for a fixed number of ms. */
  remote(fn) {

  },
  isRemote() { return this._rc > 0 || this._settling; },

  _beginSettle() {

  },
  _endSettle() {

  },
  _isSettled() {

  },

  /* ── EXPLICIT USER INTENT ──
     Broadcast NOW, override any remote gag, and arm a one-shot ack so the
     native echo of this very action isn't emitted a second time. */
  act(kind, t) {

  },
  toggleUser() { this.act(this.paused() ? "play" : "pause"); },
  /* consume the echo of an act(); returns true if this native event was ours */
  _consumeAck(kind) {

  },


  /* -- volume/toggle helpers, */
  setVol(v) {  // 0..1

  },
  setMuted(m) {

  },
  isMuted() {

  },
  vol() {

  },
  toggle() { this.paused() ? this.play() : this.pause(); },
  /* ── sync leader: broadcasts time every SYNC_INTERVAL ── */
  startLeader() {
    clearInterval(this._syncInt);
    this._syncInt = setInterval(() => {
      if (!S.perms.canSync) return;
      if (barrier.active) return;                         // room is held — no heartbeat
      if (!this.paused() && !this.buffering())
        sockEmit("video-time-sync", { currentTime: this.time() });
    }, SYNC_INTERVAL);
  },
  stopLeader() { clearInterval(this._syncInt); },
  /* ── YT seek-detection poll: always track _ytLast, never emit while gagged.
     (Previously _ytLast froze during the gag, so the first post-buffer tick
     saw a giant "jump" and reported a phantom seek.) ── */
  startYTPoll() {
    clearInterval(this._ytPoll);
    this._ytLast = this.time();
    this._ytPoll = setInterval(() => {
      if (!this.yt || !this.ready) return;
      const now = this.time(), last = this._ytLast;
      this._ytLast = now;
      if (this.isRemote() || this._settling) return;
      if (Math.abs(now - last) > 2 && !this.paused()) sockEmit("video-seek", { currentTime: now });
    }, 500);
  },
  stopYTPoll() { clearInterval(this._ytPoll); },
  /* ── cleanup ── */
  destroy() {
    this.stopLeader(); this.stopYTPoll(); this._endSettle();
    if (this.type === "youtube" && this.yt) try { this.yt.destroy(); } catch (_) {}
    this.yt = null; this.el = null;
    this.type = null; this.ready = false; this._rc = 0; this._ack = null;
  },
};

/* ══════════════════════════════════════
   SYNC BARRIER — pause everywhere → buffer → play in tandem
   Breaks the seek→buffer→drift→re-seek loop: nobody plays until
   every player has the target position buffered.
   ══════════════════════════════════════ */

/* ═══════════════════════════════════ */


let volDragging = false;
export function isSilent() { return P.isMuted() || P.vol() === 0; }
export function syncVolumeUI() {
  if (!P.ready) return;
  const m = isSilent();
  $("muteBtn").innerHTML = m ? mutedSVG : volSVG;
  if (volDragging || document.activeElement === $("volBar")) return;
  const v = m ? 0 : Math.round(P.vol() * 100);
  const vb = $("volBar");
  if (+vb.value !== v) { vb.value = v; fillSlider(vb, v, 100); }
}
/* ═══════ YOUTUBE IFRAME API (loaded once, on demand) ═══════ */
let ytAPIReady = false, ytAPIProm = null;
export function loadYTAPI() {
  if (ytAPIReady) return Promise.resolve();
  if (ytAPIProm)  return ytAPIProm;
  ytAPIProm = new Promise((res) => {
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
    window.onYouTubeIframeAPIReady = () => { ytAPIReady = true; res(); };
  });
  return ytAPIProm;
}
/* ══════════════════════════════════
   YT LETTERBOX/CROP — frontend only
   ══════════════════════════════════ */
export const ytLetterbox = (() => {
  const CFG = { pad: 80, crop: 80, aspect: 16 / 9 };
  const DEFAULT_AR = CFG.aspect;
  const desktopMQ = window.matchMedia("(min-width:769px)");
  let container = null, iframe = null, ro = null, raf = 0;
  const visibleBar = () => Math.max(0, CFG.pad - CFG.crop);
  const schedule   = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); };
  function layout() {
    if (!container || !iframe) return;
    const fixedH = desktopMQ.matches ||
                   container.classList.contains("pseudo-fs") ||
                   !!document.fullscreenElement;
    if (fixedH) {
      if (container.style.height) container.style.height = "";
      place(container.clientWidth, container.clientHeight);
    } else {
      const W = container.clientWidth;
      const H = Math.round(W / CFG.aspect + 2 * visibleBar());
      if (container.style.height !== H + "px") container.style.height = H + "px";
      document.documentElement.style.setProperty("--yt-extra", Math.round(2 * visibleBar()) + "px");
      place(W, H);
    }
  }
  function place(W, H) {
    const vb = visibleBar();
    const Vw = Math.min(W, Math.max(50, H - 2 * vb) * CFG.aspect);
    const Vh = Vw / CFG.aspect;
    const Iw = Math.round(Vw);
    /* guarantee ≥ crop px of real overflow per side even in tall containers */
    const Ih = Math.max(Math.round(Vh + 2 * CFG.pad), H + 2 * CFG.crop);
    iframe.style.width  = Iw + "px";
    iframe.style.height = Ih + "px";
    iframe.style.left   = Math.round((W - Iw) / 2) + "px";
    iframe.style.top    = Math.round((H - Ih) / 2) + "px";
  }
  function setAspect(ar) { if (ar > 0 && container) { CFG.aspect = ar; schedule(); } }
  function attach(containerEl, iframeEl) {
    detach();
    container = containerEl; iframe = iframeEl;
    container.classList.add("yt-boxed");
    ro = new ResizeObserver(schedule);
    ro.observe(container);
    desktopMQ.addEventListener("change", schedule);
    document.addEventListener("fullscreenchange", schedule);
    layout();
  }
  function detach() {
    if (ro) { ro.disconnect(); ro = null; }
    desktopMQ.removeEventListener("change", schedule);
    document.removeEventListener("fullscreenchange", schedule);
    if (container) { container.classList.remove("yt-boxed"); container.style.height = ""; }
    if (iframe) iframe.style.cssText = "";
    document.documentElement.style.setProperty("--yt-extra", "0px");
    container = iframe = null;
    CFG.aspect = DEFAULT_AR;
  }
  return { attach, detach, setAspect, CFG };
})();
/* ═══════ YT METADATA (oEmbed: title, author, thumb, aspect) ═══════ */
export async function fetchYTMeta(videoId) {
  
}
export async function showVideoInfo(ytId) {

}
export function setChannelAvatar(author, authorUrl) {

}
export function flashInfoBar(ms = 3000) {

}
/* ═══════ SETTINGS MENU — informative only (YouTube) ═══════ */
export const settingsUI = (() => {

});
/* ══════════════════════════════════
   VIDEO — load / controls / sync
   ══════════════════════════════════ */

/* ═══════ PLAYER CONTROLS (both player types, permission-gated) ═══════ */
let uiTick = null, progDragging = false, lastVisual = null;
export function startUITicker() { clearInterval(uiTick); uiTick = setInterval(updateProgressUI, 250); }
/* What should the chrome SHOW right now?
   'loading' — a sync event (barrier / remote seek / remote play) is in flight and
               the player hasn't reached a steady state yet. Shown as a spinner so
               nobody mistakes "someone seeked, I'm buffering" for "it paused".
   'playing' / 'paused' — steady state, icon derived from the player as before. */
export function visualState() {
  if (!P.ready) return "loading";
  if (barrier.active) return "loading";               // whole room is held, waiting on buffers
  if (P.buffering()) return "loading";                // YT state 3 / stalled direct <video>
  if (P._settling) {
    /* a remote action is still landing. Does the room intend to be playing? */
    const kind = P._settleKind;
    const wantsPlay = kind === "play" || (kind !== "pause" && !!S.video.isPlaying);
    if (wantsPlay && P.paused()) return "loading";    // asked to play, hasn't started yet
  }
  return P.paused() ? "paused" : "playing";
}
export function updateProgressUI() {
  if (!P.ready) return;
  const prog = $("progressBar"), t = P.time() || 0, d = P.dur() || 0;
  if (!progDragging) {
    prog.max = Math.max(1, Math.floor(d * 100));
    prog.value = Math.floor(t * 100);
    fillSlider(prog, prog.value, prog.max);
    $("curTime").textContent = fmtTime(t);
  }
  syncVolumeUI();
  $("durTime").textContent = fmtTime(d);
  renderPlayState(visualState());
  playerHooks.queueTick(t, d);
}
function renderPlayState(vs) {
  if (vs === lastVisual) return;
  lastVisual = vs;
  const c = $("cPlayBtn"), b = $("playBtn");
  const loading = vs === "loading";
  c.classList.toggle("is-loading", loading);
  dom.container.classList.toggle("is-loading", loading);
  if (loading) {
    c.innerHTML = spinnerSVG;
    c.setAttribute("aria-label", "Syncing…");
    b.innerHTML = pauseSVG;            // the room is (about to be) playing — offer "pause"
  } else if (vs === "playing") {
    c.innerHTML = bigPause;
    c.setAttribute("aria-label", "Pause");
    b.innerHTML = pauseSVG;
  } else {
    c.innerHTML = bigPlay;
    c.setAttribute("aria-label", "Play");
    b.innerHTML = playSVG;
  }
}
export function wirePlayerControls() {
  const prog = $("progressBar"), volBar = $("volBar");
  $("playBtn").onclick  = () => { if (guardSync()) P.toggleUser(); };
  $("cPlayBtn").onclick = () => { if (guardSync()) P.toggleUser(); };
  dom.shield.addEventListener("click", () => { if (guardSync()) P.toggleUser(); });
  renderPlayState(visualState());
  prog.addEventListener("input", () => {
    if (!S.perms.canSync) return;
    progDragging = true;
    const t = prog.value / 100;
    $("curTime").textContent = fmtTime(t);
    fillSlider(prog, prog.value, prog.max);
    if (P.type === "direct") P.seek(t);                        // local-only live scrub
  });
  prog.addEventListener("change", () => {
    progDragging = false;
    if (!S.perms.canSync) { updateProgressUI(); return; }
    P.act("seek", prog.value / 100);                           // both player types, broadcast now
  });
  $("muteBtn").onclick = () => {
    const silent = isSilent();
    if (silent) {                       // unmute → restore a usable level
      P.setMuted(false);
      if (P.vol() === 0) P.setVol(volBar.value > 0 ? volBar.value / 100 : 1);
    } else {
      P.setMuted(true);
    }
    syncVolumeUI();
  };
  volBar.addEventListener("pointerdown", () => (volDragging = true));
  volBar.addEventListener("pointerup",   () => (volDragging = false));
  volBar.addEventListener("input", () => {
    const v = volBar.value / 100;
    P.setVol(v);
    P.setMuted(v === 0);
    fillSlider(volBar, volBar.value, 100);
    $("muteBtn").innerHTML = v === 0 ? mutedSVG : volSVG;
  });
  fillSlider(volBar, 100, 100);
  $("fsBtn").onclick = toggleFullscreen;
  $("cPlayBtn").onclick = () => { if (guardSync()) P.toggle(); };
  $("settingsBtn").onclick = (e) => { e.stopPropagation(); settingsUI.toggle(); };
  /* keyboard */
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || !P.ready) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "k")  { e.preventDefault(); if (guardSync()) P.toggleUser(); }
    else if (k === "arrowright") { if (guardSync()) P.act("seek", P.time() + 5); }
    else if (k === "arrowleft")  { if (guardSync()) P.act("seek", Math.max(0, P.time() - 5)); }
    else if (k === "m") { P.setMuted(!isSilent()); syncVolumeUI(); }
  });
}
export function wireDirectVideoEvents() {

}

/* ⚠ REPLACES S.video with a fresh object (as it always did). Nothing caches S.video. */
export function markLocal(currentTime, isPlaying) { S.video = { currentTime, isPlaying, at: Date.now() }; }
export function expectedVideoState() {

}
/* snap a rule-breaker back to the room's authoritative state */
export function revertToRoomState(state) {
  const v = state || expectedVideoState();
  P.remote(() => { P.seek(v.currentTime); v.isPlaying ? P.play(v.currentTime) : P.pause(v.currentTime); });
}
/* ═══════ FULLSCREEN (always on the dom container, never the YT iframe) ═══════ */
export function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
export function exitFs() { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); }
export function toggleFullscreen() {
  const el = dom.container;
  if (fsEl()) { exitFs(); return; }
  if (el.classList.contains("pseudo-fs")) { setPseudoFs(false); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) { setPseudoFs(true); return; }                      // iOS Safari etc.
  try {
    const p = req.call(el);
    if (p && p.catch) p.catch(() => setPseudoFs(true));
  } catch (_) { setPseudoFs(true); }
}
/* CSS-only fullscreen fallback for browsers without element fullscreen */
export function setPseudoFs(on) {
  dom.container.classList.toggle("pseudo-fs", on);
  dom.container.classList.toggle("is-fs", on);
  document.body.style.overflow = on ? "hidden" : "";
  setFsIcon(on);
  if (!on) playerHooks.closeRail();               // ← was closeRail()
}
export function onFullscreenChange() {
  const cur = fsEl();
  /* Safety net: if anything INSIDE the player (e.g. a YT iframe that somehow still
     has permission) grabbed fullscreen for itself, bounce it onto our container so
     the reaction rail / float layer survive. */
  if (cur && cur !== dom.container && dom.container.contains(cur)) {
    try {
      const p = exitFs();
      Promise.resolve(p).then(() => dom.container.requestFullscreen()).catch(() => {});
    } catch (_) {}
    return;
  }
  const isFs = cur === dom.container;
  dom.container.classList.toggle("is-fs", isFs);
  setFsIcon(isFs);
  if (!isFs) playerHooks.closeRail();             // ← was closeRail()
}
export function setFsIcon(isFs) {
  const svg = isFs ? fsCollapseSVG : fsExpandSVG;
  const vcFs = $("fsBtn");
  if (vcFs) vcFs.innerHTML = svg;
}
/* ══════════════════════════════════════
   NETWORK — own domain events + centralized hooks
   ══════════════════════════════════════ */
