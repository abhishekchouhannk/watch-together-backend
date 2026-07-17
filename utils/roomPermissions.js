// utils/permissions.js
const sameId = (a, b) => !!a && !!b && a.toString() === b.toString();
const isAdmin    = (room, uid) => !!(room.admin && sameId(room.admin.userId, uid));
const getMember  = (room, uid) => (room.members || []).find((m) => sameId(m.userId, uid));
/* every joiner gets a persistent record; permissions then survive leave/rejoin */
function ensureMember(room, user) {
  let m = getMember(room, user.id);
  if (!m) {
    room.members.push({
      userId: user.id,
      username: user.username,
      role: isAdmin(room, user.id) ? "admin" : "member",
      canSync: isAdmin(room, user.id),
      syncRequest: "none",
      updatedAt: new Date(),
    });
    m = room.members[room.members.length - 1];
  } else {
    if (m.username !== user.username) m.username = user.username;     // keep names fresh
    if (isAdmin(room, user.id) && m.role !== "admin") m.role = "admin";
  }
  return m;
}
const roleOf = (room, uid) => (isAdmin(room, uid) ? "admin" : (getMember(room, uid)?.role || "member"));
function canSync(room, uid) {
  if (isAdmin(room, uid)) return true;
  if ((room.settings?.syncMode || "host") === "everyone") return true;
  if (roleOf(room, uid) === "mod") return true;          // mods get playback control
  return !!getMember(room, uid)?.canSync;
}
function canChangeVideo(room, uid) {
  if (isAdmin(room, uid)) return true;
  const mode = room.settings?.whoCanChangeVideo || "host";
  if (mode === "everyone") return true;
  if (mode === "controllers") return canSync(room, uid);
  return false;                                          // default: host only
}
const canEditRoom = (room, uid) => isAdmin(room, uid) || roleOf(room, uid) === "mod";  // wired later
const canManage   = (room, uid) => isAdmin(room, uid);
function resolvePerms(room, uid) {
  const m = getMember(room, uid);
  return {
    isAdmin: isAdmin(room, uid),
    role: roleOf(room, uid),
    syncMode: room.settings?.syncMode || "host",
    canSync: canSync(room, uid),
    canChangeVideo: canChangeVideo(room, uid),
    canEditRoom: canEditRoom(room, uid),
    canManage: canManage(room, uid),
    requestState: m ? m.syncRequest : "none",            // none | pending | denied
  };
}
/* roster for the config panel. `full` = admin view (includes request state) */
function serializeMembers(room, full) {
  return (room.members || []).map((m) => {
    const out = {
      userId: m.userId.toString(),
      username: m.username,
      role: m.role,
      canSync: canSync(room, m.userId),    // effective
      grantedSync: !!m.canSync,            // explicit grant
    };
    if (full) out.requestState = m.syncRequest;
    return out;
  });
}
module.exports = {
  sameId, isAdmin, getMember, ensureMember, roleOf,
  canSync, canChangeVideo, canEditRoom, canManage,
  resolvePerms, serializeMembers,
};