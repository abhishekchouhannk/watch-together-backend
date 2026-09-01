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
    if (this.type === "youtube" && this.yt)
      try { return this.yt.getCurrentTime() || 0; } catch (_) { return 0; }
    return this.el ? this.el.currentTime : 0;
  },
  dur() {
    if (this.type === "youtube" && this.yt)
      try { return this.yt.getDuration() || 0; } catch (_) { return 0; }
    return this.el ? this.el.duration || 0 : 0;
  },
  paused() {
    if (this.type === "youtube" && this.yt)
      try { return this.yt.getPlayerState() !== 1; } catch (_) { return true; }
    return !this.el || this.el.paused;
  },
  buffering() {
    if (this.type === "youtube" && this.yt)
      try { return this.yt.getPlayerState() === 3; } catch (_) { return false; } // 3 = BUFFERING
    // direct: "playing but stalled"
    return this.el ? (!this.el.paused && this.el.readyState < 3) : false;
  },
  /* ── actions ── */
  play(t) {
    if (this._inRemote) { this._settleKind = "play"; if (t != null) this._settleTarget = t; }
    if (this.type === "youtube" && this.yt) {
      if (t != null) this.yt.seekTo(t, true);
      this.yt.playVideo();
    } else if (this.el) {
      if (t != null) this.el.currentTime = t;
      this.el.play().catch(() => {});
    }
  },
  pause(t) {
    if (this._inRemote) { this._settleKind = "pause"; if (t != null) this._settleTarget = t; }
    if (this.type === "youtube" && this.yt) {
      this.yt.pauseVideo();
      if (t != null) this.yt.seekTo(t, true);
    } else if (this.el) {
      this.el.pause();
      if (t != null) this.el.currentTime = t;
    }
  },
  seek(t) {
    if (this._inRemote) { this._settleTarget = t; if (!this._settleKind) this._settleKind = "seek"; }
    if (this.type === "youtube" && this.yt) this.yt.seekTo(t, true);
    else if (this.el) this.el.currentTime = t;
  },
  /* ── remote-action guard ──
     Gag stays up until the action has SETTLED (buffer filled, target reached,
     desired state achieved) + a grace period, not for a fixed number of ms. */
  remote(fn) {
    this._rc++;
    this._inRemote = true; this._settleKind = null; this._settleTarget = null;
    try { fn(); } finally { this._inRemote = false; }
    this._beginSettle();
    setTimeout(() => (this._rc = Math.max(0, this._rc - 1)), REMOTE_COOLDOWN);
  },
  isRemote() { return this._rc > 0 || this._settling; },

  _beginSettle() {
    this._endSettle();
    this._settling = true;
    const started = Date.now();
    this._settleTick = setInterval(() => {
      if (!this.ready) return;
      if (!this._isSettled() && Date.now() - started < SETTLE_CAP) return;
      clearInterval(this._settleTick); this._settleTick = null;
      /* grace: the events that accompany settling (YT 3→1, 'playing', 'seeked'…)
         fire in the same tick region — let them drain before lifting the gag */
      this._settleGrace = setTimeout(() => { this._settling = false; }, REMOTE_COOLDOWN);
    }, 100);
  },
  _endSettle() {
    clearInterval(this._settleTick); this._settleTick = null;
    clearTimeout(this._settleGrace); this._settleGrace = null;
    this._settling = false;
  },
  _isSettled() {
    if (this.buffering()) return false;
    const kind = this._settleKind, tgt = this._settleTarget;
    if (this.type === "youtube" && this.yt) {
      let st = -1; try { st = this.yt.getPlayerState(); } catch (_) { return true; }
      if (st === 3 || st === -1) return false;                  // still buffering / unstarted
      if (kind === "play"  && st !== 1) return false;            // asked to play, not playing yet
      if (kind === "pause" && st === 1) return false;
    } else if (this.el) {
      if (this.el.seeking || this.el.readyState < 3) return false;
      if (kind === "play"  && this.el.paused)  return false;
      if (kind === "pause" && !this.el.paused) return false;
    }
    /* target not reached yet (clock still sitting before the seek point) */
    if (tgt != null && this.time() < tgt - 1.5) return false;
    return true;
  },

  /* ── EXPLICIT USER INTENT ──
     Broadcast NOW, override any remote gag, and arm a one-shot ack so the
     native echo of this very action isn't emitted a second time. */
  act(kind, t) {
    if (!this.ready) return;
    this._endSettle(); this._rc = 0;                            // manual intent beats suppression
    const time = t != null ? t : this.time();
    if (kind === "play") {
      cancelBarrier();
      sockEmit("video-play", { currentTime: time });
      markLocal(time, true);
      this._ack = { kind: "play", at: Date.now() };
      this.play(t); this.startLeader();
    } else if (kind === "pause") {
      cancelBarrier();
      sockEmit("video-pause", { currentTime: time });
      markLocal(time, false);
      this._ack = { kind: "pause", at: Date.now() };
      this.pause(t); this.stopLeader();
    } else if (kind === "seek") {
      this.seek(t);
      emitSeek(t);                                              // server → barrier if playing
    }
  },
  toggleUser() { this.act(this.paused() ? "play" : "pause"); },
  /* consume the echo of an act(); returns true if this native event was ours */
  _consumeAck(kind) {
    const a = this._ack;
    if (!a) return false;
    this._ack = null;
    return a.kind === kind && Date.now() - a.at < ACK_TTL;
  },


  /* -- volume/toggle helpers, */
  setVol(v) {  // 0..1
    if (this.type === "youtube" && this.yt) { try { this.yt.setVolume(Math.round(v*100)); if (v > 0) this.yt.unMute(); } catch(_){} }
    else if (this.el) this.el.volume = v;
  },
  setMuted(m) {
    if (this.type === "youtube" && this.yt) { try { m ? this.yt.mute() : this.yt.unMute(); } catch(_){} }
    else if (this.el) this.el.muted = m;
  },
  isMuted() {
    if (this.type === "youtube" && this.yt) { try { return this.yt.isMuted(); } catch(_) { return false; } }
    return this.el ? this.el.muted : false;
  },
  vol() {
    if (this.type === "youtube" && this.yt)
      try { return (this.yt.getVolume() || 0) / 100; } catch (_) { return 1; }
    return this.el ? this.el.volume : 1;
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
const READY_POLL_MS  = 200;
const BARRIER_SAFETY = 10000;   // client-side deadlock escape if 'go' never arrives
const BUFFER_AHEAD   = 2;       // seconds that must be buffered past the target
const barrier = { active: false, seq: 0, target: 0, poll: null, safety: null, reported: false };
/* "do I have the target position + a little runway in the buffer?" */
function isBufferedAt(t) {
  if (!P.ready) return false;
  if (P.type === "youtube" && P.yt) {
    try {
      const st = P.yt.getPlayerState();
      if (st === 3) return false;                        // actively BUFFERING
      const d = P.yt.getDuration() || 0;
      if (!d) return st === 2 || st === 5;               // no metadata yet → trust the state
      const loadedEnd = (P.yt.getVideoLoadedFraction() || 0) * d;
      return loadedEnd >= Math.min(d - 0.25, t + BUFFER_AHEAD) &&
             Math.abs(P.yt.getCurrentTime() - t) < BUFFER_AHEAD;
    } catch (_) { return true; }                         // API hiccup → don't deadlock the room
  }
  const el = P.el;
  if (!el) return false;
  const need = Math.min((el.duration || t + BUFFER_AHEAD) - 0.25, t + BUFFER_AHEAD);
  try {
    for (let i = 0; i < el.buffered.length; i++)
      if (el.buffered.start(i) <= t + 0.25 && el.buffered.end(i) >= need) return true;
  } catch (_) {}
  return el.readyState >= 4;                             // HAVE_ENOUGH_DATA fallback
}
export function enterBarrier(seq, target) {
  cancelBarrier();
  barrier.active = true; barrier.seq = seq; barrier.target = target; barrier.reported = false;
  P.stopLeader();
  P.remote(() => { P.pause(); P.seek(target); });
  markLocal(target, false);                              // held = authoritatively paused
  dom.container.classList.add("is-syncing");             // CSS hook for a spinner (optional)
  barrier.poll = setInterval(() => {
    if (barrier.reported) return;
    if (isBufferedAt(barrier.target)) {
      barrier.reported = true;
      clearInterval(barrier.poll); barrier.poll = null;
      sockEmit("video-buffer-ready", { seq: barrier.seq });
    }
  }, READY_POLL_MS);
  /* if 'go' is lost (server restart, dropped packet), don't stay frozen forever */
  barrier.safety = setTimeout(() => finishBarrier(barrier.target), BARRIER_SAFETY);
}
export function cancelBarrier() {
  clearInterval(barrier.poll);  barrier.poll = null;
  clearTimeout(barrier.safety); barrier.safety = null;
  barrier.active = false; barrier.reported = false;
  dom.container.classList.remove("is-syncing");
}
function finishBarrier(currentTime) {
  cancelBarrier();
  markLocal(currentTime, true);
  P.remote(() => P.play(currentTime));
  if (S.perms.canSync) P.startLeader();
}

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
  const fallbackThumb = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId));
    const d = await r.json();
    return {
      title:  d.title || "",
      author: d.author_name || "",
      authorUrl: d.author_url || "",
      thumb:  d.thumbnail_url || fallbackThumb,
      aspect: (d.width && d.height) ? d.width / d.height : null,
    };
  } catch (_) {
    return { title: "", author: "", authorUrl: "", thumb: fallbackThumb, aspect: null };
  }
}
export async function showVideoInfo(ytId) {
  const meta = await fetchYTMeta(ytId);
  if (meta.aspect) ytLetterbox.setAspect(meta.aspect);       // replaces old auto-detect
  setChannelAvatar(meta.author, meta.authorUrl);
  $("viTitle").textContent  = meta.title  || "YouTube video";
  $("viAuthor").textContent = meta.author || "";
  $("viBar").style.display = "";
  flashInfoBar(4000);
}
export function setChannelAvatar(author, authorUrl) {
  const img = $("viThumb"), av = $("viAv");
  const fallback = () => {
    img.style.display = "none";
    av.style.display = "";
    av.textContent = (author || "?").trim().charAt(0).toUpperCase();
  };
  av.style.display = "none";
  img.style.display = "";
  const m = (authorUrl || "").match(/youtube\.com\/(@[\w.\-]+)/);
  if (!m) return fallback();
  img.onerror = fallback;
  img.src = "https://unavatar.io/youtube/" + encodeURIComponent(m[1]) + "?fallback=false";
}
export function flashInfoBar(ms = 3000) {
  const bar = $("viBar");
  if (!bar || bar.style.display === "none") return;
  bar.classList.add("show");
  clearTimeout(flashInfoBar._t);
  flashInfoBar._t = setTimeout(() => bar.classList.remove("show"), ms);
}
/* ═══════ SETTINGS MENU — informative only (YouTube) ═══════ */
export const settingsUI = (() => {
  const QL = { highres:"4320p+", hd2160:"2160p", hd1440:"1440p", hd1080:"1080p",
              hd720:"720p", large:"480p", medium:"360p", small:"240p",
              tiny:"144p", auto:"Auto", unknown:"—" };
  let open = false, tick = null;
  function build() {
    let q = "unknown";
    try { q = P.yt.getPlaybackQuality() || "unknown"; } catch (_) {}
    $("vcMenu").innerHTML =
      '<div class="vcm-sec"><div class="vcm-title">Playback</div>' +
      '<div class="vcm-row"><span>Quality</span><span class="vcm-val">' +
      (QL[q] || q) + "</span></div></div>";
  }
  function toggle() { open ? close() : openMenu(); }
  function openMenu() {
    if (P.type !== "youtube" || !P.ready) return;
    build();
    $("vcMenu").classList.add("open");
    $("settingsBtn").setAttribute("aria-expanded", "true");
    open = true;
    tick = setInterval(build, 1000);                  // live-update while open
    setTimeout(() => document.addEventListener("click", onDocClick), 0);
  }
  function close() {
    clearInterval(tick); tick = null;
    $("vcMenu").classList.remove("open");
    $("settingsBtn").setAttribute("aria-expanded", "false");
    open = false;
    document.removeEventListener("click", onDocClick);
  }
  function onDocClick(e) {
    if (!$("vcMenu").contains(e.target) && !$("settingsBtn").contains(e.target)) close();
  }
  function onYTReady() { $("settingsBtn").style.display = ""; }
  function reset()     { close(); $("settingsBtn").style.display = "none"; }
  return { toggle, onYTReady, reset, close };
})();
/* ══════════════════════════════════
   VIDEO — load / controls / sync
   ══════════════════════════════════ */
