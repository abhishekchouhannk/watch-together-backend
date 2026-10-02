// middleware/avatarUpload.js — multer (memory only, nothing touches disk) + real type sniffing.
"use strict";
const multer = require("multer");
const { AVATAR_MAX_BYTES, AVATAR_TYPES } = require("../utils/profileValidators");
const MB = Math.round(AVATAR_MAX_BYTES / 1048576);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 6, fieldSize: 64, parts: 8 },
  fileFilter(req, file, cb) {
    // declared type (from the client) — cheap first gate; the bytes are checked below
    if (!AVATAR_TYPES.includes(file.mimetype)) {
      return cb(Object.assign(new Error("Only JPEG, PNG, WebP or GIF images are allowed"), { status: 415 }));
    }
    cb(null, true);
  },
});
/** Magic bytes — the Content-Type header is whatever the client says it is. */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const h6 = buf.toString("ascii", 0, 6);
  if (h6 === "GIF87a" || h6 === "GIF89a") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
function avatarUpload(req, res, next) {
  upload.single("avatar")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `Image must be ${MB} MB or smaller` });
        if (err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ error: "Send exactly one image in the 'avatar' field" });
        return res.status(400).json({ error: "Upload rejected (" + err.code + ")" });
      }
      return res.status(err.status || 400).json({ error: err.message || "Upload rejected" });
    }
    if (!req.file) return res.status(400).json({ error: "No image received" });
    const real = sniffImage(req.file.buffer);
    if (!real) return res.status(415).json({ error: "That file isn't a valid JPEG, PNG, WebP or GIF" });
    req.file.detectedType = real;
    next();
  });
}
module.exports = { avatarUpload, sniffImage };