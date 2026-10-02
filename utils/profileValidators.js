// utils/profileValidators.js
// Single source of truth for profile rules. GET /api/users/me ships the same
// numbers to the client as `limits`, so the UI can't drift from the server.
"use strict";
/* ── username ── */
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
// letters/digits, optionally joined by single . _ or - ; no leading/trailing/double separators
const USERNAME_RE = new RegExp(`^(?=.{${USERNAME_MIN},${USERNAME_MAX}}$)[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$`);
const USERNAME_HINT = `${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers and single . _ - between them`;
const USERNAME_COLLATION = { locale: "en", strength: 2 };          // case-insensitive compare
const RESERVED = new Set([
  "admin", "administrator", "host", "mod", "moderator", "system", "support",
  "root", "me", "you", "null", "undefined", "everyone", "staff", "official",
]);
function validateUsername(raw) {
  if (typeof raw !== "string") return { error: "Username is required" };
  const v = raw.normalize("NFKC").trim();
  if (!v) return { error: "Username is required" };
  if (!USERNAME_RE.test(v)) return { error: USERNAME_HINT };
  if (RESERVED.has(v.toLowerCase())) return { error: "That username is reserved" };
  return { value: v };
}
/* ── bio ── */
const BIO_MAX = 200;
// control chars (keeps \t and \n), zero-width chars EXCEPT U+200D (ZWJ — needed by emoji like 👨‍👩‍👧),
// bidi overrides/isolates (text-spoofing), BOM
const INVISIBLE_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
function validateBio(raw) {
  if (raw == null) return { value: "" };
  if (typeof raw !== "string") return { error: "Bio must be text" };
  const v = raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (v.length > BIO_MAX) return { error: `Bio can be at most ${BIO_MAX} characters` };
  return { value: v };
}
/* ── birthday ── */
const AGE_MIN = 15;
const AGE_MAX = 99;                                  // "no 100+ year olds"
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;   // m is 1-based here
function dateInZone(offsetHours, now) {
  const t = new Date(now + offsetHours * 3600e3);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function shiftYears({ y, m, d }, dy) {                // Feb 29 → Feb 28 in non-leap years
  const ny = y + dy;
  const last = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  return { y: ny, m, d: Math.min(d, last) };
}
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** Inclusive "YYYY-MM-DD" bounds. Lenient on both ends by timezone: if it's
 *  already your 15th birthday anywhere on Earth (UTC+14) you're allowed, and
 *  you're only "100" once it's your birthday everywhere (UTC−12). */
function birthdayBounds(now = Date.now()) {
  const max = shiftYears(dateInZone(14, now), -AGE_MIN);
  const min = addDays(shiftYears(dateInZone(-12, now), -(AGE_MAX + 1)), 1);
  return { min: iso(min.y, min.m, min.d), max: iso(max.y, max.m, max.d) };
}
function validateBirthday(raw) {
  if (raw === null || raw === "") return { value: null };      // clearing is allowed
  if (typeof raw !== "string") return { error: "Use the YYYY-MM-DD format" };
  const mt = ISO_RE.exec(raw.trim());
  if (!mt) return { error: "Use the YYYY-MM-DD format" };
  const [y, m, d] = mt.slice(1).map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return { error: "That date doesn't exist" };
  }
  const { min, max } = birthdayBounds();
  const s = iso(y, m, d);
  if (s > max) return { error: `You must be at least ${AGE_MIN} years old` };
  if (s < min) return { error: "Please enter your real birthday" };
  return { value: t };
}
function birthdayToISO(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/* ── avatar ── */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIN_PX = 64;
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** Optional square crop from the client, in the source image's natural pixels. */
function parseCrop(body = {}) {
  const keys = ["cropX", "cropY", "cropSize"];
  if (!keys.some((k) => body[k] != null && body[k] !== "")) return null;
  const [x, y, size] = keys.map((k) => Number(body[k]));
  if (![x, y, size].every((n) => Number.isInteger(n) && n >= 0 && n <= 20000)) return { error: "Invalid crop" };
  if (size < AVATAR_MIN_PX) return { error: `Image must be at least ${AVATAR_MIN_PX}×${AVATAR_MIN_PX}px` };
  return { x, y, size };
}
function profileLimits() {
  const b = birthdayBounds();
  return {
    usernameMin: USERNAME_MIN, usernameMax: USERNAME_MAX,
    usernamePattern: USERNAME_RE.source, usernameHint: USERNAME_HINT,
    bioMax: BIO_MAX,
    minAge: AGE_MIN, maxAge: AGE_MAX, birthdayMin: b.min, birthdayMax: b.max,
    avatarMaxBytes: AVATAR_MAX_BYTES, avatarMinPx: AVATAR_MIN_PX, avatarTypes: AVATAR_TYPES,
  };
}
module.exports = {
  USERNAME_MIN, USERNAME_MAX, USERNAME_RE, USERNAME_HINT, USERNAME_COLLATION,
  BIO_MAX, AGE_MIN, AGE_MAX,
  AVATAR_MAX_BYTES, AVATAR_MIN_PX, AVATAR_TYPES,
  validateUsername, validateBio, validateBirthday, birthdayToISO, birthdayBounds,
  parseCrop, profileLimits,
};