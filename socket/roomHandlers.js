// socket/roomHandlers.js
const Room = require("../models/Room");
const Message = require("../models/Message");
const User = require("../models/User");
// Build a clean room object for the client
function serializeRoom(room) {
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    description: room.description,
    mode: room.mode,
    status: room.status,
    maxParticipants: room.maxParticipants,
    tags: room.tags,
    video: room.video,
    admin: room.admin ? { username: room.admin.username } : null,
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
    (s) => s.id !== socket.id && s.data.user && s.data.user.id === user.id
  );
  socket.leave(roomId);
  socket.data.roomId = null;
  if (stillConnectedElsewhere) return; // keep participant; another tab is open
  const room = await Room.findOne({ roomId });
  if (!room) return;
  room.participants = room.participants.filter(
    (p) => !(p.userId && p.userId.toString() === user.id)
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
        (p) => p.userId && p.userId.toString() === user.id
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
          { $addToSet: { joinedRooms: roomId } }
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
  socket.on("leave-room", () => handleLeave(io, socket));
  socket.on("disconnecting", () => handleLeave(io, socket));
};