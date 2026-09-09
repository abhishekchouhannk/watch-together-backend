// utils/voiceRoom.js
const { RoomServiceClient, TrackSource } = require("livekit-server-sdk");
const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
const voiceRoomName = (roomId) => `voice-${roomId}`;
let _svc = null;
function roomService() {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) return null;
  if (!_svc) {
    // RoomServiceClient talks HTTP(S); clients get the ws(s):// URL.
    const httpUrl = LIVEKIT_URL.replace(/^ws/i, "http");
    _svc = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return _svc;
}
/**
 * Enforce / lift a host+mod voice mute on the SFU itself.
 * Best-effort: silently no-ops when the user isn't connected to voice — the
 * persisted DB flag + the token grant in routes/voice.js cover their next join.
 */
async function enforceVoiceMute(roomId, userId, muted) {
  const svc = roomService();
  if (!svc) return;
  const rn = voiceRoomName(roomId);
  const identity = String(userId);
  try {
    // 1. flip publish permission — survives any re-publish attempt for the
    //    lifetime of this connection (object-arg form; livekit-server-sdk v2).
    await svc.updateParticipant(rn, identity, {
      permission: { canSubscribe: true, canPublishData: true, canPublish: !muted },
    });
    // 2. mute the mic track that's live *right now*
    if (muted) {
      const p = await svc.getParticipant(rn, identity);
      await Promise.all(
        (p.tracks || [])
          .filter((t) => t.source === TrackSource.MICROPHONE)
          .map((t) => svc.mutePublishedTrack(rn, identity, t.sid, true)),
      );
    }
  } catch (_) {
    /* not in voice yet — nothing live to enforce */
  }
}
module.exports = { voiceRoomName, roomService, enforceVoiceMute };