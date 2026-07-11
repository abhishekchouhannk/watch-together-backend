// socket/index.js
const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const Room = require('../models/Room');
const Message = require('../models/Message');
// ── tiny cookie parser (no extra dependency) ──
function parseCookies(raw) {
  const jar = {};
  if (!raw) return jar;
  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.substring(0, idx).trim();
    let   v = pair.substring(idx + 1).trim();
    if (v[0] === '"') v = v.slice(1, -1);
    try { jar[k] = decodeURIComponent(v); } catch (_) { jar[k] = v; }
  });
  return jar;
}
module.exports = function setupSocket(io) {
  /* ═══════════════════════════════════════════
     AUTH MIDDLEWARE — runs once per connection
     ═══════════════════════════════════════════ */
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      // ⚠️  Change 'token' to whatever cookie name your auth sets
      const token = cookies.accessToken;
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      const userId  = decoded.userId;
      const user    = await User.findById(userId).select('username');
      if (!user || !user.isActive) return next(new Error('User not found'));
      socket.user = { id: user._id.toString(), username: user.username };
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });
  /* ═══════════════════════════════════════════
     PRESENCE TRACKING
     roomId → Map<userId, Set<socketId>>
     ═══════════════════════════════════════════ */
  const presence    = new Map();
  const graceTimers = new Map();   // "roomId::userId" → timeout handle
  const GRACE_MS    = 8000;        // 8-second window so page-refresh doesn't flash "left"
  function addPresence(roomId, userId, socketId) {
    if (!presence.has(roomId)) presence.set(roomId, new Map());
    const room = presence.get(roomId);
    if (!room.has(userId)) room.set(userId, new Set());
    room.get(userId).add(socketId);
  }
  /** @returns true when the removed socket was the LAST one for that user */
  function removePresence(roomId, userId, socketId) {
    const room = presence.get(roomId);
    if (!room) return true;
    const sockets = room.get(userId);
    if (!sockets) return true;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      room.delete(userId);
      if (room.size === 0) presence.delete(roomId);
      return true;
    }
    return false;
  }
  function isUserPresent(roomId, userId) {
    const room = presence.get(roomId);
    return room ? room.has(userId) : false;
  }
  /* ═══════════════════════════════════════════
     CONNECTION
     ═══════════════════════════════════════════ */
  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`[Socket] ✓ ${user.username} connected (${socket.id})`);
    /* ── JOIN ROOM ───────────────────────────── */
    socket.on('join-room', async ({ roomId }, cb) => {
      try {
        const room = await Room.findOne({ roomId });
        if (!room) return cb?.({ error: 'Room not found' });
        // Cancel any pending grace-period removal
        const gKey = `${roomId}::${user.id}`;
        if (graceTimers.has(gKey)) {
          clearTimeout(graceTimers.get(gKey));
          graceTimers.delete(gKey);
        }
        // Was the user already a DB participant? (page refresh / reconnect)
        const alreadyIn = room.participants.some(
          p => p.userId.toString() === user.id
        );
        // Re-add to DB if grace period had already removed them
        if (!alreadyIn) {
          if (room.participants.length >= (room.maxParticipants || 10))
            return cb?.({ error: 'Room is full' });
          await Room.findOneAndUpdate(
            { roomId },
            { $push: { participants: { userId: user.id, username: user.username, joinedAt: new Date() } } }
          );
          await User.findByIdAndUpdate(user.id, { $addToSet: { joinedRooms: roomId } });
        }
        // Socket.IO room
        socket.join(roomId);
        socket.currentRoom = roomId;
        addPresence(roomId, user.id, socket.id);
        const freshRoom = await Room.findOne({ roomId }).lean();
        // Broadcast only when it's a genuinely new arrival
        if (!alreadyIn) {
          socket.to(roomId).emit('user-joined', {
            userId:       user.id,
            username:     user.username,
            participants: freshRoom.participants,
          });
        }
        cb?.({ success: true, participants: freshRoom.participants, isRejoin: alreadyIn });
      } catch (err) {
        console.error('[Socket] join-room error:', err);
        cb?.({ error: 'Server error' });
      }
    });
    /* ── CHAT MESSAGE ────────────────────────── */
    socket.on('chat-message', async ({ roomId, text }, cb) => {
      if (!text || !text.trim()) return;
      try {
        const msg = await Message.create({
          roomId,
          senderId:   user.id,
          senderName: user.username,
          message:    text.trim(),
        });
        // Broadcast to EVERYONE in the room (including sender)
        io.to(roomId).emit('chat-message', {
          _id:        msg._id,
          roomId:     msg.roomId,
          senderId:   user.id,
          senderName: user.username,
          message:    msg.message,
          timestamp:  msg.timestamp,
        });
        cb?.({ success: true });
      } catch (err) {
        console.error('[Socket] chat-message error:', err);
        cb?.({ error: 'Failed to send' });
      }
    });
    /* ── EXPLICIT LEAVE (Leave button click) ── */
    socket.on('leave-room', async ({ roomId }) => {
      socket.leftExplicitly = true;
      // Wipe ALL presence entries for this user in this room
      const roomP = presence.get(roomId);
      if (roomP) roomP.delete(user.id);
      socket.leave(roomId);
      socket.currentRoom = null;
      try {
        const updated = await Room.findOneAndUpdate(
          { roomId },
          { $pull: { participants: { userId: user.id } } },
          { new: true },
        ).lean();
        await User.findByIdAndUpdate(user.id, { $pull: { joinedRooms: roomId } });
        if (updated) {
          io.to(roomId).emit('user-left', {
            userId:       user.id,
            username:     user.username,
            participants: updated.participants,
          });
        }
      } catch (err) {
        console.error('[Socket] leave-room error:', err);
      }
    });
    /* ── DISCONNECT (tab close, navigation, network drop) ── */
    socket.on('disconnect', () => {
      console.log(`[Socket] ✗ ${user.username} disconnected (${socket.id})`);
      if (socket.leftExplicitly) return;      // already handled above
      const roomId = socket.currentRoom;
      if (!roomId) return;
      const isLastSocket = removePresence(roomId, user.id, socket.id);
      if (!isLastSocket) return;              // other tabs still open
      // Start a grace timer — gives the user time to refresh / reconnect
      const gKey = `${roomId}::${user.id}`;
      const timer = setTimeout(async () => {
        graceTimers.delete(gKey);
        // If user reconnected during the grace window, abort removal
        if (isUserPresent(roomId, user.id)) return;
        try {
          const updated = await Room.findOneAndUpdate(
            { roomId },
            { $pull: { participants: { userId: user.id } } },
            { new: true },
          ).lean();
          await User.findByIdAndUpdate(user.id, { $pull: { joinedRooms: roomId } });
          if (updated) {
            io.to(roomId).emit('user-left', {
              userId:       user.id,
              username:     user.username,
              participants: updated.participants,
            });
          }
        } catch (err) {
          console.error('[Socket] grace-period cleanup error:', err);
        }
      }, GRACE_MS);
      graceTimers.set(gKey, timer);
    });
  });
};