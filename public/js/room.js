(function () {
  "use strict";
  /* ====== CONFIG ====== */
  const MODES = {
    study: { label: "Study", icon: "📚" },
    gaming: { label: "Gaming", icon: "🎮" },
    entertainment: { label: "Entertainment", icon: "🎬" },
    casual: { label: "Casual", icon: "☕" },
  };
  const AV_COLORS = [
    "#e11d48",
    "#eab308",
    "#22c55e",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#f97316",
    "#06b6d4",
    "#6366f1",
    "#14b8a6",
  ];
  /* ====== STATE ====== */
  const S = { room: null, userId: null, username: "You" };
  const roomId = location.pathname.replace(/.*\/room\//, "").replace(/\/$/, "");
  let socket = null;
  let videoLoaded = false;
  // chat pagination state
  let oldestMsgId = null;
  let hasMoreMsgs = false;
  let loadingOlder = false;
  let startMarkerShown = false; // <-- add this
  /* ====== DOM ====== */
  const $ = (id) => document.getElementById(id);
  const dom = {
    root: $("roomPage"),
    sky: $("skyBg"),
    details: $("roomDetails"),
    hdrName: $("hdrName"),
    hdrBadge: $("hdrBadge"),
    hdrDot: $("hdrDot"),
    videoWrap: $("videoWrapper"),
    placeholder: $("videoPlaceholder"),
    controls: $("videoControls"),
    container: $("videoContainer"),
    chatMsgs: $("chatMessages"),
    chatInput: $("chatInput"),
    chatOnline: $("chatOnline"),
    toasts: $("toastWrap"),
  };
  /* ====== INIT ====== */
  document.addEventListener("DOMContentLoaded", async () => {
    const tod = resolveTod();
    dom.root.dataset.theme = tod;
    dom.sky.style.backgroundImage = "url('/assets/" + tod + "/sky.png')";
    wireEvents();
    await fetchMe();
    connectSocket();
  });
  function resolveTod() {
    try {
      if (typeof getTimeOfDay === "function") return getTimeOfDay();
    } catch (_) {}
    var h = new Date().getHours();
    if (h >= 6 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 21) return "evening";
    return "night";
  }
  function loadVideoFromInput() {
    var url = $("urlInput").value.trim();
    if (!url) {
      toast("Enter a URL", "error");
      return;
    }
    if (!extractYT(url) && !/^https?:\/\/.+/.test(url)) {
      toast("Enter a valid URL", "error");
      return;
    }
    socket.emit("video-load", { url }); // server broadcasts back → everyone loads
  }
  /* ====== EVENTS ====== */
  function wireEvents() {
    $("backBtn").onclick = leaveRoom;
    $("leaveBtn").onclick = leaveRoom;
    $("loadUrlBtn").onclick = loadVideoFromInput;
    $("urlInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadVideoFromInput();
    });
    $("sendBtn").onclick = sendMessage;
    dom.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    dom.chatMsgs.addEventListener("scroll", onChatScroll);
    dom.container.addEventListener("touchstart", () => {
      dom.controls.classList.add("show");
      clearTimeout(dom.controls._t);
      dom.controls._t = setTimeout(
        () => dom.controls.classList.remove("show"),
        3000,
      );
    });
  }
  /* ====== API ====== */
  async function fetchMe() {
    try {
      var r = await fetch("/api/auth/me", { credentials: "include" });
      if (!r.ok) return;
      var d = await r.json(),
        u = d.user || d;
      S.userId = (u.id || u._id || "").toString();
      S.username = u.username || "You";
    } catch (_) {}
  }
  /* ====== SOCKET ====== */
  function connectSocket() {
    socket = io({ withCredentials: true });
    socket.on("connect", () => socket.emit("join-room", { roomId }));
    socket.on("connect_error", () => {
      toast("Session expired — please log in", "error");
      setTimeout(() => (location.href = "/"), 1500);
    });
    socket.on("room-state", async ({ room }) => {
      S.room = room;
      isHost = !!(
        room.admin &&
        room.admin.userId &&
        S.userId &&
        room.admin.userId.toString() === S.userId
      );
      renderHeader();
      renderDetails();
      addSystemMsg("You joined the room");
      if (room.video && room.video.url) {
        buildPlayer(
          room.video.url,
          room.video.currentTime || 0,
          !!room.video.isPlaying,
        );
      }
      startHeartbeat();
      await loadInitialMessages();
    });
    // ===== video sync incoming =====
    socket.on("video-load", ({ url, by }) => {
      buildPlayer(url, 0, false);
      if (by && by !== S.username) toast((by || "Someone") + " loaded a video");
    });
    socket.on("video-play", ({ currentTime }) => {
      if (!player) return;
      withSuppress(() => {
        player.seek(currentTime);
        player.play();
      });
    });
    socket.on("video-pause", ({ currentTime }) => {
      if (!player) return;
      withSuppress(() => {
        player.seek(currentTime);
        player.pause();
      });
    });
    socket.on("video-seek", ({ currentTime }) => {
      if (!player) return;
      withSuppress(() => {
        player.seek(currentTime);
      });
    });
    socket.on("video-heartbeat", ({ currentTime, isPlaying }) => {
      if (!player || isHost) return; // host doesn't correct itself
      if (Math.abs(player.getTime() - currentTime) > 0.75) {
        withSuppress(() => player.seek(currentTime));
      }
      if (isPlaying && player.isPaused()) withSuppress(() => player.play());
      if (!isPlaying && !player.isPaused()) withSuppress(() => player.pause());
    });
    socket.on("room-error", ({ message }) => {
      toast(message || "Room error", "error");
      setTimeout(() => (location.href = "/dashboard"), 1500);
    });
    socket.on("participants-update", ({ participants, count }) => {
      if (!S.room) return;
      S.room.participants = participants;
      renderDetails();
      dom.chatOnline.textContent = count + " in room";
    });
    socket.on("user-joined", ({ username }) =>
      addSystemMsg(username + " joined"),
    );
    socket.on("user-left", ({ username }) => addSystemMsg(username + " left"));
    socket.on("chat-message", (msg) => appendMessage(msg, true));
  }
  function leaveRoom() {
    if (socket) socket.emit("leave-room");
    location.href = "/dashboard";
  }
  /* ====== RENDER ROOM ====== */
  function renderHeader() {
    var r = S.room;
    if (!r) return;
    var cfg = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
    var bc = "badge-" + (MODES[r.mode] ? r.mode : "casual");
    dom.hdrName.textContent = r.roomName;
    dom.hdrBadge.className = "mode-badge " + bc;
    dom.hdrBadge.textContent = cfg.icon + " " + cfg.label;
    dom.hdrBadge.style.display = "";
    dom.hdrDot.className = "status-dot status-" + (r.status || "active");
    dom.hdrDot.style.display = "";
  }
  function renderDetails() {
    var r = S.room;
    if (!r) return;
    var cfg = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
    var bc = "badge-" + (MODES[r.mode] ? r.mode : "casual");
    var parts = r.participants || [];
    dom.details.innerHTML =
      '<h2 class="rd-name">' +
      esc(r.roomName) +
      "</h2>" +
      (r.description
        ? '<p class="rd-desc">' + esc(r.description) + "</p>"
        : "") +
      '<div class="rd-meta">' +
      '<span class="mode-badge ' +
      bc +
      '">' +
      cfg.icon +
      " " +
      cfg.label +
      "</span>" +
      '<span style="display:flex;align-items:center;gap:.3rem"><span class="status-dot status-' +
      (r.status || "active") +
      '"></span>' +
      esc(r.status || "active") +
      "</span>" +
      '<span class="rd-meta-sep">·</span>' +
      "<span>Hosted by <strong>" +
      esc(r.admin ? r.admin.username : "—") +
      "</strong></span>" +
      '<span class="rd-meta-sep">·</span>' +
      "<span>👥 " +
      parts.length +
      "/" +
      (r.maxParticipants || 10) +
      "</span>" +
      "</div>" +
      (r.tags && r.tags.length
        ? '<div class="rd-tags">' +
          r.tags
            .map((t) => '<span class="tag">#' + esc(t) + "</span>")
            .join("") +
          "</div>"
        : "") +
      renderAvatars(parts);
    dom.chatOnline.textContent = parts.length + " in room";
  }
  function renderAvatars(list) {
    if (!list.length) return "";
    var MAX = 10,
      show = list.slice(0, MAX),
      extra = list.length - MAX;
    var h = '<div class="rd-avatars">';
    show.forEach((p) => {
      var c = avColor(p.username),
        ini = (p.username || "?")[0].toUpperCase();
      h +=
        '<div class="avatar-sm" style="background:' +
        c +
        '" title="' +
        esc(p.username) +
        '">' +
        ini +
        "</div>";
    });
    if (extra > 0)
      h += '<div class="avatar-sm avatar-more">+' + extra + "</div>";
    return h + "</div>";
  }
  /* ====== VIDEO PLAYER (synced) ====== */
  let player = null; // unified interface: play/pause/seek/getTime/isPaused/destroy
  let videoEl = null; // html5 element (for custom controls)
  let suppress = false; // true while applying a remote action (prevents echo)
  let isHost = false;
  let heartbeatTimer = null;
  let seekWatch = null,
    lastWatchTime = 0,
    watchStamp = 0;
  let ytApiLoading = false,
    ytCallbacks = [];
  function withSuppress(fn, ms) {
    suppress = true;
    try {
      fn();
    } catch (_) {}
    clearTimeout(withSuppress._t);
    withSuppress._t = setTimeout(() => (suppress = false), ms || 800);
  }
  function emitVideo(type) {
    if (!socket || !player || suppress) return;
    socket.emit(type, { currentTime: player.getTime() });
  }
  function destroyPlayer() {
    stopSeekWatcher();
    if (player && player.destroy) {
      try {
        player.destroy();
      } catch (_) {}
    }
    player = null;
    videoEl = null;
  }
  function buildPlayer(url, startAt, autoplay) {
    destroyPlayer();
    videoLoaded = true;
    $("urlInput").value = url;
    if (dom.placeholder && dom.placeholder.parentNode) dom.placeholder.remove();
    var ytId = extractYT(url);
    if (ytId) buildYouTube(ytId, startAt || 0, !!autoplay);
    else buildHtml5(url, startAt || 0, !!autoplay);
  }
  /* ---- HTML5 <video> ---- */
  function buildHtml5(url, startAt, autoplay) {
    dom.videoWrap.innerHTML = '<video id="videoEl" preload="metadata"></video>';
    videoEl = $("videoEl");
    videoEl.src = url;
    dom.controls.style.display = "";
    player = {
      kind: "html5",
      play: () => videoEl.play().catch(() => {}),
      pause: () => videoEl.pause(),
      seek: (t) => {
        videoEl.currentTime = t;
      },
      getTime: () => videoEl.currentTime || 0,
      getDuration: () => videoEl.duration || 0,
      isPaused: () => videoEl.paused,
      destroy: () => {
        try {
          videoEl.pause();
          videoEl.removeAttribute("src");
          videoEl.load();
        } catch (_) {}
      },
    };
    videoEl.addEventListener("loadedmetadata", () => {
      if (startAt) videoEl.currentTime = startAt;
      if (autoplay) videoEl.play().catch(() => {});
    });
    videoEl.addEventListener("play", () => emitVideo("video-play"));
    videoEl.addEventListener("pause", () => emitVideo("video-pause"));
    videoEl.addEventListener("seeked", () => emitVideo("video-seek"));
    wireVideoControls();
  }
  /* ---- YouTube (IFrame Player API) ---- */
  function buildYouTube(id, startAt, autoplay) {
    dom.controls.style.display = "none"; // use YT's native controls
    dom.videoWrap.innerHTML = '<div id="ytPlayer"></div>';
    ensureYTApi(() => {
      var yt = new YT.Player("ytPlayer", {
        width: "100%",
        height: "100%",
        videoId: id,
        playerVars: {
          autoplay: autoplay ? 1 : 0,
          rel: 0,
          start: Math.floor(startAt || 0),
          playsinline: 1,
        },
        events: {
          onReady: (e) => {
            if (startAt) e.target.seekTo(startAt, true);
            if (autoplay) e.target.playVideo();
            startSeekWatcher();
          },
          onStateChange: (e) => {
            if (suppress) return;
            if (e.data === YT.PlayerState.PLAYING) emitVideo("video-play");
            else if (e.data === YT.PlayerState.PAUSED) emitVideo("video-pause");
          },
        },
      });
      player = {
        kind: "yt",
        play: () => yt.playVideo(),
        pause: () => yt.pauseVideo(),
        seek: (t) => yt.seekTo(t, true),
        getTime: () => (yt.getCurrentTime ? yt.getCurrentTime() : 0),
        getDuration: () => (yt.getDuration ? yt.getDuration() : 0),
        isPaused: () => (yt.getPlayerState ? yt.getPlayerState() !== 1 : true),
        destroy: () => {
          try {
            yt.destroy();
          } catch (_) {}
        },
      };
    });
  }
  function ensureYTApi(cb) {
    if (window.YT && window.YT.Player) {
      cb();
      return;
    }
    ytCallbacks.push(cb);
    if (ytApiLoading) return;
    ytApiLoading = true;
    var tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = function () {
      var cbs = ytCallbacks;
      ytCallbacks = [];
      cbs.forEach((fn) => fn());
    };
  }
  // YouTube has no "seeked" event → detect jumps by polling
  function startSeekWatcher() {
    stopSeekWatcher();
    lastWatchTime = player.getTime();
    watchStamp = Date.now();
    seekWatch = setInterval(() => {
      if (!player) return;
      var t = player.getTime(),
        now = Date.now();
      var expected =
        lastWatchTime + (player.isPaused() ? 0 : (now - watchStamp) / 1000);
      if (!suppress && Math.abs(t - expected) > 1.3) emitVideo("video-seek");
      lastWatchTime = t;
      watchStamp = now;
    }, 500);
  }
  function stopSeekWatcher() {
    if (seekWatch) {
      clearInterval(seekWatch);
      seekWatch = null;
    }
  }
  /* ---- host heartbeat (drift correction) ---- */
  function startHeartbeat() {
    stopHeartbeat();
    if (!isHost) return;
    heartbeatTimer = setInterval(() => {
      if (!player || !socket) return;
      socket.emit("video-heartbeat", {
        currentTime: player.getTime(),
        isPlaying: !player.isPaused(),
      });
    }, 3000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
  /* ---- custom controls (HTML5 only) ---- */
  function wireVideoControls() {
    if (!videoEl) return;
    var prog = $("progressBar"),
      cur = $("curTime"),
      dur = $("durTime");
    var playBtn = $("playBtn"),
      muteBtn = $("muteBtn"),
      volBar = $("volBar"),
      fsBtn = $("fsBtn");
    videoEl.addEventListener("loadedmetadata", () => {
      dur.textContent = fmtTime(videoEl.duration);
      prog.max = Math.floor(videoEl.duration * 100) || 1000;
      fillSlider(volBar, 100, 100);
    });
    videoEl.addEventListener("timeupdate", () => {
      cur.textContent = fmtTime(videoEl.currentTime);
      prog.value = Math.floor(videoEl.currentTime * 100);
      fillSlider(prog, prog.value, prog.max);
    });
    videoEl.addEventListener("play", () => {
      playBtn.innerHTML = pauseSVG;
    });
    videoEl.addEventListener("pause", () => {
      playBtn.innerHTML = playSVG;
    });
    videoEl.addEventListener("ended", () => {
      playBtn.innerHTML = playSVG;
    });
    playBtn.onclick = togglePlay;
    videoEl.onclick = togglePlay;
    prog.addEventListener("input", () => {
      videoEl.currentTime = prog.value / 100;
      fillSlider(prog, prog.value, prog.max);
    });
    muteBtn.onclick = () => {
      videoEl.muted = !videoEl.muted;
      muteBtn.innerHTML = videoEl.muted ? mutedSVG : volSVG;
    };
    volBar.addEventListener("input", () => {
      videoEl.volume = volBar.value / 100;
      videoEl.muted = videoEl.volume === 0;
      muteBtn.innerHTML = videoEl.muted ? mutedSVG : volSVG;
      fillSlider(volBar, volBar.value, 100);
    });
    fsBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else dom.container.requestFullscreen().catch(() => {});
    };
  }
  function togglePlay() {
    if (!player) return;
    if (player.isPaused()) player.play();
    else player.pause();
  }
  function extractYT(url) {
    var m = url.match(
      /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/,
    );
    return m ? m[1] : null;
  }
  /* SVG button strings (unchanged) */
  var playSVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  var pauseSVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  var volSVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  var mutedSVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  function fillSlider(el, val, max) {
    var pct = (val / max) * 100;
    el.style.background =
      "linear-gradient(to right,#fff " +
      pct +
      "%,rgba(255,255,255,.25) " +
      pct +
      "%)";
  }
  /* ====== CHAT ====== */
  function sendMessage() {
    var text = dom.chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit("chat-message", { text }); // server echoes back to all (incl. us)
    dom.chatInput.value = "";
    dom.chatInput.focus();
  }
  async function loadInitialMessages() {
    try {
      var r = await fetch("/api/rooms/" + roomId + "/messages?limit=20", {
        credentials: "include",
      });
      if (!r.ok) return;
      var d = await r.json();
      hasMoreMsgs = d.hasMore;
      oldestMsgId = d.messages.length ? d.messages[0].id : null;
      var frag = document.createDocumentFragment();
      d.messages.forEach((m) => frag.appendChild(buildMsgEl(m)));
      dom.chatMsgs.appendChild(frag);
      dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
      if (!hasMoreMsgs) markStartReached(); // already at the very beginning
    } catch (_) {}
  }
  async function onChatScroll() {
    if (
      dom.chatMsgs.scrollTop > 40 ||
      !hasMoreMsgs ||
      loadingOlder ||
      !oldestMsgId
    )
      return;
    loadingOlder = true;
    var prevHeight = dom.chatMsgs.scrollHeight; // measure BEFORE loader
    showTopLoader();
    try {
      var fetchP = fetch(
        "/api/rooms/" + roomId + "/messages?limit=20&before=" + oldestMsgId,
        { credentials: "include" },
      ).then((r) => r.json());
      // guarantee the spinner is visible long enough to read, even on a fast DB
      var d = (await Promise.all([fetchP, delay(450)]))[0];
      hasMoreMsgs = d.hasMore;
      hideTopLoader();
      if (d.messages.length) {
        oldestMsgId = d.messages[0].id;
        var frag = document.createDocumentFragment();
        d.messages.forEach((m) => frag.appendChild(buildMsgEl(m)));
        dom.chatMsgs.insertBefore(frag, dom.chatMsgs.firstChild);
        dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight - prevHeight; // keep anchor
      }
      if (!hasMoreMsgs) markStartReached();
    } catch (_) {
      hideTopLoader();
    }
    loadingOlder = false;
  }
  /* chat history UI helpers */
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function showTopLoader() {
    if (dom.chatMsgs.querySelector(".chat-loader")) return;
    var el = document.createElement("div");
    el.className = "chat-loader";
    el.innerHTML =
      '<span class="chat-spinner"></span><span>Loading earlier messages…</span>';
    dom.chatMsgs.insertBefore(el, dom.chatMsgs.firstChild);
  }
  function hideTopLoader() {
    var el = dom.chatMsgs.querySelector(".chat-loader");
    if (el) el.remove();
  }
  function markStartReached() {
    if (startMarkerShown) return;
    startMarkerShown = true;
    var el = document.createElement("div");
    el.className = "chat-start";
    el.textContent = "✨ This is the beginning of the conversation";
    dom.chatMsgs.insertBefore(el, dom.chatMsgs.firstChild);
  }
  function buildMsgEl(msg) {
    var self = msg.senderId && S.userId && msg.senderId.toString() === S.userId;
    var c = avColor(msg.username),
      ini = (msg.username || "?")[0].toUpperCase();
    var div = document.createElement("div");
    console.log(msg.senderId, S.userId, msg.senderId?.toString() === S.userId); // verify senderId comparison
    div.className = "chat-msg" + (self ? " self" : "");
    div.innerHTML =
      '<div class="msg-av" style="background:' +
      c +
      '">' +
      ini +
      "</div>" +
      '<div class="msg-body">' +
      '<div class="msg-head">' +
      '<span class="msg-name' +
      (self ? " self" : "") +
      '">' +
      esc(msg.username) +
      "</span>" +
      '<span class="msg-ts">' +
      fmtMsgTs(msg.timestamp) +
      "</span>" +
      "</div>" +
      '<div class="msg-text">' +
      esc(msg.text) +
      "</div>" +
      "</div>";
    return div;
  }
  function appendMessage(msg, autoscroll) {
    var nearBottom =
      dom.chatMsgs.scrollHeight -
        dom.chatMsgs.scrollTop -
        dom.chatMsgs.clientHeight <
      120;
    dom.chatMsgs.appendChild(buildMsgEl(msg));
    if (autoscroll && nearBottom)
      dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  function addSystemMsg(text) {
    var div = document.createElement("div");
    div.className = "chat-sys";
    div.textContent = text;
    dom.chatMsgs.appendChild(div);
    dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  /* ====== HELPERS ====== */
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }
  function fmtTime(s) {
    if (isNaN(s)) return "0:00";
    var m = Math.floor(s / 60),
      sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function fmtMsgTs(ts) {
    var d = ts ? new Date(ts) : new Date();
    return (
      d.getHours().toString().padStart(2, "0") +
      ":" +
      d.getMinutes().toString().padStart(2, "0")
    );
  }
  function avColor(name) {
    if (!name) return AV_COLORS[0];
    var h = 0;
    for (var i = 0; i < name.length; i++)
      h = name.charCodeAt(i) + ((h << 5) - h);
    return AV_COLORS[Math.abs(h) % AV_COLORS.length];
  }
  function toast(msg, type) {
    var el = document.createElement("div");
    el.className = "toast toast-" + (type || "success");
    el.textContent = msg;
    dom.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add("hiding");
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }
})();
