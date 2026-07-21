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
  const GROUP_WINDOW = 3 * 60 * 1000; // Group messages from the same sender if they are sent within 3 minutes of each other
  /* ═══════ STATE ═══════ */
  const S = {
    room: null, userId: null, username: "You", themeMode: "auto", detailsOpen: null,
    perms: { isAdmin:false, role:"member", syncMode:"host", canSync:false,
             canChangeVideo:false, canEditRoom:false, canManage:false, requestState:"none" },
    members: [], requests: [],
    video: { currentTime: 0, isPlaying: false, at: 0 },   // authoritative mirror
  };
  const roomId = location.pathname.replace(/.*\/room\//, "").replace(/\/$/, "");
  let socket = null;
  let videoLoaded = false;
  let startMarkerShown = false;
  let oldestMsgId = null, hasMoreMsgs = false, loadingOlder = false;
  let needsSync = false;
  let initialVideoState = { currentTime: 0, isPlaying: false };
  let syncFallbackTimer = null;
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
    reactHub: $("reactHub"),
    shield: $("playerShield"), vcLock: $("vcLock"),
    configBtn: $("configBtn"), gearBadge: $("gearBadge"),
    cfgSheet: $("cfgSheet"), cfgBackdrop: $("cfgBackdrop"), cfgBody: $("cfgBody"),
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
    toggle() { this.paused() ? this.play() : this.pause(); },
    /* ── sync leader: broadcasts time every SYNC_INTERVAL ── */
    startLeader() {
      clearInterval(this._syncInt);
      this._syncInt = setInterval(() => {
        if (!S.perms.canSync) return;                       // only controllers drive the clock
        if (!this.paused() && socket) socket.emit("video-time-sync", { currentTime: this.time() });
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
    wireEvents();
    await fetchMe();
    connectSocket();
  });
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
    /* collapsible room details — click anywhere on the card toggles */
    dom.details.addEventListener("click", toggleDetails);
    dom.details.setAttribute("role", "button");
    dom.details.tabIndex = 0;
    dom.details.addEventListener("keydown", (e) => {
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
    socket.on("room-state", async ({ room, perms }) => {
      S.room = room;
      if (perms) S.perms = perms;
      applyPerms();
      renderHeader(); renderDetails();
      addSystemMsg("You joined the room");
      await loadInitialMessages();
      if (room.video && room.video.url && !videoLoaded) {
        $("urlInput").value = room.video.url;
        initialVideoState = { currentTime: room.video.currentTime || 0, isPlaying: room.video.isPlaying || false };
        markLocal(initialVideoState.currentTime, initialVideoState.isPlaying);
        needsSync = true;
        await loadVideo(room.video.url, true);
      }
    });
    socket.on("room-error", ({ message }) => {
      toast(message || "Error", "error");
      setTimeout(() => (location.href = "/dashboard"), 1500);
    });

        /* ── permissions ── */
    socket.on("room-permissions", ({ perms, members, requests }) => {
      S.perms = perms || S.perms;
      S.members = members || [];
      S.requests = requests || [];
      applyPerms();
      if (isConfigOpen()) renderConfig();
    });
    socket.on("perm-denied", ({ message, video }) => {
      toast(message || "Not allowed", "error");
      if (video) { markLocal(video.currentTime, video.isPlaying); revertToRoomState(video); }
    });
    socket.on("perm-toast", ({ message, type }) => toast(message, type));
    socket.on("perm-notice", ({ text }) => addSystemMsg(text));
    socket.on("perm-request", ({ userId, username }) => showRequestPrompt(userId, username));

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
      clearTimeout(syncFallbackTimer);
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
  function toggleDetails() {
    if (!S.room) return;                          // still showing the skeleton
    S.detailsOpen = !S.detailsOpen;
    dom.details.classList.toggle("expanded", S.detailsOpen);
    dom.details.setAttribute("aria-expanded", String(S.detailsOpen));
  }
  function renderDetails() {
    const r = S.room; if (!r) return;
    if (S.detailsOpen === null) S.detailsOpen = window.innerWidth > 768;  // mobile → collapsed by default
    const cfg   = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
    const bc    = "badge-" + (MODES[r.mode] ? r.mode : "casual");
    const parts = r.participants || [];
    dom.details.innerHTML =
      /* ── always-visible header row ── */
      '<div class="rd-head">' +
        '<h2 class="rd-name">' + esc(r.roomName) + "</h2>" +
        '<span class="mode-badge ' + bc + '">' + cfg.icon + " " + cfg.label + "</span>" +
        '<span class="rd-count">👥 ' + parts.length + "/" + (r.maxParticipants || 10) + "</span>" +
        '<svg class="rd-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
      "</div>" +
      /* ── expandable body ── */
      '<div class="rd-body"><div class="rd-body-in">' +
        (r.description ? '<p class="rd-desc">' + esc(r.description) + "</p>" : "") +
        '<div class="rd-meta">' +
          '<span style="display:flex;align-items:center;gap:.3rem">' +
            '<span class="status-dot status-' + (r.status || "active") + '"></span>' +
            esc(r.status || "active") + "</span>" +
          '<span class="rd-meta-sep">·</span>' +
          "<span>Hosted by <strong>" + esc(r.admin ? r.admin.username : "—") + "</strong></span>" +
        "</div>" +
        (r.tags && r.tags.length
          ? '<div class="rd-tags">' + r.tags.map((t) => '<span class="tag">#' + esc(t) + "</span>").join("") + "</div>"
          : "") +
        renderAvatars(parts) +
      "</div></div>";
    dom.details.classList.add("rd-loaded");
    dom.details.classList.toggle("expanded", S.detailsOpen);
    dom.details.setAttribute("aria-expanded", String(S.detailsOpen));
    dom.chatOnline.textContent = parts.length + " in room";
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
    if (!fromRemote && !S.perms.canChangeVideo) { toast("Only the host can change the video", "error"); return; }
    P.destroy();
    if (dom.fxLayer) dom.fxLayer.innerHTML = "";
    const ytId = extractYT(url);
    if (ytId) {
      P.type = "youtube";
      /* controls=0 + disablekb=1 + click-shield → YouTube's chrome can no longer be used to
         pause/seek, so permissions are actually enforceable. We drive it from our own .vc bar. */
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
      P.yt = new YT.Player("ytPlayerDiv", {
        events: { onReady: onPlayerReady, onStateChange: onYTState },
      });
    } else {
      P.type = "direct";
      dom.videoWrap.innerHTML = '<video id="videoEl" preload="metadata"></video>';
      P.el = $("videoEl");
      P.el.src = url;
      wireDirectVideoEvents();                               // element-level listeners only
      P.el.addEventListener("canplay", onPlayerReady, { once: true });
    }
    dom.controls.style.display = "";                         // our bar now serves BOTH players
    startUITicker();
    if (dom.placeholder && dom.placeholder.parentNode) dom.placeholder.remove();
    $("urlInput").value = url;
    videoLoaded = true;
    if (!fromRemote && socket) socket.emit("video-load", { url });
  }

  /* Called once when the player is ready to accept commands */
  function onPlayerReady() {
    P.ready = true;
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
    if (e.data !== 1 && e.data !== 2) return;
    if (!S.perms.canSync) return revertToRoomState();        // defensive (chrome is off)
    if (e.data === 1) { socket && socket.emit("video-play",  { currentTime: P.time() }); markLocal(P.time(), true);  P.startLeader(); }
    else              { socket && socket.emit("video-pause", { currentTime: P.time() }); markLocal(P.time(), false); P.stopLeader(); }
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
    $("durTime").textContent = fmtTime(d);
    $("playBtn").innerHTML = P.paused() ? playSVG : pauseSVG;
  }
  function wirePlayerControls() {
    const prog = $("progressBar"), volBar = $("volBar");
    $("playBtn").onclick = () => { if (guardSync()) P.toggle(); };
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
    $("muteBtn").onclick = () => { const m = !P.isMuted(); P.setMuted(m); $("muteBtn").innerHTML = m ? mutedSVG : volSVG; };
    volBar.addEventListener("input", () => {
      const v = volBar.value / 100;
      P.setVol(v); P.setMuted(v === 0);
      $("muteBtn").innerHTML = v === 0 ? mutedSVG : volSVG;
      fillSlider(volBar, volBar.value, 100);
    });
    fillSlider(volBar, 100, 100);
    $("fsBtn").onclick = toggleFullscreen;
    /* keyboard */
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !P.ready) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k")       { e.preventDefault(); if (guardSync()) P.toggle(); }
      else if (k === "arrowright")      { if (guardSync()) { const t2 = P.time() + 5; P.seek(t2); emitSeek(t2); } }
      else if (k === "arrowleft")       { if (guardSync()) { const t2 = Math.max(0, P.time() - 5); P.seek(t2); emitSeek(t2); } }
      else if (k === "m")               { const m = !P.isMuted(); P.setMuted(m); $("muteBtn").innerHTML = m ? mutedSVG : volSVG; }
    });
  }
  /* element-level listeners for the direct <video> (fresh element each load) */
  function wireDirectVideoEvents() {
    const v = P.el;
    v.addEventListener("play", () => {
      if (P.isRemote()) return;
      if (!S.perms.canSync) return revertToRoomState();     // media keys / PiP / extensions
      socket && socket.emit("video-play", { currentTime: P.time() });
      markLocal(P.time(), true);
      P.startLeader();
    });
    v.addEventListener("pause", () => {
      if (P.isRemote()) return;
      if (!S.perms.canSync) return revertToRoomState();
      socket && socket.emit("video-pause", { currentTime: P.time() });
      markLocal(P.time(), false);
      P.stopLeader();
    });
    v.addEventListener("seeked", () => {
      if (P.isRemote() || !S.perms.canSync) return;
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => emitSeek(P.time()), SEEK_DEBOUNCE);
    });
  }
  function emitSeek(t) {
    if (!S.perms.canSync || !socket) return;
    socket.emit("video-seek", { currentTime: t });
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
      regroupChat();
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
        regroupChat();
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
    div.dataset.sender = msg.senderId || msg.username;
    div.dataset.ts = new Date(msg.timestamp || Date.now()).getTime();
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
    regroupChat();
    if (auto && near) dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  function addSystemMsg(text) {
    const div = document.createElement("div");
    div.className = "chat-sys";
    div.textContent = text;
    dom.chatMsgs.appendChild(div);
    dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  // Marks consecutive same-sender messages as grouped

  function regroupChat() {
    let prev = null;
    Array.from(dom.chatMsgs.children).forEach((el) => {
      if (!el.classList.contains("chat-msg")) { prev = null; return; } // sys msgs / loaders break grouping
      const sender = el.dataset.sender, ts = parseInt(el.dataset.ts, 10);
      const grouped = prev && prev.sender === sender && !isNaN(ts) && (ts - prev.ts) < GROUP_WINDOW;
      el.classList.toggle("grouped", grouped);
      prev = { sender, ts };
    });
  }

  // "Loading earlier messages…" loader at the top of the chat
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

  /* ══════════════════════════════════════
     PERMISSIONS UI + ROOM CONFIG SHEET
     ══════════════════════════════════════ */
  function applyPerms() {
    const p = S.perms;
    dom.container.classList.toggle("locked", !p.canSync);
    $("playBtn").disabled     = !p.canSync;
    $("progressBar").disabled = !p.canSync;
    dom.vcLock.style.display  = p.canSync ? "none" : "";
    const ui = $("urlInput"), lb = $("loadUrlBtn");
    ui.disabled = lb.disabled = !p.canChangeVideo;
    ui.placeholder = p.canChangeVideo ? "Paste video URL (.mp4, YouTube, etc.)" : "Only the host can change the video";
    const n = p.canManage ? S.requests.length : 0;
    dom.gearBadge.classList.toggle("is-hidden", n === 0);
    dom.gearBadge.textContent = n;  
    if (!p.canSync) P.stopLeader();
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
    dom.cfgSheet.classList.remove("open");
    dom.cfgBackdrop.classList.remove("open");
    dom.cfgSheet.setAttribute("aria-hidden", "true");
  }
  const ROLE_LABEL = { admin: "Host", mod: "Mod", member: "Member" };
  function renderConfig() {
    const p = S.perms, r = S.room || {};
    const online = new Set((r.participants || []).map((x) => (x.userId || "").toString()));
    let h = "";
    /* ── my access (non-hosts) ── */
    if (!p.canManage) {
      const st = p.canSync ? "granted" : p.requestState;
      h += '<section class="cfg-sec"><h4>Your access</h4>' +
           '<div class="cfg-row"><span>Playback control</span>' +
             '<span class="pill ' + (p.canSync ? "pill-ok" : "pill-no") + '">' +
             (p.canSync ? "Allowed" : "Host-controlled") + "</span></div>";
      if (!p.canSync) {
        if (st === "pending")      h += '<p class="cfg-note">⏳ Request sent — waiting for the host.</p>';
        else if (st === "denied")  h += '<p class="cfg-note">🚫 The host declined. They can still grant it from their settings.</p>';
        else                       h += '<button class="cfg-btn primary" data-act="request">Request playback control</button>';
      }
      h += "</section>";
    }
    /* ── sync mode (host only) ── */
    if (p.canManage) {
      h += '<section class="cfg-sec"><h4>Who can play / pause / seek</h4>' +
           '<div class="seg">' +
             '<button class="seg-btn' + (p.syncMode === "host" ? " on" : "") + '" data-act="mode" data-mode="host">🔒 Host only</button>' +
             '<button class="seg-btn' + (p.syncMode === "everyone" ? " on" : "") + '" data-act="mode" data-mode="everyone">👥 Everyone</button>' +
           "</div>" +
           '<p class="cfg-note">Only you can change the video, regardless of this setting.</p></section>';
      /* ── pending requests ── */
      if (S.requests.length) {
        h += '<section class="cfg-sec"><h4>Requests <span class="cnt">' + S.requests.length + "</span></h4>";
        S.requests.forEach((m) => {
          h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(m.username) + esc(m.username) + "</span>" +
               '<span class="cfg-acts">' +
                 '<button class="cfg-mini ok"  data-act="respond" data-approve="1" data-id="' + m.userId + '">Approve</button>' +
                 '<button class="cfg-mini no" data-act="respond" data-approve="0" data-id="' + m.userId + '">Deny</button>' +
               "</span></div>";
        });
        h += "</section>";
      }
      /* ── people ── */
      h += '<section class="cfg-sec"><h4>People</h4>';
      S.members.forEach((m) => {
        const isHost = m.role === "admin";
        const locked = isHost || p.syncMode === "everyone" || m.role === "mod";   // implicit control
        h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(m.username) +
               '<span class="cfg-uname">' + esc(m.username) +
                 (online.has(m.userId) ? '<i class="dot-on" title="In room"></i>' : "") +
               "</span>" +
               '<span class="role-tag role-' + m.role + '">' + ROLE_LABEL[m.role] + "</span>" +
             "</span>" +
             '<span class="cfg-acts">' +
               (isHost ? "" :
                 '<select class="cfg-sel" data-act="role" data-id="' + m.userId + '">' +
                   '<option value="member"' + (m.role === "member" ? " selected" : "") + ">Member</option>" +
                   '<option value="mod"' + (m.role === "mod" ? " selected" : "") + ">Mod</option>" +
                 "</select>") +
               '<label class="sw' + (locked ? " sw-lock" : "") + '" title="Can control playback">' +
                 '<input type="checkbox" data-act="sync" data-id="' + m.userId + '"' +
                   (m.canSync ? " checked" : "") + (locked ? " disabled" : "") + ">" +
                 '<span class="sw-track"><span class="sw-knob"></span></span>' +
               "</label>" +
             "</span></div>";
      });
      h += '<p class="cfg-note">Mods get playback control automatically. Room-editing powers for mods are coming soon.</p></section>';
      /* ── room details (UI only for now) ── */
      h += '<section class="cfg-sec cfg-soon"><h4>Room details <span class="soon">Coming soon</span></h4>' +
           '<label class="cfg-field"><span>Name</span><input type="text" value="' + esc(r.roomName || "") + '" disabled></label>' +
           '<label class="cfg-field"><span>Description</span><textarea rows="2" disabled>' + esc(r.description || "") + "</textarea></label>" +
           '<label class="cfg-field"><span>Mode</span><select disabled>' +
             Object.keys(MODES).map((k) => '<option' + (r.mode === k ? " selected" : "") + ">" + MODES[k].icon + " " + MODES[k].label + "</option>").join("") +
           "</select></label>" +
           '<label class="cfg-field"><span>Tags</span><input type="text" value="' + esc((r.tags || []).join(", ")) + '" disabled></label>' +
           '<label class="cfg-field"><span>Visibility</span><select disabled><option>' + (r.isPublic === false ? "Private" : "Public") + "</option></select></label>" +
           '<label class="cfg-field"><span>Max participants</span><input type="number" value="' + (r.maxParticipants || 10) + '" disabled></label>' +
           '<button class="cfg-btn" disabled>Save changes</button></section>';
    }
    dom.cfgBody.innerHTML = h;
  }
  function avatarHTML(name) {
    return '<span class="cfg-av" style="background:' + avColor(name) + '">' + (name || "?")[0].toUpperCase() + "</span>";
  }
  /* delegated actions inside the sheet */
  function onCfgClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const act = el.dataset.act;
    if (act === "request")  socket && socket.emit("perm-request");
    if (act === "mode")     socket && socket.emit("perm-set-mode", { mode: el.dataset.mode });
    if (act === "respond")  socket && socket.emit("perm-respond", { userId: el.dataset.id, approve: el.dataset.approve === "1" });
  }
  function onCfgChange(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    if (el.dataset.act === "sync") socket && socket.emit(el.checked ? "perm-grant" : "perm-revoke", { userId: el.dataset.id });
    if (el.dataset.act === "role") socket && socket.emit("perm-set-role", { userId: el.dataset.id, role: el.value });
  }
  function dom_cfgDelegate() {
    dom.cfgBody.addEventListener("click", onCfgClick);
    dom.cfgBody.addEventListener("change", onCfgChange);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", dom_cfgDelegate, { once: true });
  } else {
    dom_cfgDelegate();
  }
  /* host-side approve/deny prompt */
  function showRequestPrompt(userId, username) {
    if (dom.toasts.querySelector('[data-req="' + userId + '"]')) return;
    const el = document.createElement("div");
    el.className = "perm-prompt";
    el.dataset.req = userId;
    el.innerHTML =
      '<div class="pp-txt"><strong>' + esc(username) + "</strong> wants playback control</div>" +
      '<div class="pp-acts"><button class="cfg-mini ok">Approve</button><button class="cfg-mini no">Deny</button></div>';
    const [ok, no] = el.querySelectorAll("button");
    ok.onclick = () => { socket.emit("perm-respond", { userId, approve: true  }); el.remove(); };
    no.onclick = () => { socket.emit("perm-respond", { userId, approve: false }); el.remove(); };
    dom.toasts.appendChild(el);
    setTimeout(() => el.remove(), 30000);   // falls back to the pending list in settings
  }

})();


