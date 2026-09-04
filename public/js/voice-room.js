/* Barebones voice-room prototype.
   - Page-level auth/ban guard BEFORE any voice token is requested
   - Joins the existing socket room (so participant/member records exist)
   - Connects to LiveKit, mic/deafen controls
   - Alt + 1..9 whisper with "hold Alt" latch behaviour */
(() => {
  const LK = window.LivekitClient;
  const qs = new URLSearchParams(location.search);
  const roomId = qs.get('roomId');
  const el = {
    status:       document.getElementById('status'),
    roomId:       document.getElementById('roomId'),
    me:           document.getElementById('me'),
    participants: document.getElementById('participants'),
    micBtn:       document.getElementById('micBtn'),
    deafenBtn:    document.getElementById('deafenBtn'),
    leaveBtn:     document.getElementById('leaveBtn'),
    whisperState: document.getElementById('whisperState'),
    log:          document.getElementById('log'),
  };
  const setStatus = s => { el.status.textContent = s; };
  const log = (...a) => {
    console.log('[voice]', ...a);
    el.log.textContent =
      a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n' + el.log.textContent;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  if (!roomId) { setStatus('Missing ?roomId= in URL'); return; }
  el.roomId.textContent = roomId;
  let room = null;
  let socket = null;
  let micEnabled = false;
  let deafened = false;
  // whisper state
  let altDown = false;
  let whisperTarget = null;   // remote identity we're whispering to
  let micBeforeWhisper = null;
  const order = [];           // remote identities in join order -> Alt+N slots
  const audioEls = new Map(); // trackSid -> HTMLAudioElement
  const remotes = () => room.remoteParticipants || room.participants || new Map();
  const remotesSorted = () =>
    Array.from(remotes().values())
      .sort((a, b) => (a.joinedAt?.getTime?.() || 0) - (b.joinedAt?.getTime?.() || 0));
  const micPub = p =>
    (p.getTrackPublication?.(LK.Track.Source.Microphone)) ||
    (p.getTrack?.(LK.Track.Source.Microphone)) || null;
  /* ---------- 1. page guard (same gate as every other page) ---------- */
  async function guard() {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, { credentials: 'include' });
      if (res.status === 401) { location.href = '/login'; return false; }
      if (res.status === 403) { setStatus('You are banned from this room.'); return false; }
      if (res.status === 404) { setStatus('Room not found.'); return false; }
      if (!res.ok)            { setStatus('Room not available.'); return false; }
      return true;
    } catch {
      location.href = '/login';
      return false;
    }
  }
  /* ---------- 2. join existing socket room (reuses your handlers) ---------- */
  function connectSocket() {
    if (typeof io !== 'function') { log('socket.io client not found – skipping socket join'); return; }
    socket = io({ withCredentials: true });
    socket.on('connect', () => { socket.emit('join-room', { roomId }); log('socket: join-room sent'); });
    socket.on('room-error', e => {
      log('room-error', e);
      if (e?.fatal) { setStatus(e.message || 'Removed from room'); teardown(); }
    });
  }
  /* ---------- 3. LiveKit ---------- */
  async function getToken() {
    const res = await fetch('/api/voice-token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `token failed (${res.status})`);
    return data;
  }
  async function connectVoice() {
    const { token, url } = await getToken();
    room = new LK.Room({ adaptiveStream: true, dynacast: true });
    room
      .on(LK.RoomEvent.ParticipantConnected,    rebuild)
      .on(LK.RoomEvent.ParticipantDisconnected, p => { if (whisperTarget === p.identity) stopWhisper(); rebuild(); })
      .on(LK.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === LK.Track.Kind.Audio) {
          const node = track.attach();
          node.autoplay = true;
          audioEls.set(track.sid, node);
          if (deafened) participant.setVolume?.(0);
        }
        render();
      })
      .on(LK.RoomEvent.TrackUnsubscribed, track => {
        track.detach().forEach(n => n.remove());
        audioEls.delete(track.sid);
        render();
      })
      .on(LK.RoomEvent.ActiveSpeakersChanged, render)
      .on(LK.RoomEvent.TrackMuted,   render)
      .on(LK.RoomEvent.TrackUnmuted, render)
      .on(LK.RoomEvent.Disconnected, () => setStatus('Disconnected'));
    await room.connect(url, token);
    setStatus('Connected');
    el.me.textContent = `${room.localParticipant.name || room.localParticipant.identity} (you)`;
    rebuild();
    await setSpeakToAll();                          // explicit baseline
    await room.localParticipant.setMicrophoneEnabled(false); // start muted
    micEnabled = false;
    el.micBtn.disabled = el.deafenBtn.disabled = el.leaveBtn.disabled = false;
    updateButtons();
  }
  function rebuild() {
    order.length = 0;
    remotesSorted().forEach(p => order.push(p.identity));
    render();
  }
  /* ---------- mic / deafen ---------- */
  async function toggleMic() {
    if (!room) return;
    room.startAudio?.().catch(() => {});
    micEnabled = !micEnabled;
    await room.localParticipant.setMicrophoneEnabled(micEnabled);
    updateButtons();
  }
  function applyDeafen() {
    remotes().forEach(p => p.setVolume?.(deafened ? 0 : 1));
    audioEls.forEach(n => { n.muted = deafened; });
  }
  function toggleDeafen() {
    if (!room) return;
    room.startAudio?.().catch(() => {});
    deafened = !deafened;
    applyDeafen();
    updateButtons();
  }
  /* ---------- whisper (server-enforced subscription permissions) ---------- */
  async function setSpeakToAll() {
    whisperTarget = null;
    try { room.localParticipant.setTrackSubscriptionPermissions(true, []); }
    catch (e) { log('perm error', e.message); }
    updateWhisperUI();
  }
  async function startWhisper(identity) {
    if (!room || !order.includes(identity)) return;
    const switching = whisperTarget !== null;
    whisperTarget = identity;
    // only THIS identity may subscribe to our outgoing audio
    try {
      room.localParticipant.setTrackSubscriptionPermissions(false, [
        { participantIdentity: identity, allowAll: true },
      ]);
    } catch (e) { log('perm error', e.message); }
    if (!switching) micBeforeWhisper = micEnabled;
    if (!micEnabled) {
      micEnabled = true;
      await room.localParticipant.setMicrophoneEnabled(true);
    }
    updateButtons();
    updateWhisperUI();
  }
  async function stopWhisper() {
    if (whisperTarget === null) return;
    whisperTarget = null;
    try { room.localParticipant.setTrackSubscriptionPermissions(true, []); }
    catch (e) { log('perm error', e.message); }
    if (micBeforeWhisper === false && micEnabled) {
      micEnabled = false;
      await room.localParticipant.setMicrophoneEnabled(false);
    }
    micBeforeWhisper = null;
    updateButtons();
    updateWhisperUI();
  }
  /* ---------- keybinds ---------- */
  const digit = e => {
    if (e.code && /^Digit[1-9]$/.test(e.code)) return +e.code.slice(5);
    if (/^[1-9]$/.test(e.key)) return +e.key;
    return 0;
  };
  function onKeyDown(e) {
    if (e.key === 'Alt') { altDown = true; e.preventDefault(); return; }
    if (e.altKey) {
      const n = digit(e);
      if (!n) return;
      e.preventDefault();
      if (e.repeat) return;
      const target = order[n - 1];
      if (target) startWhisper(target);
      else log(`No participant in slot ${n}`);
      return;
    }
    if (e.repeat) return;
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMic(); }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); toggleDeafen(); }
  }
  function onKeyUp(e) {
    if (e.key === 'Alt') {            // release Alt -> back to ALL (even if the digit was already released)
      altDown = false;
      e.preventDefault();
      stopWhisper();
    }
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { if (altDown) { altDown = false; stopWhisper(); } });
  /* ---------- render ---------- */
  function updateButtons() {
    el.micBtn.textContent    = micEnabled ? 'Mute mic (M)' : 'Unmute mic (M)';
    el.deafenBtn.textContent = deafened ? 'Undeafen (D)' : 'Deafen (D)';
  }
  function updateWhisperUI() {
    if (whisperTarget) {
      const p = remotes().get(whisperTarget);
      el.whisperState.textContent = `Whispering to: ${p ? (p.name || p.identity) : whisperTarget}`;
    } else {
      el.whisperState.textContent = 'Speaking to: ALL';
    }
    render();
  }
  function render() {
    if (!room) return;
    const rows = remotesSorted().map((p, i) => {
      const slot = i + 1;
      const pub = micPub(p);
      const muted = (!pub || pub.isMuted) ? ' [muted]' : '';
      const speaking = p.isSpeaking ? ' 🔊' : '';
      const w = whisperTarget === p.identity ? '  <-- WHISPERING' : '';
      return `[Alt+${slot}] ${esc(p.name || p.identity)}${muted}${speaking}${w}`;
    });
    el.participants.innerHTML = rows.length
      ? rows.map(r => `<li>${r}</li>`).join('')
      : '<li>(no one else here)</li>';
  }
  /* ---------- lifecycle ---------- */
  async function teardown() {
    try { await room?.disconnect(); } catch {}
    try { socket?.disconnect(); } catch {}
    el.micBtn.disabled = el.deafenBtn.disabled = el.leaveBtn.disabled = true;
  }
  window.addEventListener('beforeunload', () => { try { room?.disconnect(); } catch {} });
  document.addEventListener('click', () => { room?.startAudio?.().catch(() => {}); }, { once: true });
  (async function init() {
    setStatus('Checking access…');
    if (!(await guard())) return;
    setStatus('Joining room…');
    connectSocket();
    setStatus('Requesting voice token…');
    try {
      await connectVoice();
    } catch (e) {
      console.error(e);
      setStatus('Failed to connect: ' + e.message);
      return;
    }
    el.micBtn.addEventListener('click', toggleMic);
    el.deafenBtn.addEventListener('click', toggleDeafen);
    el.leaveBtn.addEventListener('click', () => { teardown(); setStatus('Left voice room'); });
  })();
})();