// routes/users.js
const express = require("express");
const router  = express.Router();
const User    = require("../models/User");
const { authenticateToken } = require("../middleware/auth");
const { avatarUpload }      = require("../middleware/avatarUpload");
const { perUserLimit }      = require("../middleware/perUserLimit");
const V  = require("../utils/profileValidators");
const AV = require("../utils/avatarStorage");
const { broadcastProfile } = require("../utils/profileBroadcast");
const OID_RE     = /^[0-9a-fA-F]{24}$/;
const LOOKUP_MAX = 100;
const EDITABLE   = ["username", "bio", "birthday"];
/* Projections: what each endpoint may even LOAD from Mongo. */
const IDENTITY_FIELDS = "username avatar avatarPublicId avatarAnimated updatedAt";
const PUBLIC_FIELDS   = IDENTITY_FIELDS + " bio createdAt";
const ME_FIELDS       = PUBLIC_FIELDS + " email birthday isVerified";
const WRITE_FIELDS    = ME_FIELDS + " joinedRooms";                 // + who to notify after a change
const patchLimit  = perUserLimit({ windowMs: 10 * 60e3, max: 30, message: "Too many profile updates — slow down a little" });
const uploadLimit = perUserLimit({ windowMs: 10 * 60e3, max: 10, message: "Too many photo uploads — try again in a few minutes" });
/* ── serialisers: explicit whitelists on the way out (belt AND braces) ── */
const revOf      = (u) => (u.updatedAt ? new Date(u.updatedAt).getTime() : 0);
const toIdentity = (u) => ({ id: String(u._id), username: u.username, ...AV.publicAvatar(u), rev: revOf(u) });
const toPublic   = (u) => ({ ...toIdentity(u), bio: u.bio || "", createdAt: u.createdAt });
const toMe       = (u) => ({ ...toPublic(u), email: u.email, isVerified: !!u.isVerified, birthday: V.birthdayToISO(u.birthday) });
const serverError = (res, where, err, msg = "Something went wrong") => {
  console.error(where, err);
  return res.status(500).json({ error: msg });
};
const writeUser = (id, $set) =>
  User.findByIdAndUpdate(id, { $set }, { new: true, runValidators: true }).select(WRITE_FIELDS).lean();
/* ════════════════════════════════════════════════════════════════
   NOTE: every /me* and /lookup route MUST be declared before
   /:userId, or "me" hits the ObjectId guard and returns 400.
   ════════════════════════════════════════════════════════════════ */
/** GET /api/users/me — my full (private) profile + the rules the UI validates against. */
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).select(ME_FIELDS).lean();
    if (!u) return res.status(404).json({ error: "User not found" });
    res.set("Cache-Control", "no-store");
    return res.json({ user: toMe(u), limits: V.profileLimits() });
  } catch (err) {
    return serverError(res, "GET /api/users/me", err, "Failed to load your profile");
  }
});
/**
 * PATCH /api/users/me  { username?, bio?, birthday? }
 * Each field is judged on its own: valid ones are saved, invalid ones come
 * back in `errors`. 200 if anything was saved (or nothing needed saving),
 * 422 if every sent field was rejected.
 */
