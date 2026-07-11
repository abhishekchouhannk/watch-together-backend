/* public/js/room.js */
(function () {
  'use strict';
  /* ====== CONFIG ====== */
  const MODES = {
    study:         { label: 'Study',         icon: '📚' },
    gaming:        { label: 'Gaming',        icon: '🎮' },
    entertainment: { label: 'Entertainment', icon: '🎬' },
    casual:        { label: 'Casual',        icon: '☕' },
  };
  const AV_COLORS    = ['#e11d48','#eab308','#22c55e','#3b82f6','#8b5cf6',
                         '#ec4899','#f97316','#06b6d4','#6366f1','#14b8a6'];
  const MSG_PAGE     = 30;            // messages per fetch
  /* ====== STATE ====== */
  const S = {
    room: null, userId: null, username: 'You',
    messages: [],                      // chronological array of loaded msgs
    loadingMsgs: false, hasMore: true,
    initialised: false,                // true after first socket join ack
  };
  const roomId = location.pathname.replace(/.*\/room\//, '').replace(/\/$/, '');
  /* ====== DOM ====== */
  const $ = id => document.getElementById(id);
  const dom = {
    root: $('roomPage'), sky: $('skyBg'),
    details: $('roomDetails'), hdrName: $('hdrName'), hdrBadge: $('hdrBadge'), hdrDot: $('hdrDot'),
    videoWrap: $('videoWrapper'), placeholder: $('videoPlaceholder'),
    controls: $('videoControls'), container: $('videoContainer'),
    chatMsgs: $('chatMessages'), chatInput: $('chatInput'), chatOnline: $('chatOnline'),
    toasts: $('toastWrap'),
  };
  /* ====== SOCKET ref ====== */
  let socket = null;
  /* ════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', async () => {
    const tod = resolveTod();
    dom.root.dataset.theme = tod;
    dom.sky.style.backgroundImage = "url('/assets/" + tod + "/sky.png')";
    wireEvents();
    await fetchMe();
    await joinRoom();
  });
  function resolveTod() {
    try { if (typeof getTimeOfDay === 'function') return getTimeOfDay(); } catch (_) {}
    const h = new Date().getHours();
    if (h >= 6  && h < 12) return 'morning';
    if (h >= 12 && h < 17) return 'afternoon';
    if (h >= 17 && h < 21) return 'evening';
    return 'night';
  }
  /* ════════════════════════════════════════════
     DOM EVENTS
  ════════════════════════════════════════════ */
  function wireEvents() {
    $('backBtn').onclick   = () => location.href = '/dashboard';
    $('leaveBtn').onclick  = leaveRoom;
    $('loadUrlBtn').onclick = () => loadVideo($('urlInput').value.trim());
    $('urlInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') loadVideo($('urlInput').value.trim());
    });
    $('sendBtn').onclick = sendMessage;
    dom.chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    dom.chatMsgs.addEventListener('scroll', onChatScroll);
    dom.container.addEventListener('touchstart', () => {
      dom.controls.classList.add('show');
      clearTimeout(dom.controls._t);
      dom.controls._t = setTimeout(() => dom.controls.classList.remove('show'), 3000);
    });
    window.addEventListener('beforeunload', () => {
      if (socket && socket.connected) socket.disconnect();
    });
  }
  /* ════════════════════════════════════════════
     AUTH  +  HTTP JOIN / LEAVE
  ════════════════════════════════════════════ */
  async function fetchMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json(), u = d.user || d;
      S.userId   = (u.id || u._id || '').toString();
      S.username = u.username || 'You';
    } catch (_) {}
  }
  async function joinRoom() {
    try {
      const r = await fetch('/api/rooms/' + roomId + '/join',
        { method: 'POST', credentials: 'include' });
      if (r.status === 401) { location.href = '/'; return; }
      if (r.status === 404) {
        toast('Room not found', 'error');
        setTimeout(() => location.href = '/dashboard', 1500);
        return;
      }
      if (!r.ok) throw new Error();
      const d = await r.json();
      S.room = d.room;
      renderRoom();
      connectSocket();                          // ← real-time starts here
    } catch (e) {
      toast('Failed to join room', 'error');
      console.log('joinRoom error:', e);
    }
  }
  function leaveRoom() {
    if (socket) { socket.emit('leave-room', { roomId }); socket.disconnect(); }
    fetch('/api/rooms/' + roomId + '/leave',
      { method: 'POST', credentials: 'include' }).catch(() => {});
    location.href = '/dashboard';
  }
  /* ════════════════════════════════════════════
     SOCKET.IO
  ════════════════════════════════════════════ */
  function connectSocket() {
    socket = io({ withCredentials: true });
    socket.on('connect', () => {
      console.log('[socket] connected', socket.id);
      socket.emit('join-room', { roomId }, ack => {
        if (!ack || ack.error) {
          toast('Socket: ' + (ack?.error || 'error'), 'error');
          return;
        }
        if (ack.participants) updateParticipants(ack.participants);
        if (!S.initialised) {
          addSystemMsg('You joined the room');
          loadMessages();                       // first page of chat history
          S.initialised = true;
        }
      });
    });
    socket.on('connect_error', err =>
      console.warn('[socket] connect_error', err.message));
    /* ── real-time events ── */
    socket.on('user-joined', d => {
      addSystemMsg(d.username + ' joined');
      updateParticipants(d.participants);
    });
    socket.on('user-left', d => {
      addSystemMsg(d.username + ' left');
      updateParticipants(d.participants);
    });
    socket.on('chat-message', msg => appendMessage(msg));
  }
  /* ════════════════════════════════════════════
     MESSAGES — pagination  +  real-time
  ════════════════════════════════════════════ */
  /** Load a page of history.  Pass `before` (ISO timestamp) to get older messages. */
  async function loadMessages(before) {
    if (S.loadingMsgs) return;
    S.loadingMsgs = true;
    if (before) toggleLoader(true);
    let url = '/api/rooms/' + roomId + '/messages?limit=' + MSG_PAGE;
    if (before) url += '&before=' + encodeURIComponent(before);
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error();
      const data = await r.json();
      const msgs = data.messages || [];
      S.hasMore  = data.hasMore;
      if (before) {                             // prepend older batch
        S.messages = msgs.concat(S.messages);
        prependMsgEls(msgs);
      } else {                                  // initial load
        S.messages = msgs;
        msgs.forEach(m => dom.chatMsgs.appendChild(createMsgEl(m)));
        dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
      }
      if (!S.hasMore) showStartMarker();
    } catch (_) {
      console.error('loadMessages failed');
    }
    toggleLoader(false);
    S.loadingMsgs = false;
  }
  /** Triggered as user scrolls up in the chat pane */
  function onChatScroll() {
    if (dom.chatMsgs.scrollTop < 60 &&
        S.hasMore && !S.loadingMsgs && S.messages.length) {
      loadMessages(S.messages[0].timestamp);
    }
  }
  /** Prepend older messages while keeping the current scroll position stable */
  function prependMsgEls(msgs) {
    const sh = dom.chatMsgs.scrollHeight;
    const st = dom.chatMsgs.scrollTop;
    const frag = document.createDocumentFragment();
    msgs.forEach(m => frag.appendChild(createMsgEl(m)));
    const first = dom.chatMsgs.querySelector('.chat-msg,.chat-sys');
    if (first) dom.chatMsgs.insertBefore(frag, first);
    else       dom.chatMsgs.appendChild(frag);
    dom.chatMsgs.scrollTop = st + (dom.chatMsgs.scrollHeight - sh);
  }
  function toggleLoader(on) {
    let el = $('msgLoader');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'msgLoader'; el.className = 'chat-loader';
      el.textContent = 'Loading older messages…';
      dom.chatMsgs.prepend(el);
    } else if (!on && el) el.remove();
  }
  function showStartMarker() {
    if ($('msgStart')) return;
    const el = document.createElement('div');
    el.id = 'msgStart'; el.className = 'chat-sys chat-start-marker';
    el.textContent = '— beginning of conversation —';
    dom.chatMsgs.prepend(el);
  }
  /* ════════════════════════════════════════════
     CHAT  —  send / render
  ════════════════════════════════════════════ */
  function sendMessage() {
    const text = dom.chatInput.value.trim();
    if (!text) return;
    if (!socket || !socket.connected) { toast('Not connected', 'error'); return; }
    socket.emit('chat-message', { roomId, text });
    dom.chatInput.value = '';
    dom.chatInput.focus();
  }
  /** Append a live incoming message + auto-scroll when user is near the bottom */
  function appendMessage(msg) {
    S.messages.push(msg);
    const nearBot = dom.chatMsgs.scrollHeight
                  - dom.chatMsgs.scrollTop
                  - dom.chatMsgs.clientHeight < 120;
    dom.chatMsgs.appendChild(createMsgEl(msg));
    if (nearBot) dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  /** Build a single message DOM element */
  function createMsgEl(msg) {
    const self = S.userId && msg.senderId &&
                 msg.senderId.toString() === S.userId;
    const name = msg.senderName || '?';
    const col  = avColor(name);
    const ini  = name[0].toUpperCase();
    const ts   = fmtTs(msg.timestamp);
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (self ? 'sent' : 'received');
    div.dataset.id = msg._id || '';
    div.innerHTML =
      '<div class="msg-av" style="background:' + col + '">' + ini + '</div>' +
      '<div class="msg-body">' +
        '<div class="msg-head">' +
          '<span class="msg-name">' + esc(name) + '</span>' +
          '<span class="msg-ts">' + ts + '</span>' +
        '</div>' +
        '<div class="msg-text">' + esc(msg.message) + '</div>' +
      '</div>';
    return div;
  }
  function addSystemMsg(txt) {
    const d = document.createElement('div');
    d.className = 'chat-sys'; d.textContent = txt;
    dom.chatMsgs.appendChild(d);
    dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
  }
  /* ════════════════════════════════════════════
     RENDER ROOM  +  live participant updates
  ════════════════════════════════════════════ */
  function renderRoom() {
    const r = S.room; if (!r) return;
    const cfg = MODES[r.mode] || { label: r.mode || 'Room', icon: '📺' };
    const bc  = 'badge-' + (MODES[r.mode] ? r.mode : 'casual');
    dom.hdrName.textContent  = r.roomName;
    dom.hdrBadge.className   = 'mode-badge ' + bc;
    dom.hdrBadge.textContent = cfg.icon + ' ' + cfg.label;
    dom.hdrBadge.style.display = '';
    dom.hdrDot.className     = 'status-dot status-' + (r.status || 'active');
    dom.hdrDot.style.display = '';
    renderDetails(r);
    if (r.video && r.video.url) { $('urlInput').value = r.video.url; loadVideo(r.video.url); }
  }
  function renderDetails(r) {
    const cfg   = MODES[r.mode] || { label: r.mode || 'Room', icon: '📺' };
    const bc    = 'badge-' + (MODES[r.mode] ? r.mode : 'casual');
    const parts = r.participants || [];
    dom.details.innerHTML =
      '<h2 class="rd-name">' + esc(r.roomName) + '</h2>' +
      (r.description ? '<p class="rd-desc">' + esc(r.description) + '</p>' : '') +
      '<div class="rd-meta">' +
        '<span class="mode-badge ' + bc + '">' + cfg.icon + ' ' + cfg.label + '</span>' +
        '<span style="display:flex;align-items:center;gap:.3rem">' +
          '<span class="status-dot status-' + (r.status||'active') + '"></span>' +
          esc(r.status||'active') +
        '</span>' +
        '<span class="rd-meta-sep">·</span>' +
        '<span>Hosted by <strong>' + esc(r.admin ? r.admin.username : '—') + '</strong></span>' +
        '<span class="rd-meta-sep">·</span>' +
        '<span id="pCount">👥 ' + parts.length + '/' + (r.maxParticipants||10) + '</span>' +
      '</div>' +
      (r.tags && r.tags.length
        ? '<div class="rd-tags">' + r.tags.map(t => '<span class="tag">#' + esc(t) + '</span>').join('') + '</div>'
        : '') +
      '<div id="pAvatars">' + renderAvatars(parts) + '</div>';
    dom.chatOnline.textContent = parts.length + ' in room';
  }
  /** Surgically update only the participant-dependent UI (no full re-render) */
  function updateParticipants(parts) {
    if (!S.room) return;
    S.room.participants = parts;
    const c = $('pCount');
    if (c) c.textContent = '👥 ' + parts.length + '/' + (S.room.maxParticipants || 10);
    const a = $('pAvatars');
    if (a) a.innerHTML = renderAvatars(parts);
    dom.chatOnline.textContent = parts.length + ' in room';
  }
  function renderAvatars(list) {
    if (!list.length) return '';
    const MAX = 10, show = list.slice(0, MAX), extra = list.length - MAX;
    let h = '<div class="rd-avatars">';
    show.forEach(p => {
      const c = avColor(p.username), ini = (p.username||'?')[0].toUpperCase();
      h += '<div class="avatar-sm" style="background:' + c + '" title="' + esc(p.username) + '">' + ini + '</div>';
    });
    if (extra > 0) h += '<div class="avatar-sm avatar-more">+' + extra + '</div>';
    return h + '</div>';
  }
  /* ════════════════════════════════════════════
     VIDEO PLAYER  (unchanged from your original)
  ════════════════════════════════════════════ */
  let videoEl = null, isYT = false;
  function loadVideo(url) {
    if (!url) { toast('Enter a URL', 'error'); return; }
    const ytId = extractYT(url); isYT = !!ytId;
    if (ytId) {
      dom.videoWrap.innerHTML =
        '<iframe src="https://www.youtube.com/embed/' + ytId +
        '?autoplay=0&rel=0" allow="autoplay;encrypted-media;fullscreen" allowfullscreen></iframe>';
      dom.controls.style.display = 'none';
    } else {
      dom.videoWrap.innerHTML = '<video id="videoEl" preload="metadata"></video>';
      videoEl = $('videoEl'); videoEl.src = url;
      dom.controls.style.display = ''; wireVideoControls();
    }
    dom.placeholder.remove(); $('urlInput').value = url;
  }
  function wireVideoControls() {
    if (!videoEl) return;
    const prog = $('progressBar'), cur = $('curTime'), dur = $('durTime');
    const playBtn = $('playBtn'), muteBtn = $('muteBtn'), volBar = $('volBar'), fsBtn = $('fsBtn');
    videoEl.addEventListener('loadedmetadata', () => {
      dur.textContent = fmtTime(videoEl.duration);
      prog.max = Math.floor(videoEl.duration * 100) || 1000;
      fillSlider(volBar, 100, 100);
    });
    videoEl.addEventListener('timeupdate', () => {
      cur.textContent = fmtTime(videoEl.currentTime);
      prog.value = Math.floor(videoEl.currentTime * 100);
      fillSlider(prog, prog.value, prog.max);
    });
    videoEl.addEventListener('play',  () => { playBtn.innerHTML = pauseSVG; });
    videoEl.addEventListener('pause', () => { playBtn.innerHTML = playSVG; });
    videoEl.addEventListener('ended', () => { playBtn.innerHTML = playSVG; });
    playBtn.onclick = togglePlay; videoEl.onclick = togglePlay;
    prog.addEventListener('input', () => {
      videoEl.currentTime = prog.value / 100;
      fillSlider(prog, prog.value, prog.max);
    });
    muteBtn.onclick = () => {
      videoEl.muted = !videoEl.muted;
      muteBtn.innerHTML = videoEl.muted ? mutedSVG : volSVG;
    };
    volBar.addEventListener('input', () => {
      videoEl.volume = volBar.value / 100;
      videoEl.muted  = videoEl.volume === 0;
      muteBtn.innerHTML = videoEl.muted ? mutedSVG : volSVG;
      fillSlider(volBar, volBar.value, 100);
    });
    fsBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else dom.container.requestFullscreen().catch(() => {});
    };
  }
  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) videoEl.play().catch(() => {}); else videoEl.pause();
  }
  function extractYT(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  const playSVG  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  const pauseSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const volSVG   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  const mutedSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  function fillSlider(el, val, max) {
    const pct = (val / max) * 100;
    el.style.background = 'linear-gradient(to right,#fff ' + pct + '%,rgba(255,255,255,.25) ' + pct + '%)';
  }
  /* ════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════ */
  function esc(s)     { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function fmtTime(s) { if (isNaN(s)) return '0:00'; const m = Math.floor(s/60), sec = Math.floor(s%60); return m + ':' + (sec < 10 ? '0' : '') + sec; }
  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts); if (isNaN(d)) return '';
    const now   = new Date();
    const today = d.toDateString() === now.toDateString();
    const t     = d.getHours().toString().padStart(2,'0') + ':' +
                  d.getMinutes().toString().padStart(2,'0');
    return today ? t
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + t;
  }
  function avColor(n) {
    if (!n) return AV_COLORS[0]; let h = 0;
    for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h);
    return AV_COLORS[Math.abs(h) % AV_COLORS.length];
  }
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'success'); el.textContent = msg;
    dom.toasts.appendChild(el);
    setTimeout(() => { el.classList.add('hiding'); setTimeout(() => el.remove(), 300); }, 3200);
  }
})();