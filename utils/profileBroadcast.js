// utils/profileBroadcast.js — tell everyone who can see me that I changed.
"use strict";
const { publicAvatar } = require("./avatarStorage");
/* ⚠ ADAPT: these must match what your socket handlers pass to socket.join(...) */
const roomChannel = (roomId) => String(roomId);
const userChannel = (userId) => "user:" + userId;     // only useful if you join sockets to a per-user channel
/**
 * @param {object} opts.privateOnly  true → only my own other tabs (e.g. birthday changed)
 */
function broadcastProfile(req, user, { privateOnly = false } = {}) {
  const io = req.app.get("io");
  if (!io || !user) return;
  const userId = String(user._id);
  const payload = {
    userId,
    username: user.username,
    bio: user.bio || "",
    ...publicAvatar(user),
    rev: user.updatedAt ? new Date(user.updatedAt).getTime() : Date.now(),
  };
  const targets = privateOnly
    ? [userChannel(userId)]
    : [...new Set((user.joinedRooms || []).map(roomChannel)), userChannel(userId)];
  io.to(targets).emit("user-profile-updated", payload);
  /* Keep identity cached on this user's LIVE sockets fresh — otherwise chat
     messages they send keep the old name until they reconnect.
     ⚠ ADAPT if you store the user somewhere else on the socket. */
  if (!privateOnly) {
    for (const s of io.of("/").sockets.values()) {
      for (const u of [s.user, s.data && s.data.user, s.data]) {
        if (u && String(u.userId ?? u.id ?? u._id ?? "") === userId && typeof u.username === "string") {
          u.username = user.username;
        }
      }
    }
  }
}
module.exports = { broadcastProfile };