/* public/js/room.js — TRANSITIONAL.
 * Leaf concerns now live in config.js / svg.js / state.js / dom.js / utils.js.
 * Everything else is still in the IIFE below and will be extracted next. */
import {
  MODES, THEMES, THEME_STORAGE_KEY, AV_COLORS,
  REACTIONS, REACT_COOLDOWN, MAX_BUBBLES, RAIL_AUTO_CLOSE,
  SYNC_INTERVAL, DRIFT_THRESHOLD, REMOTE_COOLDOWN, SEEK_DEBOUNCE,
  GROUP_WINDOW, UPNEXT_AT, BADGE_CAP, ROOM_CAP,
  ROLE_LABEL, FIELD_LABEL, MOD_EVT, roomId,
} from "./room/config.js";
import {
  CHEV_SVG, STEP_UP, STEP_DN, SEC_CLOSE,
  playSVG, pauseSVG, bigPlay, bigPause, volSVG, mutedSVG,
  fsExpandSVG, fsCollapseSVG,
} from "./room/svg.js";
import { S } from "./room/state.js";
import { $, dom } from "./room/dom.js";
import {
  delay, esc, fmtTime, fmtMsgTs, avColor, fmtBadge, isMe,
  extractYT, fillSlider, safeHttpUrl, fmtJoined, toast,
} from "./room/utils.js";
import {
  resolveTod, initTheme, applyTheme, highlightActiveThemeOpt,
  setThemeMode, openThemeMenu, closeThemeMenu, wireTheme,
} from "./room/theme.js";
import { renderRoomDetails, toggleDetails, wireRoomDetails } from "./room/room-details.js";
import { getSocket, emit as sockEmit } from "./room/socket-ref.js";
import {
  connectSocket, leaveRoom, bounceToDashboard,
  onRoomState, onParticipantsUpdate, onUserJoined, onUserLeft,
} from "./room/socket-core.js";
import {
  Unread, SYS, addSystemMsg, appendMessage, sendMessage,
  loadInitialMessages, onChatScroll, buildMsgEl, regroupChat,
  showTopLoader, hideTopLoader, markStartReached,
  wireChatInput, wireChatUnread,
} from "./room/chat.js";

