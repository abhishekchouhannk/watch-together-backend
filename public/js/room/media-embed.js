/* public/js/media-embed.js
 * ─────────────────────────────────────────────────────────────
 * IMAGE-LINK DETECTION. Pure functions, no DOM.
 *
 *   normalizeImageUrl(raw)       → canonical href, or null if not an embeddable image
 *   findImageUrls(text)          → [{ url, start, end }] every image link, in order
 *   findImageUrl(text, skip)     → first hit whose url isn't in `skip` (a Set)
 *   stripImageUrl(text, url)     → text with that link removed + whitespace tidied
 *   interceptOutgoing(raw, opts) → { text, mediaUrl } for an outgoing message
 *
 * The server's cleanMediaUrl() mirrors normalizeImageUrl() EXACTLY
 * (https only, no credentials, pathname ends .png/.jpg/.jpeg/.gif).
 * Keep them in sync, or a link could be stripped client-side and
 * then rejected server-side.
 * ───────────────────────────────────────────────────────────── */
"use strict";
export const MEDIA_URL_MAX = 2048;
const EXT       = /\.(?:png|jpe?g|gif)$/i;
const CANDIDATE = /https:\/\/[^\s<>"'`]+/gi;
const CLOSERS   = { ")": "(", "]": "[", "}": "{" };
const WRAPS     = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`" };
export function normalizeImageUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MEDIA_URL_MAX) return null;
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!EXT.test(u.pathname)) return null;        // query strings (?cid=…) are fine
  return u.href;
}
function count(s, ch) { let n = 0; for (const c of s) if (c === ch) n++; return n; }
/* "look https://x/a.png!" → drop the "!"; keep ")" only if it closes a "(" inside the URL */
function trimTrailing(tok) {
  while (tok) {
    const c = tok[tok.length - 1];
    if (".,!?;:".includes(c)) { tok = tok.slice(0, -1); continue; }
    const open = CLOSERS[c];
    if (open && count(tok, c) > count(tok, open)) { tok = tok.slice(0, -1); continue; }
    break;
  }
  return tok;
}
export function findImageUrls(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(CANDIDATE)) {
    const tok = trimTrailing(m[0]);
    const url = normalizeImageUrl(tok);
    if (url) out.push({ url, start: m.index, end: m.index + tok.length });
  }
  return out;
}
export function findImageUrl(text, skip) {
  return findImageUrls(text).find((h) => !(skip && skip.has(h.url))) || null;
}
/* "I wanted to share this image https://x/a.png with you" → "I wanted to share this image with you"
   "look (https://x/a.png) lol"                            → "look lol"
   "see https://x/a.png, so funny"                          → "see, so funny"                     */
export function stripImageUrl(text, url) {
  const hit = findImageUrls(text).find((h) => h.url === url);
  if (!hit) return (text || "").trim();
  let l = text.slice(0, hit.start), r = text.slice(hit.end);
  const close = WRAPS[l.slice(-1)];
  if (close && r[0] === close) { l = l.slice(0, -1); r = r.slice(1); }   // empty "()" left behind
  l = l.replace(/[ \t]+$/, "");
  r = r.replace(/^[ \t]+/, "");
  if (!l || !r) return (l + r).trim();
  const joint = /\n$/.test(l) || /^\n/.test(r) || /^[.,!?;:)\]]/.test(r) ? "" : " ";
  return (l + joint + r).trim();
}
/* THE outgoing interceptor.
   opts.skip  — Set of urls the user chose to keep as plain links (× on the preview)
   opts.embed — false → never embed (e.g. the preview failed to load)           */
export function interceptOutgoing(raw, opts = {}) {
  const text = (raw || "").trim();
  if (opts.embed === false) return { text, mediaUrl: null };
  const hit = findImageUrl(text, opts.skip);
  if (!hit) return { text, mediaUrl: null };
  return { text: stripImageUrl(text, hit.url), mediaUrl: hit.url };
}