// socket/roomHandlers.js
const Room = require("../models/Room");
const Message = require("../models/Message");
const User = require("../models/User");
const {
  sameId, isAdmin, getMember, ensureMember,
  canSync, canChangeVideo, resolvePerms, serializeMembers,
} = require("../utils/roomPermissions");
function serializeRoom(room) {
  const v = room.video || {};
  let currentTime = v.currentTime || 0;
  if (v.isPlaying && v.updatedAt) {
    currentTime += (Date.now() - new Date(v.updatedAt).getTime()) / 1000;
  }
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    description: room.description,
    mode: room.mode,
    status: room.status,
    isPublic: room.isPublic,
    maxParticipants: room.maxParticipants,
    tags: room.tags,
    settings: {
      syncMode: room.settings?.syncMode || "host",
      whoCanChangeVideo: room.settings?.whoCanChangeVideo || "host",
    },
    admin: room.admin ? { userId: room.admin.userId, username: room.admin.username } : null,
    video: { url: v.url || null, currentTime, isPlaying: !!v.isPlaying },
    participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
  };
}
/* ── permission plumbing ───────────────────────────────── */
function permPayload(room, uid) {
  const perms = resolvePerms(room, uid);
  return {
    perms,
    members: serializeMembers(room, perms.canManage),
    requests: perms.canManage
      ? (room.members || []).filter((m) => m.syncRequest === "pending")
          .map((m) => ({ userId: m.userId.toString(), username: m.username }))
      : [],
  };
}
/* push fresh perms to every socket in the room + refresh their cache */
async function broadcastPermissions(io, roomId, room) {
  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const uid = s.data.user && s.data.user.id;
    if (!uid) continue;
    const payload = permPayload(room, uid);
    s.data.perm = payload.perms;                  // cache → no DB read per video event
    s.emit("room-permissions", payload);
  }
}
async function socketsOfUser(io, roomId, userId) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.user && sameId(s.data.user.id, userId));
}
async function toUser(io, roomId, userId, event, payload) {
  (await socketsOfUser(io, roomId, userId)).forEach((s) => s.emit(event, payload));
}
/* authoritative video state, used to snap a rule-breaker back into place */
function liveVideoState(room) {
  const v = room.video || {};
  let t = v.currentTime || 0;
  if (v.isPlaying && v.updatedAt) t += (Date.now() - new Date(v.updatedAt).getTime()) / 1000;
  return { currentTime: t, isPlaying: !!v.isPlaying };
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
  await room.save();
  io.to(roomId).emit("participants-update", {
    participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
    count: room.participants.length,
  });
  io.to(roomId).emit("user-left", { username: user.username });
}
module.exports = function registerRoomHandlers(io, socket) {
  const user = socket.data.user;
  socket.on("join-room", async ({ roomId }) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return socket.emit("room-error", { message: "Room not found" });
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
      ensureMember(room, user);                         // ← persistent permission record
      if (room.isModified()) await room.save();
      if (isNewParticipant) {
        await User.updateOne({ _id: user.id }, { $addToSet: { joinedRooms: roomId } });
      }
      socket.data.perm = resolvePerms(room, user.id);
      socket.emit("room-state", { room: serializeRoom(room), perms: socket.data.perm });
      io.to(roomId).emit("participants-update", {
        participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
        count: room.participants.length,
      });
      await broadcastPermissions(io, roomId, room);     // roster/badges for everyone (incl. admin)
      if (isNewParticipant) socket.to(roomId).emit("user-joined", { username: user.username });
    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("room-error", { message: "Failed to join room" });
    }
  });
  socket.on("chat-message", async ({ text }) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const clean = (text || "").trim().slice(0, 500);
      if (!clean) return;
      const msg = await Message.create({ roomId, senderId: user.id, senderName: user.username, message: clean });
      io.to(roomId).emit("chat-message", {
        id: msg._id.toString(), senderId: user.id, username: user.username,
        text: clean, timestamp: msg.timestamp,
      });
    } catch (err) { console.error("chat-message error:", err); }
  });
  /* ═══════════════ VIDEO SYNC (permission-gated) ═══════════════ */
  async function denySync(action) {
    const roomId = socket.data.roomId;
    const room = await Room.findOne({ roomId }).lean();
    socket.emit("perm-denied", {
      action,
      message: action === "load"
        ? "Only the host can change the video"
        : "You don't have playback control in this room",
      video: room ? liveVideoState(room) : null,      // client snaps back to this
    });
  }
  const maySync = () => !!(socket.data.perm && socket.data.perm.canSync);
  const mayLoad = () => !!(socket.data.perm && socket.data.perm.canChangeVideo);
  socket.on("video-load", async ({ url }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !url) return;
    if (!mayLoad()) return denySync("load");
    await Room.updateOne({ roomId }, {
      $set: { video: { url, currentTime: 0, isPlaying: false, updatedAt: new Date() } },
    });
    io.to(roomId).emit("video-load", { url, by: user.username });
  });
  socket.on("video-play", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!maySync()) return denySync("play");
    await Room.updateOne({ roomId }, { $set: {
      "video.isPlaying": true, "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-play", { currentTime, by: user.username });
  });
  socket.on("video-pause", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!maySync()) return denySync("pause");
    await Room.updateOne({ roomId }, { $set: {
      "video.isPlaying": false, "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-pause", { currentTime, by: user.username });
  });
  socket.on("video-seek", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!maySync()) return denySync("seek");
    await Room.updateOne({ roomId }, { $set: {
      "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-seek", { currentTime, by: user.username });
  });
  /* drift correction — only controllers may drive the clock
     (these three were MISSING before: the client emits them, nobody relayed them) */
  socket.on("video-time-sync", ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !maySync()) return;
    socket.to(roomId).emit("video-time-sync", { currentTime });
  });
  socket.on("video-sync-request", () => {                        // late joiner asks peers
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("video-sync-request", { requesterId: socket.id });
  });
  socket.on("video-sync-response", ({ requesterId, currentTime, isPlaying }) => {
    if (!socket.data.roomId || !requesterId) return;
    io.to(requesterId).emit("video-sync-state", { currentTime, isPlaying });
  });
  /* ═══════════════ PERMISSIONS ═══════════════ */
  async function adminAction(fn) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await Room.findOne({ roomId });
    if (!room || !isAdmin(room, user.id)) {
      return socket.emit("perm-toast", { message: "Only the host can do that", type: "error" });
    }
    await fn(room, roomId);
  }
  socket.on("perm-set-mode", ({ mode }) =>
    adminAction(async (room, roomId) => {
      if (!["host", "everyone"].includes(mode)) return;
      room.settings.syncMode = mode;
      await room.save();
      await broadcastPermissions(io, roomId, room);
      io.to(roomId).emit("perm-notice", {
        text: mode === "everyone"
          ? "Everyone can now control playback"
          : "Playback control is now host-only",
      });
    }));
  socket.on("perm-grant", ({ userId }) =>
    adminAction(async (room, roomId) => {
      const m = getMember(room, userId);
      if (!m) return;
      m.canSync = true; m.syncRequest = "none"; m.updatedAt = new Date();
      await room.save();
      await broadcastPermissions(io, roomId, room);
      await toUser(io, roomId, userId, "perm-toast", { message: "You can now control playback 🎉", type: "success" });
      io.to(roomId).emit("perm-notice", { text: `${m.username} can now control playback` });
    }));
  socket.on("perm-revoke", ({ userId }) =>
    adminAction(async (room, roomId) => {
      const m = getMember(room, userId);
      if (!m || isAdmin(room, userId)) return;
      m.canSync = false;
      m.syncRequest = "denied";          // can't re-request; host must re-grant from settings
      m.updatedAt = new Date();
      await room.save();
      await broadcastPermissions(io, roomId, room);
      await toUser(io, roomId, userId, "perm-toast", { message: "Your playback control was removed", type: "error" });
    }));
  /* role stub — stores the role now, room-editing features get wired later */
  socket.on("perm-set-role", ({ userId, role }) =>
    adminAction(async (room, roomId) => {
      if (!["mod", "member"].includes(role)) return;
      const m = getMember(room, userId);
      if (!m || isAdmin(room, userId)) return;
      m.role = role;
      if (role === "mod") m.syncRequest = "none";
      m.updatedAt = new Date();
      await room.save();
      await broadcastPermissions(io, roomId, room);
      await toUser(io, roomId, userId, "perm-toast", {
        message: role === "mod" ? "You're now a moderator" : "You're no longer a moderator",
        type: role === "mod" ? "success" : "error",
      });
    }));
  /* participant asks the host for playback control */
  socket.on("perm-request", async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const now = Date.now();
    if (socket.data.lastPermReq && now - socket.data.lastPermReq < 15000) return;   // anti-spam
    socket.data.lastPermReq = now;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    if (isAdmin(room, user.id) || canSync(room, user.id)) {
      return socket.emit("perm-toast", { message: "You already have playback control", type: "success" });
    }
    const m = ensureMember(room, user);
    if (m.syncRequest === "denied") {
      return socket.emit("perm-toast", {
        message: "The host declined — they'll have to grant it from room settings",
        type: "error",
      });
    }
    const adminSockets = await socketsOfUser(io, roomId, room.admin.userId);
    if (!adminSockets.length) {
      return socket.emit("perm-toast", { message: "The host isn't in the room right now", type: "error" });
    }
    if (m.syncRequest !== "pending") {
      m.syncRequest = "pending";
      m.updatedAt = new Date();
      await room.save();
    }
    adminSockets.forEach((s) => s.emit("perm-request", { userId: user.id, username: user.username }));
    socket.emit("perm-toast", { message: "Request sent to the host ✌️", type: "success" });
    await broadcastPermissions(io, roomId, room);     // updates the host's pending badge
  });
  socket.on("perm-respond", ({ userId, approve }) =>
    adminAction(async (room, roomId) => {
      const m = getMember(room, userId);
      if (!m || m.syncRequest !== "pending") return;
      if (approve) { m.canSync = true;  m.syncRequest = "none"; }
      else         { m.canSync = false; m.syncRequest = "denied"; }
      m.updatedAt = new Date();
      await room.save();
      await broadcastPermissions(io, roomId, room);
      await toUser(io, roomId, userId, "perm-toast", {
        message: approve ? "The host gave you playback control 🎉" : "The host declined your request",
        type: approve ? "success" : "error",
      });
      if (approve) io.to(roomId).emit("perm-notice", { text: `${m.username} can now control playback` });
    }));
  /* ═══════════════ REACTIONS (unchanged) ═══════════════ */
  const ALLOWED_REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👏", "💀"];
  const REACT_LIMIT = 8, REACT_WINDOW = 4000;
  socket.on("video-reaction", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    const now = Date.now();
    const rl = socket.data.reactRL || (socket.data.reactRL = { n: 0, reset: now + REACT_WINDOW });
    if (now > rl.reset) { rl.n = 0; rl.reset = now + REACT_WINDOW; }
    if (++rl.n > REACT_LIMIT) return;
    socket.to(roomId).emit("video-reaction", { emoji, userId: user.id, username: user.username, at: now });
  });
  socket.on("leave-room", () => handleLeave(io, socket));
  socket.on("disconnecting", () => handleLeave(io, socket));
};