// models/Report.js
const mongoose = require("mongoose");
const ReporterSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username: { type: String },
  at:       { type: Date, default: Date.now },
}, { _id: false });
/* one open report per message; extra reporters pile onto reporters[] */
const ReportSchema = new mongoose.Schema({
  roomId:         { type: String, required: true },
  messageId:      { type: mongoose.Schema.Types.ObjectId, ref: "Message", required: true },
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderName:     { type: String },
  text:           { type: String, maxlength: 500, default: "" },   // snapshot at report time
  messageTs:      { type: Date },
  messageDeleted: { type: Boolean, default: false },               // author deleted it after the report
  reporters:      [ReporterSchema],
}, { timestamps: true });
ReportSchema.index({ roomId: 1, messageId: 1 }, { unique: true });
ReportSchema.index({ roomId: 1, updatedAt: -1 });
module.exports = mongoose.model("Report", ReportSchema);