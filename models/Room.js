// models/Room.js
const mongoose = require("mongoose");
const ROOM_CAP = 10;   // hard ceiling, app-wide
/* persistent per-user permission record — survives leave / rejoin / refresh */
const MemberSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username:    { type: String },
  role:        { type: String, enum: ["admin", "mod", "member"], default: "member" },
  canSync:     { type: Boolean, default: false },
  syncRequest: { type: String, enum: ["none", "pending", "denied"], default: "none" },
  updatedAt:   { type: Date, default: Date.now },
}, { _id: false });
/* blocklist — checked on every join, REST read and discovery query */
const BannedUserSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username:     { type: String },
  bannedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  bannedByName: { type: String },
  reason:       { type: String, maxlength: 140 },
  bannedAt:     { type: Date, default: Date.now },
}, { _id: false });
const RoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  roomName: { type: String, required: true, trim: true, minlength: 3, maxlength: 60 },
  description: { type: String, maxlength: 200 },
  thumbnail: { type: String },
  mode: { type: String, enum: ["study", "gaming", "entertainment", "casual"], default: "casual" },
  isPublic: { type: Boolean, default: true },
  maxParticipants: {
    type: Number, default: ROOM_CAP,
    min: [2, "Rooms need space for at least 2 people"],
    max: [ROOM_CAP, `Rooms can't hold more than ${ROOM_CAP} people`],
    validate: {
      validator: Number.isInteger,
      message: "Max participants must be a whole number",
    },
  },
  admin: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    username: { type: String, required: true }
  },
  settings: {
    syncMode:          { type: String, enum: ["host", "everyone"], default: "host" },
    whoCanChangeVideo: { type: String, enum: ["host", "controllers", "everyone"], default: "host" },
  },
  members: [MemberSchema],
  bannedUsers: [BannedUserSchema],          // ← new
  video: {
    url: { type: String },
    title: { type: String },
    currentTime: { type: Number, default: 0 },
    duration: { type: Number },
    isPlaying: { type: Boolean, default: false },
    updatedAt: { type: Date }
  },
  participants: [
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
RoomSchema.index({ "bannedUsers.userId": 1 });
RoomSchema.statics.ROOM_CAP = ROOM_CAP;
module.exports = mongoose.model("Room", RoomSchema);