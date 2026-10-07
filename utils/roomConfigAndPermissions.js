// utils/roomPermissions.js
const { Types } = require("mongoose");

const ROOM_CAP = 10;
const MODE_VALUES = ["study", "gaming", "entertainment", "casual"];
const sameId = (a, b) => !!a && !!b && a.toString() === b.toString();
const isAdmin   = (room, uid) => !!(room.admin && sameId(room.admin.userId, uid));
const canSetRoles = isAdmin;   // promote/demote mods
const canBan      = isAdmin;   // kick / remove / ban / unban
const getMember = (room, uid) => (room.members || []).find((m) => sameId(m.userId, uid));
function roleOf(room, uid) {
  if (isAdmin(room, uid)) return "admin";
  const m = getMember(room, uid);
  return m && m.role === "mod" ? "mod" : "member";
}
const validId = (v) => !!v && Types.ObjectId.isValid(String(v));

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
    const floor = Math.max(2, here);                 // ← the bug: never below who's already in
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
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/* ── moderation / room management ───────────────────────── */
const canModerate = (room, uid) => isAdmin(room, uid) || isMod(room, uid); // mods + host

/* ── chat moderation ───────────────────────────────────── */
// edit: the author only, and only while the message is alive
const canEditMessage = (room, msg, uid) =>
  !!msg && !msg.deleted && sameId(msg.senderId, uid);
// delete: the author, OR any moderator / host
const canDeleteMessage = (room, msg, uid) =>
  !!msg && !msg.deleted && (sameId(msg.senderId, uid) || canModerate(room, uid));
// clear the whole room log: host only
const canClearChat = isAdmin;
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
    out.mediaUrl = m.mediaUrl || null; // Pass the media link to the frontend 
  }
  return out;
}
const canGrantSync = canModerate;  // grant/revoke playback, answer requests, set sync mode
const isMod = (room, uid) => roleOf(room, uid) === "mod";
function ensureMember(room, user) {
  let m = getMember(room, user.id);
  if (!m) {
    room.members.push({
      userId: user.id,
      username: user.username,
      role: isAdmin(room, user.id) ? "admin" : "member",
      canSync: false,
      syncRequest: "none",
      updatedAt: new Date(),
    });
    m = getMember(room, user.id);
  } else {
    // keep the denormalised bits fresh
    if (user.username && m.username !== user.username) m.username = user.username;
    const shouldBeAdmin = isAdmin(room, user.id);
    if (shouldBeAdmin && m.role !== "admin") m.role = "admin";
    if (!shouldBeAdmin && m.role === "admin") m.role = "member";
  }
  return m;
}
/* ── grant slots ──────────────────────────────────────────
 * Two room-agnostic, per-member grants are persisted:
 *   "sync"  — live control of the room's shared activity
 *   "queue" — managing the room's shared content list
 * Storage keeps the legacy field names (canSync / canQueue / …Request / …Mode),
 * so no migration. What a slot MEANS is decided per room type (FEATURE_SCOPES).
 * Feature code never reads slot names — it uses the named predicates below. */
const GRANT_SLOTS = {
  sync:  { flag: "canSync",  req: "syncRequest",  mode: "syncMode"  },
  queue: { flag: "canQueue", req: "queueRequest", mode: "queueMode" },
};
/* the one implementation: host/mod → implicit, mode "everyone" → open, else per-member flag */
function hasGrant(room, uid, scope) {
  const slot = GRANT_SLOTS[scope];
  if (!slot) return false;
  if (isAdmin(room, uid) || isMod(room, uid)) return true;          // implicit, never revocable
  if (((room.settings && room.settings[slot.mode]) || "host") === "everyone") return true;
  const m = getMember(room, uid);
  return !!(m && m[slot.flag]);
}
const isStudyRoom = (room) => !!room && room.roomType === "study";
/* raw slot checks — generic; used by resolvePerms/SCOPES, not by feature handlers */
const canSync  = (room, uid) => hasGrant(room, uid, "sync");
const canQueue = (room, uid) => hasGrant(room, uid, "queue");
/* media rooms (entertainment / music) */
const canControlPlayback = (room, uid) => !isStudyRoom(room) && hasGrant(room, uid, "sync");
const canUseMediaQueue   = (room, uid) => !isStudyRoom(room) && hasGrant(room, uid, "queue");
/* loading a video IS a queue action now — the URL bar is gone */
const canChangeVideo = canUseMediaQueue;
/* study rooms */
const canControlTimer = (room, uid) => isStudyRoom(room) && hasGrant(room, uid, "sync");
const canManageTasks  = (room, uid) => isStudyRoom(room) && hasGrant(room, uid, "queue");
const canManageBoards = (room, uid) => isStudyRoom(room) && hasGrant(room, uid, "queue");
const canGrantQueue = canModerate;     // host + mods, same as canGrantSync
/* ── per-room-type wording for the two slots ── */
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
};
const scopeText = (room, scope) =>
  (FEATURE_SCOPES[room && room.roomType] || MEDIA_SCOPES)[scope];
