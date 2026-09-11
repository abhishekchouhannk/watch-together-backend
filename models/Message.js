// models/Message.js
const mongoose = require("mongoose");
/** Stores all the messages throughout the application. Messages for a certain room can be grouped by using RoomId */
const MessageSchema = new mongoose.Schema({
  roomId:     { type: String, required: true },
  senderId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderName: { type: String, required: true },
  // required only while the message is alive — deleted messages are scrubbed to ""
  message:    { type: String, required: function () { return !this.deleted; }, default: "" },
  timestamp:  { type: Date, default: Date.now },
  // ── edit / delete bookkeeping ──
  editedAt:      { type: Date, default: null },
  deleted:       { type: Boolean, default: false },
  deletedAt:     { type: Date, default: null },
  deletedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  deletedByName: { type: String, default: null },
  deletedByRole: { type: String, enum: ["self", "mod", "admin", null], default: null },
}, { timestamps: true });
MessageSchema.index({ roomId: 1, timestamp: 1 });
module.exports = mongoose.model("Message", MessageSchema);