"use strict";
/* voice.js — LiveKit voice chat + whisper mode.
 * Additive: owns only #voiceRail / #voicePill and a `.voice-*` class on
 * #videoContainer. Never touches the video element, sync, chat or queue.
 *
 * Keybinds (ignored while typing / in fullscreen too):
 *   N                 mute / unmute
 *   H                 deafen / undeafen
 *   Alt + [1-9]       whisper to that slot. Hold Alt and tap more digits to
 *                     ADD more people (speak to several at once). Release Alt
 *                     → back to All.
 *   click a peer dot  sticky whisper — toggles that peer in/out of the set.
 *                     Click the pill's ✕ (or Esc) to leave whisper entirely.
 */
import {
  roomId, VOICE_TOKEN_ENDPOINT, VOICE_SDK_URL,
  VOICE_MAX_SLOTS, VOICE_AUTOCONNECT, VOICE_RAIL_AUTO_CLOSE, AV_COLORS,
} from "./config.js";
import { dom } from "./dom.js";
import { playerHooks } from "./player.js";
import { SVG_MIC_OFF, SVG_WHISPER, SVG_SPEAKER, SVG_SPEAKER_OFF, SVG_GAVEL, SVG_USER } from "./svg.js";
import { S } from "./state.js";
import { getSocket, emit } from "./socket-ref.js";   
import { onRoomState } from "./socket-core.js";  
import { openProfile } from "./permissions.js";
import { esc } from "./utils.js";
/* ── module state ───────────────────────────────────────── */
let LK = null;                 // lazily-imported livekit-client module
let room = null;
let connecting = false, connected = false;
let micLive = false, deafened = false;
let analyser = null, rafId = 0;
let altDown = false;
const whisperIds = new Set();  // identities we're whispering to; empty = everyone
let whisperMode = "none";      // "none" | "alt" | "sticky"
let micBeforeWhisper = null;
const orderIds = [];           // remote identities in join order → Alt slots
let railCloseTmr = null;
const LABELS = {
  off:     "Voice chat — click to join",
  listen:  "Voice connected — mic muted",
  live:    "Speaking to everyone",
  whisper: "Whispering privately",
};

/* keyboard-shortcut chrome is desktop-only; re-render if a mouse gets (un)plugged */
const FINE_PTR_MQ   = window.matchMedia?.("(hover: hover) and (pointer: fine)");
const isFinePointer = () => !!FINE_PTR_MQ?.matches;
FINE_PTR_MQ?.addEventListener?.("change", () => { if (connected) refreshPeers(); });

/* ── per-peer audio: personal volume + mute, host/mod force-mute, deafen ──
 * Every gain decision flows through effectiveVolume(id). Every relevant
 * LiveKit track event RE-ASSERTS it on the publications AND the <audio>
 * elements, and fully unsubscribes when silent — a freshly (re)published
 * track can therefore never leak in at full volume. */
const PREFS_KEY     = "wp:voicePrefs";   // { [userId]: { vol:0..1, muted:bool } } — global
const localVol      = new Map();         // identity → slider position 0..1 (default 1)
const localMuted    = new Set();         // identities muted just for me (slider at 0 counts)
const forceMuted    = new Set();         // identities a host/mod muted for everyone (server truth)
let   iAmForceMuted = false;
let   prefsHydrated = false;
let   voiceSocketBound = false;
const clamp01   = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} };
function hydratePrefs() {
  if (prefsHydrated) return; prefsHydrated = true;
  for (const [id, e] of Object.entries(loadPrefs())) {
    if (!e) continue;
    const v = typeof e.vol === "number" ? clamp01(e.vol) : 1;
    if (v !== 1) localVol.set(id, v);
    if (e.muted || v === 0) localMuted.add(id);
  }
}
const getLocalVol = (id) => (localVol.has(id) ? localVol.get(id) : 1);
const mutedForMe  = (id) => localMuted.has(id);                 // single source of truth
const volReadout  = (id) => (mutedForMe(id) ? "Muted" : Math.round(getLocalVol(id) * 100) + "%");
function persistPref(id) {
  const all = loadPrefs();
  const vol = getLocalVol(id), muted = mutedForMe(id);
  if (vol === 1 && !muted) delete all[id]; else all[id] = { vol, muted };
  savePrefs(all);
}
/* ── gain pipeline ── */
const isRemote = (p) => !!p && p.identity !== room?.localParticipant?.identity;
function effectiveVolume(id) {
  if (deafened)           return 0;
  if (forceMuted.has(id)) return 0;
  if (localMuted.has(id)) return 0;
  return getLocalVol(id);
}
/* re-assert target gain on EVERY publication + attached element, and fully
 * (un)subscribe. This is what kills the leak-on-(re)publish race. */
