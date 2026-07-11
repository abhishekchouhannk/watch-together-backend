// routes/rooms.js
const express = require('express');
const router = express.Router();
const Room = require('../models/Room');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

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
// POST /api/rooms/:roomId/join
router.post('/:roomId/join', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId   = (req.user.id || req.user._id).toString();
    const username = req.user.username;
    const room = await Room.findOne({ roomId });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const alreadyIn = room.participants.some(
      p => p.userId.toString() === userId
    );
    if (!alreadyIn) {
      if (room.participants.length >= (room.maxParticipants || 10))
        return res.status(400).json({ error: 'Room is full' });
      room.participants.push({ userId, username, joinedAt: new Date() });
      await room.save();
      await User.findByIdAndUpdate(userId, { $addToSet: { joinedRooms: roomId } });
    }
    const populated = await Room.findOne({ roomId }).lean();
    res.json({ room: populated });
  } catch (err) {
    console.error('Join room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// POST /api/rooms/:roomId/leave
router.post('/:roomId/leave', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = (req.user.id || req.user._id).toString();
    await Room.findOneAndUpdate({ roomId }, { $pull: { participants: { userId } } });
    await User.findByIdAndUpdate(userId, { $pull: { joinedRooms: roomId } });
    res.json({ success: true });
  } catch (err) {
    console.error('Leave room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;