const scopeLabels = (room) => ({ sync: scopeText(room, "sync"), queue: scopeText(room, "queue") });
/* scope table — lets one handler serve both permission kinds.
   `label` is the media default, kept for old call sites: prefer scopeText(room, scope).label */
const SCOPES = {
  sync:  { grant: "canSync",  req: "syncRequest",  label: MEDIA_SCOPES.sync.label,
           can: canSync,  mode: "syncMode",  grantedBy: canGrantSync },
  queue: { grant: "canQueue", req: "queueRequest", label: MEDIA_SCOPES.queue.label,
           can: canQueue, mode: "queueMode", grantedBy: canGrantQueue },
};
const isScope = (s) => Object.prototype.hasOwnProperty.call(SCOPES, s);
const canEditRoom = canModerate;   // edit name/desc/mode/tags/visibility/cap
const isBanned = (room, uid) =>
  (room.bannedUsers || []).some((b) => sameId(b.userId, uid));
/* ── reports ───────────────────────────────────────────── */
// anyone may report someone else's live message
const canReportMessage = (room, msg, uid) =>
  !!msg && !msg.deleted && !sameId(msg.senderId, uid);
// who receives / reviews / dismisses reports
const canReviewReports = canModerate;
const isVoiceMuted = (room, uid) =>
  (room.voiceMutedUsers || []).some((m) => sameId(m.userId, uid));
const serializeVoiceMutes = (room) =>
  (room.voiceMutedUsers || []).map((m) => ({
    userId: m.userId.toString(),
    username: m.username,
    by: m.mutedByName || "",
    at: m.mutedAt,
  }));
function resolvePerms(room, uid) {
  const m     = getMember(room, uid) || {};
  const admin = isAdmin(room, uid);
  const mod   = isMod(room, uid);
  const st    = room.settings || {};
  return {
    isAdmin: admin,
    isMod:   mod,
    role:    admin ? "admin" : (m.role || "member"),
    syncMode:  st.syncMode  || "host",
    queueMode: st.queueMode || "host",
    autoplay:  st.autoplay !== false,
    canSync:        canSync(room, uid),
    canQueue:       canQueue(room, uid),
    canChangeVideo: canQueue(room, uid),      // kept for backwards compat on the client
    canEditRoom:   canEditRoom(room, uid),
    canManage:     canModerate(room, uid),
    canGrantSync:  canGrantSync(room, uid),
    canGrantQueue: canGrantQueue(room, uid),
    canSetRoles:   canSetRoles(room, uid),
    canBan:        canBan(room, uid),
    canControlPlayback: canControlPlayback(room, uid),
    canUseMediaQueue:   canUseMediaQueue(room, uid),
    canControlTimer: canControlTimer(room, uid),
    canManageTasks:  canManageTasks(room, uid),
    canManageBoards: canManageBoards(room, uid),
    labels:          scopeLabels(room),
    requestState:      m.syncRequest  || "none",
    queueRequestState: m.queueRequest || "none",
  };
}
/* privileged viewers see canSync/syncRequest, everyone else just roles */
function serializeMembers(room, privileged) {
  return (room.members || []).map((m) => {
    const base = { userId: m.userId.toString(), username: m.username, role: m.role };
    if (!privileged) return base;
    return { 
      ...base, 
      canSync: canSync(room, m.userId), syncRequest: m.syncRequest || "none",
      canQueue: canQueue(room, m.userId), queueRequest: m.queueRequest || "none",
    };
  });
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
  ROOM_CAP, MODE_VALUES, validId,
  sameId, isAdmin, isMod, roleOf, getMember, ensureMember, isBanned, isVoiceMuted, serializeVoiceMutes, serializeReport,
  canSync, canChangeVideo, canModerate, canEditRoom, canGrantSync, canSetRoles, canBan, canReportMessage, canReviewReports, 
  canEditMessage, canDeleteMessage, canClearChat, serializeMessage,
  resolvePerms, serializeMembers, sanitizeRoomPatch, sameValue, canQueue, canGrantQueue, SCOPES, isScope,
  hasGrant, isStudyRoom, canControlPlayback, canUseMediaQueue,
  canControlTimer, canManageTasks, canManageBoards, scopeText, FEATURE_SCOPES,
};