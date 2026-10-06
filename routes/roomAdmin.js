// routes/roomAdmin.js — owner-only room management over REST (dashboard).
// Mount BEFORE your existing rooms router (same /api/rooms prefix).
"use strict";
const express = require("express");
const router  = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { perUserLimit }      = require("../middleware/perUserLimit");
const RA = require("../services/roomAdmin");
const ROOM_ID_RE = /^[A-Za-z0-9_-]{3,100}$/;
const editLimit   = perUserLimit({ windowMs: 10 * 60e3, max: 40, message: "Too many room edits — slow down a little" });
const deleteLimit = perUserLimit({ windowMs: 10 * 60e3, max: 10, message: "Too many deletions — try again in a few minutes" });
const checkId = (req, res, next) =>
  ROOM_ID_RE.test(req.params.roomId) ? next() : res.status(400).json({ error: "Invalid room id" });
const actorOf = (req) => ({ userId: String(req.user.id), username: req.user.username });
const send = (res, r) => { const { status, ...body } = r; return res.status(status).json(body); };
const fail = (res, where, err, msg) => { console.error(where, err); return res.status(500).json({ error: msg }); };
/** GET /api/rooms/:roomId/settings — fresh editable values for the edit modal */
router.get("/:roomId/settings", authenticateToken, checkId, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return send(res, await RA.getRoomSettings({ roomId: req.params.roomId, userId: req.user.id }));
  } catch (err) { return fail(res, "GET settings", err, "Couldn't load the room"); }
});
/** PATCH /api/rooms/:roomId  { roomName?, description?, tags?, isPublic?, maxParticipants?, base? } */
router.patch("/:roomId", authenticateToken, checkId, editLimit, async (req, res) => {
  try {
    const r = await RA.updateRoomDetails({ roomId: req.params.roomId, userId: req.user.id, body: req.body });
    if (r.status === 200 && r.saved.length) RA.notifyRoomUpdated(req.app.get("io"), r.room, r.saved, actorOf(req));
    return send(res, r);
  } catch (err) {
    if (err && err.name === "ValidationError") {
      const first = Object.values(err.errors || {})[0];
      return res.status(422).json({ error: (first && first.message) || "Invalid room details" });
    }
    return fail(res, "PATCH room", err, "Couldn't save the room");
  }
});
/** GET /api/rooms/:roomId/delete-preview — counts for the confirmation dialog */
router.get("/:roomId/delete-preview", authenticateToken, checkId, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return send(res, await RA.deletePreview({ roomId: req.params.roomId, userId: req.user.id }));
  } catch (err) { return fail(res, "GET delete-preview", err, "Couldn't load the room"); }
});
/** DELETE /api/rooms/:roomId — room + everything that belongs to it */
router.delete("/:roomId", authenticateToken, checkId, deleteLimit, async (req, res) => {
  try {
    const r = await RA.deleteRoomCascade({ roomId: req.params.roomId, userId: req.user.id });
    if (r.status === 200) {
      RA.teardownLiveRoom(req.app.get("io"), req.params.roomId, actorOf(req))
        .catch((err) => console.error("[room delete] teardown failed", err));
    }
    return send(res, r);
  } catch (err) { return fail(res, "DELETE room", err, "Couldn't delete the room"); }
});
module.exports = router;