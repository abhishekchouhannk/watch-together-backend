// models/Room.js
const mongoose = require("mongoose");
/* persistent per-user permission record — survives leave / rejoin / refresh */
const MemberSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username:    { type: String },
  role:        { type: String, enum: ["admin", "mod", "member"], default: "member" },
  canSync:     { type: Boolean, default: false },   // explicit grant to play/pause/seek
  syncRequest: { type: String, enum: ["none", "pending", "denied"], default: "none" },
  updatedAt:   { type: Date, default: Date.now },
}, { _id: false });
const RoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  roomName: { type: String, required: true },
  description: { type: String, maxlength: 200 },
  thumbnail: { type: String },
  mode: { type: String, enum: ["study", "gaming", "entertainment", "casual"], default: "casual" },
  isPublic: { type: Boolean, default: true },
  maxParticipants: { type: Number, default: 10 },
  admin: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    username: { type: String, required: true }
  },
  /* ── room-level policy ── */
  settings: {
    syncMode:          { type: String, enum: ["host", "everyone"], default: "host" },
    whoCanChangeVideo: { type: String, enum: ["host", "controllers", "everyone"], default: "host" },
  },
  /* ──  persistent roster (permissions live here, NOT in participants) ── */
  members: [MemberSchema],
  video: {
    url: { type: String },
    title: { type: String },
    currentTime: { type: Number, default: 0 },
    duration: { type: Number },
    isPlaying: { type: Boolean, default: false },
    updatedAt: { type: Date }
  },
  participants: [                       // ← presence only, pruned on leave
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      username: { type: String },
      joinedAt: { type: Date, default: Date.now },
    }
  ],
  tags: [{ type: String }],
  status: { type: String, enum: ["active", "idle", "ended"], default: "active" }
}, { timestamps: true });
RoomSchema.index({ roomName: 'text', description: 'text', tags: 'text' });
RoomSchema.index({ mode: 1, isPublic: 1, status: 1 });
module.exports = mongoose.model("Room", RoomSchema);