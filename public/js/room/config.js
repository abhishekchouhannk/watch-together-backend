/* public/js/config.js
 * ─────────────────────────────────────────────────────────────
 * PURE CONSTANTS / TUNABLES for the room page. No DOM, no state,
 * no imports — this is the bottom of the dependency graph.
 *
 * MODES / THEMES        room-mode + theme descriptors (label + icon)
 * THEME_STORAGE_KEY     localStorage key for the theme preference
 * AV_COLORS             avatar background palette (avColor() indexes it)
 * REACTIONS             emoji whitelist — MUST match the server list
 * REACT_COOLDOWN        ms throttle between MY own reactions
 * MAX_BUBBLES           hard cap on live reaction bubbles in the DOM
 * RAIL_AUTO_CLOSE       ms before the mobile reaction popover self-closes
 * SYNC_INTERVAL         ms between leader "video-time-sync" broadcasts
 * DRIFT_THRESHOLD       seconds of drift tolerated before a corrective seek
 * REMOTE_COOLDOWN       ms that P.remote() suppresses local echo emits
 * SEEK_DEBOUNCE         ms debounce on the <video> "seeked" event
 * GROUP_WINDOW          ms window for grouping consecutive chat messages
 * UPNEXT_AT             seconds before end when the Up-Next card appears
 * BADGE_CAP             unread/queue badge cap (11 → "10+")
 * ROOM_CAP              max participants allowed by the room model
 * ROLE_LABEL            role key → UI label
 * FIELD_LABEL           room-form field key → UI label (conflict notice)
 * MOD_EVT               data-act → socket event name for moderation actions
 * roomId                parsed once from location.pathname
 * ───────────────────────────────────────────────────────────── */
"use strict";
export const MODES = {
  study:         { label: "Study",         icon: "📚" },
  gaming:        { label: "Gaming",        icon: "🎮" },
  entertainment: { label: "Entertainment", icon: "🎬" },
  casual:        { label: "Casual",        icon: "☕" },
};
export const THEMES = {
  morning:   { icon: "🌅", label: "Morning"   },
  afternoon: { icon: "☀️", label: "Afternoon" },
  evening:   { icon: "🌆", label: "Evening"   },
  night:     { icon: "🌙", label: "Night"     },
};
export const THEME_STORAGE_KEY = "wt-theme-pref";
export const AV_COLORS = [
  "#e11d48","#eab308","#22c55e","#3b82f6","#8b5cf6",
  "#ec4899","#f97316","#06b6d4","#6366f1","#14b8a6",
];
/* ═══════ REACTIONS ═══════ */
export const REACTIONS       = ["❤️","😂","😮","😢","🔥","👏","💀"];  // must match server whitelist
export const REACT_COOLDOWN  = 280;   // ms — min gap between MY reactions
export const MAX_BUBBLES     = 36;    // hard cap on live DOM bubbles
export const RAIL_AUTO_CLOSE = 3500;  // ms (mobile popover)
// constants
export const SYNC_INTERVAL   = 5000;
export const DRIFT_THRESHOLD = 1.5;   // seconds
export const REMOTE_COOLDOWN = 1000;  // ms
export const GROUP_WINDOW = 3 * 60 * 1000; // Group messages from the same sender if they are sent within 3 minutes of each other
export const UPNEXT_AT = 10;              // seconds before end → show card
export const BADGE_CAP = 10;              // 11 → "10+"
export const ROOM_CAP  = 10;              // keep in step with the model
export const ROLE_LABEL = { admin: "Host", mod: "Mod", member: "Member" };
export const FIELD_LABEL = {
  roomName: "Name", description: "Description", mode: "Mode",
  tags: "Tags", isPublic: "Visibility", maxParticipants: "Max participants",
};
export const MOD_EVT = { "do-kick": "member-kick", "do-ban": "member-ban", "do-remove": "member-remove" };
export const roomId = location.pathname.replace(/.*\/room\//, "").replace(/\/$/, "");
export const SETTLE_CAP = 12000;   // hard ceiling for a remote action to settle (ms)
export const ACK_TTL    = 3000;    // how long an explicit act() swallows its own echo (ms)
/* ── VOICE CHAT (LiveKit) ─────────────────────────────────── */
export const VOICE_TOKEN_ENDPOINT = "/api/voice-token";
// ESM build, lazily imported on first use. Pin the version you test against;
// self-host it for production/CSP and just change this URL.
export const VOICE_SDK_URL =
  "https://cdn.jsdelivr.net/npm/livekit-client@2.7.2/dist/livekit-client.esm.mjs";
export const VOICE_MAX_SLOTS       = 9;                 // Alt+1 … Alt+9  (ROOM_CAP − 1)
export const VOICE_AUTOCONNECT     = false;             // true → join voice (muted) on load
export const VOICE_RAIL_AUTO_CLOSE = RAIL_AUTO_CLOSE;   // reuse the reaction-rail timing