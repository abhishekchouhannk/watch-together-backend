/* public/js/media-embed.js
 * ─────────────────────────────────────────────────────────────
 * IMAGE-LINK DETECTION + CUT/RESTORE. Pure functions, no DOM.
 *
 *   normalizeImageUrl(raw)        → canonical href, or null
 *   findImageUrls(text)           → [{ url, start, end, terminated }]
 *   cutImageUrl(text, hit)        → { start, end, chunk, lead, trail }
 *                                   the range to remove (link + wrapper + one separator)
 *   restoreChunk(text, at, piece) → string to insert at `at` to put the link back
 *
 * The server's cleanMediaUrl() mirrors normalizeImageUrl() EXACTLY.
 * ───────────────────────────────────────────────────────────── */
"use strict";
export const MEDIA_URL_MAX = 2048;
const EXT       = /\.(?:png|jpe?g|gif)$/i;
const CANDIDATE = /https:\/\/[^\s<>"'`]+/gi;
const CLOSERS   = { ")": "(", "]": "[", "}": "{" };
const WRAPS     = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`" };
const isSp = (c) => c === " " || c === "\t";
export function normalizeImageUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MEDIA_URL_MAX) return null;
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!EXT.test(u.pathname)) return null;
  return u.href;
}
function count(s, ch) { let n = 0; for (const c of s) if (c === ch) n++; return n; }
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
/* terminated = the raw token is followed by something (whitespace), i.e. the
   user has finished typing it. Pasted text is extracted regardless. */
export function findImageUrls(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(CANDIDATE)) {
    const tok = trimTrailing(m[0]);
    const url = normalizeImageUrl(tok);
    if (url) out.push({
      url, start: m.index, end: m.index + tok.length,
      terminated: m.index + m[0].length < text.length,
    });
  }
  return out;
}
/* what to remove so the remaining text reads naturally:
     "image URL with"   → "image with"      (trailing space removed, trail=" ")
     "URL lol"          → "lol"
     "line\nURL\nmore"  → "line\nmore"      (trail="\n")
     "see URL, funny"   → "see, funny"      (leading space removed, lead=" ")
     "look (URL) lol"   → "look lol"        (wrapper goes into the chunk)      */
export function cutImageUrl(text, hit) {
  let s = hit.start, e = hit.end, lead = "", trail = "";
  const close = WRAPS[text[s - 1]];
  if (close && text[e] === close) { s--; e++; }
  const chunk = text.slice(s, e);
  const L = text[s - 1], R = text[e];
  if (isSp(R) && (L === undefined || isSp(L) || L === "\n"))       { trail = R; e++; }
  else if (R === "\n" && (L === undefined || L === "\n"))          { trail = R; e++; }
  else if (isSp(L) && R !== undefined && /[.,!?;:]/.test(R))       { lead = L;  s--; }
  return { start: s, end: e, chunk, lead, trail };
}
/* re-add separators only where the CURRENT neighbours need them,
   so text typed since the cut never ends up doubled or glued */
export function restoreChunk(text, at, piece) {
  const L = text[at - 1], R = text[at];
  const before = L === undefined || /\s/.test(L) ? "" : (piece.lead || " ");
  const after  = R === undefined || /[\s.,!?;:)\]}]/.test(R) ? "" : (piece.trail || " ");
  return before + piece.chunk + after;
}