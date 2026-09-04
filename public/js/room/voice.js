"use strict";
/* voice.js — LiveKit voice chat + whisper mode.
 * Additive: owns only #voiceRail / #voicePill and a `.voice-*` class on
 * #videoContainer. Never touches the video element, sync, chat or queue.
 *
 * Keybinds (ignored while typing / in fullscreen too):
 *   N                 mute / unmute
 *   H                 deafen / undeafen
 *   Alt + [1-9]       whisper to that slot. Keep Alt held to stay in whisper
 *                     even after releasing the digit; release Alt → back to All.
 *   click a peer dot  sticky whisper (toggle; Esc also clears it)
 */
import {
  roomId, VOICE_TOKEN_ENDPOINT, VOICE_SDK_URL,
  VOICE_MAX_SLOTS, VOICE_AUTOCONNECT, VOICE_RAIL_AUTO_CLOSE, AV_COLORS,
} from "./config.js";
import { dom } from "./dom.js";
import { playerHooks } from "./player.js";
/* ── module state ───────────────────────────────────────── */
let LK = null;                 // lazily-imported livekit-client module
let room = null;
let connecting = false, connected = false;
let micLive = false, deafened = false;
let analyser = null, rafId = 0;
let altDown = false;
let whisperId = null;          // identity we're whispering to, or null = everyone
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
    // await room.localParticipant.setMicrophoneEnabled(false); // listen only, no mic prompt
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
  whisperId = null; whisperMode = "none"; micBeforeWhisper = null;
  try { await room?.disconnect(); } catch {}
  room = null; connected = false; micLive = false;
  orderIds.length = 0;
  dom.voicePeers.replaceChildren();
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
    .on(E.ParticipantConnected,    (p) => { if (deafened) p.setVolume?.(0); refreshPeers(); })
    .on(E.ParticipantDisconnected, (p) => { if (p.identity === whisperId) stopWhisper(); refreshPeers(); })
    .on(E.ParticipantMetadataChanged, refreshPeers)
    .on(E.TrackSubscribed, (track, _pub, p) => {
      if (track.kind === LK.Track.Kind.Audio) {
        track.attach();
        if (deafened) p.setVolume?.(0);
      }
    })
    .on(E.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); })
    .on(E.LocalTrackPublished, (pub) => {
      if (pub.source === LK.Track.Source.Microphone) startVisualizer();
    })
    .on(E.ActiveSpeakersChanged, renderState)
    .on(E.Disconnected, () => {
      stopVisualizer();
      connected = false; micLive = false;
      orderIds.length = 0;
      dom.voicePeers.replaceChildren();
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
  await setMic(!micLive);
}
function applyDeafen() {
  (room?.remoteParticipants || room?.participants)?.forEach((p) =>
    p.setVolume?.(deafened ? 0 : 1));
}
function toggleDeafen() {
  if (!connected) return;
  deafened = !deafened;
  applyDeafen();
  renderState();
}
/* ── whisper (server-enforced via track subscription permissions) ── */
function applyPerms(id) {
  if (id) {
    room.localParticipant.setTrackSubscriptionPermissions(false, [
      { participantIdentity: id, allowAll: true },
    ]);
  } else {
    room.localParticipant.setTrackSubscriptionPermissions(true, []);
  }
}
async function setSpeakToAll() {
  whisperId = null; whisperMode = "none";
  try { applyPerms(null); } catch (e) { console.error("[voice] perms:", e); }
  renderState();
}
async function startWhisper(id, mode) {
  if (!connected || !orderIds.includes(id)) return;
  const fresh = whisperId === null;
  whisperId = id; whisperMode = mode;
  try { applyPerms(id); } catch (e) { console.error("[voice] perms:", e); }   // restrict BEFORE mic opens
  if (fresh) micBeforeWhisper = micLive;
  if (!micLive) await setMic(true);
  renderState();
}
async function stopWhisper() {
  if (whisperId === null) return;
  whisperId = null; whisperMode = "none";
  try { applyPerms(null); } catch (e) { console.error("[voice] perms:", e); }
  if (micBeforeWhisper === false && micLive) await setMic(false);
  micBeforeWhisper = null;
  renderState();
}
function toggleStickyWhisper(id) {
  if (!connected) return;
  (whisperId === id && whisperMode === "sticky") ? stopWhisper() : startWhisper(id, "sticky");
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
    if (id) startWhisper(id, "alt");
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
  renderState();
}
/* ── single source of truth for all visuals ─────────────── */
function computeState() {
  if (!connected) return "off";
  if (whisperId)  return "whisper";
  if (micLive)    return "live";
  return "listen";
}
function renderState() {
  const st = computeState();
  dom.voiceRail.dataset.state = st;
  dom.voiceToggle.title = LABELS[st];
  dom.voiceToggle.setAttribute("aria-label", LABELS[st]);
  dom.voiceMicBtn.disabled    = !connected;
  dom.voiceDeafenBtn.disabled = !connected;
  dom.voiceMicBtn.classList.toggle("is-off", !micLive);
  dom.voiceMicBtn.classList.toggle("is-live", micLive && !whisperId);
  dom.voiceMicBtn.classList.toggle("is-whisper", micLive && !!whisperId);
  dom.voiceDeafenBtn.classList.toggle("is-off", deafened);
  dom.voicePowerBtn.classList.toggle("is-on", connected);
  dom.voicePowerBtn.classList.toggle("is-busy", connecting);
  if (connected && !connecting) dom.voicePowerBtn.title = "Leave voice";
  dom.container.classList.toggle("voice-live", st === "live");
  dom.container.classList.toggle("voice-whisper", st === "whisper");
  dom.voicePeers.querySelectorAll(".vp-peer").forEach((el) =>
    el.classList.toggle("is-target", el.dataset.id === whisperId));
  updatePill(st);
}
function updatePill(st) {
  const pill = dom.voicePill;
  if (st !== "live" && st !== "whisper") { pill.hidden = true; return; }
  pill.hidden = false;
  pill.dataset.state = (st === "whisper") ? "whisper" : "all";
  if (st === "whisper") {
    const p = room?.remoteParticipants?.get(whisperId);
    dom.voicePillText.textContent = "Speaking to";
    dom.voicePillAvatars.replaceChildren(avatarNode(peerMeta(p), "vpill-av"));
  } else {
    dom.voicePillText.textContent = "Speaking to All";
    dom.voicePillAvatars.replaceChildren();
  }
}