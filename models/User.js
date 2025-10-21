// models/User.js
const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // hashed password
    avatar: { type: String }, // optional avatar URL
    joinedRooms: [{ type: String }], // array of roomIds user has joined
    lastLogin: { type: Date, default: Date.now },
    // OAuth providers info
    oauthProviders: {
        google: {
            id: { type: String },
            email: { type: String },
            name: { type: String },
            picture: { type: String }
        },
        facebook: {
            id: { type: String },
            email: { type: String },
            name: { type: String },
            picture: { type: String }
        },
        discord: {
            id: { type: String },
            username: { type: String },
            email: { type: String },
            name: { type: String },
            picture: { type: String }
        }
    },
    // session management
    sessions: [
        {
            sessionId: { type: String },
            createdAt: { type: Date, default: Date.now },
            expiresAt: { type: Date },
            deviceInfo: {
                userAgent: { type: String },
                ipAddress: { type: String },
                deviceType: { type: String },
                location: { type: String }
            }
        }
    ],
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);
