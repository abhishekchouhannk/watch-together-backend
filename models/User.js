const mongoose = require("mongoose");
const { BIO_MAX, USERNAME_COLLATION } = require("../utils/profileValidators");
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // hashed password
    /* ── public profile ── */
    avatar:         { type: String,  default: null },  // display URL (Cloudinary or OAuth). null → client draws the generated initial avatar
    avatarPublicId: { type: String,  default: null },  // Cloudinary public_id — only set for uploads we own (needed to delete them)
    avatarAnimated: { type: Boolean, default: false }, // animated GIF/WebP → clients get a still frame for dense lists
    bio:            { type: String,  trim: true, maxlength: BIO_MAX, default: "" },
    /* ── private profile ── */
    birthday:       { type: Date,    default: null },  // stored at UTC midnight, always serialised as "YYYY-MM-DD"
    joinedRooms: [{ type: String }], // array of roomIds user has joined
    lastLogin: { type: Date, default: Date.now },
    // email Verification
    isVerified: { type: Boolean, default: false },
    verificationToken: { type: String },
    verificationTokenExpires: { type: Date },
    // password reset
    passwordResetToken: { type: String },
    passwordResetTokenExpires: { type: Date },
    // OAuth providers info
    oauthProviders: {
        google:   { id: String, email: String, name: String, picture: String },
        facebook: { id: String, email: String, name: String, picture: String },
        discord:  { id: String, username: String, email: String, name: String, picture: String }
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
}, { timestamps: true });
/* Case-insensitive uniqueness: "Bob" and "bob" can't both exist.
   Queries only USE this index when they pass the same collation
   (see USERNAME_COLLATION in profileValidators). */
UserSchema.index({ username: 1 }, { unique: true, collation: USERNAME_COLLATION, name: "username_ci_unique" });
UserSchema.index({ verificationToken: 1 });
UserSchema.index({ passwordResetToken: 1 });   // ← was `resetPasswordToken`, a field that doesn't exist
module.exports = mongoose.model("User", UserSchema);