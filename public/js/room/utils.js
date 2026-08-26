/* public/js/utils.js
 * ─────────────────────────────────────────────────────────────
 * SMALL SHARED HELPERS used by three or more feature modules.
 * Pure where possible; the two impure ones are called out below.
 *
 *   delay(ms)        promise-based sleep (used by the chat history fetch)
 *   esc(s)           HTML-escape via textContent round-trip
 *   fmtTime(s)       seconds → "m:ss"
 *   fmtMsgTs(ts)     timestamp → "HH:MM"
 *   avColor(name)    deterministic avatar colour from AV_COLORS
 *   fmtBadge(n)      badge label, capped at BADGE_CAP ("10+")
 *   extractYT(url)   YouTube id or null
 *   fillSlider(...)  paints the <input type=range> track gradient
 *   safeHttpUrl(u)   only http(s) URLs survive (avatar <img src>)
 *   fmtJoined(iso)   localised join date
 *   isMe(id)         IMPURE — reads S.userId
 *   toast(msg,type)  IMPURE — appends to dom.toasts
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { AV_COLORS, BADGE_CAP } from "./config.js";
import { S } from "./state.js";
import { dom } from "./dom.js";
/* ═══════ HELPERS ═══════ */
export function delay(ms)     { return new Promise((r) => setTimeout(r, ms)); }
export function esc(s)        { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
export function fmtTime(s)    { if (isNaN(s)) return "0:00"; const m = Math.floor(s / 60), sec = Math.floor(s % 60); return m + ":" + (sec < 10 ? "0" : "") + sec; }
export function fmtMsgTs(ts)  { const d = ts ? new Date(ts) : new Date(); return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0"); }
export function avColor(name) { if (!name) return AV_COLORS[0]; let h = 0; for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h); return AV_COLORS[Math.abs(h) % AV_COLORS.length]; }
export const fmtBadge = (n) => (n > BADGE_CAP ? BADGE_CAP + "+" : String(n));
export const isMe     = (id) => !!(id && S.userId && id.toString() === S.userId);
export function extractYT(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
export function fillSlider(el, val, max) {
  const pct = (val / max) * 100;
  el.style.background = "linear-gradient(to right,#fff " + pct + "%,rgba(255,255,255,.25) " + pct + "%)";
}
/* only ever render http(s) images */
export function safeHttpUrl(u) {
  if (!u) return "";
  try { const x = new URL(u, location.origin); return /^https?:$/.test(x.protocol) ? x.href : ""; }
  catch (_) { return ""; }
}
export function fmtJoined(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}
export function toast(msg, type) {
  const el = document.createElement("div");
  el.className = "toast toast-" + (type || "success");
  el.innerHTML = '<span class="toast-ic">' + (type === "error" ? "⚠️" : "✓") + '</span><span>' + esc(msg) + '</span>';
  dom.toasts.appendChild(el);
  setTimeout(() => { el.classList.add("hiding"); setTimeout(() => el.remove(), 300); }, 3200);
}