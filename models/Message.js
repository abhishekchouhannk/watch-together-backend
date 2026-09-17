// models/Message.js
const mongoose = require("mongoose");
const MessageSchema = new mongoose.Schema({
  roomId:     { type: String, required: true },
  senderId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderName: { type: String, required: true },
  // text is optional when the message carries media (GIF-only), and scrubbed to "" on delete.
  // NB: mongoose treats "" as missing for `required` strings, hence the function.
  message:    { type: String, required: function () { return !this.deleted && !this.mediaUrl; }, default: "" },
  // https image/GIF url (validated in the socket handler), scrubbed on delete
  mediaUrl:   { type: String, default: null, maxlength: 2048 },
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