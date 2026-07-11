// routes/messageRoutes.js
const express  = require('express');
const router   = express.Router();
const Message  = require('../models/Message');
const { authenticateToken } = require('../middleware/auth');
// GET /api/rooms/:roomId/messages?before=ISO&limit=30
router.get('/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { before, limit } = req.query;
    const pageSize = Math.min(Math.max(parseInt(limit) || 30, 1), 50);
    const filter = { roomId };
    if (before) filter.timestamp = { $lt: new Date(before) };
    const msgs = await Message.find(filter)
      .sort({ timestamp: -1 })
      .limit(pageSize)
      .lean();
    res.json({
      messages: msgs.reverse(),          // return in chronological order
      hasMore:  msgs.length === pageSize,
    });
  } catch (err) {
    console.error('Fetch messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});
module.exports = router;