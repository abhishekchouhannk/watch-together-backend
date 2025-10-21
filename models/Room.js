// models/Room.js
const mongoose = require("mongoose");

const RoomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    roomName: { type: String, required: true },
    mode: { type: String, enum: [
        "study", "gaming", "movie", "casual"
    ], default: "casual" },
    video: {
        url: { type: String },
        currentTime: { type: Number, default: 0 },
        isPlaying: { type: String, enum: ["playing", "paused"], default: "paused" }
    },
    participants: [
        {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            username: { type: String },
            joinedAt: { type: Date, default: Date.now }
        }
    ]
}, { timestamps: true });

module.exports = mongoose.model("Room", RoomSchema);