let pendingAutoplay = false;
export async function loadVideo(url, fromRemote, opts) {
  opts = opts || {};
  if (!url) return;
  cancelBarrier();
  P.destroy();
  ytLetterbox.detach();
  settingsUI.reset();
  lastVisual = null;
  dom.container.classList.remove("is-loading");
  volDragging = false;
  playerHooks.queueResetUpNext();                 // ← was Q.resetUpNext()
  $("viBar").style.display = "none";
  if (dom.fxLayer) dom.fxLayer.innerHTML = "";
  pendingAutoplay = !!opts.play;              // ← remember whether to auto-start
  const ytId = extractYT(url);
  if (ytId) {
    P.type = "youtube";
    await loadYTAPI();
    const qs = new URLSearchParams({
      enablejsapi: "1", fs: "0", controls: "0", disablekb: "1",
      rel: "0", modestbranding: "1", iv_load_policy: "3",
      playsinline: "1", autoplay: "0", origin: location.origin,
    }).toString();
    dom.videoWrap.innerHTML =
      '<iframe id="ytPlayerDiv" title="YouTube player" frameborder="0"' +
      ' allow="autoplay; encrypted-media; picture-in-picture"' +
      ' src="https://www.youtube.com/embed/' + ytId + '?' + qs + '"></iframe>';
    ytLetterbox.attach($("videoContainer"), $("ytPlayerDiv"));
    showVideoInfo(ytId);
    P.yt = new YT.Player("ytPlayerDiv", {
      events: { onReady: onPlayerReady, onStateChange: onYTState },
    });
  } else {
    P.type = "direct";
    dom.videoWrap.innerHTML = '<video id="videoEl" preload="metadata"></video>';
    P.el = $("videoEl");
    P.el.src = url;
    wireDirectVideoEvents();
    P.el.addEventListener("canplay", onPlayerReady, { once: true });
  }
  dom.controls.style.display = "";
  $("vcCenter").style.display = "";
  startUITicker();
  if (dom.placeholder && dom.placeholder.parentNode) dom.placeholder.remove();
  S.videoLoaded = true;
  playerHooks.queueRender();                      // ← was Q.render()
}
export function reportDuration() {
  if (!getSocket() || !S.currentItemId || !S.perms.canSync) return;
  const tryIt = () => {
    const d = P.dur();
    if (d > 0) sockEmit("queue-duration", { id: S.currentItemId, duration: d });
    else setTimeout(tryIt, 700);
  };
  setTimeout(tryIt, 400);
}
/* Called once when the player is ready to accept commands */
export function onPlayerReady() {
  if (P.type === "youtube") settingsUI.onYTReady();
  P.ready = true;
  /* YT hands a muted player; force it into the state the UI claims */
  P.setVol(($("volBar").value || 100) / 100);
  P.setMuted(false);
  syncVolumeUI();
  if (!S.needsSync) return;
  S.needsSync = false;
  /* auto-advance / play-now: the server told us to roll */
  if (pendingAutoplay) {
    pendingAutoplay = false;
    P.remote(() => P.play(0));
    reportDuration();
    return;
  }
  reportDuration();
  // 1) immediately apply the DB snapshot (best guess)
  P.remote(() => P.seek(S.initialVideoState.currentTime));
  // 2) ask peers for the *live* position — overrides DB if someone answers
  sockEmit("video-sync-request");
  // 3) if nobody answers within 2 s, honour the DB isPlaying flag
  S.syncFallbackTimer = setTimeout(() => {
    if (S.initialVideoState.isPlaying) P.remote(() => P.play(S.initialVideoState.currentTime));
  }, 2000);
}
/* YouTube state-change: only external inputs get here as "manual" */
export function onYTState(e) {
  if (e.data === 0) return playerHooks.queueOnEnded();
  if (e.data === 2) flashInfoBar();
  if (e.data !== 1 && e.data !== 2) return;
  if (P.isRemote()) return;                                   // remote action still settling
  if (P._consumeAck(e.data === 1 ? "play" : "pause")) return; // echo of an explicit act()
  if (!S.perms.canSync) return revertToRoomState();
  /* genuinely unexpected (shouldn't happen with chrome off) — treat as manual */
  if (e.data === 1) { sockEmit("video-play",  { currentTime: P.time() }); markLocal(P.time(), true);  P.startLeader(); }
  else              { sockEmit("video-pause", { currentTime: P.time() }); markLocal(P.time(), false); P.stopLeader(); }
}
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
  const v = P.el;
  v.addEventListener("play", () => {
    if (P.isRemote()) return;
    if (P._consumeAck("play")) return;
    if (!S.perms.canSync) return revertToRoomState();         // media keys / PiP / extensions
    sockEmit("video-play", { currentTime: P.time() });
    markLocal(P.time(), true);
    P.startLeader();
  });
  v.addEventListener("pause", () => {
    if (P.isRemote()) return;
    if (P._consumeAck("pause")) return;
    if (!S.perms.canSync) return revertToRoomState();
    sockEmit("video-pause", { currentTime: P.time() });
    markLocal(P.time(), false);
    P.stopLeader();
  });
  /* 'seeked' no longer emits. All seeks originate from our own controls (the
     native chrome is off) and those broadcast immediately via P.act('seek').
     A late 'seeked' after a slow remote buffer was the #1 storm trigger. */
  v.addEventListener("ended", () => playerHooks.queueOnEnded());
}
export function emitSeek(t) {
  if (!S.perms.canSync || !getSocket()) return;
  sockEmit("video-seek", { currentTime: t });
  markLocal(t, !P.paused());
}
/* returns true if allowed; otherwise nudges the user */
export function guardSync() {
  if (S.perms.canSync) return true;
  toast("Playback is host-controlled — ask for access", "error");
  return false;
}
/* ⚠ REPLACES S.video with a fresh object (as it always did). Nothing caches S.video. */
export function markLocal(currentTime, isPlaying) { S.video = { currentTime, isPlaying, at: Date.now() }; }
export function expectedVideoState() {
  const v = S.video;
  let t = v.currentTime || 0;
  if (v.isPlaying && v.at) t += (Date.now() - v.at) / 1000;
  return { currentTime: t, isPlaying: !!v.isPlaying };
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
let sockWired = false;
onConnect(() => {
  if (sockWired) return;        // 'connect' also fires on reconnect — attach once
  sockWired = true;
  const socket = getSocket();
  /* server is the only source of loads now */
  socket.on("video-load", ({ url, itemId, play }) => {
    S.currentItemId = itemId || null;
    loadVideo(url, true, { play: !!play });
  });
  /* play/pause from a controller overrides any pending barrier */
  socket.on("video-play",  ({ currentTime }) => { cancelBarrier(); markLocal(currentTime, true);  P.remote(() => P.play(currentTime));  P.stopLeader(); });
  socket.on("video-pause", ({ currentTime }) => { cancelBarrier(); markLocal(currentTime, false); P.remote(() => P.pause(currentTime)); P.stopLeader(); });
  /* plain relay now only happens for PAUSED seeks (server decides) */
  socket.on("video-seek",  ({ currentTime }) => {
    if (barrier.active) return;
    markLocal(currentTime, !P.paused());
    P.remote(() => P.seek(currentTime));
  });
  /* ── the barrier itself ── */
  socket.on("video-seek-hold", ({ currentTime, seq }) => enterBarrier(seq, currentTime));
  socket.on("video-seek-go",   ({ currentTime, seq }) => {
    if (barrier.active && seq !== barrier.seq) return;    // stale go from an older barrier
    finishBarrier(currentTime);                           // also handles late-joiners who missed the hold
  });
  /* heartbeat: never drift-correct a player that's mid-barrier or mid-buffer —
   seeking a buffering player just restarts its buffering (this WAS the loop) */
  socket.on("video-time-sync", ({ currentTime }) => {
    if (barrier.active) return;
    markLocal(currentTime, true);
    if (P.paused() || P.isRemote() || P.buffering()) return;
    if (Math.abs(P.time() - currentTime) > DRIFT_THRESHOLD) P.remote(() => P.seek(currentTime));
  });
  /* late-joiner peer sync */
  socket.on("video-sync-request", ({ requesterId }) => {
    if (!P.ready) return;
    sockEmit("video-sync-response", {
      requesterId,
      currentTime: P.time(),
      isPlaying:  !P.paused(),
    });
  });
  socket.on("video-sync-state", ({ currentTime, isPlaying }) => {
    clearTimeout(S.syncFallbackTimer);
    markLocal(currentTime, isPlaying);
    if (!P.ready) return;
    P.remote(() => { P.seek(currentTime); if (isPlaying) P.play(currentTime); });
  });
});
/* phase 35: after queue reconcile (30, still in room.js) — same order as the
   original room-state body: Q.applyRemote(...) then loadVideo(...) */
onRoomState(({ room }) => {
  if (room.video && room.video.url) {
    S.currentItemId = room.video.itemId || null;
    S.initialVideoState = { currentTime: room.video.currentTime, isPlaying: room.video.isPlaying };
    S.needsSync = true;
    loadVideo(room.video.url, true);
  }
}, 35);