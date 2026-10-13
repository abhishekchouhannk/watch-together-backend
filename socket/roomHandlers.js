// socket/roomHandlers.js
// ─────────────────────────────────────────────────────────────
// Per-socket room logic. Read top → bottom; nothing is used before
// it is declared:
//
//   1. imports
//   2. shared state & limits     every Map / constant, in one place
//   3. guard policies            POLICY.* — who may run an action (validated at load)
//   4. shared helpers            ids, rate limiting, socket lookups
//   5. connection context        on() · toast() · guarded() · rateLimited()
//   6. domains — each is its module helpers + register<Domain>(ctx):
//        presence · permissions · moderation · room details · chat ·
//        reports · playback · queue · study timer · study tasks ·
//        study whiteboard · reactions
//   7. room-deleted cleanup + the exported registrar
//
// Conventions
//   on(event, handler)          every listener goes through this: a throwing or
//                               rejecting handler is logged, never unhandled.
//   guarded(POLICY.X, handler)  loads the room, checks the policy, toasts the
//                               denial, then calls handler(room, roomId, ...args).
// ─────────────────────────────────────────────────────────────
"use strict";
/* ═══════════════════════════════════════════════════════════
   1. IMPORTS
   ═══════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const Room       = require("../models/Room");
const Message    = require("../models/Message");
const User       = require("../models/User");
const Report     = require("../models/Report");
const Whiteboard = require("../models/Whiteboard");
const {
  ROOM_CAP, validId, sameId, sameValue,
  isAdmin, isMod, canModerate, getMember, ensureMember, isStudyRoom,
  GRANT_SLOTS, getGrantSlot, hasGrant, scopeText,
  canManageQueue, canControlTimer, canManageStudy,
  isBanned, isVoiceMuted, canDeleteMessage, canReportMessage,
  resolvePerms, serializeMembers, serializeReport, serializeVoiceMutes,
  sanitizeRoomPatch,
} = require("../utils/roomConfigAndPermissions");
const { enforceVoiceMute } = require("../utils/voiceRoom");
const { logRoomEvent, announce, logJoin, logLeave } = require("../utils/roomEvents");
const { onRoomDeleted } = require("../services/roomRuntime");
/* ═══════════════════════════════════════════════════════════
   2. SHARED STATE & LIMITS
   ═══════════════════════════════════════════════════════════ */
/* moderation */
const KICK_COOLDOWN = 10000;
const recentKicks = new Map();              // "roomId:userId" → expiry ms
/* permissions */
const SLOT_MODES = ["host", "everyone"];
const PERM_REQUEST_COOLDOWN = 15000;
/* chat */
const CHAT_QUEUE_MAX = 20;
const MEDIA_URL_MAX  = 2048;
const MEDIA_EXT      = /\.(?:png|jpe?g|gif)$/i;
/* playback */
const SEEK_BARRIER_MAX_WAIT = 8000;
const pendingSeeks = new Map();             // roomId → { seq, currentTime, waiting:Set, ready:Set, timer }
const roomSeekSeqs = new Map();             // roomId → number
/* queue */
const MAX_QUEUE = 100;
const ADVANCE_LOCK_MS = 3000;
const YT_RE = /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;
const advanceLock = new Map();              // roomId → ts; de-dupes concurrent "video-ended" reports
/* study: timer */
const pomoTimers = new Map();               // roomId → timeout id
/* study: tasks */
const MAX_TASKS = 100;
/* study: whiteboard */
const WB = { LIM: 50000, MAX_BOARDS: 6, MAX_SAVED: 20, MAX_STROKES: 3000, MAX_POINTS: 100000,
             MAX_BATCH: 100, MAX_STROKE_PTS: 20000, MAX_SIZE: 40, MAX_TEXTS: 200,
             MAX_IDS: 500, HIST_CAP: 200, MAX_HTML: 6000, MAX_MOVE: 5000 };
const SHAPE_KINDS = new Set(["line", "arrow", "rect", "square", "circle", "oval"]);
const WB_TOOLS = ["pen", "eraser", "shape", "text"];
const HEX      = /^#[0-9a-f]{6}$/i;
const WB_TAIL  = /^[\w-]{1,24}$/;
const WB_ANYID = /^[\w:-]{1,64}$/;
const HTML_TAGS = new Set(["b", "strong", "i", "em", "u", "br", "div", "p", "span", "font"]);
const COLOR_OK  = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;
const WORKSPACE_TTL = 2 * 3600 * 1000;      // forget workspaces untouched for 2h
const workspaces = new Map();               // roomId → { enabled, boards:Map, order:[], saved:[], n, touched }
/* reactions */
const ALLOWED_REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👏", "💀"];
const REACT_LIMIT = 8, REACT_WINDOW = 4000;
/* ═══════════════════════════════════════════════════════════
   3. GUARD POLICIES
   policy = guard + the toast shown when it says no.
   Built at module load: if a guard is missing from the require block
   the server fails to START (instead of "check is not a function"
   the first time someone clicks).
   ═══════════════════════════════════════════════════════════ */
function policy(check, denied) {
  if (typeof check !== "function") {
    throw new TypeError(`roomHandlers: the guard for "${denied}" is not a function — check the require block`);
  }
  return Object.freeze({ check, denied });
}
const isStudyHost = (room, uid) => isStudyRoom(room) && isAdmin(room, uid);
const POLICY = Object.freeze({
  /* core hierarchy */
  HOST:         policy(isAdmin,         "Only the host can do that"),
  MODERATOR:    policy(canModerate,     "Only the host and moderators can do that"),
  CLEAR_CHAT:   policy(isAdmin,         "Only the host can clear the chat"),
  /* media rooms */
  MEDIA_QUEUE:  policy(canManageQueue,  "You don't have queue control in this room"),
  /* study rooms */
  STUDY_TIMER:  policy(canControlTimer, "Only the host, mods or people with timer control can change the timer"),
  STUDY_TASKS:  policy(canManageStudy,  "Only the host, mods or people with task access can manage tasks"),
  STUDY_BOARDS: policy(canManageStudy,  "Only the host, mods or people with board access can do that"),
  STUDY_HOST:   policy(isStudyHost,     "Only the host can do that"),
  STUDY_ROOM:   policy(isStudyRoom,     "Tasks are only available in study rooms"),
});
/* Playback (play / pause / seek) is the one hot path that does NOT use a policy:
   it is authorised from the cached perms (socket.data.perm.canControlMedia) so a
   video event never costs a DB read. See registerPlayback(). */
/* ═══════════════════════════════════════════════════════════
   4. SHARED HELPERS
   ═══════════════════════════════════════════════════════════ */
function newItemId() { return crypto.randomBytes(8).toString("hex"); }
/* per-socket token bucket — whiteboard hot paths (smooth refill, bursts allowed) */
function bucket(cap, perSec) {
  let tokens = cap, last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(cap, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
async function socketsOfUser(io, roomId, userId) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.user && sameId(s.data.user.id, userId));
}
async function moderatorSockets(io, roomId, room) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.user && canModerate(room, s.data.user.id));
}
async function toUser(io, roomId, userId, event, payload) {
  (await socketsOfUser(io, roomId, userId)).forEach((s) => s.emit(event, payload));
}
/* emit only to the host + mods currently in the room */
async function emitToMods(io, room, event, payload) {
  (await moderatorSockets(io, room.roomId, room)).forEach((s) => s.emit(event, payload));
}
/* ═══════════════════════════════════════════════════════════
   5. CONNECTION CONTEXT — built once per socket, handed to every domain
   ═══════════════════════════════════════════════════════════ */
function createContext(io, socket) {
  const user = socket.data.user;
  const toast = (message, type = "error") => socket.emit("perm-toast", { message, type });
  /* every listener is registered through on(): sync throws and async rejections are contained */
  const report = (event, err) => console.error(`[room] "${event}" failed:`, err);
  const on = (event, handler) => {
    if (typeof handler !== "function") throw new TypeError(`on("${event}"): handler is not a function`);
    socket.on(event, (...args) => {
      try {
        const out = handler(...args);
        if (out && typeof out.catch === "function") out.catch((err) => report(event, err));
      } catch (err) {
        report(event, err);
      }
    });
  };
  /* THE guarded-action implementation: load room → check policy → run */
  const guarded = (rule, fn) => {
    if (!rule || typeof rule.check !== "function") throw new TypeError("guarded(): unknown POLICY");
    if (typeof fn !== "function") throw new TypeError("guarded(): handler is not a function");
    return async (...args) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      try {
        const room = await Room.findOne({ roomId });
        if (!room) return;
        if (!rule.check(room, user.id)) { toast(rule.denied); return; }
        await fn(room, roomId, ...args);
      } catch (err) {
        console.error("privileged action failed:", err);
        toast("Something went wrong — try again");
      }
    };
  };
  /* fixed-window limiter stored on the socket (queue adds, lyrics, reactions) */
  const rateLimited = (key, max, windowMs) => {
    const now = Date.now();
    const rl = socket.data[key] || (socket.data[key] = { n: 0, reset: now + windowMs });
    if (now > rl.reset) { rl.n = 0; rl.reset = now + windowMs; }
    return ++rl.n > max;
  };
  /* cached by join-room / broadcastPermissions → no DB read per video event */
  const mayControlMedia = () => !!(socket.data.perm && socket.data.perm.canControlMedia);
  return { io, socket, user, on, toast, guarded, rateLimited, mayControlMedia };
}
/* ═══════════════════════════════════════════════════════════
   6a. PRESENCE — join / leave / room snapshot
   ═══════════════════════════════════════════════════════════ */
