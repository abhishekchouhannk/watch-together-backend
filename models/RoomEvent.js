// models/RoomEvent.js
const mongoose = require("mongoose");
/** Audit/receipt log for room activity. Deliberately separate from Message so the
 *  chat collection only ever holds human messages. */
const KINDS = ["presence", "chat", "queue", "playback", "perm", "room", "voice", "other"];
const RoomEventSchema = new mongoose.Schema({
  roomId:     { type: String, required: true },
  kind:       { type: String, enum: KINDS, default: "other" },      // category → colour dot
  action:     { type: String, required: true, maxlength: 64 },      // machine code, e.g. "chat.clear"
  /* template — placeholders {actor} {target} {detail}. NEVER concatenate user content into it;
     pass titles/names through `detail` / actorName / targetName instead. */
  text:       { type: String, required: true, maxlength: 300 },
  detail:     { type: String, default: null, maxlength: 200 },
  actorId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  actorName:  { type: String, default: null, maxlength: 64 },
  targetId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  targetName: { type: String, default: null, maxlength: 64 },
  meta:       { type: mongoose.Schema.Types.Mixed, default: undefined },
  createdAt:  { type: Date, default: Date.now },
}, { versionKey: false, collection: "room_events" });
/* cursor pagination by _id in both directions */
RoomEventSchema.index({ roomId: 1, _id: -1 });
/* optional retention — uncomment to auto-expire receipts after 90 days */
// RoomEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
RoomEventSchema.statics.KINDS = KINDS;
module.exports = mongoose.model("RoomEvent", RoomEventSchema);