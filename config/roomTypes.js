/* config/roomTypes.js
 * THE list of room types. Everything else derives from this:
 *   - models/Room.js      → schema enum
 *   - GET /api/rooms/types → dashboard filter chips, create dropdown, badges
 * Adding a type = adding one entry here. (The in-room layout still needs its
 * own work; see the handover doc.)
 */
const ROOM_TYPE_META = {
  entertainment: { label: "Entertainment", icon: "🎬" },
  music:         { label: "Music",         icon: "🎵" },
  study:         { label: "Study",         icon: "📚" },
};
const DEFAULT_ROOM_TYPE = "entertainment";
const ROOM_TYPE_IDS = Object.keys(ROOM_TYPE_META);
/* what the API exposes: a stable, ordered array (object key order = insertion order) */
function publicRoomTypes() {
  return ROOM_TYPE_IDS.map((id) => ({ id, label: ROOM_TYPE_META[id].label, icon: ROOM_TYPE_META[id].icon }));
}
module.exports = { ROOM_TYPE_META, ROOM_TYPE_IDS, DEFAULT_ROOM_TYPE, publicRoomTypes };