function presencePayload(room) {
  return {
    participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
    count: room.participants.length,
  };
}
function serializeRoom(room) {
  const v = room.video || {};
  const live = liveVideoState(room);
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    description: room.description,
    roomType: room.roomType,
    status: room.status,
    isPublic: room.isPublic,
    maxParticipants: room.maxParticipants,
    tags: room.tags,
    settings: {
      syncMode:  room.settings?.syncMode  || "host",
      queueMode: room.settings?.queueMode || "host",
      autoplay:  room.settings?.autoplay !== false,
      whoCanChangeVideo: room.settings?.whoCanChangeVideo || "host",   // legacy field, still in the payload
    },
    admin: room.admin ? { userId: room.admin.userId, username: room.admin.username } : null,
    video: { url: v.url || null, itemId: v.itemId || null, title: v.title || null,
             thumb: v.thumb || null, currentTime: live.currentTime, isPlaying: live.isPlaying },
    queue: serializeQueue(room),
    pomodoro: serializePomodoro(room),
    whiteboard: { enabled: !(room.whiteboard && room.whiteboard.enabled === false) },
    tasks: serializeTasks(room),
    participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
  };
}
async function handleLeave(io, socket) {
  const roomId = socket.data.roomId;
  const user = socket.data.user;
  if (!roomId || !user) return;
  const socketsInRoom = await io.in(roomId).fetchSockets();
  const stillConnectedElsewhere = socketsInRoom.some(
    (s) => s.id !== socket.id && s.data.user && s.data.user.id === user.id,
  );
  socket.leave(roomId);
  socket.data.roomId = null;
  if (stillConnectedElsewhere) return;
  const room = await Room.findOne({ roomId });
  if (!room) return;
  // NOTE: we prune `participants` (presence) but NEVER `members` (permissions persist)
  room.participants = room.participants.filter((p) => !(p.userId && p.userId.toString() === user.id));
  if (room.participants.length === 0 && room.status === "active") room.status = "idle";
  if (room.participants.length === 0) advanceLock.delete(roomId);
  await room.save();
  io.to(roomId).emit("participants-update", presencePayload(room));
  io.to(roomId).emit("user-left", { username: user.username });
  logLeave(io, roomId, user);
  checkSeekBarrier(io, roomId);
}
function registerPresence({ io, socket, user, on }) {
  on("join-room", async ({ roomId } = {}) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return socket.emit("room-error", { message: "Room not found" });
      if (isBanned(room, user.id)) {
        return socket.emit("room-error", {
          message: "You've been banned from this room",
          code: "banned", fatal: true,
        });
      }
      const cool = kickCooldownLeft(roomId, user.id);
      if (cool > 0) {
        return socket.emit("room-error", {
          message: `You were just removed from this room — try again in ${Math.ceil(cool / 1000)}s`,
          code: "kicked", fatal: true,
        });
      }
      socket.join(roomId);
      socket.data.roomId = roomId;
      const alreadyIn = room.participants.some((p) => p.userId && p.userId.toString() === user.id);
      let isNewParticipant = false;
      if (!alreadyIn) {
        if (room.participants.length >= room.maxParticipants) {
          socket.emit("room-error", { message: "Room is full" });
          socket.leave(roomId);
          socket.data.roomId = null;
          return;
        }
        room.participants.push({ userId: user.id, username: user.username, joinedAt: new Date() });
        if (room.status === "idle") room.status = "active";
        isNewParticipant = true;
      }
      ensureMember(room, user);                         // persistent permission record
      /* legacy room that has a video but no queue → seed the queue with it */
      if ((!room.queue || !room.queue.length) && room.video && room.video.url) {
        const meta = await resolveMeta(room.video.url);
        room.queue = [{
          itemId: newItemId(), url: room.video.url, ...meta,
          addedBy: room.admin.userId, addedByName: room.admin.username, addedAt: new Date(),
          playedAt: new Date(),
        }];
        room.queueIndex = 0;
        room.video.itemId = room.queue[0].itemId;
        room.video.title  = room.queue[0].title;
        room.video.thumb  = room.queue[0].thumb;
      }
      if (room.isModified()) await room.save();
      if (isNewParticipant) {
        await User.updateOne({ _id: user.id }, { $addToSet: { joinedRooms: roomId } });
      }
      socket.data.perm = resolvePerms(room, user.id);
      socket.emit("room-state", {
        room:  serializeRoom(room),
        perms: socket.data.perm,
        voiceMuted: serializeVoiceMutes(room),
      });
      io.to(roomId).emit("participants-update", presencePayload(room));
      await broadcastPermissions(io, roomId, room);     // roster/badges for everyone (incl. host)
      if (isNewParticipant) {
        socket.to(roomId).emit("user-joined", { username: user.username });
        logJoin(io, roomId, user);
      }
    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("room-error", { message: "Failed to join room" });
    }
  });
  on("leave-room",    () => handleLeave(io, socket));
  on("disconnecting", () => handleLeave(io, socket));
}
/* ═══════════════════════════════════════════════════════════
   6b. PERMISSIONS — modes, grants, requests, roles
   ═══════════════════════════════════════════════════════════ */
function permPayload(room, uid) {
  const perms = resolvePerms(room, uid);
  const requests = [];
  if (perms.canManage) {                              // only host + mods see pending requests
    for (const m of room.members || []) {
      for (const [scope, slot] of Object.entries(GRANT_SLOTS)) {
        if (m[slot.req] === "pending") requests.push({ userId: m.userId.toString(), username: m.username, scope });
      }
    }
  }
  return {
    perms,
    members: serializeMembers(room, perms.canManage),
    requests,
    banned: perms.canBan ? (room.bannedUsers || []).map((b) => ({
      userId: b.userId.toString(), username: b.username,
      reason: b.reason || "", by: b.bannedByName || "", bannedAt: b.bannedAt,
    })) : [],
  };
}
/* push fresh perms to every socket in the room + refresh their cache */
async function broadcastPermissions(io, roomId, room) {
  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const uid = s.data.user && s.data.user.id;
    if (!uid) continue;
    const payload = permPayload(room, uid);
    s.data.perm = payload.perms;                      // cache → no DB read per video event
    s.emit("room-permissions", payload);
  }
}
function registerPermissions({ io, socket, user, on, toast, guarded }) {
  /* "who can …" per slot: host-only ⇄ everyone. One handler serves both slots. */
  const setSlotMode = (scope) => guarded(POLICY.MODERATOR, async (room, roomId, { mode } = {}) => {
    const slot = GRANT_SLOTS[scope];
    if (!SLOT_MODES.includes(mode) || room.settings[slot.mode] === mode) return;
    room.settings[slot.mode] = mode;
    await room.save();
    await broadcastPermissions(io, roomId, room);
    const t = scopeText(room, scope);
    io.to(roomId).emit("perm-notice", { text: mode === "everyone" ? t.everyone : t.hostOnly, byId: user.id });
  });
  on("perm-set-mode",       setSlotMode("sync"));
  on("perm-set-queue-mode", setSlotMode("queue"));
  /* { userId, scope:'sync'|'queue' } — scope defaults to 'sync' (old clients) */
  on("perm-grant", guarded(POLICY.MODERATOR, async (room, roomId, { userId, scope = "sync" } = {}) => {
    const slot = getGrantSlot(scope);
    if (!slot) return;
    const m = getMember(room, userId);
    if (!m || canModerate(room, userId)) return;       // host/mods hold every grant implicitly
    if (m[slot.flag]) return;
    m[slot.flag] = true; m[slot.req] = "none"; m.updatedAt = new Date();
    await room.save();
    const label = scopeText(room, scope).label;
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", { message: `You can now use ${label} 🎉`, type: "success" });
    io.to(roomId).emit("perm-notice", { text: `${m.username} can now use ${label}`, byId: user.id });
  }));
  on("perm-revoke", guarded(POLICY.MODERATOR, async (room, roomId, { userId, scope = "sync" } = {}) => {
    const slot = getGrantSlot(scope);
    if (!slot) return;
    const m = getMember(room, userId);
    if (!m || canModerate(room, userId)) return;
    m[slot.flag] = false; m[slot.req] = "denied"; m.updatedAt = new Date();
    await room.save();
    const label = scopeText(room, scope).label;
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", { message: `Your ${label} was removed`, type: "error" });
  }));
  /* a member asks the host/mods for a grant (no guard: anyone may ask) */
  on("perm-request", async ({ scope = "sync" } = {}) => {
    const roomId = socket.data.roomId;
    const slot = getGrantSlot(scope);
    if (!roomId || !slot) return;
    const now = Date.now();
    const last = socket.data.lastPermReq || (socket.data.lastPermReq = {});
    if (now - (last[scope] || 0) < PERM_REQUEST_COOLDOWN) return;
    last[scope] = now;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    const label = scopeText(room, scope).label;
    if (hasGrant(room, user.id, scope)) return toast(`You already have ${label}`, "success");
    const m = ensureMember(room, user);
    if (m[slot.req] === "denied") {
      return toast("Your request was declined — a host or mod has to grant it from room settings");
    }
    const targets = await moderatorSockets(io, roomId, room);
    if (!targets.length) return toast("No host or moderator is in the room right now");
    if (m[slot.req] !== "pending") { m[slot.req] = "pending"; m.updatedAt = new Date(); await room.save(); }
    targets.forEach((s) => s.emit("perm-request", { userId: user.id, username: user.username, scope }));
    toast("Request sent ✌️", "success");
    await broadcastPermissions(io, roomId, room);
  });
  on("perm-respond", guarded(POLICY.MODERATOR, async (room, roomId, { userId, approve, scope = "sync" } = {}) => {
    const slot = getGrantSlot(scope);
    if (!slot) return;
    const m = getMember(room, userId);
    if (!m || m[slot.req] !== "pending") return;
    m[slot.flag] = !!approve;
    m[slot.req]  = approve ? "none" : "denied";
    m.updatedAt  = new Date();
    await room.save();
    const label = scopeText(room, scope).label;
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", {
      message: approve ? `${user.username} gave you ${label} 🎉` : "Your request was declined",
      type: approve ? "success" : "error",
    });
    if (approve) io.to(roomId).emit("perm-notice", { text: `${m.username} can now use ${label}`, byId: user.id });
  }));
  /* role changes: HOST ONLY */
  on("perm-set-role", guarded(POLICY.HOST, async (room, roomId, { userId, role } = {}) => {
    if (!["mod", "member"].includes(role)) return;
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === role) return;
    m.role = role;
    if (role === "mod") {
      // mods hold every grant implicitly → nothing is left to ask for
      for (const slot of Object.values(GRANT_SLOTS)) m[slot.req] = "none";
    }
    m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);       // this is what flips their UI live
    await toUser(io, roomId, userId, "perm-toast", {
      message: role === "mod"
        ? `You're now a moderator — you can edit the room and grant ${scopeText(room, "sync").label}`
        : "You're no longer a moderator",
    });
    io.to(roomId).emit("perm-notice", {
      text: role === "mod" ? `${m.username} is now a moderator` : `${m.username} is no longer a moderator`,
      byId: user.id,
    });
  }));
}
/* ═══════════════════════════════════════════════════════════
   6c. MODERATION — kick / remove / ban / unban / voice mutes
   ═══════════════════════════════════════════════════════════ */
/* a kick must survive the client's auto-reconnect for a few seconds,
   otherwise a reconnecting socket walks straight back in */
