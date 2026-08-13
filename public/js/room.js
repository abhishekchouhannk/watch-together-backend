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
    perms: { isAdmin:false, isMod:false, role:"member",
             syncMode:"host", queueMode:"host", autoplay:true,
             canSync:false, canQueue:false, canChangeVideo:false,
             canEditRoom:false, canManage:false, canGrantSync:false, canGrantQueue:false,
             requestState:"none", queueRequestState:"none" },
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
    /* ── SVG fragments ── */
  const CHEV_SVG =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none">' +
    '<path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const STEP_UP =
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none">' +
    '<path d="M2.5 6.5L5 4L7.5 6.5" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const STEP_DN =
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none">' +
    '<path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /* ── collapse bookkeeping (survives re-renders) ── */
  S.cfgCollapsed = {};          // { people: true, room: false, … }
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
  const SEC_CLOSE = "</div></div></section>";

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
    /* ── side-panel unread ── */
    dom.chatJump.onclick = () => Unread.jump();
    /* the click fires before/after Q.switchTab depending on order — defer a frame so the
       pane's .active class is already settled */
    dom.tabChat.addEventListener("click", () =>
      requestAnimationFrame(() => { Unread.onChatShown(), SYS.sweep(); }));
    document.addEventListener("visibilitychange", () => { Unread.sync(); SYS.sweep(); });
    window.addEventListener("focus", () => Unread.sync());
    Unread.paint();
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
      renderRoomDetails();
      addSystemMsg("You joined the room", { silent: true });   // ← silenced
      await loadInitialMessages();
      if (room.queue) Q.applyRemote(room.queue);
      if (room.video && room.video.url) {
        S.currentItemId = room.video.itemId || null;
        initialVideoState = { currentTime: room.video.currentTime, isPlaying: room.video.isPlaying };
        needsSync = true;
        loadVideo(room.video.url, true);
      }
    });
    socket.on("room-error", ({ message }) => {
      toast(message || "Error", "error");
      setTimeout(() => (location.href = "/dashboard"), 1500);
    });
    socket.on("queue-update", (p) => Q.applyRemote(p));
    socket.on("queue-ended", () => {
      Q.resetUpNext();
      addSystemMsg("Queue finished 🎉");
      toast("Queue finished 🎉", "success");
    });
    socket.on("chat-system", ({ text, byId }) => addSystemMsg(text, { silent: isMe(byId) }));

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

    /* presence moves the validation floor */
    socket.on("participants-update", ({ participants, count }) => {
      S.room = Object.assign({}, S.room, { participants: participants || [] });
      renderRoomDetails();
      if (isConfigOpen()) { refreshMaxHint(); syncDirtyUI(); }
    });
    socket.on("room-kicked", ({ message }) => {
      bounceToDashboard(message || "You were removed from this room");
    });
    socket.on("room-error", ({ message, fatal }) => {
      if (fatal) return bounceToDashboard(message || "You can't join this room");
      toast(message, "error");           
    });
    socket.on("user-joined", ({ username }) => addSystemMsg(username + " joined"));
    socket.on("user-left",   ({ username }) => addSystemMsg(username + " left"));
    /* ── chat ── */
    socket.on("chat-message", (msg) => appendMessage(msg, true));
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
  function bounceToDashboard(text) {
    try { sessionStorage.setItem("wp:notice", JSON.stringify({ text, type: "error" })); } catch (_) {}
    try { socket.disconnect(); } catch (_) {}
    window.location.replace("/dashboard");   // ← adjust if dashboard lives elsewhere
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
  // update everything together
  function renderRoomDetails() {
    renderHeader();
    renderDetails();
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
      return { title: "", author: "", thumb: fallbackThumb, aspect: null };
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
  const UPNEXT_AT = 10;              // seconds before end → show card
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
      if (socket) socket.emit("video-ended", { itemId: S.currentItemId });
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
      if (st.items.length === 0 && manage && !videoLoaded) {
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
    function emit(ev, data) { if (socket) socket.emit(ev, data); }
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
      ytLetterbox.attach($("videoContainer"), $("ytPlayerDiv"), ytId);
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
    videoLoaded = true;
    Q.render();
  }

  function reportDuration() {
    if (!socket || !S.currentItemId || !S.perms.canSync) return;
    const tryIt = () => {
      const d = P.dur();
      if (d > 0) socket.emit("queue-duration", { id: S.currentItemId, duration: d });
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
    if (!needsSync) return;
    needsSync = false;
    /* auto-advance / play-now: the server told us to roll */
    if (pendingAutoplay) {
      pendingAutoplay = false;
      needsSync = false;
      P.remote(() => P.play(0));
      reportDuration();
      return;
    }
    reportDuration();
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
    if (e.data === 0) return Q.onEnded();            // ENDED
    if (e.data === 2) flashInfoBar();                   // show title card on pause
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
    volBar.addEventListener("input", () => {
      const v = volBar.value / 100;
      P.setVol(v); P.setMuted(v === 0);
      $("muteBtn").innerHTML = v === 0 ? mutedSVG : volSVG;
      fillSlider(volBar, volBar.value, 100);
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
    v.addEventListener("ended", () => Q.onEnded());
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
  const bigPlay  = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  const bigPause = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
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

  /* ══════════════════════════════════════
     SIDE-PANEL BADGES (unread chat/room updates)
     ══════════════════════════════════════ */
  const BADGE_CAP = 10;                                    // 11 → "10+"
  const fmtBadge  = (n) => (n > BADGE_CAP ? BADGE_CAP + "+" : String(n));
  const isMe      = (id) => !!(id && S.userId && id.toString() === S.userId);
  const Unread = {
    n: 0,
    stick: true,            // should the log snap to the bottom next time it's shown?
    _title: document.title,
    _raf: 0,
    chatOnScreen() { return dom.paneChat.classList.contains("active"); },
    atBottom(slack) {
      const el = dom.chatMsgs;
      return el.scrollHeight - el.scrollTop - el.clientHeight <= (slack == null ? 120 : slack);
    },
    /* "the user is demonstrably looking at the newest line" */
    watching() { return !document.hidden && this.chatOnScreen() && this.atBottom(); },
    toEnd() { dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight; },
    /* ── called for every NEW line appended to the log (never for history) ── */
    note(opts) {
      opts = opts || {};
      if (opts.stick !== undefined) this.stick = !!opts.stick;
      if (opts.silent) return false;                 // my own message / my own action
      if (this.watching()) return false;             // already on screen at the bottom
      this.n++;
      this.paint();
      return true;                                     // user should be notified
    },
    /* an unseen notice expired → give the badge its point back */
    drop(k) {
      if (!this.n) return;
      this.n = Math.max(0, this.n - (k || 1));
      this.paint();
    },
    /* once the user has seen everything, no element may claim "unread" later */
    _forget() {
      dom.chatMsgs.querySelectorAll("[data-unread]").forEach((el) => delete el.dataset.unread);
    },
    clear() { this.n = 0; this._forget(); this.paint(); },
    sync()  { if (this.watching()) { this.n = 0; this._forget(); } this.paint(); },
    /* chat pane just became visible */
    onChatShown() {
      if (this.stick) this.toEnd();            // content added while display:none loses scrollTop
      this.sync();
    },
    onScroll() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        if (this.chatOnScreen()) this.stick = this.atBottom();
        this.sync();
      });
    },
    jump() { this.toEnd(); this.clear(); },
    paint() {
      const n = this.n, label = fmtBadge(n);
      dom.chatUnread.hidden      = n === 0;
      dom.chatUnread.textContent = label;
      dom.chatUnread.title       = n === 1 ? "1 new update" : n + " new updates";
      dom.tabChat.classList.toggle("has-unread", n > 0);
      dom.tabChat.setAttribute("aria-label", n ? "Chat, " + label + " new updates" : "Chat");
      /* pill only makes sense while the chat is on screen but scrolled away */
      const showPill = n > 0 && this.chatOnScreen() && !this.atBottom();
      dom.chatJump.hidden = !showPill;
      dom.chatJumpN.textContent = label;
      document.title = n > 0 ? "(" + label + ") " + this._title : this._title;
    },
  };

  /* ══════════════════════════════════════
     EPHEMERAL SYSTEM LOG — notices self-destruct so chat stays readable
     ══════════════════════════════════════ */
  const SYS = {
    TTL:      5 * 1000,  // lifetime of a notice
    GAP:      1000,           // min *stillness* between two animated removals
    OUT_MS:   560,            // must be ≥ the CSS exit duration (500ms) + slack
    SCROLL_HOLD: 1200,        // never animate right after the user scrolled
    MAX_LIVE: 15,             // burst guard: pull in expiry when notices pile up
    EARLY:    8000,
    items: [],                // [{el, exp}] — insertion order == expiry order
    timer: 0, lastOut: 0, holdUntil: 0, animating: false,
    /* ── register a notice ── */
    track(el, ttl) {
      this.items.push({ el, exp: Date.now() + (ttl || this.TTL) });
      this.trim();
      this.schedule();
    },
    /* a wall of notices shouldn't sit around for the full 5 min */
    trim() {
      const over = this.items.length - this.MAX_LIVE;
      if (over <= 0) return;
      const soon = Date.now() + this.EARLY;
      for (let i = 0; i < over; i++)
        if (this.items[i].exp > soon) this.items[i].exp = soon;
    },
    hold(ms) { this.holdUntil = Math.max(this.holdUntil, Date.now() + ms); },
    schedule() {
      clearTimeout(this.timer); this.timer = 0;
      if (this.animating || !this.items.length) return;
      this.timer = setTimeout(() => this.sweep(), Math.max(this.items[0].exp - Date.now(), 50));
    },
    sweep() {
      clearTimeout(this.timer); this.timer = 0;
      if (this.animating) return;                       // the callback re-arms us
      const now = Date.now();
      let pending = null;
      /* everything the user can't see goes instantly & silently */
      while (this.items.length) {
        const it = this.items[0];
        if (!it.el.isConnected) { this.items.shift(); continue; }
        if (it.exp > now) break;                        // ordered ⇒ nothing else is due
        if (this.visible(it.el)) { pending = it; break; }
        this.items.shift();
        this.yank(it.el);
      }
      /* at most ONE animated removal, and only when the view is calm */
      if (pending) {
        const wait = Math.max(this.GAP - (now - this.lastOut), this.holdUntil - now);
        if (wait > 0) { this.timer = setTimeout(() => this.sweep(), wait); return; }
        this.items.shift();
        this.animating = true;
        this.fade(pending.el, () => {
          this.animating = false;
          this.lastOut  = Date.now();                   // 2s of stillness AFTER the collapse
          this.schedule();
        });
        return;
      }
      this.schedule();
    },
    /* is this notice actually on screen *and* being looked at? */
    visible(el) {
      if (document.hidden) return false;
      if (!dom.paneChat.classList.contains("active")) return false;
      const c = dom.chatMsgs;
      if (!c.clientHeight || !el.offsetParent) return false;   // display:none ⇒ not rendered
      const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
      return r.bottom > cr.top + 4 && r.top < cr.bottom - 4;
    },
    /* instant removal, scroll-stable, badge-accurate */
    yank(el) {
      const c = dom.chatMsgs;
      const shown  = dom.paneChat.classList.contains("active") && c.clientHeight > 0;
      const above  = shown && el.getBoundingClientRect().bottom <= c.getBoundingClientRect().top;
      const before = shown ? c.scrollHeight : 0;
      const top    = c.scrollTop;
      this.uncount(el);
      el.remove();
      if (above) {                                      // content above the viewport vanished →
        const delta = before - c.scrollHeight;          // pull scrollTop back by exactly that much
        if (delta > 0) c.scrollTop = Math.max(0, top - delta);
      }
    },
    /* animated removal: fade, then collapse the gap */
    fade(el, done) {
      const c = dom.chatMsgs;
      const pinned = Unread.atBottom(8);
      el.style.height   = el.offsetHeight + "px";       // height:auto can't transition
      el.style.overflow = "hidden";
      void el.offsetHeight;                             // commit the start height
      el.classList.add("sys-out");
      el.style.height   = "0px";                        // …now the delayed collapse runs
      /* hold the bottom while the gap closes so the log never "drops" */
      let stop = false;
      if (pinned) {
        const keep = () => { if (stop) return; c.scrollTop = c.scrollHeight; requestAnimationFrame(keep); };
        requestAnimationFrame(keep);
      }
      setTimeout(() => {
        stop = true;
        this.uncount(el);
        el.remove();
        if (pinned) c.scrollTop = c.scrollHeight;
        done && done();
      }, this.OUT_MS);
    },
    /* a notice that dies unseen must not leave a ghost on the tab badge */
    uncount(el) {
      if (el.dataset.unread === "1") { delete el.dataset.unread; Unread.drop(1); }
    },
  };

  /* ═══════ CHAT ═══════ */
  function sendMessage() {
    const text = dom.chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit("chat-message", { text });
    dom.chatInput.value = "";
    dom.chatInput.focus();
    Unread.stick = true;
    Unread.clear();
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
    Unread.onScroll();
    SYS.hold(SYS.SCROLL_HOLD);            // ← never collapse under a moving finger
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
    const uid = msg.senderId ? msg.senderId.toString() : "";
    const div = document.createElement("div");
    div.className = "chat-msg" + (self ? " self" : "");
    div.dataset.sender = msg.senderId || msg.username;
    div.dataset.ts = new Date(msg.timestamp || Date.now()).getTime();
    const av = uid
      ? '<button type="button" class="msg-av" style="background:' + c + '" ' +
          'data-uid="' + esc(uid) + '" data-uname="' + esc(msg.username || "") + '" ' +
          'title="View profile" aria-label="View profile of ' + esc(msg.username || "user") + '">' +
          ini + "</button>"
      : '<div class="msg-av" style="background:' + c + '">' + ini + "</div>";
    div.innerHTML =
      av +
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
    const self = isMe(msg.senderId);
    const stick = self || Unread.atBottom();          // measure BEFORE inserting
    dom.chatMsgs.appendChild(buildMsgEl(msg));
    regroupChat();
    if (auto && stick) Unread.toEnd();
    Unread.note({ silent: self, stick });
  }
  /* opts.silent → this line describes something *I* just did */
  function addSystemMsg(text, opts) {
    opts = opts || {};
    const stick = Unread.atBottom();
    const div = document.createElement("div");
    div.className = "chat-sys" + (opts.cls ? " " + opts.cls : "");
    div.textContent = text;
    dom.chatMsgs.appendChild(div);
    if (stick) Unread.toEnd();
    if (Unread.note({ silent: !!opts.silent, stick })) div.dataset.unread = "1";
    if (!opts.persist) SYS.track(div, opts.ttl);        // ← auto-expires
    return div;
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

  const ROOM_CAP = 10;                                    // keep in step with the model
  const participantsHere = () => ((S.room && S.room.participants) || []).length;
  const participantFloor = () => Math.max(2, participantsHere());
  S.banned     = [];      // admin-only, from room-permissions
  S.cfgRowMenu = null;    // { id, confirm: null | 'ban' | 'remove' }
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
  const ROLE_LABEL = { admin: "Host", mod: "Mod", member: "Member" };
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
  const FIELD_LABEL = {
    roomName: "Name", description: "Description", mode: "Mode",
    tags: "Tags", isPublic: "Visibility", maxParticipants: "Max participants",
  };
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
  const MOD_EVT = { "do-kick": "member-kick", "do-ban": "member-ban", "do-remove": "member-remove" };
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
    if (act === "request") socket && socket.emit("perm-request", { scope: el.dataset.scope || "sync" });
    if (act === "mode")    socket && socket.emit("perm-set-mode",       { mode: el.dataset.mode });
    if (act === "qmode")   socket && socket.emit("perm-set-queue-mode", { mode: el.dataset.mode });
    if (act === "respond") socket && socket.emit("perm-respond", {
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
      socket && socket.emit(MOD_EVT[act], { userId: el.dataset.id });
      S.cfgRowMenu = null; renderConfig(); return;
    }
    if (act === "unban") { socket && socket.emit("member-unban", { userId: el.dataset.id }); return; }
    if (act === "save-room") {
      if (!socket) return;
      if (S.roomConflict) return nudgeConflict();
      const payload = readRoomForm();
      S.roomDraft = payload;
      el.disabled = true;
      socket.emit("room-update", payload);
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
      socket && socket.emit(el.checked ? "perm-grant" : "perm-revoke", { userId: el.dataset.id, scope: a });
    if (a === "role")
      socket && socket.emit("perm-set-role", { userId: el.dataset.id, role: el.value });
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
    ok.onclick = () => { socket.emit("perm-respond", { userId, scope, approve: true  }); el.remove(); };
    no.onclick = () => { socket.emit("perm-respond", { userId, scope, approve: false }); el.remove(); };
    dom.toasts.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }

  /* ══════════════════════════════════════
     MEMBER PROFILE PANEL
     identity = /api/users/:id · moderation = reused from the config sheet
     ══════════════════════════════════════ */
  S.profile = null;                 // { userId, username, confirm, loading, error, data }
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
  function closeProfile() {
    S.profile = null;
    dom.profCard.classList.remove("open");
    dom.profBackdrop.classList.remove("open");
    dom.profCard.setAttribute("aria-hidden", "true");
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
  /* only ever render http(s) images */
  function safeHttpUrl(u) {
    if (!u) return "";
    try { const x = new URL(u, location.origin); return /^https?:$/.test(x.protocol) ? x.href : ""; }
    catch (_) { return ""; }
  }
  function fmtJoined(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
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
    const m      = (S.members || []).find((x) => x.userId === p.userId) || null;  // membership row
    const d      = p.data || {};
    const name      = d.username || (m && m.username) || p.username || "Unknown";
    const role      = m ? m.role : null;
    const isSelf    = !!S.userId && p.userId === S.userId;
    const isHostRow = role === "admin";
    const isModRow  = role === "mod";
    /* ── 1. identity — EVERYONE sees exactly this much ── */
    let h = '<div class="prof-id">' +
        profAvatarHTML(name, d.avatar) +
        '<div class="prof-name">' + esc(name) +
          (online.has(p.userId) ? '<i class="dot-on" title="In room"></i>' : "") +
          (role ? '<span class="role-tag role-' + role + '">' + ROLE_LABEL[role] + "</span>" : "") +
          (isSelf ? '<span class="prof-self">You</span>' : "") +
        "</div>" +
        '<div class="prof-meta">' +
          (p.loading ? '<span class="prof-skel"></span>'
            : p.error ? "Profile unavailable"
            : d.createdAt ? "Joined " + esc(fmtJoined(d.createdAt))
            : "Join date unknown") +
        "</div>" +
      "</div>";
    /* ── 2. everything below is host/mod only, and never targets yourself ── */
    if (me.canManage && m && !isSelf) {
      /* permissions — mods & the host are immutable (they always have both) */
      if (isHostRow) {
        h += profSec("Permissions",
          '<p class="cfg-note">The host always has playback and queue control.</p>');
      } else if (isModRow) {
        h += profSec("Permissions",
          '<p class="cfg-note">🛡️ Moderators always have playback and queue control — it can\'t be revoked.' +
          (me.canSetRoles ? " Change their role below to adjust this." : "") + "</p>");
      } else if (me.canGrantSync || me.canGrantQueue) {
        /* identical lock rules to the config sheet's member row */
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
      /* role — host only (p.canSetRoles), never on the host row */
      if (me.canSetRoles && !isHostRow) {
        h += profSec("Role",
          '<div class="cfg-row"><span>Room role</span><span class="cfg-acts">' +
            '<select class="cfg-sel" data-act="role" data-id="' + m.userId + '">' +
              '<option value="member"' + (role === "member" ? " selected" : "") + ">Member</option>" +
              '<option value="mod"'    + (isModRow ? " selected" : "") + ">Mod</option>" +
            "</select></span></div>" +
          '<p class="cfg-note">Mods can edit room details and grant playback control, but can\'t change roles.</p>');
      }
      /* moderation — host only (p.canBan), never on the host row.
         rowMenuHTML() renders kick/remove/ban *and* the destructive confirm step. */
      if (me.canBan && !isHostRow) {
        h += profSec("Moderation",
          rowMenuHTML(m, online.has(m.userId), p) +
          (p.confirm ? "" :
            '<p class="cfg-note">Kick boots them from this session. Remove deletes their membership ' +
            "and permissions. Ban also blocks them from rejoining.</p>"));
      }
    }
    dom.profBody.innerHTML = h;
    const img = dom.profBody.querySelector(".prof-av img");
    if (img) img.addEventListener("error", () => img.remove(), { once: true }); // → generated avatar
  }
  /* ── delegated clicks inside the card (change events reuse onCfgChange verbatim) ── */
  function onProfClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || !S.profile || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const a = el.dataset.act;
    if (a === "ask-ban")    { S.profile.confirm = "ban";    renderProfile(); return; }
    if (a === "ask-remove") { S.profile.confirm = "remove"; renderProfile(); return; }
    if (a === "menu-close") { S.profile.confirm = null;     renderProfile(); return; }
    if (MOD_EVT[a]) {
      socket && socket.emit(MOD_EVT[a], { userId: el.dataset.id });
      S.profile.confirm = null;
      /* kick keeps the membership → stay open; remove/ban destroys it → close */
      if (a === "do-kick") renderProfile(); else closeProfile();
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
