/* public/js/room.js */
(function () {
  "use strict";
  /* ═══════ CONFIG ═══════ */
  const MODES = {
    study:         { label: "Study",         icon: "📚" },
    gaming:        { label: "Gaming",        icon: "🎮" },
    entertainment: { label: "Entertainment", icon: "🎬" },
    casual:        { label: "Casual",        icon: "☕" },
  };
  const THEMES = {
    morning:   { icon: "🌅", label: "Morning"   },
    afternoon: { icon: "☀️", label: "Afternoon" },
    evening:   { icon: "🌆", label: "Evening"   },
    night:     { icon: "🌙", label: "Night"     },
  };
  const THEME_STORAGE_KEY = "wt-theme-pref";
  const AV_COLORS = [
    "#e11d48","#eab308","#22c55e","#3b82f6","#8b5cf6",
    "#ec4899","#f97316","#06b6d4","#6366f1","#14b8a6",
  ];
  /* ═══════ REACTIONS ═══════ */
  const REACTIONS       = ["❤️","😂","😮","😢","🔥","👏","💀"];  // must match server whitelist
  const REACT_COOLDOWN  = 280;   // ms — min gap between MY reactions
  const MAX_BUBBLES     = 36;    // hard cap on live DOM bubbles
  const RAIL_AUTO_CLOSE = 3500;  // ms (mobile popover)
  let lastReactAt   = 0;
  let railCloseTmr  = null;

  // constants
  const SYNC_INTERVAL   = 5000;
  const DRIFT_THRESHOLD = 1.5;   // seconds
  const REMOTE_COOLDOWN = 1000;  // ms
  const SEEK_DEBOUNCE   = 300;   // ms
  /* ═══════ STATE ═══════ */
  const S = { room: null, userId: null, username: "You", themeMode: "auto" };
  const roomId = location.pathname.replace(/.*\/room\//, "").replace(/\/$/, "");
  let socket = null;
  let videoLoaded = false;
  let startMarkerShown = false;
  let oldestMsgId = null, hasMoreMsgs = false, loadingOlder = false;
  let needsSync = false;
  let initialVideoState = { currentTime: 0, isPlaying: false };
  let syncFallbackTimer = null;

  /* ═══════ Collapsible Room Details Div ═══════ */
  const DETAILS_KEY = "wt-details-open";
  let detailsOpen = true;
  const chevSVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  /* ═══════ DOM ═══════ */
  const $ = (id) => document.getElementById(id);
  const dom = {
    root: $("roomPage"), sky: $("skyBg"),
    details: $("roomDetails"), hdrName: $("hdrName"), hdrBadge: $("hdrBadge"), hdrDot: $("hdrDot"),
    videoWrap: $("videoWrapper"), placeholder: $("videoPlaceholder"),
    controls: $("videoControls"), container: $("videoContainer"),
    chatMsgs: $("chatMessages"), chatInput: $("chatInput"), chatOnline: $("chatOnline"),
    toasts: $("toastWrap"),
    themeSwitcher: $("themeSwitcher"), themeBtn: $("themeBtn"), themeBtnIcon: $("themeBtnIcon"), themeMenu: $("themeMenu"),
    fxLayer: $("fxLayer"), playerBar: $("playerBar"),
    reactRail: $("reactRail"), reactToggle: $("reactToggle"), reactStrip: $("reactStrip"),
    reactHub: $("reactHub"), ytFsBtn: $("ytFsBtn"),
  };
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
    /* ── sync leader: broadcasts time every SYNC_INTERVAL ── */
    startLeader() {
      clearInterval(this._syncInt);
      this._syncInt = setInterval(() => {
        if (!this.paused() && socket)
          socket.emit("video-time-sync", { currentTime: this.time() });
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
          socket && socket.emit("video-seek", { currentTime: now });
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
    initDetailsState();
    wireEvents();
    await fetchMe();
    connectSocket();
  });
  function initDetailsState() {
    let saved = null;
    try { saved = localStorage.getItem(DETAILS_KEY); } catch (_) {}
    // no stored preference → collapsed on mobile, expanded on desktop
    detailsOpen = saved === null ? window.innerWidth > 768 : saved === "1";
  }
  function resolveTod() {
    try { if (typeof getTimeOfDay === "function") return getTimeOfDay(); } catch (_) {}
    const h = new Date().getHours();
    if (h >= 6  && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 21) return "evening";
    return "night";
  }
  /* ═══════ THEME SWITCHER ═══════ */
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch (_) {}
    S.themeMode = saved && (saved === "auto" || THEMES[saved]) ? saved : "auto";
    applyTheme(S.themeMode === "auto" ? resolveTod() : S.themeMode, false);
    highlightActiveThemeOpt();
  }
  function applyTheme(themeKey, animate) {
    if (!THEMES[themeKey]) themeKey = "morning";
    const imgUrl = "url('/assets/" + themeKey + "/sky.png')";
    if (animate) {
      dom.sky.style.opacity = "0";
      setTimeout(() => {
        dom.root.dataset.theme = themeKey;
        dom.sky.style.backgroundImage = imgUrl;
        dom.root.style.setProperty("--sky-img", imgUrl);
        requestAnimationFrame(() => (dom.sky.style.opacity = "1"));
      }, 180);
    } else {
      dom.root.dataset.theme = themeKey;
      dom.sky.style.backgroundImage = imgUrl;
      dom.root.style.setProperty("--sky-img", imgUrl);
    }
    dom.themeBtnIcon.textContent = S.themeMode === "auto" ? "🧭" : (THEMES[themeKey] ? THEMES[themeKey].icon : "🌤️");
  }
  function highlightActiveThemeOpt() {
    dom.themeMenu.querySelectorAll(".theme-opt").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === S.themeMode);
    });
  }
  function setThemeMode(mode) {
    S.themeMode = mode;
    try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch (_) {}
    applyTheme(mode === "auto" ? resolveTod() : mode, true);
    highlightActiveThemeOpt();
    closeThemeMenu();
  }
  function openThemeMenu() {
    dom.themeSwitcher.classList.add("open");
    dom.themeBtn.setAttribute("aria-expanded", "true");
  }
  function closeThemeMenu() {
    dom.themeSwitcher.classList.remove("open");
    dom.themeBtn.setAttribute("aria-expanded", "false");
  }
  /* ═══════ EVENT WIRING ═══════ */
  function wireEvents() {
    $("backBtn").onclick  = leaveRoom;
    $("leaveBtn").onclick = leaveRoom;
    $("loadUrlBtn").onclick = () => loadVideo($("urlInput").value.trim(), false);
    $("urlInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadVideo($("urlInput").value.trim(), false);
    });
    $("sendBtn").onclick = sendMessage;
    dom.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    dom.chatMsgs.addEventListener("scroll", onChatScroll);
    dom.container.addEventListener("touchstart", () => {
      dom.controls.classList.add("show");
      clearTimeout(dom.controls._t);
      dom.controls._t = setTimeout(() => dom.controls.classList.remove("show"), 3000);
    });
    /* room details: click anywhere to expand / collapse */
    dom.details.addEventListener("click", () => {
      if (!dom.details.classList.contains("rd-loaded")) return;   // still skeleton
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.type === "Range" && sel.toString().trim()) return; // user is selecting text
      toggleDetails();
    });
    dom.details.addEventListener("keydown", (e) => {
      if (!e.target.classList || !e.target.classList.contains("rd-head")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDetails(); }
    });
    /* theme dropdown */
    dom.themeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dom.themeSwitcher.classList.contains("open") ? closeThemeMenu() : openThemeMenu();
    });
    dom.themeMenu.addEventListener("click", (e) => {
      const opt = e.target.closest(".theme-opt");
      if (!opt) return;
      setThemeMode(opt.dataset.theme);
    });
    document.addEventListener("click", (e) => {
      if (!dom.themeSwitcher.contains(e.target)) closeThemeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeThemeMenu();
      closeRail();
      if (dom.container.classList.contains("pseudo-fs")) setPseudoFs(false);
    });
    wireReactions();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
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
     SOCKET — presence / chat / video
     ══════════════════════════════════════ */
  function connectSocket() {
    socket = io({ withCredentials: true });
    socket.on("connect", () => socket.emit("join-room", { roomId }));
    socket.on("connect_error", () => {
      toast("Session expired", "error");
      setTimeout(() => (location.href = "/"), 1500);
    });
    /* ── presence ── */
    socket.on("room-state", async ({ room }) => {
      S.room = room;
      renderHeader();
      renderDetails();
      addSystemMsg("You joined the room");
      await loadInitialMessages();
      if (room.video && room.video.url && !videoLoaded) {
        $("urlInput").value = room.video.url;
        initialVideoState = {
          currentTime: room.video.currentTime || 0,
          isPlaying:   room.video.isPlaying   || false,
        };
        needsSync = true;
        await loadVideo(room.video.url, true);          // true = don't re-emit
      }
    });
    socket.on("room-error", ({ message }) => {
      toast(message || "Error", "error");
      setTimeout(() => (location.href = "/dashboard"), 1500);
    });
    socket.on("participants-update", ({ participants, count }) => {
      if (!S.room) return;
      S.room.participants = participants;
      renderDetails();
      dom.chatOnline.textContent = count + " in room";
    });
    socket.on("user-joined", ({ username }) => addSystemMsg(username + " joined"));
    socket.on("user-left",   ({ username }) => addSystemMsg(username + " left"));
    /* ── chat ── */
    socket.on("chat-message", (msg) => appendMessage(msg, true));
    /* ── video sync ── */
    socket.on("video-load", ({ url, username }) => {
      loadVideo(url, true);
      addSystemMsg(username + " loaded a new video");
    });
    socket.on("video-play", ({ currentTime }) => {
      P.remote(() => P.play(currentTime));
      P.stopLeader();                                   // remote user is leader now
    });
    socket.on("video-pause", ({ currentTime }) => {
      P.remote(() => P.pause(currentTime));
      P.stopLeader();
    });
    socket.on("video-seek", ({ currentTime }) => {
      P.remote(() => P.seek(currentTime));
    });
    socket.on("video-time-sync", ({ currentTime }) => {
      if (P.paused() || P.isRemote()) return;
      if (Math.abs(P.time() - currentTime) > DRIFT_THRESHOLD)
        P.remote(() => P.seek(currentTime));
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
      clearTimeout(syncFallbackTimer);
      if (!P.ready) return;
      P.remote(() => { P.seek(currentTime); if (isPlaying) P.play(currentTime); });
    });
    /* ── live reactions ── */
    socket.on("video-reaction", ({ emoji, userId, username }) => {
      if (userId && S.userId && userId.toString() === S.userId) return; // already rendered locally
      spawnReaction(emoji, username);
    });
  }
  function leaveRoom() {
    if (socket) socket.emit("leave-room");
    location.href = "/dashboard";
  }
  /* ═══════ RENDER ═══════ */
  function renderHeader() {
    const r = S.room; if (!r) return;
    const cfg = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
    const bc  = "badge-" + (MODES[r.mode] ? r.mode : "casual");
    dom.hdrName.textContent  = r.roomName;
    dom.hdrBadge.className   = "mode-badge " + bc;
    dom.hdrBadge.textContent = cfg.icon + " " + cfg.label;
    dom.hdrBadge.style.display = "";
    dom.hdrDot.className = "status-dot status-" + (r.status || "active");
    dom.hdrDot.style.display = "";
  }
  function renderDetails() {
    const r = S.room; if (!r) return;
    const cfg   = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
    const bc    = "badge-" + (MODES[r.mode] ? r.mode : "casual");
    const parts = r.participants || [];
    const max   = r.maxParticipants || 10;
    dom.details.innerHTML =
      /* ── always-visible summary ── */
      '<div class="rd-head" role="button" tabindex="0" aria-controls="rdBody" aria-expanded="' + (detailsOpen ? "true" : "false") + '">' +
        '<div class="rd-head-main">' +
          '<h2 class="rd-name">' + esc(r.roomName) + "</h2>" +
          '<span class="mode-badge ' + bc + '">' + cfg.icon + " " + cfg.label + "</span>" +
          '<span class="rd-count">👥 ' + parts.length + "/" + max + "</span>" +
        "</div>" +
        '<span class="rd-chev" aria-hidden="true">' + chevSVG + "</span>" +
      "</div>" +
      /* ── collapsible body ── */
      '<div class="rd-body-wrap"><div class="rd-body" id="rdBody"><div class="rd-body-inner">' +
        (r.description ? '<p class="rd-desc">' + esc(r.description) + "</p>" : "") +
        '<div class="rd-meta">' +
          '<span style="display:flex;align-items:center;gap:.3rem">' +
            '<span class="status-dot status-' + (r.status || "active") + '"></span>' +
            esc(r.status || "active") + "</span>" +
          '<span class="rd-meta-sep">·</span>' +
          "<span>Hosted by <strong>" + esc(r.admin ? r.admin.username : "—") + "</strong></span>" +
          '<span class="rd-meta-sep">·</span>' +
          "<span>👥 " + parts.length + "/" + max + " participants</span>" +
        "</div>" +
        (r.tags && r.tags.length
          ? '<div class="rd-tags">' + r.tags.map((t) => '<span class="tag">#' + esc(t) + "</span>").join("") + "</div>"
          : "") +
        renderAvatars(parts) +
      "</div></div></div>";
    dom.details.classList.add("rd-loaded");
    dom.details.classList.toggle("expanded", detailsOpen);   // applied same frame → no open/close flicker on re-render
    dom.chatOnline.textContent = parts.length + " in room";
  }
  function toggleDetails() {
    detailsOpen = !detailsOpen;
    try { localStorage.setItem(DETAILS_KEY, detailsOpen ? "1" : "0"); } catch (_) {}
    dom.details.classList.toggle("expanded", detailsOpen);
    const head = dom.details.querySelector(".rd-head");
    if (head) head.setAttribute("aria-expanded", detailsOpen ? "true" : "false");
  }
  function renderAvatars(list) {
    if (!list.length) return "";
    const MAX = 10, show = list.slice(0, MAX), extra = list.length - MAX;
    let h = '<div class="rd-avatars">';
    show.forEach((p) => {
      const c = avColor(p.username), ini = (p.username || "?")[0].toUpperCase();
      h += '<div class="avatar-sm" style="background:' + c + '" title="' + esc(p.username) + '">' + ini + "</div>";
    });
    if (extra > 0) h += '<div class="avatar-sm avatar-more">+' + extra + "</div>";
    return h + "</div>";
  }
  /* ══════════════════════════════════
     VIDEO — load / controls / sync
     ══════════════════════════════════ */
  async function loadVideo(url, fromRemote) {
    if (!url) { toast("Enter a URL", "error"); return; }
    P.destroy();
    // clear any existing FX (e.g., bubble emojis) so it doesn't linger when a new video is loaded
    if (dom.fxLayer) dom.fxLayer.innerHTML = "";
    const ytId = extractYT(url);
    if (ytId) {
      /* ── YouTube ── */
      P.type = "youtube";
      dom.controls.style.display = "none";
      dom.container.classList.add("is-yt");      // reveals OUR fullscreen button in the rail
      await loadYTAPI();
      /* Create the <iframe> ourselves instead of letting YT.Player do it, because:
         • no `allowfullscreen` attribute + no `fullscreen` in `allow`
           → the browser REFUSES any fullscreen request coming from inside the iframe,
             so YouTube can never fullscreen itself and orphan the app's overlays (app's own fullscreen button for example).
         • fs=0           → YouTube hides its own fullscreen button
         • playsinline=1  → iOS won't hijack the video into native fullscreen
         • enablejsapi=1  → required when handing an existing iframe to YT.Player   */
      const qs = new URLSearchParams({
        enablejsapi: "1", fs: "0", rel: "0", modestbranding: "1",
        playsinline: "1", autoplay: "0", origin: location.origin,
      }).toString();
      dom.videoWrap.innerHTML =
        '<iframe id="ytPlayerDiv" title="YouTube player" frameborder="0"' +
        ' allow="autoplay; encrypted-media; picture-in-picture"' +
        ' src="https://www.youtube.com/embed/' + ytId + '?' + qs + '"></iframe>';
      P.yt = new YT.Player("ytPlayerDiv", {
        events: { onReady: onPlayerReady, onStateChange: onYTState },
      });
    } else {
      /* ── direct <video> ── */
      P.type = "direct";
      dom.container.classList.remove("is-yt");
      dom.videoWrap.innerHTML = '<video id="videoEl" preload="metadata"></video>';
      P.el = $("videoEl");
      P.el.src = url;
      dom.controls.style.display = "";
      wireVideoControls();
      P.el.addEventListener("canplay", onPlayerReady, { once: true });
    }
    if (dom.placeholder && dom.placeholder.parentNode) dom.placeholder.remove();
    $("urlInput").value = url;
    videoLoaded = true;
    // only the person who pasted the URL emits → server saves + broadcasts
    if (!fromRemote && socket) socket.emit("video-load", { url });
  }
  /* Called once when the player is ready to accept commands */
  function onPlayerReady() {
    P.ready = true;
    if (P.type === "youtube") P.startYTPoll();
    if (!needsSync) return;
    needsSync = false;
    // 1) immediately apply the DB snapshot (best guess)
    P.remote(() => P.seek(initialVideoState.currentTime));
    // 2) ask peers for the *live* position — overrides DB if someone answers
    if (socket) socket.emit("video-sync-request");
    // 3) if nobody answers within 2 s, honour the DB isPlaying flag
    syncFallbackTimer = setTimeout(() => {
      if (initialVideoState.isPlaying) P.remote(() => P.play(initialVideoState.currentTime));
    }, 2000);
  }
  /* YouTube state-change → emit play / pause */
  function onYTState(e) {
    if (P.isRemote()) return;
    if (e.data === 1) {                              // PLAYING
      socket && socket.emit("video-play",  { currentTime: P.time() });
      P.startLeader();
    } else if (e.data === 2) {                       // PAUSED
      socket && socket.emit("video-pause", { currentTime: P.time() });
      P.stopLeader();
    }
    // BUFFERING (3) / ENDED (0) / UNSTARTED (-1) / CUED (5) → ignored
  }
  /* ── Direct-video custom controls + sync hooks ── */
  let seekTimer = null;
  function wireVideoControls() {
    if (!P.el) return;
    const v       = P.el;
    const prog    = $("progressBar");
    const cur     = $("curTime");
    const dur     = $("durTime");
    const playBtn = $("playBtn");
    const muteBtn = $("muteBtn");
    const volBar  = $("volBar");
    const fsBtn   = $("fsBtn");
    v.addEventListener("loadedmetadata", () => {
      dur.textContent = fmtTime(v.duration);
      prog.max = Math.floor(v.duration * 100) || 1000;
      fillSlider(volBar, 100, 100);
    });
    v.addEventListener("timeupdate", () => {
      cur.textContent = fmtTime(v.currentTime);
      prog.value = Math.floor(v.currentTime * 100);
      fillSlider(prog, prog.value, prog.max);
    });
    /* play / pause — always update the button icon; only emit if local */
    v.addEventListener("play", () => {
      playBtn.innerHTML = pauseSVG;
      if (P.isRemote()) return;
      socket && socket.emit("video-play", { currentTime: P.time() });
      P.startLeader();
    });
    v.addEventListener("pause", () => {
      playBtn.innerHTML = playSVG;
      if (P.isRemote()) return;
      socket && socket.emit("video-pause", { currentTime: P.time() });
      P.stopLeader();
    });
    v.addEventListener("ended", () => { playBtn.innerHTML = playSVG; });
    /* seek — debounced so scrubbing sends only the final position */
    v.addEventListener("seeked", () => {
      if (P.isRemote()) return;
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        socket && socket.emit("video-seek", { currentTime: P.time() });
      }, SEEK_DEBOUNCE);
    });
    playBtn.onclick = togglePlay;
    v.onclick       = togglePlay;
    prog.addEventListener("input", () => {
      v.currentTime = prog.value / 100;
      fillSlider(prog, prog.value, prog.max);
    });
    muteBtn.onclick = () => {
      v.muted = !v.muted;
      muteBtn.innerHTML = v.muted ? mutedSVG : volSVG;
    };
    volBar.addEventListener("input", () => {
      v.volume = volBar.value / 100;
      v.muted  = v.volume === 0;
      muteBtn.innerHTML = v.muted ? mutedSVG : volSVG;
      fillSlider(volBar, volBar.value, 100);
    });
    fsBtn.onclick = toggleFullscreen; // let toglleFullscreen() handle the YT case too
  }
  function togglePlay() {
    if (!P.el) return;
    if (P.el.paused) P.el.play().catch(() => {}); else P.el.pause();
  }
  function extractYT(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  /* SVG icons */
  const playSVG  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  const pauseSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const volSVG   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  const mutedSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  function fillSlider(el, val, max) {
    const pct = (val / max) * 100;
    el.style.background = "linear-gradient(to right,#fff " + pct + "%,rgba(255,255,255,.25) " + pct + "%)";
  }

  /* ══════════════════════════════════════
     LIVE REACTIONS
     ══════════════════════════════════════ */
  function wireReactions() {
    dom.ytFsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFullscreen(); });
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
    if (socket) socket.emit("video-reaction", { emoji });
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
  const fsExpandSVG  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const fsCollapseSVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  function setFsIcon(isFs) {
    const svg = isFs ? fsCollapseSVG : fsExpandSVG;
    if (dom.ytFsBtn) dom.ytFsBtn.innerHTML = svg;
    const vcFs = $("fsBtn");
    if (vcFs) vcFs.innerHTML = svg;
  }

  /* ═══════ CHAT ═══════ */
  function sendMessage() {
    const text = dom.chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit("chat-message", { text });
    dom.chatInput.value = "";
    dom.chatInput.focus();
  }
  async function loadInitialMessages() {
    try {
      const r = await fetch("/api/rooms/" + roomId + "/messages?limit=20", { credentials: "include" });
      if (!r.ok) return;
      const d = await r.json();
      hasMoreMsgs = d.hasMore;
      oldestMsgId = d.messages.length ? d.messages[0].id : null;
      const frag = document.createDocumentFragment();
      d.messages.forEach((m) => frag.appendChild(buildMsgEl(m)));
      dom.chatMsgs.appendChild(frag);
      dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
      if (!hasMoreMsgs) markStartReached();
    } catch (_) {}
  }
  async function onChatScroll() {
    if (dom.chatMsgs.scrollTop > 40 || !hasMoreMsgs || loadingOlder || !oldestMsgId) return;
    loadingOlder = true;
    const prev = dom.chatMsgs.scrollHeight;
    showTopLoader();
    try {
      const fp = fetch("/api/rooms/" + roomId + "/messages?limit=20&before=" + oldestMsgId, { credentials: "include" }).then((r) => r.json());
      const d = (await Promise.all([fp, delay(450)]))[0];
      hasMoreMsgs = d.hasMore;
      hideTopLoader();
      if (d.messages.length) {
        oldestMsgId = d.messages[0].id;
        const frag = document.createDocumentFragment();
        d.messages.forEach((m) => frag.appendChild(buildMsgEl(m)));
        dom.chatMsgs.insertBefore(frag, dom.chatMsgs.firstChild);
        dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight - prev;
      }
      if (!hasMoreMsgs) markStartReached();
    } catch (_) { hideTopLoader(); }
    loadingOlder = false;
  }
  function buildMsgEl(msg) {
    const self = msg.senderId && S.userId && msg.senderId.toString() === S.userId;
    const c = avColor(msg.username), ini = (msg.username || "?")[0].toUpperCase();
    const div = document.createElement("div");
    div.className = "chat-msg" + (self ? " self" : "");
    div.innerHTML =
      '<div class="msg-av" style="background:' + c + '">' + ini + "</div>" +
      '<div class="msg-body">' +
        '<div class="msg-head">' +
          '<span class="msg-name' + (self ? " self" : "") + '">' + esc(msg.username) + "</span>" +
          '<span class="msg-ts">' + fmtMsgTs(msg.timestamp) + "</span>" +
        "</div>" +
        '<div class="msg-text">' + esc(msg.text) + "</div>" +
      "</div>";
    return div;
  }
  function appendMessage(msg, auto) {
    const near = dom.chatMsgs.scrollHeight - dom.chatMsgs.scrollTop - dom.chatMsgs.clientHeight < 120;
    dom.chatMsgs.appendChild(buildMsgEl(msg));
    if (auto && near) dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  function addSystemMsg(text) {
    const div = document.createElement("div");
    div.className = "chat-sys";
    div.textContent = text;
    dom.chatMsgs.appendChild(div);
    dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  function showTopLoader() {
    if (dom.chatMsgs.querySelector(".chat-loader")) return;
    const el = document.createElement("div");
    el.className = "chat-loader";
    el.innerHTML = '<span class="chat-spinner"></span><span>Loading earlier messages…</span>';
    dom.chatMsgs.insertBefore(el, dom.chatMsgs.firstChild);
  }
  function hideTopLoader() { const el = dom.chatMsgs.querySelector(".chat-loader"); if (el) el.remove(); }
  function markStartReached() {
    if (startMarkerShown) return;
    startMarkerShown = true;
    const el = document.createElement("div");
    el.className = "chat-start";
    el.textContent = "✨ This is the beginning of the conversation";
    dom.chatMsgs.insertBefore(el, dom.chatMsgs.firstChild);
  }
  /* ═══════ HELPERS ═══════ */
  function delay(ms)     { return new Promise((r) => setTimeout(r, ms)); }
  function esc(s)        { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
  function fmtTime(s)    { if (isNaN(s)) return "0:00"; const m = Math.floor(s / 60), sec = Math.floor(s % 60); return m + ":" + (sec < 10 ? "0" : "") + sec; }
  function fmtMsgTs(ts)  { const d = ts ? new Date(ts) : new Date(); return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0"); }
  function avColor(name) { if (!name) return AV_COLORS[0]; let h = 0; for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h); return AV_COLORS[Math.abs(h) % AV_COLORS.length]; }
  function toast(msg, type) {
    const el = document.createElement("div");
    el.className = "toast toast-" + (type || "success");
    el.innerHTML = '<span class="toast-ic">' + (type === "error" ? "⚠️" : "✓") + '</span><span>' + esc(msg) + '</span>';
    dom.toasts.appendChild(el);
    setTimeout(() => { el.classList.add("hiding"); setTimeout(() => el.remove(), 300); }, 3200);
  }
})();