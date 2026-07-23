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
  if (raw.mode !== undefined) {
    if (!MODE_VALUES.includes(raw.mode)) errors.push("Unknown room mode");
    else patch.mode = raw.mode;
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
/* ── playback ───────────────────────────────────────────── */
function canSync(room, uid) {
  if (isAdmin(room, uid) || isMod(room, uid)) return true;        // implicit, never revocable
  if ((room.settings && room.settings.syncMode) === "everyone") return true;
  const m = getMember(room, uid);
  return !!(m && m.canSync);
}
function canChangeVideo(room, uid) {
  if (isAdmin(room, uid)) return true;
  const who = (room.settings && room.settings.whoCanChangeVideo) || "host";
  if (who === "everyone") return true;
  if (who === "controllers") return canSync(room, uid);
  return false;                                                    // "host"
}
/* ── moderation / room management ───────────────────────── */
const canModerate = (room, uid) => isAdmin(room, uid) || isMod(room, uid); // mods + host
const canEditRoom = canModerate;   // edit name/desc/mode/tags/visibility/cap
const canGrantSync = canModerate;  // grant/revoke playback, answer requests, set sync mode
const isBanned = (room, uid) =>
  (room.bannedUsers || []).some((b) => sameId(b.userId, uid));
function resolvePerms(room, uid) {
  const role = roleOf(room, uid);
  const m = getMember(room, uid);
  return {
    role,
    isAdmin: role === "admin",
    isMod:   role === "mod",
    canSync:        canSync(room, uid),
    canChangeVideo: canChangeVideo(room, uid),
    canManage:      canModerate(room, uid),
    canGrantSync:   canGrantSync(room, uid),
    canEditRoom:    canEditRoom(room, uid),
    canSetRoles:    canSetRoles(room, uid),
    canBan:         canBan(room, uid),        // ← new (admin only)
    canKick:        canBan(room, uid),        // ← new (flip to canModerate to let mods kick)
    syncMode:     (room.settings && room.settings.syncMode) || "host",
    requestState: (m && m.syncRequest) || "none",
  };
}
/* privileged viewers see canSync/syncRequest, everyone else just roles */
function serializeMembers(room, privileged) {
  return (room.members || []).map((m) => {
    const base = { userId: m.userId.toString(), username: m.username, role: m.role };
    if (!privileged) return base;
    return { ...base, canSync: canSync(room, m.userId), syncRequest: m.syncRequest || "none" };
  });
}
module.exports = {
  ROOM_CAP, MODE_VALUES, validId,
  sameId, isAdmin, isMod, roleOf, getMember, ensureMember, isBanned,
  canSync, canChangeVideo, canModerate, canEditRoom, canGrantSync, canSetRoles, canBan,
  resolvePerms, serializeMembers, sanitizeRoomPatch, sameValue,
};