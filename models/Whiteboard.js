const mongoose = require("mongoose");
const WhiteboardSchema = new mongoose.Schema({
  roomId:        { type: String, required: true, index: true },
  boardId:       { type: String, required: true, unique: true },
  name:          { type: String, required: true, trim: true, maxlength: 40 },
  objects:       { type: [mongoose.Schema.Types.Mixed], default: [] },   // visible strokes/shapes/text only
  count:         { type: Number, default: 0 },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdByName: { type: String },
  updatedByName: { type: String },
}, { timestamps: true });
module.exports = mongoose.model("Whiteboard", WhiteboardSchema);