function kickKey(roomId, uid) { return roomId + ":" + uid; }
function markKicked(roomId, uid) {
  recentKicks.set(kickKey(roomId, uid), Date.now() + KICK_COOLDOWN);
}
function kickCooldownLeft(roomId, uid) {
  const until = recentKicks.get(kickKey(roomId, uid));
  if (!until) return 0;
  if (Date.now() > until) { recentKicks.delete(kickKey(roomId, uid)); return 0; }
  return until - Date.now();
}
/* boot every socket this user has in the room, prune presence (caller saves) */
async function evictUser(io, roomId, room, userId, reason, message) {
  const mine = await socketsOfUser(io, roomId, userId);
  for (const s of mine) {
    s.emit("room-kicked", { reason, message, roomId });   // client stashes a toast + redirects
    s.leave(roomId);                                      // no further room traffic reaches them
    s.data.roomId = null;
    s.data.perm = null;
    setTimeout(() => { try { s.disconnect(true); } catch (_) {} }, 1000); // in case their JS is dead
  }
  const before = room.participants.length;
  room.participants = room.participants.filter((p) => !sameId(p.userId, userId));
  if (room.participants.length === 0 && room.status === "active") room.status = "idle";
  return { wasPresent: before !== room.participants.length, sockets: mine.length };
}
function voiceMutePayload(room) { return { muted: serializeVoiceMutes(room) }; }
function registerModeration({ io, socket, user, on, toast, guarded }) {
  /* resolve a display name even if the member record is already gone */
  function nameOf(room, userId) {
    const m = getMember(room, userId);
    if (m && m.username) return m.username;
    const p = room.participants.find((x) => sameId(x.userId, userId));
    if (p && p.username) return p.username;
    const b = (room.bannedUsers || []).find((x) => sameId(x.userId, userId));
    return (b && b.username) || "That user";
  }
  /* shared target validation for every destructive action */
  function badTarget(room, userId) {
    if (!validId(userId)) return "Unknown user";
    if (sameId(userId, user.id)) return "You can't do that to yourself";
    if (isAdmin(room, userId))   return "The host can't be removed";
    return null;
  }
  /* KICK — boot from this session; membership + permissions survive, they may rejoin */
  on("member-kick", guarded(POLICY.HOST, async (room, roomId, { userId } = {}) => {
    const bad = badTarget(room, userId);
    if (bad) return toast(bad);
    const name = nameOf(room, userId);
    const { wasPresent } = await evictUser(
      io, roomId, room, userId, "kick",
      `${user.username} removed you from “${room.roomName}”. You can rejoin in a moment.`
    );
    if (!wasPresent) return toast(`${name} isn't in the room right now`);
    markKicked(roomId, userId);
    await room.save();
    io.to(roomId).emit("participants-update", presencePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was kicked from the room`, byId: user.id });
    toast(`${name} was kicked`, "success");
    await broadcastPermissions(io, roomId, room);
  }));
  /* REMOVE — delete the member record (role, grants, request state) + boot; rejoining is allowed */
  on("member-remove", guarded(POLICY.HOST, async (room, roomId, { userId } = {}) => {
    const bad = badTarget(room, userId);
    if (bad) return toast(bad);
    if (!getMember(room, userId)) return toast("They're not a member of this room");
    const name = nameOf(room, userId);
    await evictUser(io, roomId, room, userId, "removed",
      `${user.username} removed you from “${room.roomName}”.`);
    room.members = room.members.filter((m) => !sameId(m.userId, userId));
    markKicked(roomId, userId);
    await room.save();
    await User.updateOne({ _id: userId }, { $pull: { joinedRooms: roomId } });
    io.to(roomId).emit("participants-update", presencePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was removed from the room`, byId: user.id });
    toast(`${name} was removed`, "success");
    await broadcastPermissions(io, roomId, room);
  }));
  /* BAN — remove + blocklist; rejoining is impossible until unbanned */
  on("member-ban", guarded(POLICY.HOST, async (room, roomId, { userId, reason } = {}) => {
    const bad = badTarget(room, userId);
    if (bad) return toast(bad);
    const name = nameOf(room, userId);
    if (isBanned(room, userId)) return toast(`${name} is already banned`);
    await evictUser(io, roomId, room, userId, "banned",
      `You were banned from “${room.roomName}” by ${user.username}.`);
    room.members = room.members.filter((m) => !sameId(m.userId, userId));
    room.bannedUsers.push({
      userId, username: name,
      bannedBy: user.id, bannedByName: user.username,
      reason: String(reason || "").trim().slice(0, 140),
      bannedAt: new Date(),
    });
    await room.save();
    await User.updateOne({ _id: userId }, { $pull: { joinedRooms: roomId } });
    io.to(roomId).emit("participants-update", presencePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was banned from the room`, byId: user.id });
    toast(`${name} was banned`, "success");
    await broadcastPermissions(io, roomId, room);
  }));
  /* UNBAN */
  on("member-unban", guarded(POLICY.HOST, async (room, roomId, { userId } = {}) => {
    if (!validId(userId)) return;
    const b = (room.bannedUsers || []).find((x) => sameId(x.userId, userId));
    if (!b) return;
    const name = b.username || "They";
    room.bannedUsers = room.bannedUsers.filter((x) => !sameId(x.userId, userId));
    recentKicks.delete(kickKey(roomId, userId));
    await room.save();
    await broadcastPermissions(io, roomId, room);
    toast(`${name} can join again`, "success");
  }));
  /* VOICE — host/mods force-mute a member for the whole room (persists like a ban) */
  on("voice-force-mute", guarded(POLICY.MODERATOR, async (room, roomId, { userId } = {}) => {
    const bad = badTarget(room, userId);                 // blocks self / host / bad id
    if (bad) return toast(bad);
    if (isMod(room, userId)) return toast("You can't voice-mute another moderator");
    const name = nameOf(room, userId);
    if (isVoiceMuted(room, userId)) return toast(`${name} is already muted`);
    room.voiceMutedUsers.push({
      userId, username: name,
      mutedBy: user.id, mutedByName: user.username, mutedAt: new Date(),
    });
    await room.save();
    enforceVoiceMute(roomId, userId, true).catch(() => {});   // best-effort SFU kill
    io.to(roomId).emit("voice-muted-users", voiceMutePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was muted in voice by ${user.username}`, byId: user.id });
    await toUser(io, roomId, userId, "perm-toast",
      { message: `${user.username} muted your microphone`, type: "error" });
    toast(`${name} muted in voice`, "success");
  }));
  on("voice-force-unmute", guarded(POLICY.MODERATOR, async (room, roomId, { userId } = {}) => {
    if (!validId(userId)) return;
    const name = nameOf(room, userId);
    if (!isVoiceMuted(room, userId)) return toast(`${name} isn't muted`);
    room.voiceMutedUsers = room.voiceMutedUsers.filter((m) => !sameId(m.userId, userId));
    await room.save();
    enforceVoiceMute(roomId, userId, false).catch(() => {});  // restores publish rights
    io.to(roomId).emit("voice-muted-users", voiceMutePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was unmuted in voice by ${user.username}`, byId: user.id });
    await toUser(io, roomId, userId, "perm-toast",
      { message: `${user.username} lifted your voice mute — you can unmute yourself now`, type: "info" });
    toast(`${name} unmuted in voice`, "success");
  }));
}
/* ═══════════════════════════════════════════════════════════
   6d. ROOM DETAILS — name / description / tags / visibility / cap
   ═══════════════════════════════════════════════════════════ */
function registerRoomDetails({ socket, user, on, toast, guarded }) {
  on("room-update", guarded(POLICY.MODERATOR, async (room, roomId, payload = {}) => {
    const { patch, errors } = sanitizeRoomPatch(room, payload);
    if (errors.length) return toast(errors[0]);
    const changed = Object.keys(patch).filter((k) => !sameValue(room[k], patch[k]));
    if (!changed.length) return toast("Nothing to save", "info");
    changed.forEach((k) => { room[k] = patch[k]; });
    await room.save();                                   // schema validators run here; guarded() catches throws
    const updatedRoom = serializeRoom(room);
    socket.emit("room-saved", { room: updatedRoom, changed });                                  // the editor
    socket.to(roomId).emit("room-updated", { room: updatedRoom, by: user.username, changed }); // everyone else
    toast("Room details saved ✅", "success");
    socket.to(roomId).emit("perm-notice", { text: `${user.username} updated the room details`, byId: user.id });
  }));
}
/* ═══════════════════════════════════════════════════════════
   6e. CHAT — send / edit / delete / clear
   ═══════════════════════════════════════════════════════════ */
function cleanText(text) {
  return (typeof text === "string" ? text : "")
    .replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
}
/* mirrors normalizeImageUrl() in public/js/media-embed.js — keep in sync */
function cleanMediaUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MEDIA_URL_MAX) return null;
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!MEDIA_EXT.test(u.pathname)) return null;
  return u.href;
}
function registerChat({ io, socket, user, on, toast, guarded }) {
  /* strict FIFO per socket: a send with N images emits N events back to back; each
     awaits the DB, so without a queue they could broadcast out of order */
  let chain = Promise.resolve();
  let pending = 0;
  async function sendMessage(payload) {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const { text, mediaUrl } = payload || {};
      const clean = cleanText(text);
      const media = cleanMediaUrl(mediaUrl);
      if (!clean && !media) return;
      const msg = await Message.create({
        roomId, senderId: user.id, senderName: user.username,
        message: clean, mediaUrl: media,
      });
      io.to(roomId).emit("chat-message", {
        id: msg._id.toString(), senderId: user.id, username: user.username,
        text: clean, mediaUrl: media, timestamp: msg.timestamp,
      });
    } catch (err) { console.error("chat-message error:", err); }     // never rejects → the chain survives
  }
  on("chat-message", (payload) => {
    if (pending >= CHAT_QUEUE_MAX) return;               // flood guard
    pending++;
    chain = chain.then(() => sendMessage(payload)).finally(() => { pending--; });
  });
  /* edit (author only) — the caption may be emptied if media exists */
  on("chat-edit", async ({ id, text } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !validId(id)) return;
    const clean = cleanText(text);
    const msg = await Message.findById(id);
    if (!msg || msg.roomId !== roomId || msg.deleted) return;
    if (!sameId(msg.senderId, user.id)) return toast("You can only edit your own messages");
    if (!clean && !msg.mediaUrl) return toast("Message can't be empty — delete it instead");
    if (msg.message === clean) return;                   // no-op
    msg.message  = clean;
    msg.editedAt = new Date();
    await msg.save();
    io.to(roomId).emit("chat-edited", { id: msg._id.toString(), text: clean, editedAt: msg.editedAt });
  });
  /* delete (author, or any mod / host) */
  on("chat-delete", async ({ id } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !validId(id)) return;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    const msg = await Message.findById(id);
    if (!msg || msg.roomId !== roomId || msg.deleted) return;
    if (!canDeleteMessage(room, msg, user.id)) return toast("You can't delete that message");
    const mine = sameId(msg.senderId, user.id);
    const role = mine ? "self" : (isAdmin(room, user.id) ? "admin" : "mod");
    msg.deleted       = true;
    msg.deletedAt     = new Date();
    msg.deletedBy     = user.id;
    msg.deletedByName = user.username;
    msg.deletedByRole = role;
    msg.message       = "";                              // scrub text at rest
    msg.mediaUrl      = null;                            // …and the media link
    await msg.save();
    io.to(roomId).emit("chat-deleted", {
      id: msg._id.toString(),
      byId: String(user.id), byName: user.username, byRole: role,
    });
    /* a mod/host delete resolves the report; an author delete keeps it as evidence */
    if (role === "self") {
      const r = await Report.updateMany({ roomId, messageId: msg._id }, { $set: { messageDeleted: true } });
      if (r.modifiedCount) await pushReports(io, room);
    } else {
      const r = await Report.deleteMany({ roomId, messageId: msg._id });
      if (r.deletedCount) await pushReports(io, room);
      logRoomEvent(io, roomId, {
        kind: "chat", action: "chat.delete", actor: user,
        target: { id: msg.senderId, username: msg.senderName },
        text: "{actor} deleted a message from {target}",
      });
    }
  });
  /* clear the whole room log (host only) */
  on("chat-clear", guarded(POLICY.CLEAR_CHAT, async (room, roomId) => {
    const { deletedCount } = await Message.deleteMany({ roomId });
    await Report.deleteMany({ roomId });
    io.to(roomId).emit("chat-cleared", { byId: String(user.id), byName: user.username });
    logRoomEvent(io, roomId, {
      kind: "chat", action: "chat.clear", actor: user,
      text: "{actor} cleared the chat ({detail})",
      detail: deletedCount === 1 ? "1 message" : deletedCount + " messages",
      meta: { count: deletedCount },
    });
    await pushReports(io, room);
  }));
}
/* ═══════════════════════════════════════════════════════════
   6f. REPORTS — report a message, review, dismiss
   ═══════════════════════════════════════════════════════════ */
async function listReports(roomId) {
  const docs = await Report.find({ roomId }).sort({ updatedAt: -1 }).limit(50).lean();
  return docs.map(serializeReport);
}
/* re-broadcast the full list to every host/mod in the room */
async function pushReports(io, room) {
  const reports = await listReports(room.roomId);
  await emitToMods(io, room, "room-reports", { reports });
}
function registerReports({ io, socket, user, on, toast, guarded }) {
  /* report a message (anyone, not your own) */
  on("chat-report", async ({ id } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !validId(id)) return;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    const msg = await Message.findById(id);
    if (!msg || msg.roomId !== roomId || msg.deleted) return toast("That message is no longer available");
    if (!canReportMessage(room, msg, user.id)) return toast("You can't report your own message");
    let rep;
    try {
      /* the $ne filter plus the unique index make this atomic: a second report
         from the same user can't match, so the upsert collides → E11000 */
      rep = await Report.findOneAndUpdate(
        { roomId, messageId: msg._id, "reporters.userId": { $ne: user.id } },
        {
          $set:  { senderId: msg.senderId, senderName: msg.senderName,
                   text: msg.message || (msg.mediaUrl ? "[image] " + msg.mediaUrl : ""),
                   messageTs: msg.timestamp, messageDeleted: false },
          $push: { reporters: { userId: user.id, username: user.username, at: new Date() } },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (e) {
      if (e && e.code === 11000) return toast("You've already reported this message", "info");
      throw e;
    }
    toast("Reported. The host and mods have been notified", "success");
    await emitToMods(io, room, "report-new", {
      id: rep._id.toString(),
      messageId: msg._id.toString(),
      reporterName: user.username,
      senderName: msg.senderName,
      count: rep.reporters.length,
    });
    await pushReports(io, room);
  });
  /* fetch the list — silently ignored for non-moderators (the UI never asks) */
  on("report-list", async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await Room.findOne({ roomId });
    if (!room || !canModerate(room, user.id)) return;
    socket.emit("room-reports", { reports: await listReports(roomId) });
  });
  /* dismiss a report without touching the message */
  on("report-dismiss", guarded(POLICY.MODERATOR, async (room, roomId, { id } = {}) => {
    if (!validId(id)) return;
    await Report.deleteOne({ _id: id, roomId });
    await pushReports(io, room);
  }));
}
/* ═══════════════════════════════════════════════════════════
   6g. PLAYBACK — play / pause / seek + the seek barrier (media rooms)
   ═══════════════════════════════════════════════════════════ */
/* authoritative video state: snapshot for joiners, and to snap a rule-breaker back */
function liveVideoState(room) {
  const v = room.video || {};
  let t = v.currentTime || 0;
  if (v.isPlaying && v.updatedAt) t += (Date.now() - new Date(v.updatedAt).getTime()) / 1000;
  return { currentTime: t, isPlaying: !!v.isPlaying };
}
function clearSeekBarrier(roomId) {
  const ps = pendingSeeks.get(roomId);
  if (ps) { clearTimeout(ps.timer); pendingSeeks.delete(roomId); }
}
async function finishSeekBarrier(io, roomId) {
  const ps = pendingSeeks.get(roomId);
  if (!ps) return;
  clearTimeout(ps.timer);
  pendingSeeks.delete(roomId);
  // un-freeze the room in the DB
  await Room.updateOne({ roomId }, { $set: {
    "video.isPlaying": true, "video.currentTime": ps.currentTime, "video.updatedAt": new Date(),
  }});
  io.to(roomId).emit("video-seek-go", { currentTime: ps.currentTime, seq: ps.seq });
}
async function checkSeekBarrier(io, roomId) {
  const ps = pendingSeeks.get(roomId);
  if (!ps) return;
  const sockets = await io.in(roomId).fetchSockets();
  const present = new Set(sockets.map((s) => s.data.user && String(s.data.user.id)).filter(Boolean));
  for (const uid of ps.waiting) {
    if (present.has(uid) && !ps.ready.has(uid)) return;   // someone is still buffering
  }
  await finishSeekBarrier(io, roomId);
}
async function startSeekBarrier(io, roomId, currentTime) {
  clearSeekBarrier(roomId);
  const seq = (roomSeekSeqs.get(roomId) || 0) + 1;
  roomSeekSeqs.set(roomId, seq);
  const sockets = await io.in(roomId).fetchSockets();
  const waiting = new Set(sockets.map((s) => s.data.user && String(s.data.user.id)).filter(Boolean));
  pendingSeeks.set(roomId, {
    seq, currentTime, waiting, ready: new Set(),
    timer: setTimeout(() => {
      finishSeekBarrier(io, roomId).catch((err) => console.error("seek barrier timeout:", err));
    }, SEEK_BARRIER_MAX_WAIT),
  });
  // freeze the room in the DB so late joiners see it paused
  await Room.updateOne({ roomId }, { $set: {
    "video.isPlaying": false, "video.currentTime": currentTime, "video.updatedAt": new Date(),
  }});
  io.to(roomId).emit("video-seek-hold", { currentTime, seq });
}
function registerPlayback({ io, socket, user, on, mayControlMedia }) {
  /* tell the client no, and hand it the real state so it can snap back */
  async function denyMedia(action) {
    const room = await Room.findOne({ roomId: socket.data.roomId }).lean();
    socket.emit("perm-denied", {
      action,
      message: "You don't have playback control in this room",
      video: room ? liveVideoState(room) : null,
    });
  }
  /* hot path: authorised from the cached perms — no DB read just to say yes */
  const mediaAction = (action, fn) => async (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!mayControlMedia()) return denyMedia(action);
    await fn(roomId, payload);
  };
  on("video-play", mediaAction("play", async (roomId, { currentTime }) => {
    clearSeekBarrier(roomId);                              // an explicit play overrides a pending barrier
    await Room.updateOne({ roomId }, { $set: {
      "video.isPlaying": true, "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-play", { currentTime, by: user.username });
  }));
  on("video-pause", mediaAction("pause", async (roomId, { currentTime }) => {
    clearSeekBarrier(roomId);
    await Room.updateOne({ roomId }, { $set: {
      "video.isPlaying": false, "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-pause", { currentTime, by: user.username });
  }));
  on("video-seek", mediaAction("seek", async (roomId, { currentTime }) => {
    const room = await Room.findOne({ roomId }).lean();
    if (!room) return;
    if (room.video?.isPlaying || pendingSeeks.has(roomId)) {
      await startSeekBarrier(io, roomId, currentTime);     // seek-while-playing → barrier
    } else {
      await Room.updateOne({ roomId }, { $set: {           // paused seek → plain relay
        "video.currentTime": currentTime, "video.updatedAt": new Date(),
      }});
      socket.to(roomId).emit("video-seek", { currentTime, by: user.username });
    }
  }));
  on("video-buffer-ready", ({ seq } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const ps = pendingSeeks.get(roomId);
    if (!ps || ps.seq !== seq) return;
    ps.ready.add(String(user.id));
    return checkSeekBarrier(io, roomId);
  });
  /* drift correction — only controllers may drive the clock */
  on("video-time-sync", ({ currentTime } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !mayControlMedia()) return;
    socket.to(roomId).emit("video-time-sync", { currentTime });
  });
  on("video-sync-request", () => {                         // late joiner asks peers
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("video-sync-request", { requesterId: socket.id });
  });
  on("video-sync-response", ({ requesterId, currentTime, isPlaying } = {}) => {
    if (!socket.data.roomId || !requesterId) return;
    io.to(requesterId).emit("video-sync-state", { currentTime, isPlaying });
  });
}
/* ═══════════════════════════════════════════════════════════
   6h. QUEUE — playlist, auto-advance, shared lyrics (media rooms)
   ═══════════════════════════════════════════════════════════ */
function validUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && u.length <= 2048; }
  catch (_) { return false; }
}
async function fetchJSON(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch (_) { return null; }
  finally { clearTimeout(t); }
}
function iso8601ToSec(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
/* metadata is resolved HERE, never trusted from the client */
async function resolveMeta(url) {
  const m = url.match(YT_RE);
  if (m) {
    const id = m[1];
    const o = await fetchJSON("https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    let duration = 0;
    if (process.env.YT_API_KEY) {                       // optional: gives us runtimes
      const d = await fetchJSON("https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=" +
        id + "&key=" + process.env.YT_API_KEY);
      duration = iso8601ToSec(d?.items?.[0]?.contentDetails?.duration);
    }
    return {
      type: "youtube", videoId: id,
      title:  (o?.title || "YouTube video").slice(0, 300),
      author: (o?.author_name || "YouTube").slice(0, 120),
      thumb:  o?.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      duration,
    };
  }
  let title = "Video";
  try { title = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "Video"; } catch (_) {}
  return { type: "direct", videoId: null, title: title.slice(0, 300), author: "Direct link", thumb: "", duration: 0 };
}
function serializeQueue(room) {
  return {
    items: (room.queue || []).map((i) => ({
      id: i.itemId, url: i.url, type: i.type, videoId: i.videoId,
      title: i.title, author: i.author, thumb: i.thumb, duration: i.duration || 0,
      addedBy: i.addedBy ? i.addedBy.toString() : null, addedByName: i.addedByName || "",
      lyrics: i.lyrics || "",
    })),
    index:    typeof room.queueIndex === "number" ? room.queueIndex : -1,
    autoplay: room.settings?.autoplay !== false,
  };
}
function findItem(room, id) { return (room.queue || []).findIndex((i) => i.itemId === id); }
/* make queue[idx] the room's current video */
function applyCurrent(room, idx, play) {
  const it = room.queue[idx];
  room.queueIndex = idx;
  it.playedAt = new Date();
  room.video = {
    url: it.url, itemId: it.itemId, title: it.title, thumb: it.thumb,
    duration: it.duration || 0, currentTime: 0, isPlaying: !!play, updatedAt: new Date(),
  };
  return it;
}
function emitLoad(io, roomId, it, by, play) {
  io.to(roomId).emit("video-load", {
    url: it.url, itemId: it.itemId, title: it.title, thumb: it.thumb,
    by: by || null, play: !!play, startAt: 0,
  });
}
function registerQueue({ io, socket, user, on, toast, guarded, rateLimited, mayControlMedia }) {
  const pushQueue = (roomId, room) => io.to(roomId).emit("queue-update", serializeQueue(room));
  on("queue-add", guarded(POLICY.MEDIA_QUEUE, async (room, roomId, { url } = {}) => {
    const link = String(url || "").trim();
    if (!validUrl(link)) return toast("That doesn't look like a valid URL");
    if ((room.queue || []).length >= MAX_QUEUE) return toast(`Queue is full (${MAX_QUEUE} videos max)`);
    if (rateLimited("qRL", 10, 10000)) return toast("Slow down a little ✋");
    const meta = await resolveMeta(link);
    const item = Object.assign({
      itemId: newItemId(), url: link,
      addedBy: user.id, addedByName: user.username, addedAt: new Date(),
    }, meta);
    room.queue.push(item);
    /* first video in an empty room → make it current (paused; someone presses play) */
    const startNow = room.queueIndex < 0 && !(room.video && room.video.url);
    if (startNow) applyCurrent(room, room.queue.length - 1, false);
    await room.save();
    pushQueue(roomId, room);
    announce(io, roomId, {
      kind: "queue", action: "queue.add", actor: user,
      text: "{actor} added {detail} to the queue", detail: item.title,
    });
    if (startNow) emitLoad(io, roomId, room.queue[room.queueIndex], user.username, false);
  }));
  on("queue-remove", guarded(POLICY.MEDIA_QUEUE, async (room, roomId, {id } = {}) => {
    const i = findItem(room, id);
    if (i < 0) return;
    const [gone] = room.queue.splice(i, 1);
    if (i < room.queueIndex) room.queueIndex--;
    else if (i === room.queueIndex) room.queueIndex = -1;   // keep playing, just detach
    await room.save();
    pushQueue(roomId, room);
    announce(io, roomId, {
      kind: "queue", action: "queue.remove", actor: user,
      text: "{actor} removed {detail} from the queue", detail: gone.title,
    });
  }));
  on("queue-move", guarded(POLICY.MEDIA_QUEUE, async (room, roomId, { id, to } = {}) => {
    const from = findItem(room, id);
    const dest = parseInt(to, 10);
    if (from < 0 || !Number.isInteger(dest) || dest < 0 || dest >= room.queue.length || from === dest) return;
    const curId = room.queueIndex >= 0 ? room.queue[room.queueIndex].itemId : null;
    const [it] = room.queue.splice(from, 1);
    room.queue.splice(dest, 0, it);
    if (curId) room.queueIndex = findItem(room, curId);      // index follows the playing item
    await room.save();
    pushQueue(roomId, room);
  }));
  on("queue-clear", guarded(POLICY.MEDIA_QUEUE, async (room, roomId) => {
    const cur = room.queueIndex >= 0 ? room.queue[room.queueIndex] : null;
    room.queue = cur ? [cur] : [];
    room.queueIndex = cur ? 0 : -1;
    await room.save();
    pushQueue(roomId, room);
    announce(io, roomId, { kind: "queue", action: "queue.clear", actor: user, text: "{actor} cleared the queue" });
  }));
  /* play a specific item (also powers the prev/next buttons) */
  on("queue-play", guarded(POLICY.MEDIA_QUEUE, async (room, roomId, { id } = {}) => {
    const i = findItem(room, id);
    if (i < 0) return;
    clearSeekBarrier(roomId);
    const it = applyCurrent(room, i, true);
    advanceLock.set(roomId, Date.now());                     // suppress a stale "ended" from the old video
    await room.save();
    pushQueue(roomId, room);
    emitLoad(io, roomId, it, user.username, true);
    announce(io, roomId, {
      kind: "playback", action: "video.change", actor: user,
      text: "{actor} started playing {detail}", detail: it.title,
    });
  }));
  on("queue-autoplay", guarded(POLICY.MEDIA_QUEUE, async (room, roomId, { on: enabled } = {}) => {
    const v = !!enabled;
    if (room.settings.autoplay === v) return;
    room.settings.autoplay = v;
    await room.save();
    pushQueue(roomId, room);
    announce(io, roomId, {
      kind: "room", action: "room.update", actor: user,
      text: `{actor} turned autoplay ${v ? "on" : "off"}`,
    });
  }));
  /* a controller learned the real runtime — cache it so everyone sees it */
  on("queue-duration", async ({ id, duration } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !mayControlMedia()) return;
    const d = Number(duration);
    if (!isFinite(d) || d <= 0 || d > 86400) return;
    const room = await Room.findOne({ roomId });
    const i = room ? findItem(room, id) : -1;
    if (i < 0 || room.queue[i].duration) return;
    room.queue[i].duration = d;
    if (room.video && room.video.itemId === id) room.video.duration = d;
    await room.save();
    pushQueue(roomId, room);
  });
  /* music rooms: one person finds the right lyrics, everyone gets them */
  on("sync-lyrics", async ({ id, lyrics } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (typeof id !== "string" || !id) return;
    if (typeof lyrics !== "string" || !lyrics.trim()) return;
    if (lyrics.length > 20000) return toast("Those lyrics are too long to share");
    if (rateLimited("lyrRL", 6, 15000)) return toast("Slow down a little ✋");
    const room = await Room.findOne({ roomId });
    if (!room) return;
    const i = findItem(room, id);
    if (i < 0) return;                             // not in the queue (e.g. detached)
    if (room.queue[i].lyrics === lyrics) return;   // already stored
    room.queue[i].lyrics = lyrics;
    await room.save();
    socket.to(roomId).emit("sync-lyrics", { id, lyrics });
  });
  /* SERVER-AUTHORITATIVE AUTO-ADVANCE
     Any client may report the end; the lock means exactly one advance happens. */
  on("video-ended", async ({ itemId } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (Date.now() - (advanceLock.get(roomId) || 0) < ADVANCE_LOCK_MS) return;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    const cur = room.queueIndex >= 0 ? room.queue[room.queueIndex] : null;
    if (!cur || (itemId && itemId !== cur.itemId)) return;              // stale / wrong video
    advanceLock.set(roomId, Date.now());
    const nextIdx = room.queueIndex + 1;
    if (room.settings.autoplay !== false && nextIdx < room.queue.length) {
      clearSeekBarrier(roomId);
      const it = applyCurrent(room, nextIdx, true);
      await room.save();
      pushQueue(roomId, room);
      emitLoad(io, roomId, it, null, true);
      announce(io, roomId, {
        kind: "playback", action: "video.change",
        text: "▶ Now playing {detail}", detail: it.title,
      });
    } else {
      room.video.isPlaying = false;
      room.video.updatedAt = new Date();
      await room.save();
      io.to(roomId).emit("video-pause", { currentTime: room.video.currentTime, by: null });
      io.to(roomId).emit("queue-ended", {});
    }
  });
}
/* ═══════════════════════════════════════════════════════════
   6i. STUDY — POMODORO TIMER
   State is stored, never ticked: clients derive the countdown from
   endsAt (running) or remainingMs (paused).
   ═══════════════════════════════════════════════════════════ */
function serializePomodoro(room) {
  const p = room.pomodoro || {};
  return {
    phase:       p.phase || "focus",
    running:     !!p.running,
    endsAt:      p.running && p.endsAt ? new Date(p.endsAt).toISOString() : null,
    remainingMs: p.running ? null : (p.remainingMs ?? Room.POMO_MS.focus),
    cycle:       p.cycle || 0,
    durations:   Room.POMO_MS,
    serverNow:   Date.now(),                           // lets clients correct clock skew
  };
}
function clearPomoTimer(roomId) {
  clearTimeout(pomoTimers.get(roomId));
  pomoTimers.delete(roomId);
}
function setPomoPhase(p, phase) {
  p.phase = phase;
  p.running = false;
  p.endsAt = null;
  p.remainingMs = Room.POMO_MS[phase];
}
function nextPomoPhase(p) {
  if (p.phase === "focus") {
    p.cycle = (p.cycle || 0) + 1;
    return p.cycle % 4 === 0 ? "long_break" : "short_break";
  }
  return "focus";
}
async function pomoAutoEnd(io, roomId) {
  pomoTimers.delete(roomId);
  const room = await Room.findOne({ roomId });
  if (!room || !room.pomodoro || !room.pomodoro.running) return;
  const done = room.pomodoro.phase;
  setPomoPhase(room.pomodoro, nextPomoPhase(room.pomodoro));
  await room.save();
  io.to(roomId).emit("pomodoro-update", serializePomodoro(room));
  announce(io, roomId, {
    kind: "study", action: "pomodoro.end", actor: null,
    text: done === "focus" ? "Focus session complete — time for a break"
                           : "Break over — time to focus",
  });
}
function schedulePomoEnd(io, roomId, endsAtMs) {
  clearPomoTimer(roomId);
  pomoTimers.set(roomId, setTimeout(() => {
    pomoAutoEnd(io, roomId).catch((err) => console.error("pomodoro auto-end:", err));
  }, Math.max(0, endsAtMs - Date.now())));
}
function registerStudyTimer({ io, user, on, guarded }) {
  const pushTimer = (roomId, room) => io.to(roomId).emit("pomodoro-update", serializePomodoro(room));
  on("pomodoro-start", guarded(POLICY.STUDY_TIMER, async (room, roomId) => {
    const p = room.pomodoro;
    if (p.running) return;
    const ms = p.remainingMs > 0 ? p.remainingMs : Room.POMO_MS[p.phase];
    p.running = true;
    p.endsAt = new Date(Date.now() + ms);
    p.remainingMs = ms;
    await room.save();
    schedulePomoEnd(io, roomId, p.endsAt.getTime());
    pushTimer(roomId, room);
    announce(io, roomId, {
      kind: "study", action: "pomodoro.start", actor: user,
      text: `{actor} started a ${p.phase === "focus" ? "focus session" : "break"}`,
    });
  }));
  on("pomodoro-pause", guarded(POLICY.STUDY_TIMER, async (room, roomId) => {
    const p = room.pomodoro;
    if (!p.running) return;
    clearPomoTimer(roomId);
    p.remainingMs = Math.max(0, new Date(p.endsAt).getTime() - Date.now());
    p.running = false;
    p.endsAt = null;
    await room.save();
    pushTimer(roomId, room);
    announce(io, roomId, { kind: "study", action: "pomodoro.pause", actor: user, text: "{actor} paused the timer" });
  }));
  on("pomodoro-reset", guarded(POLICY.STUDY_TIMER, async (room, roomId) => {
    clearPomoTimer(roomId);
    setPomoPhase(room.pomodoro, room.pomodoro.phase);
    await room.save();
    pushTimer(roomId, room);
    announce(io, roomId, { kind: "study", action: "pomodoro.reset", actor: user, text: "{actor} reset the timer" });
  }));
  on("pomodoro-skip", guarded(POLICY.STUDY_TIMER, async (room, roomId) => {
    clearPomoTimer(roomId);
    setPomoPhase(room.pomodoro, nextPomoPhase(room.pomodoro));
    await room.save();
    pushTimer(roomId, room);
    announce(io, roomId, { kind: "study", action: "pomodoro.skip", actor: user, text: "{actor} skipped to the next phase" });
  }));
}
/* ═══════════════════════════════════════════════════════════
   6j. STUDY — TASKS
   ═══════════════════════════════════════════════════════════ */
function cleanTaskText(t) {
  return (typeof t === "string" ? t : "").replace(/\s+/g, " ").trim().slice(0, 200);
}
/* finished assignees first (in the order they finished), pending keep creation order */
function doneFirst(a, b) {
  return (Number(!!b.done) - Number(!!a.done)) ||
    (a.done && b.done ? (+a.doneAt || 0) - (+b.doneAt || 0) : 0);
}
function serializeTasks(room) {
  return {
    items: (room.tasks || []).map((t) => ({
      id: t.taskId, text: t.text, audience: t.audience, done: !!t.done,
      addedBy: t.addedBy ? t.addedBy.toString() : null, addedByName: t.addedByName || "",
      addedAt: t.addedAt, doneAt: t.doneAt || null,
      assignees: [...(t.assignees || [])].sort(doneFirst).map((a) => ({
        userId: a.userId.toString(), username: a.username || "",
        done: !!a.done, doneAt: a.doneAt || null,
      })),
    })),
  };
}
function registerStudyTasks({ io, socket, user, on, toast, guarded }) {
  const pushTasks = (roomId, room) => io.to(roomId).emit("tasks-update", serializeTasks(room));
  on("task-add", guarded(POLICY.STUDY_TASKS, async (room, roomId, { text, audience, assignees } = {}) => {
    const clean = cleanTaskText(text);
    if (!clean) return toast("Write something for the task first");
    if ((room.tasks || []).length >= MAX_TASKS) return toast("The task list is full");
    let targets;
    if (audience === "room") {
      targets = room.participants.map((p) => ({ userId: p.userId, username: p.username }));
    } else if (audience === "members") {
      const ids = [...new Set((Array.isArray(assignees) ? assignees : []).map(String))]
        .filter(validId).slice(0, ROOM_CAP);
      targets = ids.map((id) => getMember(room, id))
        .filter((m) => m && !isBanned(room, m.userId))
        .map((m) => ({ userId: m.userId, username: m.username }));
    } else return;
    if (!targets.length) return toast("Pick at least one person");
    room.tasks.push({
      taskId: newItemId(), text: clean, audience,
      assignees: targets.map((t) => ({ ...t, done: false })),
      done: false, addedBy: user.id, addedByName: user.username, addedAt: new Date(),
    });
    await room.save();
    pushTasks(roomId, room);
    /* user text goes in `detail`, never in `text`, so "{actor}"-style input can't be substituted */
    announce(io, roomId, {
      kind: "task", action: "task.add", actor: user,
      text: "{actor} added a task: {detail}", detail: clean,
    });
  }));
  /* complete / un-complete MY OWN share — any assignee may, no grant needed */
  on("task-toggle", guarded(POLICY.STUDY_ROOM, async (room, roomId, { id, done } = {}) => {
    const task = (room.tasks || []).find((t) => t.taskId === id);
    if (!task) return;
    const mine = task.assignees.find((a) => sameId(a.userId, user.id));
    if (!mine) return toast("That task isn't assigned to you");
    const next = !!done;
    if (mine.done === next) return;                          // idempotent
    mine.done   = next;
    mine.doneAt = next ? new Date() : null;
    task.done   = task.assignees.every((a) => a.done);
    task.doneAt = task.done ? new Date() : null;
    await room.save();
    pushTasks(roomId, room);
    if (!next) return;                                       // un-ticking is silent
    const group = task.assignees.length > 1;
    socket.to(roomId).emit("task-notice", {                  // everyone except the caller
      id, userId: user.id, username: user.username, text: task.text,
      finished: task.done, group,
    });
    announce(io, roomId, {
      kind: "task", action: task.done ? "task.finish" : "task.complete", actor: user,
      text: task.done && group ? "{actor} finished the last part of: {detail}"
                               : "{actor} completed: {detail}",
      detail: task.text,
    });
  }));
  on("task-remove", guarded(POLICY.STUDY_TASKS, async (room, roomId, { id } = {}) => {
    const i = (room.tasks || []).findIndex((t) => t.taskId === id);
    if (i < 0) return;
    const text = room.tasks[i].text;
    room.tasks.splice(i, 1);
    await room.save();
    pushTasks(roomId, room);
    announce(io, roomId, {
      kind: "task", action: "task.remove", actor: user,
      text: "{actor} removed a task: {detail}", detail: text,
    });
  }));
  on("task-clear-done", guarded(POLICY.STUDY_TASKS, async (room, roomId) => {
    const before = room.tasks.length;
    room.tasks = room.tasks.filter((t) => !t.done);
    const n = before - room.tasks.length;
    if (!n) return;
    await room.save();
    pushTasks(roomId, room);
    announce(io, roomId, {
      kind: "task", action: "task.clear", actor: user,
      text: `{actor} cleared ${n} finished task${n === 1 ? "" : "s"}`,
    });
  }));
}
/* ═══════════════════════════════════════════════════════════
   6k. STUDY — WHITEBOARD WORKSPACE
   Live boards are in memory (workspaces); saved boards are Whiteboard docs.
   ═══════════════════════════════════════════════════════════ */
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r1(v) { return Math.round(v * 10) / 10; }
function clampW(v) { return clampN(r1(+v || 0), -WB.LIM, WB.LIM); }
function cleanPts(arr) {
  if (!Array.isArray(arr)) return [];
  const n = Math.min(arr.length, WB.MAX_BATCH * 2) & ~1;
  const out = [];
  for (let i = 0; i < n; i += 2) out.push(clampW(arr[i]), clampW(arr[i + 1]));
  return out;
}
/* rich text: tag allowlist, attributes dropped (except a validated <font color>) */
function cleanHtml(html) {
  return String(html || "").slice(0, WB.MAX_HTML).split(/(<[^>]*>)/).map((part) => {
    if (part[0] !== "<") return part.replace(/</g, "&lt;");
    const m = /^<(\/?)([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(part);
    if (!m || !HTML_TAGS.has(m[2].toLowerCase())) return "";
    const tag = m[2].toLowerCase();
    if (m[1]) return "</" + tag + ">";
    if (tag === "font") {
      const c = /\bcolor\s*=\s*["']?([^"'\s>]+)["']?/i.exec(m[3]);
      return c && COLOR_OK.test(c[1]) ? '<font color="' + c[1] + '">' : "<font>";
    }
    return "<" + tag + ">";
  }).join("");
}
function newBid() { return crypto.randomBytes(6).toString("hex"); }
function cleanName(n) { return String(n || "").replace(/\s+/g, " ").trim().slice(0, 40); }
function newBoard(name, extra = {}) {
  return { id: newBid(), name, savedId: null, strokes: [], byId: new Map(), hist: new Map(),
           points: 0, rev: 0, savedRev: 0, dirtyMark: false, touched: Date.now(), ...extra };
}
function isDirty(b) { return b.rev !== b.savedRev; }
function boardMeta(b) {
  return {
    id: b.id, name: b.name, savedId: b.savedId, dirty: isDirty(b),
    count: b.strokes.reduce((n, s) => n + (!s.undone && !s.deleted ? 1 : 0), 0),
  };
}
function wsPayload(ws) {
  return {
    enabled: ws.enabled,
    boards: ws.order.map((id) => boardMeta(ws.boards.get(id))),
    saved: ws.saved,
  };
}
function reindex(b) {
  b.byId = new Map(b.strokes.map((s) => [s.id, s]));
  b.points = b.strokes.reduce((n, s) => n + s.pts.length / 2, 0);
}
function publicStroke({ id, tool, kind, color, size, pts, html, undone, deleted }) {
  return { id, tool, kind, color, size, pts, html, undone: !!undone, deleted: !!deleted };
}
/* saved → live validation: never trust stored JSON blindly */
function importObject(o) {
  if (!o || typeof o.id !== "string" || !WB_ANYID.test(o.id) || !WB_TOOLS.includes(o.tool)) return null;
  const pts = (Array.isArray(o.pts) ? o.pts : []).slice(0, WB.MAX_STROKE_PTS).map(clampW);
  if (pts.length % 2) pts.pop();
  if (pts.length < 2) return null;
  const s = { id: o.id, uid: null, undone: false, deleted: false, tool: o.tool,
              color: HEX.test(o.color) ? o.color : "#000000", pts };
  if (o.tool === "shape") {
    if (!SHAPE_KINDS.has(o.kind)) return null;
    s.kind = o.kind; s.size = clampN(Math.round(+o.size) || 4, 1, WB.MAX_SIZE);
    s.pts = pts.length >= 4 ? [pts[0], pts[1], pts[2], pts[3]] : [pts[0], pts[1], pts[0], pts[1]];
  } else if (o.tool === "text") {
    s.size = clampN(Math.round(+o.size) || 24, 8, 200); s.html = cleanHtml(o.html); s.pts = pts.slice(0, 2);
  } else s.size = clampN(Math.round(+o.size) || 4, 1, WB.MAX_SIZE);
  return s;
}
function purgeStrokes(b, ids) {                    // permanent removal
  if (!ids.size) return;
  b.strokes = b.strokes.filter((s) => {
    if (!ids.has(s.id)) return true;
    b.byId.delete(s.id); b.points -= s.pts.length / 2;
    return false;
  });
}
function trimBoard(b) {                            // oldest-first eviction past the caps
  while (b.strokes.length > WB.MAX_STROKES || b.points > WB.MAX_POINTS) {
    const old = b.strokes.shift();
    if (!old) break;
    b.byId.delete(old.id); b.points -= old.pts.length / 2;
  }
}
function shiftStroke(s, dx, dy) {
  for (let i = 0; i < s.pts.length; i += 2) { s.pts[i] = clampW(s.pts[i] + dx); s.pts[i + 1] = clampW(s.pts[i + 1] + dy); }
}
function histCounts(b, uid) {
  const h = b.hist.get(uid);
  return { undo: h ? h.undo.length : 0, redo: h ? h.redo.length : 0 };
}
/* ids the client may act on: present, visible, not eraser marks */
function liveIds(b, ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.slice(0, WB.MAX_IDS).filter((id) => typeof id === "string"))].filter((id) => {
    const s = b.byId.get(id);
    return s && !s.undone && !s.deleted && s.tool !== "eraser";
  });
}
async function listSaved(roomId) {
  const docs = await Whiteboard.find({ roomId })
    .select("boardId name count updatedAt updatedByName").sort({ updatedAt: -1 }).lean();
  return docs.map((d) => ({ id: d.boardId, name: d.name, count: d.count || 0, updatedAt: d.updatedAt, by: d.updatedByName || "" }));
}
async function ensureWorkspace(roomId) {
  let ws = workspaces.get(roomId);
  if (ws) return ws;
  const room = await Room.findOne({ roomId }, "roomType whiteboard").lean();
  if (!room || room.roomType !== "study") return null;
  const saved = await listSaved(roomId);
  ws = workspaces.get(roomId);                      // another socket may have won the race
  if (ws) return ws;
  ws = { enabled: !(room.whiteboard && room.whiteboard.enabled === false),
         boards: new Map(), order: [], saved, n: 1, touched: Date.now() };
  const first = newBoard("Board 1");
  ws.boards.set(first.id, first); ws.order.push(first.id);
  workspaces.set(roomId, ws);
  return ws;
}
/* any content change: bump the revision, and tell everyone when dirty flips */
function bumpBoard(io, roomId, b) {
  b.rev++; b.touched = Date.now();
  const d = isDirty(b);
  if (d !== b.dirtyMark) { b.dirtyMark = d; io.to(roomId).emit("wb-dirty", { b: b.id, dirty: d }); }
}
setInterval(() => {                                 // forget idle workspaces
  const cutoff = Date.now() - WORKSPACE_TTL;
  for (const [id, ws] of workspaces) if (ws.touched < cutoff) workspaces.delete(id);
}, 10 * 60 * 1000).unref();
function registerStudyWhiteboard({ io, socket, user, on, toast, guarded }) {
  /* per-socket rate buckets */
  const ok = {
    sync: bucket(8, 1),     start: bucket(20, 10), points: bucket(60, 40),
    cursor: bucket(40, 40), hist: bucket(10, 5),   move: bucket(60, 40),
    text: bucket(20, 8),    select: bucket(30, 15), manage: bucket(10, 2),
  };
  /* hot path: NO db reads — the in-memory workspace is the gate */
  function liveBoard(bid) {
    const roomId = socket.data.roomId;
    const ws = roomId && workspaces.get(roomId);
    if (!ws || !ws.enabled || typeof bid !== "string") return null;
    const b = ws.boards.get(bid);
    if (!b) return null;
    ws.touched = Date.now();
    return { roomId, ws, b };
  }
  function pushHistory(roomId, b) {
    return toUser(io, roomId, user.id, "wb-history", { b: b.id, ...histCounts(b, user.id) }).catch(() => {});
  }
  const pushWorkspace = (roomId, ws) => io.to(roomId).emit("wb-workspace", wsPayload(ws));
  /* per-user op stack. A new op permanently discards that user's redo stack. */
  function recordOp(roomId, b, op) {
    let h = b.hist.get(user.id);
    if (!h) b.hist.set(user.id, (h = { undo: [], redo: [] }));
    const hadRedo = h.redo.length > 0;
    const dead = new Set();
    for (const r of h.redo) if (r.t === "draw") { const s = b.byId.get(r.id); if (s && s.undone) dead.add(r.id); }
    h.redo = [];
    h.undo.push(op);
    if (h.undo.length > WB.HIST_CAP) {
      const old = h.undo.shift();
      if (old.t === "del") for (const id of old.ids) { const s = b.byId.get(id); if (s && s.deleted) dead.add(id); }
    }
    if (dead.size) { purgeStrokes(b, dead); io.to(roomId).emit("wb-purge", { b: b.id, ids: [...dead] }); }
    if (hadRedo) pushHistory(roomId, b);
  }
  /* dir: -1 undo, +1 redo. Returns false if the op no longer has any effect. */
  function applyOp(roomId, b, op, dir) {
    if (op.t === "draw") {
      const s = b.byId.get(op.id);
      if (!s) return false;
      s.undone = dir < 0;
      io.to(roomId).emit("wb-stroke-visibility", { b: b.id, id: s.id, undone: s.undone });
      return true;
    }
    const ids = op.ids.filter((id) => b.byId.has(id));
    if (!ids.length) return false;
    if (op.t === "del") {
      ids.forEach((id) => { b.byId.get(id).deleted = dir > 0; });
      io.to(roomId).emit("wb-deleted", { b: b.id, ids, deleted: dir > 0 });
      return true;
    }
    if (op.t === "move") {
      const dx = op.dx * dir, dy = op.dy * dir;
      ids.forEach((id) => shiftStroke(b.byId.get(id), dx, dy));
      io.to(roomId).emit("wb-move", { b: b.id, ids, dx, dy });
      return true;
    }
    return false;
  }
  /* live drag deltas are applied immediately, accumulated per socket and
     committed as ONE undoable op on wb-move-end */
  function finalizeMove() {
    const acc = socket.data.wbMove;
    socket.data.wbMove = null;
    if (!acc || (!acc.dx && !acc.dy)) return;
    const ws = workspaces.get(acc.roomId);
    const b = ws && ws.boards.get(acc.b);
    if (!b) return;
    recordOp(acc.roomId, b, { t: "move", ids: acc.ids, dx: acc.dx, dy: acc.dy });
    bumpBoard(io, acc.roomId, b);
  }
  async function saveBoard(roomId, ws, b) {
    const objects = b.strokes.filter((s) => !s.undone && !s.deleted).map((s) => ({
      id: s.id, tool: s.tool, kind: s.kind, color: s.color, size: s.size, pts: s.pts, html: s.html,
    }));
    const base = { name: b.name, objects, count: objects.length, updatedByName: user.username };
    const doc = b.savedId && await Whiteboard.findOneAndUpdate({ roomId, boardId: b.savedId }, { $set: base });
    if (!doc) {                                      // first save (or the saved copy was deleted meanwhile)
      b.savedId = b.savedId || newBid();
      await Whiteboard.create({ roomId, boardId: b.savedId, createdBy: user.id, createdByName: user.username, ...base });
    }
    b.savedRev = b.rev; b.dirtyMark = false;
    ws.saved = await listSaved(roomId);
  }
  /* board management runs after the policy check: rate-limit, then hand over the workspace */
  const withWorkspace = (fn) => async (room, roomId, ...args) => {
    if (!ok.manage()) return;
    const ws = await ensureWorkspace(roomId);
    if (ws) await fn(room, roomId, ws, ...args);
  };
  /* ── sync ── */
  on("wb-sync-request", async () => {                // workspace only (tabs + saved list); content is lazy
    if (!ok.sync()) return;
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const ws = await ensureWorkspace(roomId);
    if (ws) socket.emit("wb-workspace", wsPayload(ws));
  });
  on("wb-board-sync", (d = {}) => {
    if (!ok.sync()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    socket.emit("wb-board-snapshot", {
      b: live.b.id, strokes: live.b.strokes.map(publicStroke), history: histCounts(live.b, user.id),
    });
  });
  /* ── drawing (any participant while the board is enabled) ── */
  on("wb-stroke-start", (d = {}) => {
    if (!ok.start()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    const { roomId, b } = live;
    if (typeof d.id !== "string" || !d.id.startsWith(user.id + ":") ||
        !WB_TAIL.test(d.id.slice(user.id.length + 1)) || b.byId.has(d.id)) return;
    if (!WB_TOOLS.includes(d.tool)) return;
    const pts = cleanPts(d.pts).slice(0, 2);
    if (pts.length < 2) return;
    const s = { id: d.id, uid: user.id, undone: false, deleted: false, tool: d.tool,
                color: HEX.test(d.color) ? d.color : "#000000", pts };
    if (d.tool === "shape") {
      if (!SHAPE_KINDS.has(d.kind)) return;
      s.kind = d.kind; s.pts = [pts[0], pts[1], pts[0], pts[1]];
      s.size = clampN(Math.round(+d.size) || 4, 1, WB.MAX_SIZE);
    } else if (d.tool === "text") {
      if (b.strokes.reduce((n, x) => n + (x.tool === "text" && !x.deleted ? 1 : 0), 0) >= WB.MAX_TEXTS) return;
      s.size = clampN(Math.round(+d.size) || 24, 8, 200); s.html = cleanHtml(d.html);
    } else s.size = clampN(Math.round(+d.size) || 4, 1, WB.MAX_SIZE);
    b.strokes.push(s); b.byId.set(s.id, s); b.points += s.pts.length / 2;
    trimBoard(b);
    recordOp(roomId, b, { t: "draw", id: s.id });
    bumpBoard(io, roomId, b);
    socket.to(roomId).emit("wb-stroke-start", {
      b: b.id, id: s.id, tool: s.tool, kind: s.kind, color: s.color, size: s.size, pts: s.pts, html: s.html,
    });
  });
  on("wb-stroke-points", (d = {}) => {
    if (!ok.points()) return;
    const live = liveBoard(d.b);
    if (!live || typeof d.id !== "string") return;
    const s = live.b.byId.get(d.id);
    if (!s || s.uid !== user.id || s.tool === "text") return;   // only the author extends a stroke
    const pts = cleanPts(d.pts);
    if (!pts.length) return;
    if (s.tool === "shape") {                                    // shapes: only the END corner moves
      s.pts[2] = pts[pts.length - 2]; s.pts[3] = pts[pts.length - 1];
      socket.to(live.roomId).emit("wb-stroke-points", { b: live.b.id, id: s.id, pts: pts.slice(-2) });
      return;
    }
    if (s.pts.length >= WB.MAX_STROKE_PTS) return;
    for (const v of pts) s.pts.push(v);
    live.b.points += pts.length / 2;
    trimBoard(live.b);
    socket.to(live.roomId).emit("wb-stroke-points", { b: live.b.id, id: s.id, pts });
  });
  /* text content/size/colour (any participant may edit; last write wins) */
  on("wb-text-update", (d = {}) => {
    if (!ok.text()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    const s = live.b.byId.get(d.id);
    if (!s || s.tool !== "text" || s.deleted) return;
    if (typeof d.html === "string") s.html = cleanHtml(d.html);
    if (Number.isFinite(+d.size)) s.size = clampN(Math.round(+d.size), 8, 200);
    if (HEX.test(d.color)) s.color = d.color;
    bumpBoard(io, live.roomId, live.b);
    socket.to(live.roomId).emit("wb-text-update", { b: live.b.id, id: s.id, html: s.html, size: s.size, color: s.color });
  });
  /* ── selection, group move, delete ── */
  on("wb-select", (d = {}) => {
    if (!ok.select()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    socket.to(live.roomId).emit("wb-select", {
      b: live.b.id, uid: user.id, name: user.username,
      ids: (Array.isArray(d.ids) ? d.ids : []).slice(0, WB.MAX_IDS).filter((x) => typeof x === "string" && x.length <= 64),
    });
  });
  on("wb-move", (d = {}) => {
    if (!ok.move()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    const ids = liveIds(live.b, d.ids);
    const dx = r1(clampN(+d.dx || 0, -WB.MAX_MOVE, WB.MAX_MOVE));
    const dy = r1(clampN(+d.dy || 0, -WB.MAX_MOVE, WB.MAX_MOVE));
    if (!ids.length || (!dx && !dy)) return;
    ids.forEach((id) => shiftStroke(live.b.byId.get(id), dx, dy));
    const key = ids.slice().sort().join(",");
    let acc = socket.data.wbMove;
    if (acc && (acc.b !== live.b.id || acc.key !== key)) { finalizeMove(); acc = null; }
    if (!acc) acc = socket.data.wbMove = { roomId: live.roomId, b: live.b.id, key, ids, dx: 0, dy: 0 };
    acc.dx = r1(acc.dx + dx); acc.dy = r1(acc.dy + dy);
    socket.to(live.roomId).emit("wb-move", { b: live.b.id, ids, dx, dy });
  });
  on("wb-move-end", () => finalizeMove());
  on("wb-delete", (d = {}) => {
    if (!ok.move()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    const ids = liveIds(live.b, d.ids);
    if (!ids.length) return;
    ids.forEach((id) => { live.b.byId.get(id).deleted = true; });
    recordOp(live.roomId, live.b, { t: "del", ids });
    bumpBoard(io, live.roomId, live.b);
    io.to(live.roomId).emit("wb-deleted", { b: live.b.id, ids, deleted: true });
  });
  /* ── undo / redo (per user, per board) ── */
  on("wb-undo", (d = {}) => {
    if (!ok.hist()) return;
    const live = liveBoard(d.b);
    const h = live && live.b.hist.get(user.id);
    if (!h) return;
    while (h.undo.length) {
      const op = h.undo.pop();
      if (applyOp(live.roomId, live.b, op, -1)) { h.redo.push(op); bumpBoard(io, live.roomId, live.b); break; }
    }
    pushHistory(live.roomId, live.b);
  });
  on("wb-redo", (d = {}) => {
    if (!ok.hist()) return;
    const live = liveBoard(d.b);
    const h = live && live.b.hist.get(user.id);
    if (!h) return;
    while (h.redo.length) {
      const op = h.redo.pop();
      if (applyOp(live.roomId, live.b, op, +1)) { h.undo.push(op); bumpBoard(io, live.roomId, live.b); break; }
    }
    pushHistory(live.roomId, live.b);
  });
  /* ── cursors: ephemeral + lossy by design ── */
  on("wb-cursor", (d = {}) => {
    if (!ok.cursor()) return;
    const live = liveBoard(d.b);
    if (!live) return;
    const hide = d.x == null || d.y == null;
    socket.to(live.roomId).volatile.emit("wb-cursor", {
      b: live.b.id, uid: user.id, name: user.username,
      x: hide ? null : clampW(d.x), y: hide ? null : clampW(d.y),
    });
  });
  /* ── host only: wipe a board, open/close the whiteboard ── */
  on("wb-clear", guarded(POLICY.STUDY_HOST, async (room, roomId, { b: bid } = {}) => {
    const ws = await ensureWorkspace(roomId);
    const b = ws && ws.boards.get(bid);
    if (!b) return;
    b.strokes = []; b.byId.clear(); b.hist.clear(); b.points = 0;
    bumpBoard(io, roomId, b);
    io.to(roomId).emit("wb-cleared", { b: b.id, by: user.username });
    announce(io, roomId, { kind: "study", action: "wb.clear", actor: user,
      text: "{actor} cleared the board: {detail}", detail: b.name });
  }));
  on("wb-set-enabled", guarded(POLICY.STUDY_HOST, async (room, roomId, { enabled } = {}) => {
    const next = !!enabled;
    if ((room.whiteboard.enabled !== false) === next) return;
    room.whiteboard.enabled = next;
    await room.save();
    const ws = await ensureWorkspace(roomId);
    if (ws) ws.enabled = next;
    io.to(roomId).emit("wb-enabled", { enabled: next });
    announce(io, roomId, { kind: "study", action: next ? "wb.open" : "wb.close", actor: user,
      text: next ? "{actor} opened the whiteboard" : "{actor} closed the whiteboard" });
  }));
  /* ── board management (host, mods, or anyone granted the study content slot) ── */
  on("wb-board-new", guarded(POLICY.STUDY_BOARDS, withWorkspace(async (room, roomId, ws, { name } = {}) => {
    if (ws.boards.size >= WB.MAX_BOARDS) return toast(`At most ${WB.MAX_BOARDS} boards can be open at once`);
    const b = newBoard(cleanName(name) || `Board ${++ws.n}`);
    ws.boards.set(b.id, b); ws.order.push(b.id);
    pushWorkspace(roomId, ws);
    socket.emit("wb-board-created", { b: b.id });
    announce(io, roomId, { kind: "study", action: "wb.new", actor: user, text: "{actor} opened a new board: {detail}", detail: b.name });
  })));
  on("wb-board-open", guarded(POLICY.STUDY_BOARDS, withWorkspace(async (room, roomId, ws, { savedId, reload } = {}) => {
    if (typeof savedId !== "string") return;
    const live = [...ws.boards.values()].find((x) => x.savedId === savedId);
    if (live && !reload) return socket.emit("wb-board-created", { b: live.id });   // already open → just switch
    const doc = await Whiteboard.findOne({ roomId, boardId: savedId }).lean();
    if (!doc) { ws.saved = await listSaved(roomId); pushWorkspace(roomId, ws); return toast("That saved board no longer exists"); }
    const strokes = (doc.objects || []).map(importObject).filter(Boolean).slice(0, WB.MAX_STROKES);
    if (live) {                                                                      // reload in place (caller confirmed)
      Object.assign(live, { strokes, name: doc.name, rev: 0, savedRev: 0, dirtyMark: false });
      live.hist.clear(); reindex(live);
      io.to(roomId).emit("wb-board-reloaded", { b: live.id });
      pushWorkspace(roomId, ws);
      return socket.emit("wb-board-created", { b: live.id });
    }
    if (ws.boards.size >= WB.MAX_BOARDS) return toast(`At most ${WB.MAX_BOARDS} boards can be open at once`);
    const b = newBoard(doc.name, { savedId, strokes });
    reindex(b);
    ws.boards.set(b.id, b); ws.order.push(b.id);
    pushWorkspace(roomId, ws);
    socket.emit("wb-board-created", { b: b.id });
    announce(io, roomId, { kind: "study", action: "wb.load", actor: user, text: "{actor} opened the saved board: {detail}", detail: b.name });
  })));
  on("wb-board-save", guarded(POLICY.STUDY_BOARDS, withWorkspace(async (room, roomId, ws, { b: bid } = {}) => {
    const b = ws.boards.get(bid);
    if (!b) return;
    if (!b.savedId && ws.saved.length >= WB.MAX_SAVED) return toast(`Up to ${WB.MAX_SAVED} boards can be saved per room`);
    await saveBoard(roomId, ws, b);
    pushWorkspace(roomId, ws);
    announce(io, roomId, { kind: "study", action: "wb.save", actor: user, text: "{actor} saved the board: {detail}", detail: b.name });
  })));
  on("wb-board-rename", guarded(POLICY.STUDY_BOARDS, withWorkspace(async (room, roomId, ws, { b: bid, name } = {}) => {
    const b = ws.boards.get(bid), n = cleanName(name);
    if (!b || !n) return;
    b.name = n;
    if (b.savedId) { await Whiteboard.updateOne({ roomId, boardId: b.savedId }, { $set: { name: n } }); ws.saved = await listSaved(roomId); }
    pushWorkspace(roomId, ws);
  })));
  /* closing a dirty board needs an explicit decision: mode = "save" | "discard" */
  on("wb-board-close", guarded(POLICY.STUDY_BOARDS, withWorkspace(async (room, roomId, ws, { b: bid, mode } = {}) => {
    const b = ws.boards.get(bid);
    if (!b) return;
    if (isDirty(b)) {
      if (mode === "save") {
        if (!b.savedId && ws.saved.length >= WB.MAX_SAVED) return toast(`Up to ${WB.MAX_SAVED} boards can be saved per room`);
        await saveBoard(roomId, ws, b);
      } else if (mode !== "discard") return toast(`“${b.name}” has unsaved changes — save or discard first`);
    }
    ws.boards.delete(bid); ws.order = ws.order.filter((x) => x !== bid);
    io.to(roomId).emit("wb-board-closed", { b: bid });
    pushWorkspace(roomId, ws);
    announce(io, roomId, { kind: "study", action: "wb.closeboard", actor: user, text: "{actor} closed the board: {detail}", detail: b.name });
  })));
  on("wb-saved-delete", guarded(POLICY.STUDY_BOARDS, withWorkspace(async (room, roomId, ws, { savedId } = {}) => {
    if (typeof savedId !== "string") return;
    await Whiteboard.deleteOne({ roomId, boardId: savedId });
    ws.saved = await listSaved(roomId);
    for (const b of ws.boards.values()) if (b.savedId === savedId) {      // its open copy is now unsaved
      b.savedId = null;
      b.savedRev = b.strokes.length ? b.rev - 1 : b.rev;
      b.dirtyMark = isDirty(b);
    }
    pushWorkspace(roomId, ws);
  })));
}
/* ═══════════════════════════════════════════════════════════
   6l. REACTIONS — ephemeral, relayed only
   ═══════════════════════════════════════════════════════════ */
function registerReactions({ socket, user, on, rateLimited }) {
  on("video-reaction", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    if (rateLimited("reactRL", REACT_LIMIT, REACT_WINDOW)) return;
    socket.to(roomId).emit("video-reaction", { emoji, userId: user.id, username: user.username, at: Date.now() });
  });
}
/* ═══════════════════════════════════════════════════════════
   7. ROOM-DELETED CLEANUP + EXPORT
   ═══════════════════════════════════════════════════════════ */
/* a room was deleted (dashboard or anywhere else) → drop everything held in memory for it */
onRoomDeleted((roomId) => {
  workspaces.delete(roomId);
  clearPomoTimer(roomId);
  clearSeekBarrier(roomId);
  roomSeekSeqs.delete(roomId);
  advanceLock.delete(roomId);
  const prefix = roomId + ":";
  for (const k of recentKicks.keys()) {
    if (k.startsWith(prefix)) recentKicks.delete(k);
  }
});
module.exports = function registerRoomHandlers(io, socket) {
  const ctx = createContext(io, socket);
  registerPresence(ctx);
  registerPermissions(ctx);
  registerModeration(ctx);
  registerRoomDetails(ctx);
  registerChat(ctx);
  registerReports(ctx);
  registerPlayback(ctx);
  registerQueue(ctx);
  registerStudyTimer(ctx);
  registerStudyTasks(ctx);
  registerStudyWhiteboard(ctx);
  registerReactions(ctx);
};