// utils/avatarStorage.js — everything Cloudinary-specific lives here.
"use strict";
const cloudinary = require("cloudinary").v2;
const crypto = require("crypto");
const FOLDER = process.env.CLOUDINARY_AVATAR_FOLDER || "watch-together/avatars";
const STORE_PX = 512;   // what we keep (after the user's crop)
const SHOW_PX  = 256;   // what we deliver for normal avatars (retina-safe up to 128 css px)
const STILL_PX = 96;    // first-frame still for animated av's in dense lists
let configured = false;
/** Lazy so it works no matter when dotenv runs. */
function isConfigured() {
  if (configured) return true;
  const { CLOUDINARY_CLOUD_NAME: cloud_name, CLOUDINARY_API_KEY: api_key, CLOUDINARY_API_SECRET: api_secret } = process.env;
  if (!cloud_name || !api_key || !api_secret) return false;
  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
  configured = true;
  return true;
}
/** Buffer → Cloudinary. The crop runs as an *incoming* transformation, so the
 *  stored original is already the square the user chose (GIFs stay animated). */
function uploadAvatarBuffer(buffer, { userId, crop }) {
  const incoming = [];
  if (crop) incoming.push({ crop: "crop", x: crop.x, y: crop.y, width: crop.size, height: crop.size });
  incoming.push({ width: STORE_PX, height: STORE_PX, crop: "lfill", gravity: "center" });   // lfill = never upscale
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: FOLDER,
      public_id: `${userId}-${crypto.randomBytes(5).toString("hex")}`,   // unique per upload → URLs never need cache-busting
      resource_type: "image",
      overwrite: false,
      allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"],
      transformation: incoming,
      pages: true,                    // response includes frame count → we know if it's animated
      tags: ["avatar"],
      context: { user_id: String(userId) },
      timeout: 60000,
    }, (err, result) => (err ? reject(err) : resolve(result)));
    stream.end(buffer);
  });
}
/** Fire-and-forget: a failed delete leaves an orphan, never breaks the request. */
async function destroyAvatar(publicId) {
  if (!publicId || !isConfigured()) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (err) {
    console.warn("[avatar] destroy failed:", publicId, err && err.message);
  }
}
function displayUrl(publicId, animated) {
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      { width: SHOW_PX, height: SHOW_PX, crop: "fill", gravity: "center" },
      // f_auto → animated WebP/AVIF for GIFs on modern browsers (much smaller)
      animated ? { fetch_format: "auto", quality: "auto", flags: "animated" } : { fetch_format: "auto", quality: "auto" },
    ],
  });
}
function stillUrl(publicId) {
  return cloudinary.url(publicId, {
    secure: true,
    format: "png",                                   // png keeps transparency; first frame only
    transformation: [{ page: 1 }, { width: STILL_PX, height: STILL_PX, crop: "fill", gravity: "center" }],
  });
}
/** What any client may see about someone's avatar. */
function publicAvatar(u) {
  const avatar = (u && u.avatar) || null;
  const avatarStill = avatar && u.avatarAnimated && u.avatarPublicId && isConfigured()
    ? stillUrl(u.avatarPublicId) : null;
  return { avatar, avatarStill };
}
module.exports = { isConfigured, uploadAvatarBuffer, destroyAvatar, displayUrl, publicAvatar };