function applyVolumeTo(p) {
  if (!isRemote(p)) return;
  const vol    = effectiveVolume(p.identity);
  const silent = vol === 0;
  const pubs   = p.audioTrackPublications || p.audioTracks || p.trackPublications;
  pubs?.forEach((pub) => {
    try { pub.setSubscribed?.(!silent); } catch {}
    const track = pub && pub.track;
    if (!track) return;
    try { track.setVolume?.(vol); } catch {}
    track.attachedElements?.forEach((el) => { el.muted = silent; el.volume = vol; });
  });
}
function applyAllVolumes() {
  (room?.remoteParticipants || room?.participants)?.forEach(applyVolumeTo);
}
function participantById(id) {
  const map = room?.remoteParticipants || room?.participants;
  return map?.get(id) || null;
}
function applyVolume(id) { const p = participantById(id); if (p) applyVolumeTo(p); }
function syncPeerUI(id) {
  paintPaneRow(id);
  if (vcIsOpen() && vcOpenFor.id === id) paintVoiceControl(id);
}
function setLocalVol(id, v) {
  v = clamp01(v);
  localVol.set(id, v);
  if (v === 0) localMuted.add(id); else localMuted.delete(id);
  persistPref(id);
  applyVolume(id);
  syncPeerUI(id);
}
function toggleLocalMute(id) {
  if (localMuted.has(id)) {
    localMuted.delete(id);
    if (getLocalVol(id) === 0) localVol.set(id, 1);
  } else {
    localMuted.add(id);
  }
  persistPref(id);
  applyVolume(id);
  syncPeerUI(id);
}
/* host/mod control — members only, mirrors the server gate */
function peerRole(id) {
  if (String(S.room?.admin?.userId || "") === id) return "admin";
  return (S.members || []).find((m) => String(m.userId) === id)?.role || "member";
}
const canIForceMute    = (id) => !!S.perms?.canManage && peerRole(id) === "member";
const requestForceMute = (id, mute) =>
  emit(mute ? "voice-force-mute" : "voice-force-unmute", { userId: id });
function toggleDeafen() {
  if (!connected) return;
  deafened = !deafened;
  applyAllVolumes();
  renderState();
}

