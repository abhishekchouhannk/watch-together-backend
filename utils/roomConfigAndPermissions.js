// utils/roomConfigAndPermissions.js
// ─────────────────────────────────────────────────────────────
// Room rules in one place: who is who, who may do what, and the
// serialisers that expose it. Pure functions over a Room document
// (hydrated or lean) — no sockets, no DB calls.
//
//  1. Core hierarchy    isAdmin ▸ isMod ▸ canModerate   (+ roleOf, getMember)
//                       Everything "host only" is isAdmin; everything
//                       "host + mods" is canModerate. No aliases.
//
//  2. Grant slots       Two per-member grants are persisted (GRANT_SLOTS).
//                       hasGrant() is the ONLY implementation of
//                       "does this user hold slot X".
//
//  3. Feature guards    What a slot MEANS depends on the room family:
//
//        slot (wire/storage id)    media rooms         study rooms
//        SLOT.CONTROL ("sync")     canControlMedia     canControlTimer
//        SLOT.CONTENT ("queue")    canManageQueue      canManageStudy
//                                                      (tasks + whiteboards)
//
//                       Feature code calls the named guard, never a slot id.
//
//  4. Wording           FEATURE_SCOPES — per-room-type labels for each slot.
//  5. resolvePerms()    the exact permission payload the client consumes.
// ─────────────────────────────────────────────────────────────
"use strict";
const { Types } = require("mongoose");
const ROOM_CAP = 10;                       // hard ceiling on participants (mirrors models/Room.js)
/* ── ids / values ─────────────────────────────────────────── */
const sameId    = (a, b) => !!a && !!b && a.toString() === b.toString();
const validId   = (v) => !!v && Types.ObjectId.isValid(String(v));
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/* ═══════════════════════════════════════════════════════════
   1. CORE HIERARCHY
   ═══════════════════════════════════════════════════════════ */
const getMember = (room, uid) => (room.members || []).find((m) => sameId(m.userId, uid));
const isAdmin   = (room, uid) => !!(room.admin && sameId(room.admin.userId, uid));
function roleOf(room, uid) {
  if (isAdmin(room, uid)) return "admin";
  const m = getMember(room, uid);
  return m && m.role === "mod" ? "mod" : "member";
}
const isMod       = (room, uid) => roleOf(room, uid) === "mod";
const canModerate = (room, uid) => isAdmin(room, uid) || isMod(room, uid);   // host + mods
/* room families */
const isStudyRoom  = (room) => !!room && room.roomType === "study";
const isGamingRoom = (room) => !!room && room.roomType === "gaming";
const isMediaRoom  = (room) => !!room && !isStudyRoom(room) && !isGamingRoom(room);   // entertainment, music
/* ═══════════════════════════════════════════════════════════
   2. GRANT SLOTS
   Two room-agnostic, per-member grants are persisted. Storage keeps the
   original field names (no migration) and the slot ids double as the
   `scope` strings on the wire ("sync" / "queue").
   ═══════════════════════════════════════════════════════════ */
const GRANT_SLOTS = {
  sync:  { flag: "canSync",  req: "syncRequest",  mode: "syncMode"  },
  queue: { flag: "canQueue", req: "queueRequest", mode: "queueMode" },
};
/* neutral names for the two slots, so feature guards never say "queue" in a study room */
const SLOT = Object.freeze({
  CONTROL: "sync",     // live control of the room's shared activity (playback / timer)
  CONTENT: "queue",    // managing the room's shared content (queue / tasks + boards)
});
/** slot descriptor for a wire `scope`, or null if it isn't one */
const getGrantSlot = (scope) =>
  (typeof scope === "string" && Object.prototype.hasOwnProperty.call(GRANT_SLOTS, scope)
    ? GRANT_SLOTS[scope] : null);