router.patch("/me", authenticateToken, patchLimit, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Expected a JSON object" });
  }
  const sent = Object.keys(body);
  const unknown = sent.filter((k) => !EDITABLE.includes(k));
  if (unknown.length) return res.status(400).json({ error: "These fields can't be edited here: " + unknown.join(", ") });
  if (!sent.length)   return res.status(400).json({ error: "Nothing to update" });
  try {
    const cur = await User.findById(req.user.id).select(WRITE_FIELDS).lean();
    if (!cur) return res.status(404).json({ error: "User not found" });
    const errors = {}, $set = {};
    if ("username" in body) {
      const raw = typeof body.username === "string" ? body.username.trim() : body.username;
      // identical to the current one → accepted as-is (even if it predates today's rules)
      if (raw !== cur.username) {
        const r = V.validateUsername(raw);
        if (r.error) errors.username = r.error;
        else if (r.value !== cur.username) {
          const clash = await User.exists({ username: r.value, _id: { $ne: cur._id } }).collation(V.USERNAME_COLLATION);
          if (clash) errors.username = "That username is taken";
          else $set.username = r.value;   // case-only changes ("bob" → "Bob") are allowed: the only clash is yourself
        }
      }
    }
    if ("bio" in body) {
      const r = V.validateBio(body.bio);
      if (r.error) errors.bio = r.error;
      else if (r.value !== (cur.bio || "")) $set.bio = r.value;
    }
    if ("birthday" in body) {
      const r = V.validateBirthday(body.birthday);
      if (r.error) errors.birthday = r.error;
      else if (V.birthdayToISO(r.value) !== V.birthdayToISO(cur.birthday)) $set.birthday = r.value;
    }
    let user = cur;
    if (Object.keys($set).length) {
      try {
        user = await writeUser(cur._id, $set);
      } catch (err) {
        // lost a race for the same name between our check and the write → the unique index caught it
        if (err && err.code === 11000 && "username" in $set) {
          delete $set.username;
          errors.username = "That username is taken";
          if (Object.keys($set).length) user = await writeUser(cur._id, $set);
        } else {
          throw err;
        }
      }
      if (!user) return res.status(404).json({ error: "User not found" });
    }
    const saved = Object.keys($set);
    if (saved.some((k) => k !== "birthday")) broadcastProfile(req, user);                 // rooms see name/bio
    else if (saved.length)                  broadcastProfile(req, user, { privateOnly: true }); // only my other tabs
    const status = Object.keys(errors).length && !saved.length ? 422 : 200;
    return res.status(status).json({ user: toMe(user), saved, errors });
  } catch (err) {
    return serverError(res, "PATCH /api/users/me", err, "Couldn't save your profile");
  }
});
/** POST /api/users/me/avatar  multipart: avatar=<file>, cropX, cropY, cropSize */
router.post(
  "/me/avatar",
  authenticateToken,
  uploadLimit,
  (req, res, next) => (AV.isConfigured() ? next()
    : res.status(503).json({ error: "Photo uploads aren't configured on this server yet" })),
  avatarUpload,
  async (req, res) => {
    const crop = V.parseCrop(req.body);
    if (crop && crop.error) return res.status(400).json({ error: crop.error });
    let result;
    try {
      result = await AV.uploadAvatarBuffer(req.file.buffer, { userId: String(req.user.id), crop });
    } catch (err) {
      console.error("POST /api/users/me/avatar (cloudinary)", err);
      return err && err.http_code === 400
        ? res.status(422).json({ error: "That image couldn't be processed — try another one" })
        : res.status(502).json({ error: "Upload failed — please try again" });
    }
    const animated = (result.pages || 1) > 1;
    const avatar = AV.displayUrl(result.public_id, animated);
    try {
      // returns the PREVIOUS doc atomically → we know exactly which asset to delete
      const prev = await User.findByIdAndUpdate(
        req.user.id,
        { $set: { avatar, avatarPublicId: result.public_id, avatarAnimated: animated } },
        { new: false }
      ).select("avatarPublicId").lean();
      if (!prev) { AV.destroyAvatar(result.public_id); return res.status(404).json({ error: "User not found" }); }
      if (prev.avatarPublicId && prev.avatarPublicId !== result.public_id) AV.destroyAvatar(prev.avatarPublicId);
      const user = await User.findById(req.user.id).select(WRITE_FIELDS).lean();
      broadcastProfile(req, user);
      return res.status(201).json({ user: toMe(user) });
    } catch (err) {
      AV.destroyAvatar(result.public_id);                 // don't leave an orphan if the DB write failed
      return serverError(res, "POST /api/users/me/avatar", err, "Couldn't save your new photo");
    }
  }
);
/** DELETE /api/users/me/avatar — back to the generated initial. Idempotent. */
router.delete("/me/avatar", authenticateToken, async (req, res) => {
  try {
    const prev = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { avatar: null, avatarPublicId: null, avatarAnimated: false } },
      { new: false }
    ).select("avatar avatarPublicId").lean();
    if (!prev) return res.status(404).json({ error: "User not found" });
    if (prev.avatarPublicId) AV.destroyAvatar(prev.avatarPublicId);   // OAuth URLs (no public id) are just dropped
    const user = await User.findById(req.user.id).select(WRITE_FIELDS).lean();
    if (prev.avatar) broadcastProfile(req, user);
    return res.json({ user: toMe(user) });
  } catch (err) {
    return serverError(res, "DELETE /api/users/me/avatar", err, "Couldn't remove your photo");
  }
});
/**
 * GET /api/users/lookup?ids=a,b,c — batched identity (name + avatar) for
 * chat history, member lists etc. Max 100 ids; unknown ids are just absent.
 */
router.get("/lookup", authenticateToken, async (req, res) => {
  const ids = [...new Set(String(req.query.ids || "").split(",").map((s) => s.trim()).filter((s) => OID_RE.test(s)))]
    .slice(0, LOOKUP_MAX);
  if (!ids.length) return res.json({ users: [] });
  try {
    const users = await User.find({ _id: { $in: ids } }).select(IDENTITY_FIELDS).lean();
    res.set("Cache-Control", "private, no-cache");       // revalidate (Express ETags make it a cheap 304)
    return res.json({ users: users.map(toIdentity) });
  } catch (err) {
    return serverError(res, "GET /api/users/lookup", err, "Lookup failed");
  }
});
/**
 * GET /api/users/:userId — public profile card. Birthday/email never leave.
 */
router.get("/:userId", authenticateToken, async (req, res) => {
  const { userId } = req.params;
  if (!OID_RE.test(userId)) return res.status(400).json({ error: "Invalid user id" });
  try {
    const user = await User.findById(userId).select(PUBLIC_FIELDS).lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    // was max-age=60: people would see a stale bio/photo for a minute after an edit
    res.set("Cache-Control", "private, no-cache");
    return res.json(toPublic(user));                      // { id, username, avatar, avatarStill, bio, createdAt, rev }
  } catch (err) {
    return serverError(res, "GET /api/users/:userId", err, "Failed to load profile");
  }
});
module.exports = router;