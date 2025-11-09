// models/Room.js
const mongoose = require("mongoose");

const RoomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    roomName: { type: String, required: true },
    description: { type: String, maxlength: 200 },
    thumbnail: { type: String }, // URL for room preview image
    mode: { 
        type: String, 
        enum: ["study", "gaming", "entertainment", "casual"], 
        default: "casual" 
    },
    isPublic: { type: Boolean, default: true }, // For searchability
    maxParticipants: { type: Number, default: 10 },
    admin: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        username: { type: String, required: true }
    },
    video: {
        url: { type: String },
        title: { type: String },
        currentTime: { type: Number, default: 0 },
        duration: { type: Number },
        isPlaying: { type: Boolean, default: false }
    },
    participants: [
        {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            username: { type: String },
            // avatar: { type: String }, // User avatar URL
            joinedAt: { type: Date, default: Date.now },
            // isActive: { type: Boolean, default: true }
        }
    ],
    tags: [{ type: String }], // Additional tags for better search
    status: { 
        type: String, 
        enum: ["active", "idle", "ended"], 
        default: "active" 
    }
}, { timestamps: true });

// Index for better search performance
RoomSchema.index({ roomName: 'text', description: 'text', tags: 'text' });
RoomSchema.index({ mode: 1, isPublic: 1, status: 1 });

module.exports = mongoose.model("Room", RoomSchema);