/* ── public API ─────────────────────────────────────────── */
export function wireVoice() {
  if (!dom.voiceRail) return;
  hydratePrefs();
  bindVoiceSocket();
  wireVoiceControlModal();
  onRoomState((payload) => {
    bindVoiceSocket();                                    // socket is guaranteed to exist here
    if (Array.isArray(payload?.voiceMuted)) applyForceMutes(payload.voiceMuted);
  });
  dom.voiceToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!dom.voiceRail.classList.contains("open")) { openVoiceRail(); return; }
    if (connected) toggleMic(); else connect();
  });
  dom.voiceStrip.addEventListener("click", (e) => {
    if (e.target.closest(".voice-btn, .vp-peer") &&
        dom.voiceRail.classList.contains("open")) openVoiceRail();   // reset auto-close
  });
  dom.voicePowerBtn.addEventListener("click", (e) => {
    e.stopPropagation(); connected ? disconnect() : connect();
  });
  dom.voiceMicBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMic(); });
  dom.voiceDeafenBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleDeafen(); });
  dom.voicePillClose.addEventListener("click", (e) => { e.stopPropagation(); stopWhisper(); });
  dom.voicePanePower       ?.addEventListener("click", () => { connected ? disconnect() : connect(); });
  dom.voicePaneMicBtn      ?.addEventListener("click", () => toggleMic());
  dom.voicePaneDeafenBtn   ?.addEventListener("click", () => toggleDeafen());
  dom.voicePaneClearWhisper?.addEventListener("click", () => stopWhisper());
  document.addEventListener("click", (e) => {
    if (!dom.voiceRail.contains(e.target)) closeVoiceRail();
  });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    if (altDown) { altDown = false; if (whisperMode === "alt") stopWhisper(); }
  });
  window.addEventListener("beforeunload", () => { try { room?.disconnect(); } catch {} });
  // resume autoplay-blocked remote audio on the first user gesture
  document.addEventListener("click",
    () => { room?.startAudio?.().catch(() => {}); }, { once: true });
  renderState();
  if (VOICE_AUTOCONNECT) connect();
}
export function openVoiceRail() {
  dom.voiceRail.classList.add("open");
  dom.voiceToggle.setAttribute("aria-expanded", "true");
  clearTimeout(railCloseTmr);
  railCloseTmr = setTimeout(closeVoiceRail, VOICE_RAIL_AUTO_CLOSE);
}
export function closeVoiceRail() {
  clearTimeout(railCloseTmr);
  dom.voiceRail.classList.remove("open");
  dom.voiceToggle.setAttribute("aria-expanded", "false");
}
/* let player.js collapse us on fullscreen-exit without importing this module */
playerHooks.closeVoiceRail = closeVoiceRail;
/* ── connection lifecycle ───────────────────────────────── */
async function connect() {
  if (connected || connecting) return;
  connecting = true; renderState();
  try {
    LK = LK || await import(VOICE_SDK_URL);
    const { token, url, forceMuted: tokForceMuted } = await fetchToken();
    room = new LK.Room({ adaptiveStream: true, dynacast: true });
    bindRoomEvents();
    await room.connect(url, token);
    connected = true; micLive = false;
    applyAllVolumes();
    refreshPeers();
    await setSpeakToAll();
  } catch (err) {
    console.error("[voice] connect failed:", err);
    if (String(err?.message).includes("unauthorized")) return; // fetchToken already redirected
    dom.voicePowerBtn.title = "Voice unavailable — click to retry";
    try { await room?.disconnect(); } catch {}
    room = null; connected = false;
  } finally {
    connecting = false; renderState();
  }
}
async function disconnect() {
  stopVisualizer();
  closeVoiceControl();
  whisperIds.clear(); whisperMode = "none"; micBeforeWhisper = null;
  forceMuted.clear(); iAmForceMuted = false;
  try { await room?.disconnect(); } catch {}
  room = null; connected = false; micLive = false;
  orderIds.length = 0;
  dom.voicePeers.replaceChildren();
  dom.voicePaneList?.replaceChildren();
  dom.voicePowerBtn.title = "Join voice";
  renderState();
}
async function fetchToken() {
  const res = await fetch(VOICE_TOKEN_ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `token ${res.status}`);
  return data;
}
function bindRoomEvents() {
  const E = LK.RoomEvent;
  room
    .on(E.ParticipantConnected,    (p) => { applyVolumeTo(p); refreshPeers(); })
    .on(E.ParticipantDisconnected, (p) => { if (whisperIds.has(p.identity)) removeWhisper(p.identity); refreshPeers(); })
    .on(E.ParticipantMetadataChanged, refreshPeers)
    .on(E.TrackPublished, (_pub, p) => applyVolumeTo(p))         // silence it before we ever subscribe
    .on(E.TrackSubscribed, (track, _pub, p) => {
      if (track.kind !== LK.Track.Kind.Audio) return;
      const vol = effectiveVolume(p.identity);
      try { track.setVolume?.(vol); } catch {}                  // set BEFORE attach — born silent
      const el = track.attach();
      el.muted  = vol === 0;
      el.volume = vol;
      applyVolumeTo(p);                                         // re-assert across every pub/element
      renderState();
    })
    .on(E.TrackUnsubscribed, (track) => { track.detach().forEach((elm) => elm.remove()); })
    .on(E.TrackMuted,   (_pub, p) => { if (isRemote(p)) applyVolumeTo(p); renderState(); })
    .on(E.TrackUnmuted, (_pub, p) => { if (isRemote(p)) applyVolumeTo(p); renderState(); })
    .on(E.LocalTrackPublished, (pub) => {
      if (pub.source === LK.Track.Source.Microphone) startVisualizer();
    })
    .on(E.ActiveSpeakersChanged, renderState)
    .on(E.Disconnected, () => {
      stopVisualizer();
      connected = false; micLive = false;
      orderIds.length = 0;
      dom.voicePeers.replaceChildren();
      dom.voicePaneList?.replaceChildren();
      renderState();
    });
}
function bindVoiceSocket() {
  if (voiceSocketBound) return;
  const s = getSocket();
  if (!s) return;
  voiceSocketBound = true;
  s.on("voice-muted-users", (p) => applyForceMutes(p?.muted || []));
  s.on("room-permissions",  ()  => refreshPeers());   // mod promoted/demoted → show/hide the gavel
}
function applyForceMutes(list) {
  forceMuted.clear();
  list.forEach((m) => forceMuted.add(String(m && m.userId != null ? m.userId : m)));
  const me    = String(S.userId || "");
  const muted = forceMuted.has(me);
  if (muted && !iAmForceMuted) {
    if (whisperIds.size) stopWhisper();
    if (micLive) setMic(false);
  }
  iAmForceMuted = muted;
  applyAllVolumes();
  renderState();            // ← in-place; no refreshPeers()
}
/* ── mic / deafen ───────────────────────────────────────── */
async function setMic(on) {
  if (!connected) return;
  if (on && iAmForceMuted) { renderState(); return; }   // SFU won't let us publish anyway
  try {
    await room.localParticipant.setMicrophoneEnabled(on);
    micLive = on;
  } catch (err) {
    console.error("[voice] mic toggle failed:", err);
    micLive = !!room.localParticipant.isMicrophoneEnabled;
  }
  renderState();
}
async function toggleMic() {
  if (!connected) return;
  if (iAmForceMuted) return;  // locked by host/mod — SFU won't let us publish anyway
  if (whisperMode === "alt") return;         // push-to-talk owns the mic

  if (micLive) {
    // Manually muting: turn off the mic and drop active whispers
    await setMic(false);
    if (whisperIds.size > 0) {
      await stopWhisper();
    }
  } else {
    // Unmuting: simply turn the mic on
    await setMic(true);
  }
}
/* ── whisper (server-enforced via track subscription permissions) ── */
function applyPerms(ids) {
  if (ids && ids.length) {
    // only these participants may subscribe to our mic track
    room.localParticipant.setTrackSubscriptionPermissions(
      false,
      ids.map((id) => ({ participantIdentity: id, allowAll: true })),
    );
  } else {
    room.localParticipant.setTrackSubscriptionPermissions(true, []);
  }
}
function syncPerms() {
  try { applyPerms([...whisperIds]); } catch (e) { console.error("[voice] perms:", e); }
}
async function setSpeakToAll() {
  whisperIds.clear(); whisperMode = "none";
  syncPerms();
  renderState();
}
/* add one identity to the whisper set (keeps anyone already selected) */
async function addWhisper(id, mode) {
  if (!connected || iAmForceMuted || !orderIds.includes(id)) return;
  const fresh = whisperIds.size === 0;
  whisperIds.add(id); whisperMode = mode;
  syncPerms();                               // restrict BEFORE the mic opens
  if (fresh) micBeforeWhisper = micLive;     // remember state at the very first target
  if (!micLive) await setMic(true);
  renderState();
}
/* remove one identity; if that empties the set, leave whisper entirely */
async function removeWhisper(id) {
  if (!whisperIds.has(id)) return;
  whisperIds.delete(id);
  if (whisperIds.size === 0) { await stopWhisper(); return; }
  syncPerms();
  renderState();
}
async function stopWhisper() {
  if (whisperMode === "none" && whisperIds.size === 0) return;
  whisperIds.clear(); whisperMode = "none";
  syncPerms();
  if (micBeforeWhisper === false && micLive) await setMic(false);
  micBeforeWhisper = null;
  renderState();
}
function toggleStickyWhisper(id) {
  if (!connected || iAmForceMuted) return;
  whisperIds.has(id) ? removeWhisper(id) : addWhisper(id, "sticky");
}
/* ── keybinds ───────────────────────────────────────────── */
function typing(t) {
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
function digitOf(e) {
  if (e.code && /^Digit[1-9]$/.test(e.code)) return +e.code[5];
  if (/^[1-9]$/.test(e.key)) return +e.key;
  return 0;
}
function onKeyDown(e) {
  if (e.key === "Alt") { if (!typing(e.target)) altDown = true; return; }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const n = digitOf(e);
    if (!n || typing(e.target)) return;
    e.preventDefault();
    if (e.repeat) return;
    const id = orderIds[n - 1];
    if (id) addWhisper(id, "alt");           // additive: tap more digits to add more people
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
  if (e.key === "n" || e.key === "N") { e.preventDefault(); toggleMic(); }
  else if (e.key === "h" || e.key === "H") { e.preventDefault(); toggleDeafen(); }
  else if (e.key === "Escape" && whisperMode === "sticky") stopWhisper();
}
function onKeyUp(e) {
  if (e.key !== "Alt") return;
  altDown = false;
  e.preventDefault();                         // stop Win/FF from focusing the menu bar
  if (whisperMode === "alt") stopWhisper();
}
/* ── audio visualiser (real levels via LiveKit's analyser helper) ── */
function localMicTrack() {
  const lp = room?.localParticipant;
  const pub = lp?.getTrackPublication?.(LK.Track.Source.Microphone) ||
              lp?.getTrack?.(LK.Track.Source.Microphone);
  return pub?.audioTrack || null;
}
function startVisualizer() {
  stopVisualizer();
  const track = localMicTrack();
  if (!track || !LK.createAudioAnalyser) return;
  try { analyser = LK.createAudioAnalyser(track, { smoothingTimeConstant: 0.6 }); }
  catch { analyser = null; return; }
  const tick = () => {
    const v = analyser ? Math.min(1, analyser.calculateVolume()) : 0;
    const lvl = (v < 0.02 ? 0 : v).toFixed(3);
    dom.container.style.setProperty("--vlevel", lvl);
    dom.voiceRail.style.setProperty("--vlevel", lvl);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}
function stopVisualizer() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (analyser?.cleanup) { try { analyser.cleanup(); } catch {} }
  analyser = null;
  dom.container.style.setProperty("--vlevel", "0");
  dom.voiceRail.style.setProperty("--vlevel", "0");
}
/* ── peers / avatars ────────────────────────────────────── */
function sortedRemotes() {
  const map = room?.remoteParticipants || room?.participants;
  return map
    ? [...map.values()].sort(
        (a, b) => (a.joinedAt?.getTime?.() || 0) - (b.joinedAt?.getTime?.() || 0))
    : [];
}
function peerMeta(p) {
  let username = p?.name || p?.identity || "Guest", avatar = null;
  try {
    if (p?.metadata) {
      const m = JSON.parse(p.metadata);
      if (m.username) username = m.username;
      if (m.avatar) avatar = m.avatar;
    }
  } catch {}
  return { username, avatar };
}
function avColorFor(name) {
  const pal = (Array.isArray(AV_COLORS) && AV_COLORS.length)
    ? AV_COLORS : ["#e11d48", "#9333ea", "#2563eb", "#0891b2", "#059669", "#d97706"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return pal[Math.abs(h) % pal.length];
}
function avatarNode(meta, cls) {
  const el = document.createElement("span");
  el.className = cls;
  if (meta.avatar) {
    const img = document.createElement("img");
    img.src = meta.avatar; img.alt = ""; img.loading = "lazy";
    el.appendChild(img);
  } else {
    el.style.background = avColorFor(meta.username);
    el.textContent = (meta.username[0] || "?").toUpperCase();
  }
  return el;
}
function avatarButton(meta, cls, title) {
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = cls;
  btn.title = title; btn.setAttribute("aria-label", title);
  if (meta.avatar) {
    const img = document.createElement("img");
    img.src = meta.avatar; img.alt = ""; img.loading = "lazy";
    img.addEventListener("error", () => img.remove(), { once: true });
    btn.appendChild(img);
  } else {
    btn.style.background = avColorFor(meta.username);
    btn.textContent = (meta.username[0] || "?").toUpperCase();
  }
  return btn;
}
function refreshPeers() {
  const remotes = sortedRemotes();
  orderIds.length = 0;
  const present = new Set(remotes.map((p) => p.identity));
  let changed = false;
  whisperIds.forEach((id) => { if (!present.has(id)) { whisperIds.delete(id); changed = true; } });
  if (changed && whisperIds.size === 0 && whisperMode !== "none") stopWhisper();
  else if (changed) syncPerms();
  const fine = isFinePointer();
  const frag = document.createDocumentFragment();
  remotes.forEach((p, i) => {
    orderIds.push(p.identity);
    const slot = i + 1, meta = peerMeta(p);
    const showKbd = fine && slot <= VOICE_MAX_SLOTS;
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "vp-peer"; chip.dataset.id = p.identity;
    chip.title = showKbd
      ? `Hold Alt + ${slot} to whisper to ${meta.username}`
      : `Whisper to ${meta.username}`;
    chip.setAttribute("aria-label", chip.title);
    chip.appendChild(avatarNode(meta, "vp-av"));
    if (showKbd) {
      const s = document.createElement("span");
      s.className = "vp-slot"; s.textContent = slot;
      chip.appendChild(s);
    }
    chip.addEventListener("click", (e) => { e.stopPropagation(); toggleStickyWhisper(p.identity); });
    frag.appendChild(chip);
  });
  dom.voicePeers.replaceChildren(frag);
  renderPanePeers();
  renderState();
}
/* ── single source of truth for all visuals ─────────────── */
function computeState() {
  if (!connected)        return "off";
  if (whisperIds.size)   return "whisper";
  if (micLive)           return "live";
  return "listen";
}
function renderState() {
  const st = computeState();
  const whispering = whisperIds.size > 0;
  dom.voiceRail.dataset.state = st;
  dom.voiceToggle.title = LABELS[st];
  dom.voiceToggle.setAttribute("aria-label", LABELS[st]);
  dom.voiceMicBtn.disabled = !connected || iAmForceMuted;
  dom.voiceDeafenBtn.disabled = !connected;
  dom.voiceMicBtn.classList.toggle("is-hostmuted", iAmForceMuted);
  dom.voiceMicBtn.classList.toggle("is-off", !micLive);
  dom.voiceMicBtn.classList.toggle("is-live", micLive && !whispering);
  dom.voiceMicBtn.classList.toggle("is-whisper", micLive && whispering);
  dom.voiceDeafenBtn.classList.toggle("is-off", deafened);
  dom.voicePowerBtn.classList.toggle("is-on", connected);
  dom.voicePowerBtn.classList.toggle("is-busy", connecting);
  if (connected && !connecting) dom.voicePowerBtn.title = "Leave voice";
  dom.container.classList.toggle("voice-live", st === "live");
  dom.container.classList.toggle("voice-whisper", st === "whisper");
  dom.voicePeers.querySelectorAll(".vp-peer").forEach((el) =>
    el.classList.toggle("is-target", whisperIds.has(el.dataset.id)));
  renderVoicePane(st)
  renderVoiceControl();
  updatePill(st);
}
function updatePill(st) {
  const pill = dom.voicePill;
  if (st !== "live" && st !== "whisper") { pill.hidden = true; return; }
  pill.hidden = false;
  const whispering = st === "whisper";
  pill.dataset.state = whispering ? "whisper" : "all";
  dom.voicePillClose.hidden = !whispering;
  if (whispering) {
    const map = room?.remoteParticipants || room?.participants;
    const ids = orderIds.filter((id) => whisperIds.has(id));   // keep join-order
    dom.voicePillText.textContent = ids.length > 1 ? "Speaking to" : "Whispering to";
    dom.voicePillAvatars.replaceChildren(
      ...ids.map((id) => avatarNode(peerMeta(map?.get(id)), "vpill-av")),
    );
  } else {
    dom.voicePillText.textContent = "Speaking to All";
    dom.voicePillAvatars.replaceChildren();
  }
}
/* Row = [avatar → profile] · [name/status → voice-control modal] · mute-me · whisper.
   Volume, % readout and the host/mod "mute for everyone" control all moved
   into the per-user modal (openVoiceControl). */
function renderPanePeers() {
  if (!dom.voicePaneList) return;
  const remotes = sortedRemotes();
  const fine = isFinePointer();
  const frag = document.createDocumentFragment();
  remotes.forEach((p, i) => {
    const id = p.identity, slot = i + 1, meta = peerMeta(p);
    const kbd = fine && slot <= VOICE_MAX_SLOTS ? ` (Alt + ${slot})` : "";
    const li = document.createElement("li");
    li.className = "vpane-peer";
    li.dataset.id = id;
    const av = avatarButton(meta, "vpane-av", `View ${meta.username}'s profile`);
    av.addEventListener("click", (e) => { e.stopPropagation(); openProfile(id, meta.username); });
    li.appendChild(av);
    const open = document.createElement("button");
    open.type = "button"; open.className = "vpane-open";
    open.setAttribute("aria-label", `Voice controls for ${meta.username}`);
    const box = document.createElement("span");
    box.className = "vpane-peer-meta";
    const nm = document.createElement("span");
    nm.className = "vpane-name"; nm.textContent = meta.username;
    const sub = document.createElement("span");
    sub.className = "vpane-sub";
    sub.dataset.slot = fine && slot <= VOICE_MAX_SLOTS ? String(slot) : "";
    box.append(nm, sub);
    const eq = document.createElement("span");
    eq.className = "vpane-eq"; eq.setAttribute("aria-hidden", "true");
    eq.innerHTML = "<i></i><i></i><i></i>";
    const micIc = document.createElement("span");
    micIc.className = "vpane-mutedic"; micIc.title = "Their mic is off";
    micIc.innerHTML = SVG_MIC_OFF;
    open.append(box, eq, micIc);
    open.addEventListener("click", (e) => { e.stopPropagation(); openVoiceControl(id); });
    li.appendChild(open);
    const lm = document.createElement("button");
    lm.type = "button"; lm.className = "vpane-localmute";
    lm.innerHTML = `<span class="ic-on">${SVG_SPEAKER}</span><span class="ic-off">${SVG_SPEAKER_OFF}</span>`;
    lm.addEventListener("click", (e) => { e.stopPropagation(); toggleLocalMute(id); });
    li.appendChild(lm);
    const wb = document.createElement("button");
    wb.type = "button"; wb.className = "vpane-wbtn";
    wb.title = `Whisper to ${meta.username}${kbd}`;
    wb.setAttribute("aria-label", wb.title);
    wb.innerHTML = SVG_WHISPER;
    wb.addEventListener("click", (e) => { e.stopPropagation(); toggleStickyWhisper(id); });
    li.appendChild(wb);
    frag.appendChild(li);
    paintPaneRow(id, li, p);
  });
  dom.voicePaneList.replaceChildren(frag);
  if (dom.voicePaneEmpty) dom.voicePaneEmpty.hidden = remotes.length > 0;
}
/* single in-place row updater — used by renderVoicePane AND the slider/mute handlers */
function paintPaneRow(id, li, p) {
  if (!dom.voicePaneList) return;
  li = li || dom.voicePaneList.querySelector(`.vpane-peer[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  const map = room?.remoteParticipants || room?.participants;
  p = p || map?.get(id);
  const youMuted   = mutedForMe(id);
  const hostMuted  = forceMuted.has(id);
  const isTarget   = whisperIds.has(id);
  const isSpeaking = (room?.activeSpeakers || []).some((s) => s.identity === id);
  const micOff     = p ? (p.isMicrophoneEnabled === false) : false;
  const audible    = !youMuted && !hostMuted && !deafened;
  li.classList.toggle("is-target",     isTarget);
  li.classList.toggle("is-speaking",   isSpeaking && audible);
  li.classList.toggle("is-muted",      micOff && !isSpeaking);
  li.classList.toggle("is-localmuted", youMuted && !hostMuted);
  li.classList.toggle("is-hostmuted",  hostMuted);
  const lm = li.querySelector(".vpane-localmute");
  if (lm) {
    lm.disabled = hostMuted;
    lm.setAttribute("aria-pressed", String(youMuted));
    lm.title = hostMuted ? "Muted for the whole room"
             : youMuted  ? "Unmute for yourself" : "Mute for yourself";
  }
  const wb = li.querySelector(".vpane-wbtn");
  if (wb) {
    wb.disabled = iAmForceMuted || whisperMode === "alt";
    wb.setAttribute("aria-pressed", String(isTarget));
  }
  const sub = li.querySelector(".vpane-sub");
  if (sub) {
    const slot  = sub.dataset.slot;
    const state = hostMuted  ? "Muted by host"
                : youMuted   ? "Muted for you"
                : isSpeaking ? "Speaking"
                : isTarget   ? "In your whisper"
                : micOff     ? "Mic off"
                :              "Listening";
    sub.textContent = slot ? `Alt + ${slot} · ${state}` : state;
  }
}
function renderVoicePane(st) {
  if (!dom.paneVoice) return;
  const whispering = whisperIds.size > 0;
  const map = room?.remoteParticipants || room?.participants;
  dom.paneVoice.dataset.state = st;
  /* tab badge — heads in the voice channel (you included) */
  const heads = connected ? (sortedRemotes().length + 1) : 0;
  if (dom.voiceCount) {
    dom.voiceCount.textContent = String(heads);
    dom.voiceCount.dataset.zero = heads ? "0" : "1";
  }
  dom.tabVoice?.classList.toggle("has-voice-live", st === "live" || st === "whisper");
  /* status + power */
  dom.voicePaneStatus.textContent =
    !connected      ? (connecting ? "Connecting…" : "Not connected")
    : iAmForceMuted ? "Muted by host"
    : whispering    ? "Whispering privately"
    : micLive       ? "Speaking to everyone"
    : deafened      ? "Deafened"
    :                 "Listening";
  /* mic / deafen (mirror the rail, incl. push-to-talk lock) */
  dom.voicePaneMicBtn.disabled = !connected || iAmForceMuted || whisperMode === "alt";
  dom.voicePaneMicBtn.classList.toggle("is-hostmuted", iAmForceMuted);
  if (dom.voicePaneMicLabel)
    dom.voicePaneMicLabel.textContent =
      iAmForceMuted ? "Muted by host"
      : !micLive    ? "Mic off"
      : whispering  ? "Whispering" : "Mic on";
  dom.voicePanePower.textContent = connecting ? "…" : (connected ? "Leave" : "Join");
  dom.voicePanePower.classList.toggle("is-on", connected);
  dom.voicePanePower.classList.toggle("is-busy", connecting);
  dom.voicePaneDeafenBtn.disabled = !connected;
  dom.voicePaneMicBtn.setAttribute("aria-pressed", String(micLive));
  dom.voicePaneDeafenBtn.setAttribute("aria-pressed", String(deafened));
  dom.voicePaneMicBtn.classList.toggle("is-off",     connected && !micLive);
  dom.voicePaneMicBtn.classList.toggle("is-live",    micLive && !whispering);
  dom.voicePaneMicBtn.classList.toggle("is-whisper", micLive &&  whispering);
  dom.voicePaneDeafenBtn.classList.toggle("is-off",  deafened);
  /* exit-whisper shortcut + "whispering to" avatar strip */
  dom.voicePaneClearWhisper.hidden = !whispering;
  const ids = orderIds.filter((id) => whisperIds.has(id));
  dom.voicePaneTarget.hidden = ids.length === 0;
  dom.voicePaneTargetAvs.replaceChildren(
    ...ids.map((id) => avatarNode(peerMeta(map?.get(id)), "vpane-av")));
  /* per-row live state */
  const speaking = new Set((room?.activeSpeakers || []).map((p) => p.identity));
  dom.voicePaneList.querySelectorAll(".vpane-peer").forEach((li) => paintPaneRow(li.dataset.id, li));
}

/* ════════════════════════════════════════════════════════════
   PER-USER VOICE CONTROL MODAL
   A separate entity from the member profile panel — it only
   borrows the profile card's themed shell. Build once on open /
   on structural change; paint the dynamic bits in place so the
   volume drag is never interrupted.
   ════════════════════════════════════════════════════════════ */
let vcOpenFor = null;                       // { id, sig } | null
const vcIsOpen = () => !!vcOpenFor;
const vcSignature = (id) => peerRole(id) + "|" + (S.perms?.canManage ? "1" : "0");
const kbdHint = (txt) => (isFinePointer() ? `<span class="vc-kbd">${txt}</span>` : "");
function openVoiceControl(id) {
  if (!connected || !id || !participantById(id)) return;
  vcOpenFor = { id, sig: vcSignature(id) };
  buildVoiceControl(id);
  dom.vcCard.classList.add("open");
  dom.vcBackdrop.classList.add("open");
  dom.vcCard.setAttribute("aria-hidden", "false");
  dom.vcClose.focus();
}
function closeVoiceControl() {
  vcOpenFor = null;
  dom.vcCard.classList.remove("open");
  dom.vcBackdrop.classList.remove("open");
  dom.vcCard.setAttribute("aria-hidden", "true");
}
function buildVoiceControl(id) {
  const p = participantById(id);
  if (!p) { closeVoiceControl(); return; }
  const meta = peerMeta(p);
  const slot = orderIds.indexOf(id) + 1;
  const role = peerRole(id);
  const canForce = canIForceMute(id);
  dom.vcTitle.textContent = "Voice · " + meta.username;
  let h =
    '<div class="prof-id vc-id">' +
      '<span class="vc-av-slot"></span>' +                        // ← avatarButton injected below
      `<div class="prof-name">${esc(meta.username)}</div>` +
      '<div class="vc-status" id="vcStatus"></div>' +
    "</div>" +
    '<div class="cfg-sec">' +
      "<h4>Just for you</h4>" +
      '<div class="vc-volrow"><span class="vc-vol-l">Volume</span>' +
        '<span class="vc-vol-pct" id="vcVolPct"></span></div>' +
      '<input type="range" class="vc-vol" id="vcVol" min="0" max="1" step="0.02" ' +
        `aria-label="Volume for ${esc(meta.username)}">` +
      '<button type="button" class="vc-toggle" data-act="local-mute" id="vcLocalMute"></button>' +
      '<button type="button" class="vc-toggle" data-act="whisper" id="vcWhisper"></button>' +
      (slot > 0 && slot <= VOICE_MAX_SLOTS
        ? kbdHint(`Tip — hold Alt + ${slot} for push-to-talk whisper.`) : "") +
    "</div>";
  if (canForce) {
    h +=
      '<div class="cfg-sec">' +
        "<h4>Everyone</h4>" +
        '<button type="button" class="vc-toggle vc-danger" data-act="force-toggle" id="vcForce"></button>' +
        '<p class="cfg-note" id="vcForceNote"></p>' +
      "</div>";
  } else if (role === "admin" || role === "mod") {
    h +=
      '<div class="cfg-sec"><p class="cfg-note">' +
        (role === "admin" ? "The host" : "Moderators") +
        " can't be muted for the room.</p></div>";
  }
  h +=
    '<div class="vc-foot">' +
      '<button type="button" class="vc-link" data-act="profile">' +
        SVG_USER + `<span>Open ${esc(meta.username)}'s profile</span>` +
      "</button>" +
    "</div>";
  dom.vcBody.innerHTML = h;
  const avBtn = avatarButton(meta, "prof-av vc-av", `View ${esc(meta.username)}'s profile`);
  avBtn.dataset.act = "profile";
  dom.vcBody.querySelector(".vc-av-slot")?.replaceWith(avBtn);
  paintVoiceControl(id);
}
function paintVoiceControl(id) {
  if (!vcIsOpen() || vcOpenFor.id !== id) return;
  const p = participantById(id); const b = dom.vcBody;
  if (!p) { closeVoiceControl(); return; }
  const vol        = getLocalVol(id);
  const youMuted   = mutedForMe(id);
  const hostMuted  = forceMuted.has(id);
  const isTarget   = whisperIds.has(id);
  const isSpeaking = (room?.activeSpeakers || []).some((s) => s.identity === id);
  const micOff     = p.isMicrophoneEnabled === false;
  const st = b.querySelector("#vcStatus");
  if (st) {
    const [txt, state] =
        hostMuted  ? ["Muted for the whole room", "muted"]
      : youMuted   ? ["Muted — just for you",     "muted"]
      : deafened   ? ["You're deafened",          "muted"]
      : isSpeaking ? ["Speaking now",             "speaking"]
      : isTarget   ? ["In your whisper",          "whisper"]
      : micOff     ? ["Their mic is off",         "micoff"]
      :              ["Listening",                "listening"];
    st.textContent = txt; st.dataset.state = state;
  }
  const sl = b.querySelector("#vcVol");
  if (sl) {
    sl.disabled = deafened || hostMuted;
    if (document.activeElement !== sl) sl.value = String(vol);
    sl.style.setProperty("--fill", Math.round((youMuted ? 0 : vol) * 100) + "%");
    sl.setAttribute("aria-valuetext", volReadout(id));
  }
  const pct = b.querySelector("#vcVolPct");
  if (pct) pct.textContent = hostMuted ? "Muted by host" : volReadout(id);
  const lm = b.querySelector("#vcLocalMute");
  if (lm) {
    lm.disabled = hostMuted;
    lm.setAttribute("aria-pressed", String(youMuted));
    lm.innerHTML = (youMuted ? SVG_SPEAKER : SVG_SPEAKER_OFF) +
      `<span>${youMuted ? "Unmute for yourself" : "Mute for yourself"}</span>`;
  }
  const wb = b.querySelector("#vcWhisper");
  if (wb) {
    wb.disabled = iAmForceMuted || whisperMode === "alt";
    wb.setAttribute("aria-pressed", String(isTarget));
    wb.innerHTML = SVG_WHISPER +
      `<span>${isTarget ? "Stop whispering to them" : "Whisper to them"}</span>`;
  }
  const fb = b.querySelector("#vcForce");
  if (fb) {
    fb.setAttribute("aria-pressed", String(hostMuted));
    fb.innerHTML = SVG_GAVEL +
      `<span>${hostMuted ? "Unmute for everyone" : "Mute for everyone"}</span>`;
  }
  const fn = b.querySelector("#vcForceNote");
  if (fn) fn.textContent = hostMuted
    ? "Their mic is disabled for everyone here. Lifting this lets them unmute themselves again."
    : "Disables their mic for everyone and stops them turning it back on. This persists if they rejoin.";
}
function renderVoiceControl() {
  if (!vcIsOpen()) return;
  const { id } = vcOpenFor;
  if (!connected || !participantById(id)) { closeVoiceControl(); return; }
  const sig = vcSignature(id);
  if (sig !== vcOpenFor.sig) { vcOpenFor.sig = sig; buildVoiceControl(id); }  // role / my-perms changed
  else                        paintVoiceControl(id);
}
function onVcClick(e) {
  if (!vcIsOpen()) return;
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const id = vcOpenFor.id, act = el.dataset.act;
  if (act === "profile") {
    const p = participantById(id);
    closeVoiceControl();                                  // hand off to the (separate) profile panel
    openProfile(id, p ? peerMeta(p).username : "");
  } else if (act === "local-mute")   toggleLocalMute(id);
  else if (act === "whisper")        toggleStickyWhisper(id);
  else if (act === "force-toggle")   requestForceMute(id, !forceMuted.has(id));
}
function onVcInput(e) {
  if (vcIsOpen() && e.target.closest("#vcVol")) setLocalVol(vcOpenFor.id, e.target.value);
}
function wireVoiceControlModal() {
  dom.vcBody.addEventListener("click", onVcClick);
  dom.vcBody.addEventListener("input", onVcInput);
  dom.vcClose.addEventListener("click", closeVoiceControl);
  dom.vcBackdrop.addEventListener("click", closeVoiceControl);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && vcIsOpen()) { e.stopPropagation(); closeVoiceControl(); }
  }, true);
  playerHooks.closeVoiceControl = closeVoiceControl;      // fullscreen-exit dismisses it too
}