/** THE grant check: host/mod → implicit · slot mode "everyone" → open · else the member's flag */
function hasGrant(room, uid, scope) {
  const slot = getGrantSlot(scope);
  if (!slot) return false;
  if (canModerate(room, uid)) return true;                            // implicit, never revocable
  if (((room.settings && room.settings[slot.mode]) || "host") === "everyone") return true;
  const m = getMember(room, uid);
  return !!(m && m[slot.flag]);
}
/* ═══════════════════════════════════════════════════════════
   3. FEATURE GUARDS  (room family × slot)
   ═══════════════════════════════════════════════════════════ */
const featureGuard = (inRoomFamily, slot) => (room, uid) => inRoomFamily(room) && hasGrant(room, uid, slot);
const canControlMedia = featureGuard(isMediaRoom, SLOT.CONTROL);   // play / pause / seek
const canManageQueue  = featureGuard(isMediaRoom, SLOT.CONTENT);   // add / remove / reorder / play item
const canControlTimer = featureGuard(isStudyRoom, SLOT.CONTROL);   // pomodoro start / pause / reset / skip
const canManageStudy  = featureGuard(isStudyRoom, SLOT.CONTENT);   // tasks + whiteboards
const canManageGame   = featureGuard(isGamingRoom, SLOT.CONTROL);  // pick game / seat players / start / reset
const canPlayGames    = featureGuard(isGamingRoom, SLOT.CONTENT);  // hold a seat + make moves
/* ═══════════════════════════════════════════════════════════
   4. WORDING — what each slot is called per room type
   ═══════════════════════════════════════════════════════════ */
const MEDIA_SCOPES = {
  sync:  { label: "playback control", short: "Playback", ask: "control playback",
           modeTitle: "Who can play / pause / seek", on: "Can play / pause / seek",
           everyone: "Everyone can now control playback", hostOnly: "Playback control is now host-only" },
  queue: { label: "queue control", short: "Queue", ask: "manage the queue",
           modeTitle: "Who can manage the queue", on: "Can manage the queue",
           everyone: "Everyone can now manage the queue", hostOnly: "Queue management is now host & mods only" },
};
const FEATURE_SCOPES = {
  entertainment: MEDIA_SCOPES,
  music:         MEDIA_SCOPES,
  study: {
    sync:  { label: "timer control", short: "Timer", ask: "control the timer",
             modeTitle: "Who can control the timer", on: "Can start / pause / skip the timer",
             everyone: "Everyone can now control the timer", hostOnly: "Timer control is now host-only" },
    queue: { label: "task & board management", short: "Tasks & boards", ask: "manage tasks and boards",
             modeTitle: "Who can manage tasks and boards", on: "Can manage tasks and whiteboards",
             everyone: "Everyone can now manage tasks and boards",
             hostOnly: "Task and board management is now host & mods only" },
  },
  gaming: {
    sync:  { label: "game management", short: "Game", ask: "manage the game",
             modeTitle: "Who can pick the game, seat players and start / reset",
             on: "Can set up, start and reset games",
             everyone: "Everyone can now manage the game", hostOnly: "Game management is now host-only" },
    queue: { label: "player access", short: "Players", ask: "play games",
             modeTitle: "Who can sit at the board and play", on: "Can take a seat and make moves",
             everyone: "Everyone can now take a seat and play",
             hostOnly: "Playing is now limited to the host, mods and approved players" },
  },
};
const scopeText = (room, scope) =>
  (FEATURE_SCOPES[room && room.roomType] || MEDIA_SCOPES)[scope];
const scopeLabels = (room) =>
  Object.fromEntries(Object.keys(GRANT_SLOTS).map((scope) => [scope, scopeText(room, scope)]));
/* ═══════════════════════════════════════════════════════════
   MEMBERSHIP · BANS · VOICE MUTES
   ═══════════════════════════════════════════════════════════ */
/** create (or refresh) the persistent per-user permission record */
function ensureMember(room, user) {
  let m = getMember(room, user.id);
  if (!m) {
    const fresh = {
      userId: user.id,
      username: user.username,
      role: isAdmin(room, user.id) ? "admin" : "member",
      updatedAt: new Date(),
    };
    for (const slot of Object.values(GRANT_SLOTS)) { fresh[slot.flag] = false; fresh[slot.req] = "none"; }
    room.members.push(fresh);
    return getMember(room, user.id);
  }
  // keep the denormalised bits fresh
  if (user.username && m.username !== user.username) m.username = user.username;
  const shouldBeAdmin = isAdmin(room, user.id);
  if (shouldBeAdmin && m.role !== "admin") m.role = "admin";
  if (!shouldBeAdmin && m.role === "admin") m.role = "member";
  return m;
}
const isBanned = (room, uid) =>
  (room.bannedUsers || []).some((b) => sameId(b.userId, uid));
