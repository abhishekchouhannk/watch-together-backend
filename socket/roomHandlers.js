// socket/roomHandlers.js
const Room = require("../models/Room");
const Message = require("../models/Message");
const User = require("../models/User");
const {
  sameId, isAdmin, isMod, getMember, ensureMember,
  canSync, canChangeVideo, canModerate, canEditRoom, canGrantSync, canSetRoles,
  resolvePerms, serializeMembers, MODE_VALUES, sanitizeRoomPatch, sameValue,
} = require("../utils/roomConfigAndPermissions");
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
    requests: perms.canGrantSync
      ? (room.members || [])
          .filter((m) => m.syncRequest === "pending")
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

async function moderatorSockets(io, roomId, room) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.user && canModerate(room, s.data.user.id));
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
  /* generic gate: `check(room, uid)` decides, `msg` is the rejection toast */
  function guarded(check, msg, fn) {
    return async (...args) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = await Room.findOne({ roomId });
      if (!room) return;
      if (!check(room, user.id)) {
        return socket.emit("perm-toast", { message: msg, type: "error" });
      }
      try {
        await fn(room, roomId, ...args);
      } catch (err) {
        console.error("privileged action failed:", err);
        socket.emit("perm-toast", { message: "Something went wrong — try again", type: "error" });
      }
    };
  }
  
  const adminAction = (fn) => guarded(isAdmin, "Only the host can do that", fn);
  const modAction   = (fn) => guarded(canModerate, "Only the host and moderators can do that", fn);
  
  socket.on("perm-set-mode", modAction(async (room, roomId, { mode } = {}) => {
    if (!["host", "everyone"].includes(mode)) return;
    if (room.settings.syncMode === mode) return;
    room.settings.syncMode = mode;
    await room.save();
    await broadcastPermissions(io, roomId, room);
    io.to(roomId).emit("perm-notice", {
      text: mode === "everyone"
        ? "Everyone can now control playback"
        : "Playback control is now host-only",
    });
  }));
  socket.on("perm-grant", modAction(async (room, roomId, { userId } = {}) => {
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === "mod") return;   // both already implicit
    m.canSync = true; m.syncRequest = "none"; m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", { message: "You can now control playback 🎉", type: "success" });
    io.to(roomId).emit("perm-notice", { text: `${m.username} can now control playback` });
  }));
  socket.on("perm-revoke", modAction(async (room, roomId, { userId } = {}) => {
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === "mod") return;   // can't strip host/mods here
    m.canSync = false;
    m.syncRequest = "denied";
    m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", { message: "Your playback control was removed", type: "error" });
  }));
  /* role changes: HOST ONLY */
  socket.on("perm-set-role", adminAction(async (room, roomId, { userId, role } = {}) => {
    if (!["mod", "member"].includes(role)) return;
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === role) return;
    m.role = role;
    if (role === "mod") { m.syncRequest = "none"; m.canSync = true; } // implicit anyway; keeps it true on demote-back
    m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);                    // ← this is what flips their UI live
    await toUser(io, roomId, userId, "perm-toast", {
      message: role === "mod"
        ? "You're now a moderator — you can edit the room and grant playback control"
        : "You're no longer a moderator",
      type: role === "mod" ? "success" : "error",
    });
    io.to(roomId).emit("perm-notice", {
      text: role === "mod" ? `${m.username} is now a moderator` : `${m.username} is no longer a moderator`,
    });
  }));
  /* ═══════════════ ROOM DETAILS ═══════════════ */
  socket.on("room-update", modAction(async (room, roomId, payload = {}) => {
    if (!canEditRoom(room, user.id)) return;   // belt & braces
    const { patch, errors } = sanitizeRoomPatch(room, payload);
    if (errors.length) return socket.emit("perm-toast", { message: errors[0], type: "error" });
    const changed = Object.keys(patch).filter((k) => !sameValue(room[k], patch[k]));
    if (!changed.length) return socket.emit("perm-toast", { message: "Nothing to save", type: "info" });
    changed.forEach((k) => { room[k] = patch[k]; });
    await room.save();   // schema validators (enum/maxlength) run here; guarded() catches throws
    const updatedRoom = serializeRoom(room);
    socket.emit("room-saved", { room: updatedRoom, changed });                               // the editor
    socket.to(roomId).emit("room-updated", { room: updatedRoom, by: user.username, changed }); // everyone else
    socket.emit("perm-toast", { message: "Room details saved ✅", type: "success" });
    socket.to(roomId).emit("perm-notice", { text: `${user.username} updated the room details` });
  }));
  /* participant asks the host/mod for playback control */
  socket.on("perm-request", async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const now = Date.now();
    if (socket.data.lastPermReq && now - socket.data.lastPermReq < 15000) return;
    socket.data.lastPermReq = now;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    if (canSync(room, user.id)) {
      return socket.emit("perm-toast", { message: "You already have playback control", type: "success" });
    }
    const m = ensureMember(room, user);
    if (m.syncRequest === "denied") {
      return socket.emit("perm-toast", {
        message: "Your request was declined — a host or mod has to grant it from room settings",
        type: "error",
      });
    }
    const targets = await moderatorSockets(io, roomId, room);
    if (!targets.length) {
      return socket.emit("perm-toast", { message: "No host or moderator is in the room right now", type: "error" });
    }
    if (m.syncRequest !== "pending") { m.syncRequest = "pending"; m.updatedAt = new Date(); await room.save(); }
    targets.forEach((s) => s.emit("perm-request", { userId: user.id, username: user.username }));
    socket.emit("perm-toast", { message: "Request sent ✌️", type: "success" });
    await broadcastPermissions(io, roomId, room);
  });
  socket.on("perm-respond", modAction(async (room, roomId, { userId, approve } = {}) => {
    const m = getMember(room, userId);
    if (!m || m.syncRequest !== "pending") return;
    if (approve) { m.canSync = true;  m.syncRequest = "none"; }
    else         { m.canSync = false; m.syncRequest = "denied"; }
    m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", {
      message: approve ? `${user.username} gave you playback control 🎉` : "Your request was declined",
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