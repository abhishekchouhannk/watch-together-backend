// routes/voice.js
const express = require('express');
const router = express.Router();
const { AccessToken, TrackSource } = require('livekit-server-sdk');
const Room = require('../models/Room');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { isBanned } = require('../utils/roomConfigAndPermissions');
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL        = process.env.LIVEKIT_URL;
const TOKEN_TTL_SECONDS  = 60 * 10; // short‑lived; only used at connect time
// Keep the mapping in ONE place so client + server never disagree.
function voiceRoomName(roomId) {
  return `voice-${roomId}`;
}
/**
 * "Genuine, currently-allowed member" check.
 * Mirrors the gate used by the socket join-room handler:
 *   - room exists / not ended
 *   - user is not banned
 *   - user is the admin, a current participant, OR has a persistent member record
 *     (ensureMember() writes that record on first legitimate join)
 */
function isActiveMember(room, userId) {
  const uid = String(userId);
  if (room.admin?.userId && String(room.admin.userId) === uid) return true;
  if (room.participants?.some(p => p.userId && String(p.userId) === uid)) return true;
  if (room.members?.some(m => m.userId && String(m.userId) === uid)) return true;
  return false;
}
// POST /api/voice-token   body: { roomId }
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(503).json({ error: 'Voice service is not configured' });
    }
    const { roomId } = req.body || {};
    if (!roomId || typeof roomId !== 'string') {
      return res.status(400).json({ error: 'roomId is required' });
    }
    const room = await Room.findOne({ roomId });
    if (!room)                     return res.status(404).json({ error: 'Room not found' });
    if (room.status === 'ended')   return res.status(410).json({ error: 'Room has ended' });
    if (isBanned(room, req.user.id)) {
      return res.status(403).json({ error: 'banned', message: "You've been banned from this room" });
    }
    if (!isActiveMember(room, req.user.id)) {
      return res.status(403).json({ error: 'not_a_member', message: 'Join the room before connecting to voice' });
    }
    const user = await User.findById(req.user.id).select('username avatar').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const identity = String(req.user.id);          // stable + unique per room
    const rn = voiceRoomName(roomId);
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: user.username,
      ttl: TOKEN_TTL_SECONDS,
      metadata: JSON.stringify({
        userId:   identity,
        username: user.username,
        avatar:   user.avatar || null,            // used later for the "Speaking to" avatars
      }),
    });
    at.addGrant({
      room: rn,
      roomJoin:             true,
      canPublish:           true,
      canSubscribe:         true,
      canPublishData:       true,
      canUpdateOwnMetadata: true,
      canPublishSources:  [TrackSource.MICROPHONE],       // audio‑only: SFU rejects cam/screen
    });
    const token = await at.toJwt();                // async in server-sdk v2
    res.json({
      token,
      url: LIVEKIT_URL,
      roomName: rn,
      identity,
      ttl: TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    console.error('voice-token error:', err);
    res.status(500).json({ error: 'Failed to issue voice token' });
  }
});
module.exports = router;