// socket/roomHandlers.js
const Room = require("../models/Room");
const Message = require("../models/Message");
const User = require("../models/User");
// Build a clean room object for the client
function serializeRoom(room) {
  const v = room.video || {};
  let currentTime = v.currentTime || 0;
  // if it's playing, advance by however long it's been playing (server clock → safe)
  if (v.isPlaying && v.updatedAt) {
    currentTime += (Date.now() - new Date(v.updatedAt).getTime()) / 1000;
  }
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    description: room.description,
    mode: room.mode,
    status: room.status,
    maxParticipants: room.maxParticipants,
    tags: room.tags,
    admin: room.admin
      ? { userId: room.admin.userId, username: room.admin.username } // <-- expose userId
      : null,
    video: { url: v.url || null, currentTime, isPlaying: !!v.isPlaying },
    participants: room.participants.map((p) => ({
      userId: p.userId,
      username: p.username,
    })),
  };
}
async function handleLeave(io, socket) {
  const roomId = socket.data.roomId;
  const user = socket.data.user;
  if (!roomId || !user) return;
  // During "disconnecting" the socket is still in its rooms, so we must
  // exclude the current socket and check if this user has OTHER live
  // connections in the same room (e.g. another browser tab).
  const socketsInRoom = await io.in(roomId).fetchSockets();
  const stillConnectedElsewhere = socketsInRoom.some(
    (s) => s.id !== socket.id && s.data.user && s.data.user.id === user.id,
  );
  socket.leave(roomId);
  socket.data.roomId = null;
  if (stillConnectedElsewhere) return; // keep participant; another tab is open
  const room = await Room.findOne({ roomId });
  if (!room) return;
  room.participants = room.participants.filter(
    (p) => !(p.userId && p.userId.toString() === user.id),
  );
  // optional: mark idle when empty
  if (room.participants.length === 0 && room.status === "active") {
    room.status = "idle";
  }
  await room.save();
  io.to(roomId).emit("participants-update", {
    participants: room.participants.map((p) => ({
      userId: p.userId,
      username: p.username,
    })),
    count: room.participants.length,
  });
  io.to(roomId).emit("user-left", { username: user.username });
}
module.exports = function registerRoomHandlers(io, socket) {
  const user = socket.data.user;
  socket.on("join-room", async ({ roomId }) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) {
        socket.emit("room-error", { message: "Room not found" });
        return;
      }
      socket.join(roomId);
      socket.data.roomId = roomId;
      const alreadyIn = room.participants.some(
        (p) => p.userId && p.userId.toString() === user.id,
      );
      let isNewParticipant = false;
      if (!alreadyIn) {
        if (room.participants.length >= room.maxParticipants) {
          socket.emit("room-error", { message: "Room is full" });
          socket.leave(roomId);
          socket.data.roomId = null;
          return;
        }
        room.participants.push({
          userId: user.id,
          username: user.username,
          joinedAt: new Date(),
        });
        if (room.status === "idle") room.status = "active";
        await room.save();
        await User.updateOne(
          { _id: user.id },
          { $addToSet: { joinedRooms: roomId } },
        );
        isNewParticipant = true;
      }
      // send full room state to the joiner only
      socket.emit("room-state", { room: serializeRoom(room) });
      // update the count/avatars for everyone
      io.to(roomId).emit("participants-update", {
        participants: room.participants.map((p) => ({
          userId: p.userId,
          username: p.username,
        })),
        count: room.participants.length,
      });
      // only announce a genuinely new person (not a second tab)
      if (isNewParticipant) {
        socket.to(roomId).emit("user-joined", { username: user.username });
      }
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
      const msg = await Message.create({
        roomId,
        senderId: user.id,
        senderName: user.username,
        message: clean,
      });
      // broadcast to everyone INCLUDING the sender (single source of truth)
      io.to(roomId).emit("chat-message", {
        id: msg._id.toString(),
        senderId: user.id,
        username: user.username,
        text: clean,
        timestamp: msg.timestamp,
      });
    } catch (err) {
      console.error("chat-message error:", err);
    }
  });
  // ===== VIDEO SYNC =====
  socket.on("video-load", async ({ url }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !url) return;
    await Room.updateOne(
      { roomId },
      {
        $set: {
          video: {
            url,
            currentTime: 0,
            isPlaying: false,
            updatedAt: new Date(),
          },
        },
      },
    );
    // to EVERYONE (incl. sender) so all load via the same path
    io.to(roomId).emit("video-load", { url, by: user.username });
  });
  socket.on("video-play", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    await Room.updateOne(
      { roomId },
      {
        $set: {
          "video.isPlaying": true,
          "video.currentTime": currentTime,
          "video.updatedAt": new Date(),
        },
      },
    );
    socket.to(roomId).emit("video-play", { currentTime }); // everyone except sender
  });
  socket.on("video-pause", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    await Room.updateOne(
      { roomId },
      {
        $set: {
          "video.isPlaying": false,
          "video.currentTime": currentTime,
          "video.updatedAt": new Date(),
        },
      },
    );
    socket.to(roomId).emit("video-pause", { currentTime });
  });
  socket.on("video-seek", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    await Room.updateOne(
      { roomId },
      {
        $set: {
          "video.currentTime": currentTime,
          "video.updatedAt": new Date(),
        },
      },
    );
    socket.to(roomId).emit("video-seek", { currentTime });
  });
  // host's periodic clock → keeps everyone drift-free
  socket.on("video-heartbeat", ({ currentTime, isPlaying }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("video-heartbeat", { currentTime, isPlaying });
  });

  // reaction handler
  const ALLOWED_REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👏", "💀"];
  const REACT_LIMIT = 8; // max reactions
  const REACT_WINDOW = 4000; // per 4 seconds, per socket
  socket.on("video-reaction", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    if (!ALLOWED_REACTIONS.includes(emoji)) return; // whitelist only
    // token-bucket rate limit
    const now = Date.now();
    const rl =
      socket.data.reactRL ||
      (socket.data.reactRL = { n: 0, reset: now + REACT_WINDOW });
    if (now > rl.reset) {
      rl.n = 0;
      rl.reset = now + REACT_WINDOW;
    }
    if (++rl.n > REACT_LIMIT) return; // silently drop spam
    // everyone EXCEPT the sender (sender rendered it optimistically)
    socket.to(roomId).emit("video-reaction", {
      emoji,
      userId: user.id, // ← your existing user refs
      username: user.username,
      at: now,
    });
  });

  socket.on("leave-room", () => handleLeave(io, socket));
  socket.on("disconnecting", () => handleLeave(io, socket));
};
