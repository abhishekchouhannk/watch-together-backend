// models/Message.js
const mongoose = require("mongoose");

/** Stores all the messages throughout the application. Messages for a certain room can be grouped by using RoomId */
const MessageSchema = new mongoose.Schema({
    roomId: { type: String, required: true },
    senderId: {
        type: mongoose.Schema.Types.ObjectId, ref: "User", required: true
    },
    senderName: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

// Index for fast room-based queries
MessageSchema.index({ roomId: 1, timestamp: 1 });

module.exports = mongoose.model("Message", MessageSchema);