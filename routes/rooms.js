// routes/rooms.js
const express = require('express');
const router = express.Router();
const Room = require('../models/Room');
const Message = require('../models/Message');
const { authenticateToken } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { sanitizeRoomPatch, canModerate } = require('../utils/roomConfigAndPermissions');

// Get user's joined rooms
router.get('/joined', authenticateToken, async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { 'admin.userId': req.user.id },
        { 'participants.userId': req.user.id }
      ]
    }).sort({ updatedAt: -1 });
    
    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch joined rooms' });
  }
});

// Get rooms created or joined by the logged-in user
router.get('/my-rooms', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id; // comes from middleware

    const rooms = await Room.find({
      $or: [
        { 'admin.userId': userId },
        { 'participants.userId': userId }
      ]
    }).sort({ updatedAt: -1 });

    res.json({ rooms });
  } catch (error) {
    console.error('Error fetching user rooms:', error);
    res.status(500).json({ error: 'Failed to fetch your rooms' });
  }
});

// Get public rooms
router.get('/public', authenticateToken, async (req, res) => {
  try {
    const rooms = await Room.find({ isPublic: true })
      .sort({ createdAt: -1 })
      .limit(20);
    
    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch public rooms' });
  }
});

// Search rooms
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q, type } = req.query;
    let query = { isPublic: true };
    
    if (type && type !== 'all') {
      query.roomType = type;
    }
    
    if (q) {
      query.$text = { $search: q };
    }
    
    const rooms = await Room.find(query)
      .sort({ score: { $meta: 'textScore' } })
      .limit(20);
    
    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search rooms' });
  }
});

// Create new room
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { roomName, description, mode, maxParticipants, isPublic, tags, thumbnail, video } = req.body;
    
    const newRoom = new Room({
      roomId: uuidv4(),
      roomName,
      description,
      mode,
      maxParticipants,
      isPublic,
      tags,
      video,
      thumbnail,
      admin: {
        userId: req.user.id,
        username: req.user.username
      },
      participants: [{
        userId: req.user.id,
        username: req.user.username,
        joinedAt: new Date()
      }]
    });
    
    await newRoom.save();
    res.status(201).json({ room: newRoom });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// PATCH /api/rooms/:roomId  (host or mod)
router.patch('/:roomId', authenticateToken, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!canModerate(room, req.user.id)) return res.status(403).json({ error: 'Not allowed' });
    const { patch, errors } = sanitizeRoomPatch(room, req.body);
    if (errors.length) return res.status(400).json({ error: errors[0] });
    Object.assign(room, patch);
    await room.save();
    res.json({ room });
  } catch (e) { res.status(500).json({ error: 'Failed to update room' }); }
});

// ── GET single room ──────────────────────────────
router.get('/:roomId', authenticateToken, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ room });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// GET /api/rooms/:roomId/messages?limit=20&before=<messageId>
router.get("/:roomId/messages", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const { before } = req.query;
    const query = { roomId };
    // _id is monotonically increasing → reliable cursor for pagination
    if (before) query._id = { $lt: before };
    // newest first, then reverse to chronological for rendering
    const docs = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1) // fetch one extra to detect "hasMore"
      .lean();
    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();
    docs.reverse();
    res.json({
      hasMore,
      messages: docs.map((m) => ({
        id: m._id.toString(),
        senderId: m.senderId,
        username: m.senderName,
        text: m.message,
        timestamp: m.timestamp,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load messages" });
  }
});

module.exports = router;