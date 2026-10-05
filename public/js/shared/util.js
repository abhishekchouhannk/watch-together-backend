/* public/js/shared/util.js
 * Page-agnostic helpers for the shared identity/profile stack (room AND
 * dashboard). No imports, no DOM work at load time.
 *
 * AV_COLORS is THE avatar palette for the whole app. room/config.js
 * re-exports it from here so both pages always agree.
 */
"use strict";
// ⚠ Paste the exact array from your current room/config.js AV_COLORS here.
export const AV_COLORS = [
  "#e11d48","#eab308","#22c55e","#3b82f6","#8b5cf6",
  "#ec4899","#f97316","#06b6d4","#6366f1","#14b8a6",
];
/* same hash as room/utils.js avColor — colours must match across pages */
export function avColor(name) {
  if (!name) return AV_COLORS[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AV_COLORS[Math.abs(h) % AV_COLORS.length];
}
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
/** https URLs only (http allowed for localhost dev); anything else → null */
export function safeHttpUrl(u) {
  if (typeof u !== "string" || !u) return null;
  try {
    const x = new URL(u, location.href);
    if (x.protocol === "https:") return x.href;
    if (x.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(x.hostname)) return x.href;
  } catch (_) {}
  return null;
}