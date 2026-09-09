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
import { SVG_MIC_OFF, SVG_WHISPER } from "./svg.js";
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
/* ── public API ─────────────────────────────────────────── */
export function wireVoice() {
  if (!dom.voiceRail) return;
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
    const { token, url } = await fetchToken();
    room = new LK.Room({ adaptiveStream: true, dynacast: true });
    bindRoomEvents();
    await room.connect(url, token);
    connected = true; micLive = false;
    applyDeafen();
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
  whisperIds.clear(); whisperMode = "none"; micBeforeWhisper = null;
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
  const isRemote = (p) => p && p.identity !== room?.localParticipant?.identity;
  room
    .on(E.ParticipantConnected,    (p) => { applyDeafenTo(p); refreshPeers(); })
    .on(E.ParticipantDisconnected, (p) => { if (whisperIds.has(p.identity)) removeWhisper(p.identity); refreshPeers(); })
    .on(E.ParticipantMetadataChanged, refreshPeers)
    .on(E.TrackSubscribed, (track, _pub, p) => {
      if (track.kind !== LK.Track.Kind.Audio) return;
      // Born silent when deafened: set volume first, attach, then hard-mute
      // the freshly created element before re-asserting on the participant.
      try { track.setVolume?.(deafened ? 0 : 1); } catch {}
      const el = track.attach();
      el.muted  = deafened;
      el.volume = deafened ? 0 : 1;
      applyDeafenTo(p);
    })
    .on(E.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); })
    .on(E.TrackPublished,      (_pub, p) => { applyDeafenTo(p); })           // remote (re)publish
    .on(E.LocalTrackPublished, (pub)    => {
      if (pub.source === LK.Track.Source.Microphone) startVisualizer();
    })
    .on(E.TrackMuted,   (_pub, p) => { if (isRemote(p)) applyDeafenTo(p); renderState(); })
    .on(E.TrackUnmuted, (_pub, p) => { if (isRemote(p)) applyDeafenTo(p); renderState(); })  // fixes case #3
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
/* ── mic / deafen ───────────────────────────────────────── */
async function setMic(on) {
  if (!connected) return;
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
/* ── mic / deafen ───────────────────────────────────────── */
/* Re-assert the current deafen state on ONE remote participant and every
 * audio track / media element it owns. Idempotent — the whole point is that
 * we re-run it on every lifecycle event instead of relying on one call. */
function applyDeafenTo(p) {
  if (!p || p.identity === room?.localParticipant?.identity) return;
  const pubs = p.audioTrackPublications || p.audioTracks || p.trackPublications;
  pubs?.forEach((pub) => {
    try { pub.setSubscribed?.(!deafened); } catch {}
    const track = pub?.track;
    if (!track) return;
    const vol = deafened ? 0 : 1;
    try { track.setVolume?.(vol); } catch {}
    track.attachedElements?.forEach((el) => { el.muted = deafened; el.volume = vol; });
  });
}
function applyDeafen() {
  (room?.remoteParticipants || room?.participants)?.forEach(applyDeafenTo);
}
function toggleDeafen() {
  if (!connected) return;
  deafened = !deafened;
  applyDeafen();
  renderState();
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
  if (!connected || !orderIds.includes(id)) return;
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
  if (!connected) return;
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
function refreshPeers() {
  const remotes = sortedRemotes();
  orderIds.length = 0;
  // drop any whisper targets that are no longer present
  const present = new Set(remotes.map((p) => p.identity));
  let changed = false;
  whisperIds.forEach((id) => { if (!present.has(id)) { whisperIds.delete(id); changed = true; } });
  if (changed && whisperIds.size === 0 && whisperMode !== "none") { stopWhisper(); }
  else if (changed) { syncPerms(); }
  const frag = document.createDocumentFragment();
  remotes.forEach((p, i) => {
    orderIds.push(p.identity);
    const slot = i + 1;
    const meta = peerMeta(p);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "vp-peer";
    chip.dataset.id = p.identity;
    chip.title = slot <= VOICE_MAX_SLOTS
      ? `Hold Alt + ${slot} to whisper to ${meta.username}`
      : `Whisper to ${meta.username}`;
    chip.setAttribute("aria-label", chip.title);
    chip.appendChild(avatarNode(meta, "vp-av"));
    if (slot <= VOICE_MAX_SLOTS) {
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
  dom.voiceMicBtn.disabled    = !connected;
  dom.voiceDeafenBtn.disabled = !connected;
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
/* ── side-panel "Voice" pane (3rd tab) ──────────────────── */
function renderPanePeers() {
  if (!dom.voicePaneList) return;
  const remotes = sortedRemotes();
  const frag = document.createDocumentFragment();
  remotes.forEach((p, i) => {
    const slot = i + 1;
    const meta = peerMeta(p);
    const li = document.createElement("li");
    li.className = "vpane-peer";
    li.dataset.id = p.identity;
    li.appendChild(avatarNode(meta, "vpane-av"));
    const box = document.createElement("span");
    box.className = "vpane-peer-meta";
    const nm = document.createElement("span");
    nm.className = "vpane-name"; nm.textContent = meta.username;
    const sub = document.createElement("span");
    sub.className = "vpane-sub";
    sub.dataset.slot = slot <= VOICE_MAX_SLOTS ? String(slot) : "";
    box.append(nm, sub);
    li.appendChild(box);
    const mute = document.createElement("span");
    mute.className = "vpane-mutedic"; mute.title = "Microphone off";
    mute.innerHTML = SVG_MIC_OFF;
    li.appendChild(mute);
    const eq = document.createElement("span");
    eq.className = "vpane-eq"; eq.setAttribute("aria-hidden", "true");
    eq.innerHTML = "<i></i><i></i><i></i>";
    li.appendChild(eq);
    const wb = document.createElement("button");
    wb.type = "button"; wb.className = "vpane-wbtn";
    wb.title = slot <= VOICE_MAX_SLOTS
      ? `Whisper to ${meta.username} (Alt + ${slot})`
      : `Whisper to ${meta.username}`;
    wb.setAttribute("aria-label", wb.title);
    wb.innerHTML = SVG_WHISPER;
    wb.addEventListener("click", (e) => { e.stopPropagation(); toggleStickyWhisper(p.identity); });
    li.appendChild(wb);
    li.addEventListener("click", () => toggleStickyWhisper(p.identity));
    frag.appendChild(li);
  });
  dom.voicePaneList.replaceChildren(frag);
  if (dom.voicePaneEmpty) dom.voicePaneEmpty.hidden = remotes.length > 0;
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
    !connected ? (connecting ? "Connecting…" : "Not connected")
    : whispering ? "Whispering privately"
    : micLive    ? "Speaking to everyone"
    : deafened   ? "Deafened"
    :              "Listening";
  dom.voicePanePower.textContent = connecting ? "…" : (connected ? "Leave" : "Join");
  dom.voicePanePower.classList.toggle("is-on", connected);
  dom.voicePanePower.classList.toggle("is-busy", connecting);
  /* mic / deafen (mirror the rail, incl. push-to-talk lock) */
  dom.voicePaneMicBtn.disabled    = !connected || whisperMode === "alt";
  dom.voicePaneDeafenBtn.disabled = !connected;
  dom.voicePaneMicBtn.setAttribute("aria-pressed", String(micLive));
  dom.voicePaneDeafenBtn.setAttribute("aria-pressed", String(deafened));
  dom.voicePaneMicBtn.classList.toggle("is-off",     connected && !micLive);
  dom.voicePaneMicBtn.classList.toggle("is-live",    micLive && !whispering);
  dom.voicePaneMicBtn.classList.toggle("is-whisper", micLive &&  whispering);
  dom.voicePaneDeafenBtn.classList.toggle("is-off",  deafened);
  if (dom.voicePaneMicLabel)
    dom.voicePaneMicLabel.textContent = !micLive ? "Mic off" : (whispering ? "Whispering" : "Mic on");
  /* exit-whisper shortcut + "whispering to" avatar strip */
  dom.voicePaneClearWhisper.hidden = !whispering;
  const ids = orderIds.filter((id) => whisperIds.has(id));
  dom.voicePaneTarget.hidden = ids.length === 0;
  dom.voicePaneTargetAvs.replaceChildren(
    ...ids.map((id) => avatarNode(peerMeta(map?.get(id)), "vpane-av")));
  /* per-row live state */
  const speaking = new Set((room?.activeSpeakers || []).map((p) => p.identity));
  dom.voicePaneList.querySelectorAll(".vpane-peer").forEach((li) => {
    const id = li.dataset.id;
    const p  = map?.get(id);
    const isTarget   = whisperIds.has(id);
    const isSpeaking = speaking.has(id);
    const micOff     = p ? (p.isMicrophoneEnabled === false) : false;
    li.classList.toggle("is-target",   isTarget);
    li.classList.toggle("is-speaking", isSpeaking);
    li.classList.toggle("is-muted",    micOff && !isSpeaking);
    li.querySelector(".vpane-wbtn")?.setAttribute("aria-pressed", String(isTarget));
    const sub = li.querySelector(".vpane-sub");
    if (sub) {
      const slot  = sub.dataset.slot;
      const state = isSpeaking ? "Speaking"
                  : isTarget   ? "In your whisper"
                  : micOff     ? "Muted"
                  :              "Listening";
      sub.textContent = slot ? `Alt + ${slot} · ${state}` : state;
    }
  });
}