(function () {
  "use strict";

  let lastReactAt   = 0;
  let railCloseTmr  = null;
  
  /* ═══════ DOM ═══════ */
  const dom = {
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
  /* ═══════════════════════════════════════════
     ROOM STATE / PERMISSIONS / CONFIG
     ═══════════════════════════════════════════ */
  /**
   * Opens a collapsible section.
   * @param {string}  id                 stored key in S.cfgCollapsed
   * @param {string}  titleHTML          inner HTML for the <h4> (before the chevron)
   * @param {boolean} [defaultClosed]    initial state when no user toggle yet
   * @param {string}  [extraAttrs]       additional HTML attributes for the <section>
   */
  function secOpen(id, titleHTML, defaultClosed, extraAttrs) {
    const closed = S.cfgCollapsed[id] !== undefined
      ? S.cfgCollapsed[id]
      : !!defaultClosed;
    return '<section class="cfg-sec' + (closed ? " collapsed" : "") + '"' +
      ' data-collapsible data-sec-id="' + id + '"' +
      (extraAttrs ? " " + extraAttrs : "") + ">" +
      '<h4 class="cfg-sec-head">' + titleHTML +
        '<span class="cfg-chev">' + CHEV_SVG + "</span></h4>" +
      '<div class="cfg-sec-body"><div class="cfg-sec-inner">';
  }

  /* ═══════════════════════════════════════════
     PLAYER ABSTRACTION  (direct <video> + YT)
     ═══════════════════════════════════════════ */
  const P = {
    type: null,   // 'direct' | 'youtube'
    el: null,     // HTMLVideoElement
    yt: null,     // YT.Player
    ready: false,
    _rc: 0,       // remote-action counter
    _syncInt: null,
    _ytPoll: null,
    _ytLast: 0,
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
    /* ── actions ── */
    play(t) {
      if (this.type === "youtube" && this.yt) {
        if (t != null) this.yt.seekTo(t, true);
        this.yt.playVideo();
      } else if (this.el) {
        if (t != null) this.el.currentTime = t;
        this.el.play().catch(() => {});
      }
    },
    pause(t) {
      if (this.type === "youtube" && this.yt) {
        this.yt.pauseVideo();
        if (t != null) this.yt.seekTo(t, true);
      } else if (this.el) {
        this.el.pause();
        if (t != null) this.el.currentTime = t;
      }
    },
    seek(t) {
      if (this.type === "youtube" && this.yt) this.yt.seekTo(t, true);
      else if (this.el) this.el.currentTime = t;
    },
    /* ── remote-action guard ── */
    remote(fn) {
      this._rc++;
      fn();
      setTimeout(() => (this._rc = Math.max(0, this._rc - 1)), REMOTE_COOLDOWN);
    },
    isRemote() { return this._rc > 0; },
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
        if (!S.perms.canSync) return;                       // only controllers drive the clock
        if (!this.paused()) sockEmit("video-time-sync", { currentTime: this.time() });
      }, SYNC_INTERVAL);
    },
    stopLeader() { clearInterval(this._syncInt); },
    /* ── YT seek-detection poll (no native seeked event) ── */
    startYTPoll() {
      clearInterval(this._ytPoll);
      this._ytLast = this.time();
      this._ytPoll = setInterval(() => {
        if (!this.yt || !this.ready || this.isRemote()) return;
        const now = this.time();
        // if time jumped more than ±2 s in a single 500 ms tick → user seeked
        if (Math.abs(now - this._ytLast) > 2 && !this.paused())
          sockEmit("video-seek", { currentTime: now });
        this._ytLast = now;
      }, 500);
    },
    stopYTPoll() { clearInterval(this._ytPoll); },
    /* ── cleanup ── */
    destroy() {
      this.stopLeader();
      this.stopYTPoll();
      if (this.type === "youtube" && this.yt) try { this.yt.destroy(); } catch (_) {}
      this.yt = null; this.el = null;
      this.type = null; this.ready = false; this._rc = 0;
    },
  };
  let volDragging = false;
  function isSilent() { return P.isMuted() || P.vol() === 0; }
  function syncVolumeUI() {
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
  function loadYTAPI() {
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
  /* ═══════ INIT ═══════ */
  document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    wireEvents();
    await fetchMe();
    connectSocket();
    wireFeatureSockets();
  });
  /* ═══════ EVENT WIRING ═══════ */
  function wireEvents() {
    $("backBtn").onclick  = leaveRoom;
    $("leaveBtn").onclick = leaveRoom;
    dom.container.addEventListener("touchstart", () => {
      dom.controls.classList.add("show");
      clearTimeout(dom.controls._t);
      dom.controls._t = setTimeout(() => dom.controls.classList.remove("show"), 3000);
    });
    /* collapsible room details — click anywhere on the card toggles */
    wireRoomDetails();
    /* theme dropdown */
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
    dom.configBtn.onclick = openConfig;
    $("cfgClose").onclick = closeConfig;
    dom.cfgBackdrop.onclick = closeConfig;

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
  /* ══════════════════════════════════════
     SOCKET — feature listeners still living in room.js.
     Registered once, right after socket-core has created the instance.
     Centralized lifecycle events (connect / connect_error / room-state /
     room-error / participants-update / room-kicked / user-joined /
     user-left) now live in socket-core.js and reach us via subscriptions.
     ══════════════════════════════════════ */
  function wireFeatureSockets() {
    const socket = getSocket();
    socket.on("queue-update", (p) => Q.applyRemote(p));
    socket.on("queue-ended", () => {
      Q.resetUpNext();
      addSystemMsg("Queue finished 🎉");
      toast("Queue finished 🎉", "success");
    });
    /* ── permissions ── */
    socket.on("room-permissions", ({ perms, members, requests, banned }) => {
      S.perms    = perms;
      S.members  = members  || [];
      S.requests = requests || [];
      S.banned   = banned   || [];
      if (S.cfgRowMenu && !S.members.some((m) => m.userId === S.cfgRowMenu.id)) S.cfgRowMenu = null;
      applyPerms();
      refreshPanels();
    });
    socket.on("room-saved", ({ room }) => {               // my own save came back
      S.room = Object.assign({}, S.room, room);
      S.roomDraft = null;
      S.roomConflict = null;
      renderRoomDetails();
      refreshPanels();
    });
    socket.on("room-updated", ({ room, by, changed }) => applyIncomingRoom(room, by, changed));
    socket.on("perm-denied", ({ message, video }) => {
      toast(message || "Not allowed", "error");
      if (video) { markLocal(video.currentTime, video.isPlaying); revertToRoomState(video); }
    });
    socket.on("perm-toast", ({ message, type }) => toast(message, type));
    socket.on("perm-notice", ({ text, byId }) => addSystemMsg(text, { silent: isMe(byId) }));
    socket.on("perm-request", ({ userId, username, scope }) => showRequestPrompt(userId, username, scope || "sync"));
    /* server is the only source of loads now */
    socket.on("video-load", ({ url, itemId, play }) => {
      S.currentItemId = itemId || null;
      loadVideo(url, true, { play: !!play });
    });
    socket.on("video-play",  ({ currentTime }) => { markLocal(currentTime, true);  P.remote(() => P.play(currentTime));  P.stopLeader(); });
    socket.on("video-pause", ({ currentTime }) => { markLocal(currentTime, false); P.remote(() => P.pause(currentTime)); P.stopLeader(); });
    socket.on("video-seek",  ({ currentTime }) => { markLocal(currentTime, !P.paused()); P.remote(() => P.seek(currentTime)); });
    socket.on("video-time-sync", ({ currentTime }) => {
      markLocal(currentTime, true);
      if (P.paused() || P.isRemote()) return;
      if (Math.abs(P.time() - currentTime) > DRIFT_THRESHOLD) P.remote(() => P.seek(currentTime));
    });
    /* late-joiner peer sync */
    socket.on("video-sync-request", ({ requesterId }) => {
      if (!P.ready) return;
      socket.emit("video-sync-response", {
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
    /* ── live reactions ── */
    socket.on("video-reaction", ({ emoji, userId, username }) => {
      if (userId && S.userId && userId.toString() === S.userId) return; // already rendered locally
      spawnReaction(emoji, username);
    });
  }
  /* ── subscriptions to the centralized lifecycle events ──
     Registration order == the order the original room-state handler body ran in.
     When these bodies move into their own modules (Steps 4-7) each module
     registers its own slice here-equivalent call; keep this order. */
  onRoomState(async ({ room }) => {
    applyPerms();
    renderRoomDetails();
    if (room.queue) Q.applyRemote(room.queue);
    if (room.video && room.video.url) {
      S.currentItemId = room.video.itemId || null;
      S.initialVideoState = { currentTime: room.video.currentTime, isPlaying: room.video.isPlaying };
      S.needsSync = true;
      loadVideo(room.video.url, true);
    }
  });
  onParticipantsUpdate(() => {
    if (isConfigOpen()) { refreshMaxHint(); syncDirtyUI(); }
  });

  /* ══════════════════════════════════
   YT LETTERBOX/CROP — frontend only
   ══════════════════════════════════ */
  const ytLetterbox = (() => {
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
  async function fetchYTMeta(videoId) {
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
  async function showVideoInfo(ytId) {
    const meta = await fetchYTMeta(ytId);
    if (meta.aspect) ytLetterbox.setAspect(meta.aspect);       // replaces old auto-detect
    setChannelAvatar(meta.author, meta.authorUrl);
    $("viTitle").textContent  = meta.title  || "YouTube video";
    $("viAuthor").textContent = meta.author || "";
    $("viBar").style.display = "";
    flashInfoBar(4000);
  }
  function setChannelAvatar(author, authorUrl) {
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
  function flashInfoBar(ms = 3000) {
    const bar = $("viBar");
    if (!bar || bar.style.display === "none") return;
    bar.classList.add("show");
    clearTimeout(flashInfoBar._t);
    flashInfoBar._t = setTimeout(() => bar.classList.remove("show"), ms);
  }

  /* ═══════ SETTINGS MENU — informative only (YouTube) ═══════ */
  const settingsUI = (() => {
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

/* ═══════════════════════════════════════════
     QUEUE  —  playlist + auto-advance + up-next
     ═══════════════════════════════════════════
     Local-first: every mutation updates state, re-renders, then fires a
     socket emit (BACKEND HOOK). Server should answer with `queue-update`
     carrying the authoritative list → applyRemote() reconciles.
     ═══════════════════════════════════════════ */
  const Q = (() => {
    /* items[i] = { id, url, type:'youtube'|'direct', videoId, title, author,
                    thumb, duration, addedBy } ; index = currently playing */
    const st = (S.queue = { items: [], index: -1 });
    let dragId = null, autoplay = true;
    let unVisible = false, unCancelled = false;
    /* Host + moderators. Server should ideally expose a dedicated `canQueue`
       permission; until then reuse the two flags already shipped. */
    const canManage = () => !!S.perms.canQueue;
    function playId(id) {
      if (!canManage()) return toast("You don't have queue control", "error");
      emit("queue-play", { id });
    }
    /* ── queries ────────────────────────────────────────── */
    const hasNext = () => st.index >= -1 && st.index + 1 < st.items.length;
    const hasPrev = () => st.index > 0;
    const peekNext = () => (hasNext() ? st.items[st.index + 1] : null);
    const find = (id) => st.items.findIndex((i) => i.id === id);
    /* ── mutations ──────────────────────────────────────── */
    function add(url) {
      if (!url) return toast("Enter a URL", "error");
      if (!canManage()) return toast("You don't have queue control", "error");
      emit("queue-add", { url });                      // server resolves metadata + echoes queue-update
    }
    const remove = (id)     => canManage() && emit("queue-remove", { id });
    const move   = (id, to) => canManage() && emit("queue-move", { id, to });
    const clear  = ()       => canManage() && emit("queue-clear", {});
    /* ── playback ───────────────────────────────────────── */
    const playIndex = (i) => st.items[i] && playId(st.items[i].id);
    const next = () => hasNext() && playIndex(st.index + 1);
    const prev = () => hasPrev() && playIndex(st.index - 1);
    /* video finished → tell the server; IT decides what plays next (single authority) */
    function onEnded() {
      hideUpNext();
      sockEmit("video-ended", { itemId: S.currentItemId });
    }

    /* ── UP NEXT card ───────────────────────────────────── */
    function tick(t, d) {
      const nxt = peekNext();
      const rem = d > 0 && isFinite(d) ? d - t : Infinity;
      if (!nxt || !autoplay) return hideUpNext();
      if (rem > UPNEXT_AT + 0.5) { unCancelled = false; return hideUpNext(); }   // user seeked back
      if (unCancelled || P.paused() || rem <= 0.25) return hideUpNext();
      showUpNext(nxt, rem);
    }
    function showUpNext(item, rem) {
      const card = $("upNext");
      if (!unVisible) {
        $("unTitle").textContent = item.title;
        $("unSub").textContent   = item.author || "";
        const img = $("unThumb");
        img.style.display = item.thumb ? "" : "none";
        if (item.thumb) img.src = item.thumb;
        card.hidden = false; unVisible = true;
      }
      $("unCount").textContent = Math.max(0, Math.ceil(rem)) + "s";
      $("unRing").style.setProperty("--p", Math.min(100, (1 - rem / UPNEXT_AT) * 100).toFixed(0) + "%");
    }
    function hideUpNext() { if (unVisible) { $("upNext").hidden = true; unVisible = false; } }
    function resetUpNext() { hideUpNext(); unCancelled = false; }
    /* ── render ─────────────────────────────────────────── */
    const ICON = {
      play:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
      up:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="18 15 12 9 6 15"/></svg>',
      down:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>',
      remove: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    };
    function render() {
      const manage = canManage();
      const list = $("queueList");
      /* badge + empty state */
      const upcoming = Math.max(0, st.items.length - (st.index + 1));
      const badge = $("queueCount");
      badge.textContent   = fmtBadge(upcoming);                  // ← 11+ → "10+"
      badge.dataset.zero  = upcoming ? "0" : "1";
      badge.title = upcoming === 1 ? "1 video up next"
                                   : upcoming + " videos up next";
      $("queueEmpty").hidden = st.items.length > 0;
      $("queueClearBtn").disabled = !manage || st.items.length === 0;
      $("queueBar").hidden = !manage;
      $("queueLock").hidden = manage;
      $("qAutoplay").disabled = !manage;
      if (st.items.length === 0 && manage && !S.videoLoaded) {
        $("queueEmpty").querySelector(".q-empty-s").textContent =
          "Paste a URL below — the first video starts right away";
      }
      list.innerHTML = st.items.map((it, i) => {
        const playing = i === st.index;
        const cls = ["q-item", manage ? "can-manage" : "",
                     playing ? "playing" : (i < st.index ? "played" : "")].join(" ");
        const thumb = it.thumb
          ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy">'
          : "🎞️";
        const now = playing ? '<span class="q-now"><span class="q-eq"><i></i><i></i><i></i></span></span>' : "";
        const dur = it.duration ? '<span class="q-dur">' + fmtTime(it.duration) + "</span>" : "";
        const sub = [it.author, it.addedByName].filter(Boolean).map(esc).join(" · ");
        return (
          '<li class="' + cls + '" data-id="' + it.id + '"' + (manage ? ' draggable="true"' : "") + ">" +
            '<span class="q-grip" aria-hidden="true">⠿</span>' +
            '<div class="q-thumb">' + thumb + dur + now + "</div>" +
            '<div class="q-meta">' +
              '<div class="q-title" title="' + esc(it.title) + '">' + esc(it.title) + "</div>" +
              '<div class="q-sub">' + sub + "</div>" +
            "</div>" +
            '<div class="q-actions">' +
              '<button class="q-act" data-act="play"   title="Play now">'  + ICON.play   + "</button>" +
              '<button class="q-act" data-act="up"     title="Move up"'    + (i === 0 ? " disabled" : "") + ">" + ICON.up + "</button>" +
              '<button class="q-act" data-act="down"   title="Move down"'  + (i === st.items.length - 1 ? " disabled" : "") + ">" + ICON.down + "</button>" +
              '<button class="q-act" data-act="remove" title="Remove">'    + ICON.remove + "</button>" +
            "</div>" +
          "</li>"
        );
      }).join("");
      refreshNav();
    }
    /* prev/next enabled state in the control bar */
    function refreshNav() {
      const manage = canManage();
      const noPrev = !manage || !hasPrev(), noNext = !manage || !hasNext();
      $("prevBtn").disabled  = noPrev;  $("nextBtn").disabled  = noNext;
      $("cPrevBtn").disabled = noPrev;  $("cNextBtn").disabled = noNext;
    }
    /* ── remote reconcile (call from socket `queue-update`) ── */
    function applyRemote(p) {
      if (!p || !Array.isArray(p.items)) return;
      st.items = p.items;
      st.index = typeof p.index === "number" ? p.index : -1;
      if (typeof p.autoplay === "boolean") {
        autoplay = p.autoplay;
        const cb = $("qAutoplay");
        if (cb) cb.checked = autoplay;
      }
      resetUpNext(); render();
    }
    function emit(ev, data) { sockEmit(ev, data); }
    /* ── wiring ─────────────────────────────────────────── */
    function wire() {
      /* tabs */
      [dom.tabChat, dom.tabQueue].forEach((b) =>
        b.addEventListener("click", () => switchTab(b.dataset.tab))
      );
      /* add */
      $("queueAddBtn").onclick = () => {
        const v = $("queueInput").value.trim();
        if (v) { add(v); $("queueInput").value = ""; }
      };
      $("queueInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("queueAddBtn").click();
      });
      $("queueClearBtn").onclick = clear;
      $("qAutoplay").onchange = (e) => {
        if (!canManage()) { e.target.checked = autoplay; return toast("You don't have queue control", "error"); }
        emit("queue-autoplay", { on: e.target.checked });
      };
      /* row actions (delegated) */
      $("queueList").addEventListener("click", (e) => {
        const btn = e.target.closest(".q-act"); if (!btn) return;
        const id = e.target.closest(".q-item").dataset.id;
        const i  = find(id); if (i < 0) return;
        const act = btn.dataset.act;
        if (act === "play")   playIndex(i);
        if (act === "remove") remove(id);
        if (act === "up")     move(id, i - 1);
        if (act === "down")   move(id, i + 1);
      });
      /* drag & drop reorder */
      const list = $("queueList");
      list.addEventListener("dragstart", (e) => {
        const li = e.target.closest(".q-item"); if (!li || !canManage()) return;
        dragId = li.dataset.id; li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      list.addEventListener("dragend", () => {
        dragId = null;
        list.querySelectorAll(".q-item").forEach((n) => n.classList.remove("dragging", "drag-over"));
      });
      list.addEventListener("dragover", (e) => {
        if (!dragId) return;
        e.preventDefault();
        const li = e.target.closest(".q-item"); if (!li) return;
        list.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
        li.classList.add("drag-over");
      });
      list.addEventListener("drop", (e) => {
        if (!dragId) return;
        e.preventDefault();
        const li = e.target.closest(".q-item"); if (!li) return;
        move(dragId, find(li.dataset.id));
      });
      /* transport */
      $("prevBtn").onclick = prev;
      $("nextBtn").onclick = next;
      /* center transport (previous/next video buttons) */
      $("cPrevBtn").onclick = prev;
      $("cNextBtn").onclick = next;
      /* up-next card */
      const cancel = () => { unCancelled = true; hideUpNext(); };
      $("unCancel").onclick    = cancel;
      $("unCancelBtn").onclick = cancel;
      $("unNowBtn").onclick = () => { hideUpNext(); next(); };
      /* N / P shortcuts */
      document.addEventListener("keydown", (e) => {
        const t = e.target;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (e.key === "n" || e.key === "N") next();
        if (e.key === "p" || e.key === "P") prev();
      });
      render();
    }
    function switchTab(which) {
      const chat = which === "chat";
      dom.tabChat.classList.toggle("active", chat);
      dom.tabQueue.classList.toggle("active", !chat);
      dom.tabChat.setAttribute("aria-selected", String(chat));
      dom.tabQueue.setAttribute("aria-selected", String(!chat));
      dom.paneChat.classList.toggle("active", chat);
      dom.paneQueue.classList.toggle("active", !chat);
      if (chat) Unread.onChatShown();
    }
    return { wire, add, render, refreshNav, applyRemote,
             onEnded, tick, resetUpNext, next, prev, hasNext, hasPrev, canManage };
  })();

  /* ══════════════════════════════════
     VIDEO — load / controls / sync
     ══════════════════════════════════ */
  let pendingAutoplay = false;
  
  async function loadVideo(url, fromRemote, opts) {
    opts = opts || {};
    if (!url) return;
    P.destroy();
    ytLetterbox.detach();
    settingsUI.reset();
    volDragging = false;
    Q.resetUpNext();
    $("viBar").style.display = "none";
    if (dom.fxLayer) dom.fxLayer.innerHTML = "";
    pendingAutoplay = !!opts.play;              // ← new: remember whether to auto-start

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
    Q.render();
  }

  function reportDuration() {
    if (!getSocket() || !S.currentItemId || !S.perms.canSync) return;
    const tryIt = () => {
      const d = P.dur();
      if (d > 0) sockEmit("queue-duration", { id: S.currentItemId, duration: d });
      else setTimeout(tryIt, 700);
    };
    setTimeout(tryIt, 400);
  }

  /* Called once when the player is ready to accept commands */
  function onPlayerReady() {
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
  /* YouTube state-change → emit play / pause */
  function onYTState(e) {
    if (e.data === 0) return Q.onEnded();            // ENDED
    if (e.data === 2) flashInfoBar();                   // show title card on pause
    if (P.isRemote()) return;
    if (e.data !== 1 && e.data !== 2) return;
    if (!S.perms.canSync) return revertToRoomState();        // defensive (chrome is off)
    if (e.data === 1) { sockEmit("video-play",  { currentTime: P.time() }); markLocal(P.time(), true);  P.startLeader(); }
    else              { sockEmit("video-pause", { currentTime: P.time() }); markLocal(P.time(), false); P.stopLeader(); }
  }

  /* ═══════ PLAYER CONTROLS (both player types, permission-gated) ═══════ */
  let uiTick = null, progDragging = false, seekTimer = null;
  function startUITicker() { clearInterval(uiTick); uiTick = setInterval(updateProgressUI, 250); }
  function updateProgressUI() {
    if (!P.ready) return;
    const prog = $("progressBar"), t = P.time() || 0, d = P.dur() || 0;
    if (!progDragging) {
      prog.max = Math.max(1, Math.floor(d * 100));
      prog.value = Math.floor(t * 100);
      fillSlider(prog, prog.value, prog.max);
      $("curTime").textContent = fmtTime(t);
    }
    syncVolumeUI();   // YT can mute itself (autoplay policy, ads, etc.)
    $("durTime").textContent = fmtTime(d);
    $("playBtn").innerHTML = P.paused() ? playSVG : pauseSVG;
    $("cPlayBtn").innerHTML = P.paused() ? bigPlay : bigPause;
    Q.tick(t, d);
  }
  function wirePlayerControls() {
    const prog = $("progressBar"), volBar = $("volBar");
    $("playBtn").onclick = () => { if (guardSync()) P.toggle(); };
    if (P.type !== "youtube") $("cPlayBtn").innerHTML = P.paused() ? bigPlay : bigPause;
    dom.shield.addEventListener("click", () => { if (guardSync()) P.toggle(); });
    dom.vcLock.onclick = (e) => { e.stopPropagation(); openConfig(); };
    prog.addEventListener("input", () => {
      if (!S.perms.canSync) return;
      progDragging = true;
      const t = prog.value / 100;
      $("curTime").textContent = fmtTime(t);
      fillSlider(prog, prog.value, prog.max);
      if (P.type === "direct") P.seek(t);                   // live scrub
    });
    prog.addEventListener("change", () => {
      progDragging = false;
      if (!S.perms.canSync) { updateProgressUI(); return; }
      const t = prog.value / 100;
      P.seek(t);
      if (P.type === "youtube") emitSeek(t);                // direct emits via its "seeked" event
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
      if (k === " " || k === "k")       { e.preventDefault(); if (guardSync()) P.toggle(); }
      else if (k === "arrowright")      { if (guardSync()) { const t2 = P.time() + 5; P.seek(t2); emitSeek(t2); } }
      else if (k === "arrowleft")       { if (guardSync()) { const t2 = Math.max(0, P.time() - 5); P.seek(t2); emitSeek(t2); } }
      else if (k === "m") { P.setMuted(!isSilent()); syncVolumeUI(); }
    });
  }
  /* element-level listeners for the direct <video> (fresh element each load) */
  function wireDirectVideoEvents() {
    const v = P.el;
    v.addEventListener("play", () => {
      if (P.isRemote()) return;
      if (!S.perms.canSync) return revertToRoomState();     // media keys / PiP / extensions
      sockEmit("video-play", { currentTime: P.time() });
      markLocal(P.time(), true);
      P.startLeader();
    });
    v.addEventListener("pause", () => {
      if (P.isRemote()) return;
      if (!S.perms.canSync) return revertToRoomState();
      sockEmit("video-pause", { currentTime: P.time() });
      markLocal(P.time(), false);
      P.stopLeader();
    });
    v.addEventListener("seeked", () => {
      if (P.isRemote() || !S.perms.canSync) return;
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => emitSeek(P.time()), SEEK_DEBOUNCE);
    });
    v.addEventListener("ended", () => Q.onEnded());
  }
  function emitSeek(t) {
    if (!S.perms.canSync || !getSocket()) return;
    sockEmit("video-seek", { currentTime: t });
    markLocal(t, !P.paused());
  }
  /* returns true if allowed; otherwise nudges the user */
  function guardSync() {
    if (S.perms.canSync) return true;
    toast("Playback is host-controlled — ask for access", "error");
    return false;
  }
  function markLocal(currentTime, isPlaying) { S.video = { currentTime, isPlaying, at: Date.now() }; }
  function expectedVideoState() {
    const v = S.video;
    let t = v.currentTime || 0;
    if (v.isPlaying && v.at) t += (Date.now() - v.at) / 1000;
    return { currentTime: t, isPlaying: !!v.isPlaying };
  }
  /* snap a rule-breaker back to the room's authoritative state */
  function revertToRoomState(state) {
    const v = state || expectedVideoState();
    P.remote(() => { P.seek(v.currentTime); v.isPlaying ? P.play(v.currentTime) : P.pause(v.currentTime); });
  }

  /* ══════════════════════════════════════
     LIVE REACTIONS
     ══════════════════════════════════════ */
  function wireReactions() {
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
  function popBtn(btn) {
    if (!btn) return;
    btn.classList.remove("pop");
    void btn.offsetWidth;            // force reflow → replay animation
    btn.classList.add("pop");
  }
  function openRail() {
    dom.reactRail.classList.add("open");
    dom.reactToggle.setAttribute("aria-expanded", "true");
    clearTimeout(railCloseTmr);
    railCloseTmr = setTimeout(closeRail, RAIL_AUTO_CLOSE);
  }
  function closeRail() {
    clearTimeout(railCloseTmr);
    dom.reactRail.classList.remove("open");
    dom.reactToggle.setAttribute("aria-expanded", "false");
  }
  /* send: optimistic local render + emit */
  function sendReaction(emoji) {
    if (REACTIONS.indexOf(emoji) === -1) return;
    const now = Date.now();
    if (now - lastReactAt < REACT_COOLDOWN) return;   // client-side throttle
    lastReactAt = now;
    spawnReaction(emoji, S.username);
    sockEmit("video-reaction", { emoji });
  }
  /* render one floating bubble */
  function spawnReaction(emoji, username) {
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

   /* ═══════ FULLSCREEN (always on the dom container, never the YT iframe) ═══════ */
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function exitFs() { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); }
  function toggleFullscreen() {
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
  function setPseudoFs(on) {
    dom.container.classList.toggle("pseudo-fs", on);
    dom.container.classList.toggle("is-fs", on);
    document.body.style.overflow = on ? "hidden" : "";
    setFsIcon(on);
    if (!on) closeRail();
  }
  function onFullscreenChange() {
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
    if (!isFs) closeRail();
  }
  function setFsIcon(isFs) {
    const svg = isFs ? fsCollapseSVG : fsExpandSVG;
    const vcFs = $("fsBtn");
    if (vcFs) vcFs.innerHTML = svg;
  }
  /* ══════════════════════════════════════
     PERMISSIONS UI + ROOM CONFIG SHEET
     ══════════════════════════════════════ */

  const participantsHere = () => ((S.room && S.room.participants) || []).length;
  const participantFloor = () => Math.max(2, participantsHere());
  /* first blocking problem with the room-details form, or null */
  function roomFormError() {
    if (!$("cfgMax")) return null;
    const v = readRoomForm();
    const name = String(v.roomName || "").trim();
    if (name.length < 3)  return { id: "cfgName", msg: "Room name needs at least 3 characters" };
    if (name.length > 60) return { id: "cfgName", msg: "Room name can be 60 characters at most" };
    const here = participantsHere();
    const n = Number(v.maxParticipants);
    if (!Number.isInteger(n)) return { id: "cfgMax", msg: "Max participants must be a whole number" };
    if (n > ROOM_CAP)         return { id: "cfgMax", msg: `Rooms can't hold more than ${ROOM_CAP} people` };
    if (n < 2)               return { id: "cfgMax", msg: "Rooms need space for at least 2 people" };
    if (n < here)            return { id: "cfgMax",
      msg: `${here} ${here === 1 ? "person is" : "people are"} here right now — remove someone first` };
    return null;
  }

  function applyPerms() {
    const p = S.perms;
    dom.container.classList.toggle("locked", !p.canSync);
    $("playBtn").disabled     = !p.canSync;
    $("progressBar").disabled = !p.canSync;
    dom.vcLock.style.display  = p.canSync ? "none" : "";
    const n = (p.canGrantSync || p.canGrantQueue) ? S.requests.length : 0;
    dom.gearBadge.classList.toggle("is-hidden", n === 0);
    dom.gearBadge.textContent = n;
    if (!p.canSync) P.stopLeader();
    Q.render();
  }
  // Check if the config sheet is open
  const isConfigOpen = () => dom.cfgSheet.classList.contains("open");
  function openConfig() {
    renderConfig();
    dom.cfgSheet.classList.add("open");
    dom.cfgBackdrop.classList.add("open");
    dom.cfgSheet.setAttribute("aria-hidden", "false");
  }
  function closeConfig() {
    S.roomDraft = null;
    S.roomConflict = null;
    dom.cfgSheet.classList.remove("open");
    dom.cfgBackdrop.classList.remove("open");
    dom.cfgSheet.setAttribute("aria-hidden", "true");
  }
  /* one access row + its request affordance */
  function accessRow(label, granted, state, scope, openToAll) {
    let h = '<div class="cfg-row"><span>' + label + "</span>" +
      '<span class="pill ' + (granted ? "pill-ok" : "pill-no") + '">' +
      (granted ? (openToAll ? "Everyone" : "Allowed") : "Host-controlled") + "</span></div>";
    if (granted || !scope) return h;
    if (state === "pending")     h += '<p class="cfg-note">⏳ Request sent — waiting for a host or mod.</p>';
    else if (state === "denied") h += '<p class="cfg-note">🚫 Declined. A host or mod can still grant it.</p>';
    else h += '<button class="cfg-btn primary" data-act="request" data-scope="' + scope + '">Request ' +
              label.toLowerCase() + "</button>";
    return h;
  }
  function renderConfig() {
    const p = S.perms, r = S.room || {};
    const online = new Set((r.participants || []).map((x) => (x.userId || "").toString()));
    const host = !!p.isAdmin, mod = !!p.isMod;
    let h = "";
    /* ── your access (non-host) ── */
    if (!host) {
      h += secOpen("access", "Your access");
      if (mod) {
        h += '<div class="cfg-banner"><span class="role-tag role-mod">🛡️ MOD</span>' +
             "<span>You're a moderator of this room</span></div>" +
             accessRow("Playback control", true, null, null) +
             accessRow("Queue control",    true, null, null) +
             '<p class="cfg-note">You can edit the room, manage the queue and grant ' +
             "control to others. Only the host can change roles.</p>";
      } else {
        h += accessRow("Playback control", p.canSync,  p.requestState,      "sync",
                       p.syncMode  === "everyone");
        h += accessRow("Queue control",    p.canQueue, p.queueRequestState, "queue",
                       p.queueMode === "everyone");
      }
      h += SEC_CLOSE;
    }
    /* ── sync mode (host + mods) ── */
    if (p.canGrantSync) {
      h += secOpen("sync", "Who can play / pause / seek");
      h += '<div class="seg">' +
              '<button class="seg-btn' + (p.syncMode === "host" ? " on" : "") +
                '" data-act="mode" data-mode="host">🔒 Host only</button>' +
              '<button class="seg-btn' + (p.syncMode === "everyone" ? " on" : "") +
                '" data-act="mode" data-mode="everyone">👥 Everyone</button>' +
            "</div>" +
            '<p class="cfg-note">' +
              (host ? "Only you can change the video, regardless of this setting."
                    : "Only the host can change the video, regardless of this setting.") +
            "</p>" + SEC_CLOSE;
      /* ── pending requests ── */
      if (S.requests.length) {
        h += secOpen("requests", 'Requests <span class="cnt">' + S.requests.length + "</span>");
        S.requests.forEach((m) => {
          const lbl = m.scope === "queue" ? "queue" : "playback";
          h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(m.username) +
                 '<span class="cfg-uname">' + esc(m.username) + "</span>" +
                 '<span class="scope-tag scope-' + lbl + '">' + lbl + "</span></span>" +
               '<span class="cfg-acts">' +
                 '<button class="cfg-mini ok"  data-act="respond" data-approve="1" data-scope="' + m.scope + '" data-id="' + m.userId + '">Approve</button>' +
                 '<button class="cfg-mini no" data-act="respond" data-approve="0" data-scope="' + m.scope + '" data-id="' + m.userId + '">Deny</button>' +
               "</span></div>";
        });
        h += SEC_CLOSE;
      }
    }
    // ── queue mode (host + mods) ──
    if (p.canGrantQueue) {
      h += secOpen("queuemode", "Who can manage the queue");
      h += '<div class="seg">' +
             '<button class="seg-btn' + (p.queueMode === "host" ? " on" : "") +
               '" data-act="qmode" data-mode="host">🔒 Host &amp; mods</button>' +
             '<button class="seg-btn' + (p.queueMode === "everyone" ? " on" : "") +
               '" data-act="qmode" data-mode="everyone">👥 Everyone</button>' +
           "</div>" +
           '<p class="cfg-note">Controls adding, removing, reordering and skipping videos.</p>' + SEC_CLOSE;
    }
    /* ── people (host + mods) ── */
    if (p.canManage) {
      h += secOpen(
        "people",
        'People <span class="cnt">' + S.members.length + "</span>",
        S.members.length > 8          // auto-collapse when the list is long
      );
      S.members.forEach((m) => {
        const isHostRow = m.role === "admin";
        const isModRow  = m.role === "mod";
        const locked = isHostRow || isModRow || p.syncMode === "everyone" || !p.canGrantSync;
        const showRoleSelect = p.canSetRoles && !isHostRow;
        const menuOpen = !!(S.cfgRowMenu && S.cfgRowMenu.id === m.userId);
        const canAct   = !!p.canBan && !isHostRow;
        const syncLocked  = isHostRow || isModRow || p.syncMode  === "everyone" || !p.canGrantSync;
        const queueLocked = isHostRow || isModRow || p.queueMode === "everyone" || !p.canGrantQueue;
        h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(m.username) +
                '<span class="cfg-uname">' + esc(m.username) +
                  (online.has(m.userId) ? '<i class="dot-on" title="In room"></i>' : "") +
                "</span>" +
                '<span class="role-tag role-' + m.role + '">' + ROLE_LABEL[m.role] + "</span>" +
              "</span>" +
              '<span class="cfg-acts">' +
                (showRoleSelect
                  ? '<select class="cfg-sel" data-act="role" data-id="' + m.userId + '">' +
                      '<option value="member"' + (m.role === "member" ? " selected" : "") + ">Member</option>" +
                      '<option value="mod"'    + (isModRow ? " selected" : "") + ">Mod</option>" +
                    "</select>"
                  : "") +
                swHTML("sync",  m.userId, m.canSync,  syncLocked,  "Can play / pause / seek") +    // ← replaces the old <label>
                swHTML("queue", m.userId, m.canQueue, queueLocked, "Can manage the queue") +        // ← new
              (canAct
                ? '<button class="cfg-more' + (menuOpen ? " on" : "") + '" data-act="row-menu" ' +
                    'data-id="' + m.userId + '" aria-expanded="' + menuOpen + '" ' +
                    'title="More actions" aria-label="More actions for ' + esc(m.username) + '">⋯</button>'
                : "") +
            "</span></div>";
        if (canAct && menuOpen) h += rowMenuHTML(m, online.has(m.userId));
      });
      h += '<p class="cfg-note">Hosts and mods get playback control automatically.' +
            (p.canSetRoles
              ? " Mods can edit room details and grant playback control, but can't change roles."
              : " Only the host can change roles.") +
            "</p>" + SEC_CLOSE;
    }
    /* ── banned (host only) ── */
    if (p.canBan && S.banned.length) {
      h += secOpen("banned", 'Banned <span class="cnt">' + S.banned.length + "</span>", true);
      S.banned.forEach((b) => {
        h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(b.username) +
               '<span class="cfg-uname">' + esc(b.username) + "</span></span>" +
             '<span class="cfg-acts">' +
               '<button class="cfg-mini ok" data-act="unban" data-id="' + b.userId + '">Unban</button>' +
             "</span></div>" +
             (b.reason ? '<p class="cfg-note" style="margin-top:0">"' + esc(b.reason) + "\"</p>" : "");
      });
      h += '<p class="cfg-note">Banned people can\'t rejoin and won\'t see this room in Discover.</p>' + SEC_CLOSE;
    }
    /* ── room details (host + mods → editable) ── */
    if (p.canEditRoom) {
      const f = roomFormValues();
      h += secOpen("room", "Room details", false, 'data-sec="room"');
      if (S.roomConflict) h += conflictHTML(S.roomConflict);
      h += '<label class="cfg-field"><span>Name</span>' +
              '<input id="cfgName" data-room-field type="text" maxlength="60" ' +
                'value="' + esc(f.roomName) + '"></label>' +
            '<label class="cfg-field"><span>Description</span>' +
              '<textarea id="cfgDesc" data-room-field rows="2" maxlength="200">' +
                esc(f.description) + "</textarea></label>" +
            '<label class="cfg-field"><span>Mode</span>' +
              '<select id="cfgMode" data-room-field>' +
                Object.keys(MODES).map((k) =>
                  '<option value="' + k + '"' + (f.mode === k ? " selected" : "") + ">" +
                  MODES[k].icon + " " + MODES[k].label + "</option>").join("") +
              "</select></label>" +
            '<label class="cfg-field"><span>Tags ' +
              '<span class="cfg-note" style="margin:0">(comma separated, max 8)</span>' +
              "</span>" +
              '<input id="cfgTags" data-room-field type="text" ' +
                'value="' + esc(f.tags) + '"></label>' +
            '<label class="cfg-field"><span>Visibility</span>' +
              '<select id="cfgVis" data-room-field>' +
                '<option value="public"'  + (f.isPublic  ? " selected" : "") + ">Public</option>" +
                '<option value="private"' + (!f.isPublic ? " selected" : "") + ">Private</option>" +
              "</select></label>" +
            '<label class="cfg-field"><span>Max participants ' +
             '<span class="cfg-note" id="cfgMaxHint" style="margin:0">(' + participantsHere() +
               " here now · " + participantFloor() + "–" + ROOM_CAP + ")</span></span>" +
             '<div class="num-stepper">' +
               '<input id="cfgMax" data-room-field type="number" step="1" ' +
                 'min="' + participantFloor() + '" max="' + ROOM_CAP + '" ' +
                 'value="' + f.maxParticipants + '">' +
               '<span class="num-btns">' +
                 '<button type="button" class="num-btn" data-act="step-up" tabindex="-1">' + STEP_UP + "</button>" +
                 '<button type="button" class="num-btn" data-act="step-down" tabindex="-1">' + STEP_DN + "</button>" +
               "</span></div></label>" +
            '<div class="cfg-actions">' +
              '<button class="cfg-btn primary" id="cfgSave" data-act="save-room">' +
                "Save changes</button>" +
              '<button class="cfg-btn" id="cfgReset" data-act="reset-room" disabled>' +
                "Reset</button>" +
            "</div>" +
            '<p class="cfg-dirty is-hidden" id="cfgDirtyNote"></p>' +
            (host ? ""
              : '<p class="cfg-note">Changes are visible to everyone in the room.</p>');
      h += SEC_CLOSE;
    }
    dom.cfgBody.innerHTML = h;
    syncDirtyUI();
  }

  /* ── incoming room-details change ── */
  function conflictHTML(c) {
    const fields = (c.changed || []).map((k) => FIELD_LABEL[k] || k).join(", ");
    return '<div class="cfg-conflict" role="status">' +
      '<div class="pp-txt"><strong>' + esc(c.by) + "</strong> updated the room" +
        (fields ? " <em>(" + esc(fields) + ")</em>" : "") +
        ". Your edits were kept — save to overwrite, or discard to load theirs.</div>" +
      '<div class="pp-acts">' +
        '<button class="cfg-mini ok" data-act="ack-conflict">OK, keep mine</button>' +
        '<button class="cfg-mini alt" data-act="reset-room">Discard mine</button>' +
      "</div></div>";
  }
  function mountConflict() {
    const head = dom.cfgBody.querySelector('[data-sec="room"] h4');
    if (!head) return;
    const old = dom.cfgBody.querySelector(".cfg-conflict");
    if (old) old.remove();                              // refresh text if a 2nd edit lands
    head.insertAdjacentHTML("afterend", conflictHTML(S.roomConflict));
  }
  function nudgeConflict() {
    const el = dom.cfgBody.querySelector(".cfg-conflict");
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("nudge");
    void el.offsetWidth;                                // restart the animation
    el.classList.add("nudge");
    setTimeout(() => el.classList.remove("nudge"), 600);
  }
  function applyIncomingRoom(room, by, changed) {
    S.room = Object.assign({}, S.room, room);
    renderRoomDetails();                                // header/title/tags update for everyone
    if (!isConfigOpen() || !isRoomDirty()) {            // nothing to protect → just refresh
      S.roomDraft = null;
      S.roomConflict = null;
      refreshPanels();
      return;
    }
    /* dirty form: keep the draft, queue an acknowledgement */
    const prev = (S.roomConflict && S.roomConflict.changed) || [];
    S.roomConflict = { by, changed: [...new Set([...prev, ...(changed || [])])] };
    mountConflict();
    syncDirtyUI();                                      // blocks Save, shows the warning line
  }
  function rowMenuHTML(m, isOnline, state) {
    const c = (state || S.cfgRowMenu || {}).confirm;
    if (c === "ban" || c === "remove") {
      const ban = c === "ban";
      return '<div class="cfg-rowmenu confirm">' +
        '<div class="pp-txt">' + (ban
          ? "<strong>Ban " + esc(m.username) + "?</strong> They'll be kicked out now and can't rejoin until you unban them."
          : "<strong>Remove " + esc(m.username) + "?</strong> They lose their role and permissions here, but can join again.") +
        "</div><div class=\"pp-acts\">" +
          '<button class="cfg-mini no" data-act="do-' + c + '" data-id="' + m.userId + '">' +
            (ban ? "🚫 Ban" : "✕ Remove") + "</button>" +
          '<button class="cfg-mini alt" data-act="menu-close">Cancel</button>' +
        "</div></div>";
    }
    return '<div class="cfg-rowmenu">' +
      '<button class="cfg-mini alt" data-act="do-kick" data-id="' + m.userId + '"' +
        (isOnline ? "" : " disabled") +
        ' title="Boot from this session — they keep their permissions and can rejoin">👟 Kick</button>' +
      '<button class="cfg-mini alt" data-act="ask-remove" data-id="' + m.userId + '"' +
        ' title="Delete their membership and permissions">✕ Remove</button>' +
      '<button class="cfg-mini no" data-act="ask-ban" data-id="' + m.userId + '"' +
        ' title="Remove and block them from rejoining">🚫 Ban</button>' +
    "</div>";
  }

  S.roomDraft    = null;   // in-progress edits
  S.roomConflict = null;   // unacknowledged incoming change
  /* canonical form of the six editable fields — mirrors the server's sanitizer */
  function normRoom(v) {
    const tags = String(v.tags == null ? "" : v.tags)
      .split(",").map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
    return {
      roomName:        String(v.roomName || "").trim().replace(/\s+/g, " "),
      description:     String(v.description || "").trim(),
      mode:            v.mode || "casual",
      tags:            [...new Set(tags)].slice(0, 8).join(","),
      isPublic:        !!v.isPublic,
      maxParticipants: parseInt(v.maxParticipants, 10) || 0,
    };
  }
  /* what's in the DB right now (S.room is kept in sync by room-saved/room-updated) */
  function serverRoomVals() {
    const r = S.room || {};
    return normRoom({
      roomName: r.roomName, description: r.description, mode: r.mode || "casual",
      tags: (r.tags || []).join(","), isPublic: r.isPublic !== false,
      maxParticipants: r.maxParticipants || 10,
    });
  }
  const isRoomDirty = () =>
    !!S.roomDraft && JSON.stringify(normRoom(S.roomDraft)) !== JSON.stringify(serverRoomVals());
  function roomFormValues() {
    const r = S.room || {}, d = S.roomDraft || {};
    const pick = (k, fb) => (d[k] !== undefined ? d[k] : fb);
    return {
      roomName:        pick("roomName", r.roomName || ""),
      description:     pick("description", r.description || ""),
      mode:            pick("mode", r.mode || "casual"),
      tags:            pick("tags", (r.tags || []).join(", ")),
      isPublic:        pick("isPublic", r.isPublic !== false),
      maxParticipants: pick("maxParticipants", r.maxParticipants || 10),
    };
  }
  function readRoomForm() {
    return {
      roomName:        $("cfgName").value,
      description:     $("cfgDesc").value,
      mode:            $("cfgMode").value,
      tags:            $("cfgTags").value,
      isPublic:        $("cfgVis").value === "public",
      maxParticipants: $("cfgMax").value,
    };
  }
  /* live state of Reset / Save / the hint line — no re-render, so typing isn't interrupted */
  function syncDirtyUI() {
    const reset = $("cfgReset"), save = $("cfgSave"), note = $("cfgDirtyNote"), maxIn = $("cfgMax");
    if (!reset || !save || !note) return;
    /* keep the native clamp honest as people come and go */
    if (maxIn) { maxIn.min = String(participantFloor()); maxIn.max = String(ROOM_CAP); }
    const dirty = isRoomDirty();
    const err   = roomFormError();
    const blocked = !!S.roomConflict || !!err;
    reset.disabled = !dirty;
    dom.cfgBody.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    if (err && $(err.id)) $(err.id).classList.add("invalid");
    note.textContent = S.roomConflict
      ? "⚠️ Someone else changed the room — dismiss the note above, then save."
      : err   ? "⚠️ " + err.msg
      : dirty ? "Unsaved changes" : "";
    note.classList.toggle("warn", blocked);
    note.classList.toggle("is-hidden", !note.textContent);
    save.classList.toggle("is-blocked", blocked);
    save.setAttribute("aria-disabled", blocked ? "true" : "false");
    /* grey out the arrow that would go out of range */
    if (maxIn) {
      const n  = Number(maxIn.value);
      const up = dom.cfgBody.querySelector('[data-act="step-up"]');
      const dn = dom.cfgBody.querySelector('[data-act="step-down"]');
      if (up) up.disabled = Number.isInteger(n) && n >= ROOM_CAP;
      if (dn) dn.disabled = Number.isInteger(n) && n <= participantFloor();
    }
  }
  function refreshMaxHint() {
    const hint = $("cfgMaxHint");
    if (!hint) return;
    const here = participantsHere();
    hint.textContent = "(" + here + " here now · " + participantFloor() + "–" + ROOM_CAP + ")";
  }
  function nudgeNote() {
    const note = $("cfgDirtyNote");
    if (!note) return;
    note.classList.remove("nudge"); void note.offsetWidth; note.classList.add("nudge");
    setTimeout(() => note.classList.remove("nudge"), 600);
  }
  const refreshConfig  = () => { if (isConfigOpen())  renderConfig();  };
  const refreshProfile = () => { if (isProfileOpen()) renderProfile(); };
  /* anything that used to call refreshConfig() on a server broadcast
     (room-permissions, member list changes, participants changes) should call this */
  const refreshPanels  = () => { refreshConfig(); refreshProfile(); };
  function avatarHTML(name) {
    return '<span class="cfg-av" style="background:' + avColor(name) + '">' + (name || "?")[0].toUpperCase() + "</span>";
  }
  function swHTML(scope, id, on, locked, title) {
    const ic = scope === "sync" ? "▶" : "☰";
    return '<label class="sw sw-ic' + (locked ? " sw-lock" : "") + '" title="' + title + '">' +
      '<span class="sw-tag">' + ic + "</span>" +
      '<input type="checkbox" data-act="' + scope + '" data-id="' + id + '"' +
        (on ? " checked" : "") + (locked ? " disabled" : "") + ">" +
      '<span class="sw-track"><span class="sw-knob"></span></span></label>';
  }
  /* delegated actions inside the sheet */
  function onCfgClick(e) {
    /* ── collapsible header toggle ── */
    const head = e.target.closest(".cfg-sec-head");
    if (head) {
      const sec = head.closest("[data-collapsible]");
      if (sec) {
        const id = sec.dataset.secId;
        sec.classList.toggle("collapsed");
        S.cfgCollapsed[id] = sec.classList.contains("collapsed");
        return;
      }
    }
    /* ── data-act buttons ── */
    const el = e.target.closest("[data-act]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const act = el.dataset.act;
    /* number stepper */
    if (act === "step-up" || act === "step-down") {
      const input = $("cfgMax");
      if (!input) return;
      const dir = act === "step-up" ? 1 : -1;
      const min = Number(input.min) || participantFloor();
      const max = Number(input.max) || ROOM_CAP;
      const cur = parseInt(input.value, 10) || min;
      const next = Math.max(min, Math.min(max, cur + dir));
      if (next !== cur) {
        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (act === "request") sockEmit("perm-request", { scope: el.dataset.scope || "sync" });
    if (act === "mode")    sockEmit("perm-set-mode",       { mode: el.dataset.mode });
    if (act === "qmode")   sockEmit("perm-set-queue-mode", { mode: el.dataset.mode });
    if (act === "respond") sockEmit("perm-respond", {
      userId: el.dataset.id, approve: el.dataset.approve === "1", scope: el.dataset.scope || "sync",
    });
    if (act === "row-menu") {
      const id = el.dataset.id;
      S.cfgRowMenu = (S.cfgRowMenu && S.cfgRowMenu.id === id) ? null : { id, confirm: null };
      renderConfig(); return;
    }
    if (act === "menu-close")  { S.cfgRowMenu = null; renderConfig(); return; }
    if (act === "ask-ban")     { S.cfgRowMenu = { id: el.dataset.id, confirm: "ban" };    renderConfig(); return; }
    if (act === "ask-remove")  { S.cfgRowMenu = { id: el.dataset.id, confirm: "remove" }; renderConfig(); return; }
    if (act === "do-kick" || act === "do-ban" || act === "do-remove") {
      sockEmit(MOD_EVT[act], { userId: el.dataset.id });
      S.cfgRowMenu = null; renderConfig(); return;
    }
    if (act === "unban") { sockEmit("member-unban", { userId: el.dataset.id }); return; }
    if (act === "save-room") {
      if (!getSocket()) return;
      if (S.roomConflict) return nudgeConflict();
      const payload = readRoomForm();
      S.roomDraft = payload;
      el.disabled = true;
      sockEmit("room-update", payload);
      setTimeout(() => { el.disabled = false; }, 1200);
      return;
    }
    if (act === "reset-room") {
      S.roomDraft = null;
      S.roomConflict = null;
      renderConfig();
      return;
    }
    if (act === "ack-conflict") {
      S.roomConflict = null;
      const b = dom.cfgBody.querySelector(".cfg-conflict");
      if (b) b.remove();
      syncDirtyUI();
      return;
    }
  }
  /* scroll-to-step on the number field */
  function onCfgWheel(e) {
    const input = e.target.closest('.num-stepper input[type="number"]');
    if (!input) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const min = parseInt(input.min, 10) || 2;
    const max = parseInt(input.max, 10) || 50;
    const cur = parseInt(input.value, 10) || min;
    const next = Math.max(min, Math.min(max, cur + dir));
    if (next !== cur) {
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  function onCfgChange(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const a = el.dataset.act;
    if (a === "sync" || a === "queue")
      sockEmit(el.checked ? "perm-grant" : "perm-revoke", { userId: el.dataset.id, scope: a });
    if (a === "role")
      sockEmit("perm-set-role", { userId: el.dataset.id, role: el.value });
  }
  /* remember room-detail edits so a perms broadcast doesn't wipe the form */
  function onCfgRoomInput(e) {
    if (!e.target.closest("[data-room-field]")) return;
    S.roomDraft = readRoomForm();
    syncDirtyUI();                       // Reset lights up immediately
  }
  function dom_cfgDelegate() {
    dom.cfgBody.addEventListener("click",  onCfgClick);
    dom.cfgBody.addEventListener("change", onCfgChange);
    dom.cfgBody.addEventListener("input",  onCfgRoomInput);
    dom.cfgBody.addEventListener("change", onCfgRoomInput);          // selects
    dom.cfgBody.addEventListener("wheel",  onCfgWheel, { passive: false });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", dom_cfgDelegate, { once: true });
  } else {
    dom_cfgDelegate();
  }
  /* host-side approve/deny prompt */
  function showRequestPrompt(userId, username, scope) {
    const key = userId + ":" + scope;
    if (dom.toasts.querySelector('[data-req="' + key + '"]')) return;
    const label = scope === "queue" ? "manage the queue" : "control playback";
    const el = document.createElement("div");
    el.className = "perm-prompt";
    el.dataset.req = key;
    el.innerHTML =
      '<div class="pp-txt"><strong>' + esc(username) + "</strong> wants to " + label + "</div>" +
      '<div class="pp-acts"><button class="cfg-mini ok">Approve</button><button class="cfg-mini no">Deny</button></div>';
    const [ok, no] = el.querySelectorAll("button");
    ok.onclick = () => { sockEmit("perm-respond", { userId, scope, approve: true  }); el.remove(); };
    no.onclick = () => { sockEmit("perm-respond", { userId, scope, approve: false }); el.remove(); };
    dom.toasts.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }

  /* ══════════════════════════════════════
     MEMBER PROFILE PANEL
     identity = /api/users/:id · moderation = reused from the config sheet
     ══════════════════════════════════════ */
  const profCache = new Map();      // userId → { username, avatar, createdAt }
  const isProfileOpen = () => dom.profCard.classList.contains("open");
  function openProfile(userId, fallbackName) {
    if (!userId) return;
    const cached = profCache.get(userId) || null;
    S.profile = {
      userId,
      username: fallbackName || "",
      confirm:  null,               // null | 'ban' | 'remove'  (mirrors S.cfgRowMenu.confirm)
      loading:  !cached,
      error:    false,
      data:     cached,
    };
    renderProfile();
    dom.profCard.classList.add("open");
    dom.profBackdrop.classList.add("open");
    dom.profCard.setAttribute("aria-hidden", "false");
    dom.profClose.focus();
    if (!cached) fetchProfile(userId);
  }
  /* the ban/unban round-trip is async — hold an optimistic state until the
     room-permissions broadcast reconciles it (or 5s passes, i.e. it failed) */
  function setPending(kind) {
    if (!S.profile) return;
    S.profile.pending = kind;                       // 'ban' | 'unban'
    clearTimeout(S.profile._pt);
    S.profile._pt = setTimeout(() => {
      if (S.profile && S.profile.pending === kind) { S.profile.pending = null; renderProfile(); }
    }, 5000);
  }
  function clearPending(p) { p.pending = null; clearTimeout(p._pt); }
  function closeProfile() {
    if (S.profile) clearTimeout(S.profile._pt);
    S.profile = null;
    dom.profCard.classList.remove("open");
    dom.profBackdrop.classList.remove("open");
    dom.profCard.setAttribute("aria-hidden", "true");
  }
  /* mirrors the "Banned" section of the config sheet — same button, same event */
  function profBanSec(name, userId, ban, pending) {
    const busy   = pending === "ban" || pending === "unban";
    const label  = pending === "ban"   ? "Banning…"
                 : pending === "unban" ? "Unbanning…"
                 : "✓ Unban";
    return profSec("Banned",
      '<div class="prof-ban">' +
        '<div class="pp-txt"><strong>' + esc(name) + "</strong> is banned from this room. " +
          "They can't rejoin and won't see it in Discover.</div>" +
        (ban && ban.reason ? '<p class="cfg-note prof-reason">"' + esc(ban.reason) + '"</p>' : "") +
        '<div class="pp-acts">' +
          '<button class="cfg-mini ok" data-act="unban" data-id="' + userId + '"' +
            (busy ? " disabled" : "") + ">" + label + "</button>" +
        "</div>" +
      "</div>");
  }
  async function fetchProfile(userId) {
    try {
      const r = await fetch("/api/users/" + encodeURIComponent(userId), { credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      profCache.set(userId, d);
      if (S.profile && S.profile.userId === userId) {
        S.profile.data = d; S.profile.loading = false; renderProfile();
      }
    } catch (_) {
      if (S.profile && S.profile.userId === userId) {
        S.profile.loading = false; S.profile.error = true; renderProfile();
      }
    }
  }
  /* generated avatar underneath, optional <img> on top; the img removes itself on error */
  function profAvatarHTML(name, url) {
    const u = safeHttpUrl(url);
    return '<span class="prof-av" style="background:' + avColor(name) + '">' +
      (name || "?")[0].toUpperCase() +
      (u ? '<img src="' + esc(u) + '" alt="">' : "") +
      "</span>";
  }
  const profSec = (title, inner) => '<div class="cfg-sec"><h4>' + title + "</h4>" + inner + "</div>";
  function renderProfile() {
    const p = S.profile;
    if (!p) return;
    const me     = S.perms || {};
    const online = new Set(((S.room && S.room.participants) || []).map((x) => (x.userId || "").toString()));
    const m      = (S.members || []).find((x) => x.userId === p.userId) || null;
    const d      = p.data || {};
    /* S.banned is only ever populated for the host (canBan) — mods/members see nothing */
    const ban = me.canBan ? ((S.banned || []).find((b) => b.userId === p.userId) || null) : null;
    /* reconcile the optimistic flag against the authoritative list */
    if (p.pending === "ban"   &&  ban) clearPending(p);
    if (p.pending === "unban" && !ban) clearPending(p);
    const isBanned = !!ban || p.pending === "ban";
    const name      = d.username || (m && m.username) || (ban && ban.username) || p.username || "Unknown";
    const role      = m ? m.role : null;
    const isSelf    = !!S.userId && p.userId === S.userId;
    const isHostRow = role === "admin";
    const isModRow  = role === "mod";
    /* ── 1. identity — EVERYONE sees exactly this much ── */
    let h = '<div class="prof-id">' +
        profAvatarHTML(name, d.avatar) +
        '<div class="prof-name">' + esc(name) +
          (online.has(p.userId) ? '<i class="dot-on" title="In room"></i>' : "") +
          (isBanned ? '<span class="role-tag role-banned">Banned</span>'
            : role  ? '<span class="role-tag role-' + role + '">' + ROLE_LABEL[role] + "</span>" : "") +
          (isSelf ? '<span class="prof-self">You</span>' : "") +
        "</div>" +
        '<div class="prof-meta">' +
          (p.loading ? '<span class="prof-skel"></span>'
            : p.error ? "Profile unavailable"
            : d.createdAt ? "Joined " + esc(fmtJoined(d.createdAt))
            : "Join date unknown") +
        "</div>" +
      "</div>";
    /* ── 2. host/mod only, never targets yourself ── */
    if (me.canManage && !isSelf) {
      /* a) banned → the only thing left to do is lift it (host only, since S.banned is host-only) */
      if (isBanned) {
        h += profBanSec(name, p.userId, ban, p.pending);
      }
      /* b) still a member → the normal perms / role / moderation stack */
      else if (m) {
        if (isHostRow) {
          h += profSec("Permissions",
            '<p class="cfg-note">The host always has playback and queue control.</p>');
        } else if (isModRow) {
          h += profSec("Permissions",
            '<p class="cfg-note">🛡️ Moderators always have playback and queue control — it can\'t be revoked.' +
            (me.canSetRoles ? " Change their role below to adjust this." : "") + "</p>");
        } else if (me.canGrantSync || me.canGrantQueue) {
          const syncLocked  = me.syncMode  === "everyone" || !me.canGrantSync;
          const queueLocked = me.queueMode === "everyone" || !me.canGrantQueue;
          h += profSec("Permissions",
            '<div class="cfg-row"><span>Playback control</span><span class="cfg-acts">' +
              swHTML("sync", m.userId, m.canSync, syncLocked, "Can play / pause / seek") +
            "</span></div>" +
            '<div class="cfg-row"><span>Queue control</span><span class="cfg-acts">' +
              swHTML("queue", m.userId, m.canQueue, queueLocked, "Can manage the queue") +
            "</span></div>" +
            (syncLocked || queueLocked
              ? '<p class="cfg-note">Some controls are open to everyone right now — switch that off in ' +
                "Room settings to grant them individually.</p>"
              : ""));
        }
        if (me.canSetRoles && !isHostRow) {
          h += profSec("Role",
            '<div class="cfg-row"><span>Room role</span><span class="cfg-acts">' +
              '<select class="cfg-sel" data-act="role" data-id="' + m.userId + '">' +
                '<option value="member"' + (role === "member" ? " selected" : "") + ">Member</option>" +
                '<option value="mod"'    + (isModRow ? " selected" : "") + ">Mod</option>" +
              "</select></span></div>" +
            '<p class="cfg-note">Mods can edit room details and grant playback control, but can\'t change roles.</p>');
        }
        if (me.canBan && !isHostRow) {
          h += profSec("Moderation",
            rowMenuHTML(m, online.has(m.userId), p) +
            (p.confirm ? "" :
              '<p class="cfg-note">Kick boots them from this session. Remove deletes their membership ' +
              "and permissions. Ban also blocks them from rejoining.</p>"));
        }
      }
      /* c) removed / unbanned / never joined */
      else {
        h += '<div class="cfg-sec"><p class="cfg-note">Not a member of this room — they can join again.</p></div>';
      }
    }
    dom.profBody.innerHTML = h;
    const img = dom.profBody.querySelector(".prof-av img");
    if (img) img.addEventListener("error", () => img.remove(), { once: true });
  }
  /* ── delegated clicks inside the card (change events reuse onCfgChange verbatim) ── */
  function onProfClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || !S.profile || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const a = el.dataset.act;
    if (a === "ask-ban")    { S.profile.confirm = "ban";    renderProfile(); return; }
    if (a === "ask-remove") { S.profile.confirm = "remove"; renderProfile(); return; }
    if (a === "menu-close") { S.profile.confirm = null;     renderProfile(); return; }
    if (MOD_EVT[a]) {                                   // do-kick | do-ban | do-remove
      sockEmit(MOD_EVT[a], { userId: el.dataset.id });
      S.profile.confirm = null;
      if (a === "do-remove") { closeProfile(); return; } // membership gone, nothing to undo here
      if (a === "do-ban")    setPending("ban");          // ← stay open, flips to the Unban card
      renderProfile();
      return;
    }
    if (a === "unban") {                                 // same event the config sheet emits
      sockEmit("member-unban", { userId: el.dataset.id });
      setPending("unban");
      renderProfile();
      return;
    }
  }
  function onChatAvatarClick(e) {
    const av = e.target.closest(".msg-av[data-uid]");
    if (!av) return;
    openProfile(av.dataset.uid, av.dataset.uname);
  }
  function dom_profDelegate() {
    dom.profBody.addEventListener("click",  onProfClick);
    dom.profBody.addEventListener("change", onCfgChange);   // ← sync / queue / role, same emits
    dom.profClose.addEventListener("click", closeProfile);
    dom.profBackdrop.addEventListener("click", closeProfile);
    dom.chatMsgs.addEventListener("click", onChatAvatarClick);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isProfileOpen()) { e.stopPropagation(); closeProfile(); }
    }, true);                                               // capture → closes before the cfg sheet
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", dom_profDelegate, { once: true });
  } else {
    dom_profDelegate();
  }

})();