const isVoiceMuted = (room, uid) =>
  (room.voiceMutedUsers || []).some((m) => sameId(m.userId, uid));
/* ═══════════════════════════════════════════════════════════
   MESSAGE-LEVEL GUARDS (these depend on the message, not just the role)
   ═══════════════════════════════════════════════════════════ */
// delete: the author, OR any moderator / host — only while the message is alive
const canDeleteMessage = (room, msg, uid) =>
  !!msg && !msg.deleted && (sameId(msg.senderId, uid) || canModerate(room, uid));
// report: anyone may report someone ELSE's live message
const canReportMessage = (room, msg, uid) =>
  !!msg && !msg.deleted && !sameId(msg.senderId, uid);
/* ═══════════════════════════════════════════════════════════
   ROOM DETAILS — validation shared by the socket editor and REST
   ═══════════════════════════════════════════════════════════ */
function sanitizeRoomPatch(room, raw = {}) {
  const patch = {}, errors = [];
  if (raw.roomName !== undefined) {
    const name = String(raw.roomName || "").trim().replace(/\s+/g, " ");
    if (name.length < 3 || name.length > 60) errors.push("Room name must be 3–60 characters");
    else patch.roomName = name;
  }
  if (raw.description !== undefined) {
    const d = String(raw.description || "").trim();
    if (d.length > 200) errors.push("Description must be 200 characters or fewer");
    else patch.description = d;
  }
  if (raw.tags !== undefined) {
    const list = (Array.isArray(raw.tags) ? raw.tags : String(raw.tags).split(","))
      .map((t) => String(t).trim().replace(/^#/, "").toLowerCase())
      .filter(Boolean);
    const uniq = [...new Set(list)];
    if (uniq.some((t) => t.length > 20)) errors.push("Each tag must be 20 characters or fewer");
    else patch.tags = uniq.slice(0, 8);
  }
  if (raw.isPublic !== undefined) patch.isPublic = !!raw.isPublic;
  if (raw.maxParticipants !== undefined) {
    const n = Number(raw.maxParticipants);
    const here = room.participants.length;
    const floor = Math.max(2, here);                 // never below who's already in
    if (!Number.isInteger(n))  errors.push("Max participants must be a whole number");
    else if (n > ROOM_CAP)     errors.push(`Rooms can't hold more than ${ROOM_CAP} people`);
    else if (n < 2)            errors.push("Rooms need space for at least 2 people");
    else if (n < floor)        errors.push(
      `${here} ${here === 1 ? "person is" : "people are"} in the room right now — remove someone before lowering the limit to ${n}`
    );
    else patch.maxParticipants = n;
  }
  return { patch, errors };
}
/* ═══════════════════════════════════════════════════════════
   5. resolvePerms — the permission payload for ONE user.
   This object is the contract with the client (S.perms) and the
   per-socket cache on the server (socket.data.perm). Every key is
   always present and always a boolean / string / object.
   ═══════════════════════════════════════════════════════════ */
function resolvePerms(room, uid) {
  const m         = getMember(room, uid) || {};
  const admin     = isAdmin(room, uid);
  const mod       = isMod(room, uid);
  const moderator = admin || mod;
  const settings  = room.settings || {};
  const study     = canManageStudy(room, uid);
  return {
    /* who am I */
    isAdmin: admin,
    isMod:   mod,
    role:    admin ? "admin" : (m.role || "member"),
    /* room-level modes */
    syncMode:  settings.syncMode  || "host",
    queueMode: settings.queueMode || "host",
    autoplay:  settings.autoplay !== false,
    /* the two grant slots, room-type agnostic — drives the "Your access" rows
       and request buttons; what they are CALLED comes from `labels` */
    canSync:           hasGrant(room, uid, SLOT.CONTROL),
    canQueue:          hasGrant(room, uid, SLOT.CONTENT),
    requestState:      m.syncRequest  || "none",
    queueRequestState: m.queueRequest || "none",
    /* features — room-type aware (false when this room type has no such feature) */
    canControlMedia: canControlMedia(room, uid),     // also the server's hot-path gate for video events
    canManageQueue:  canManageQueue(room, uid),
    canControlTimer: canControlTimer(room, uid),
    canManageTasks:  study,
    canManageBoards: study,
    canManageGame:   canManageGame(room, uid),
    canPlayGames:    canPlayGames(room, uid),
    /* moderation */
    canManage:     moderator,    // host + mods: people list, requests, reports
    canEditRoom:   moderator,
    canGrantSync:  moderator,
    canGrantQueue: moderator,
    canSetRoles:   admin,        // host only
    canBan:        admin,        // host only: kick / remove / ban / unban
    /* wording for the two slots in THIS room type */
    labels: scopeLabels(room),
  };
}
/* ═══════════════════════════════════════════════════════════
   SERIALISERS
   ═══════════════════════════════════════════════════════════ */
/* privileged viewers also see each member's grants + request states */
function serializeMembers(room, privileged) {
  return (room.members || []).map((m) => {
    const out = { userId: m.userId.toString(), username: m.username, role: m.role };
    if (!privileged) return out;
    for (const [scope, slot] of Object.entries(GRANT_SLOTS)) {
      out[slot.flag] = hasGrant(room, m.userId, scope);     // canSync / canQueue
      out[slot.req]  = m[slot.req] || "none";               // syncRequest / queueRequest
    }
    return out;
  });
}
const serializeVoiceMutes = (room) =>
  (room.voiceMutedUsers || []).map((m) => ({
    userId: m.userId.toString(),
    username: m.username,
    by: m.mutedByName || "",
    at: m.mutedAt,
  }));
/* one serializer so REST history and socket payloads never drift */
function serializeMessage(m) {
  const out = {
    id:        m._id.toString(),
    senderId:  m.senderId,
    username:  m.senderName,
    timestamp: m.timestamp,
    editedAt:  m.editedAt || null,
    deleted:   !!m.deleted,
  };
  if (m.deleted) {
    out.text          = "";
    out.mediaUrl      = null;
    out.deletedByName = m.deletedByName || null;
    out.deletedByRole = m.deletedByRole || null;
  } else {
    out.text     = m.message;
    out.mediaUrl = m.mediaUrl || null;
  }
  return out;
}
function serializeReport(r) {
  const reporters = (r.reporters || []).map((x) => ({
    userId: x.userId.toString(), username: x.username || "Someone", at: x.at,
  }));
  return {
    id:             r._id.toString(),
    messageId:      r.messageId.toString(),
    senderId:       r.senderId.toString(),
    senderName:     r.senderName || "Unknown",
    text:           r.text || "",
    messageTs:      r.messageTs || null,
    messageDeleted: !!r.messageDeleted,
    reporters,
    count:          reporters.length,
    at:             r.updatedAt || r.createdAt,
  };
}
module.exports = {
  ROOM_CAP, sameId, validId, sameValue,
  /* 1. hierarchy */
  isAdmin, isMod, roleOf, canModerate, getMember, ensureMember,
  isStudyRoom, isMediaRoom, isGamingRoom,
  /* 2. grant slots */
  GRANT_SLOTS, SLOT, getGrantSlot, hasGrant,
  /* 3. feature guards */
  canControlMedia, canManageQueue, canControlTimer, canManageStudy, canManageGame, canPlayGames,
  /* 4. wording */
  FEATURE_SCOPES, scopeText,
  /* bans, mutes, messages */
  isBanned, isVoiceMuted, canDeleteMessage, canReportMessage,
  /* payloads */
  resolvePerms, serializeMembers, serializeMessage, serializeReport, serializeVoiceMutes,
  sanitizeRoomPatch,
};