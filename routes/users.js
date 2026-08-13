// routes/users.js
const express = require("express");
const router  = express.Router();
const User    = require("../models/User");
// swap this for whatever your project already uses (requireAuth / authMiddleware / passport…)
const { authenticateToken } = require('../middleware/auth');
/** only these three fields ever leave the DB */
const PUBLIC_FIELDS = "username avatar createdAt";
const OID_RE = /^[0-9a-fA-F]{24}$/;
/**
 * GET /api/users/:userId
 * Public profile card data. Mongoose projection guarantees email / password /
 * sessions / oauthProviders / tokens are never even loaded from Mongo.
 */
router.get("/:userId", authenticateToken, async (req, res) => {
  const { userId } = req.params;
  // cheap guard: avoids a CastError -> 500 on garbage input
  if (!OID_RE.test(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  try {
    const user = await User.findById(userId)
      .select(PUBLIC_FIELDS)   // ← projection happens in Mongo, not in Node
      .lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    // explicit whitelist on the way out too — belt *and* braces
    res.set("Cache-Control", "private, max-age=60");
    return res.json({
      id:        user._id.toString(),
      username:  user.username,
      avatar:    user.avatar || null,      // null => client draws the generated avatar
      createdAt: user.createdAt,           // exists thanks to { timestamps: true }
    });
  } catch (err) {
    console.error("GET /api/users/:userId", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});
module.exports = router;