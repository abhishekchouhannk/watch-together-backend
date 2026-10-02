/* public/js/room/identity.js
 * ─────────────────────────────────────────────────────────────
 * IDENTITY STORE — the one place that knows what a user looks like NOW.
 *
 *  store     userId → { username, avatar, avatarStill, bio?, rev }
 *            Fed by /api/users/me, /api/users/:id, the batched
 *            /api/users/lookup and the 'user-profile-updated' socket
 *            event. `rev` (server updatedAt) makes every write order-
 *            independent: an older response never overwrites newer data.
 *
 *  avatarHTML({ uid, name, cls, tag, attrs, animate, src })
 *            The ONLY avatar renderer. Generated initial underneath,
 *            optional <img> on top. Elements carry data-av-uid, so later
 *            changes repaint them IN PLACE (listeners, classes and data-*
 *            on the host element survive). animate:false (default) uses
 *            the still frame of animated avatars — chat, people lists;
 *            animate:true → profile card, header chip.
 *            `src:{avatar,avatarStill}` renders a detached preview (no uid
 *            binding) — used by the settings hero.
 *
 *  [data-name-uid]   any element whose textContent is a username; renames
 *            are patched in place everywhere.
 *
 *  ensureIdentities(ids)  queue unknown ids; one batched request per tick
 *  onIdentity(fn)         fn(uid, record, changed) after every accepted merge
 *  nameOf(uid, fallback)  live username, or the fallback from the payload
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { esc, avColor, safeHttpUrl } from "../utils.js";
import { getSocket } from "../socket-ref.js";
import { onConnect } from "../socket-core.js";
const OID = /^[0-9a-f]{24}$/i;
const LOOKUP_MAX = 100;
const FIELDS = ["username", "avatar", "avatarStill", "bio"];
const store  = new Map();   // uid → record
const subs   = new Set();
const broken = new Set();   // avatar URLs that failed to load this session
const queued = new Set();   // waiting for the next lookup batch
const asked  = new Set();   // already fetched / in flight / known
let flushT = 0;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const key = (uid) => (uid == null ? "" : String(uid));
const initial = (name) => (Array.from(String(name || "").trim())[0] || "?").toUpperCase();
export const getIdentity = (uid) => store.get(key(uid)) || null;
export function nameOf(uid, fallback) {
  const r = store.get(key(uid));
  return (r && r.username) || fallback || "Unknown";
}
export function onIdentity(fn) { subs.add(fn); return () => subs.delete(fn); }
export function mergeIdentity(uid, data) {
  uid = key(uid);
  if (!uid || !data) return false;
  const cur = store.get(uid) || { rev: 0 };
  const rev = Number(data.rev) || 0;
  if (rev && cur.rev && rev < cur.rev) return false;                // older than what we show
  const next = { ...cur };
  let changed = !store.has(uid);
  for (const f of FIELDS) {
    if (data[f] === undefined) continue;                             // lookup payloads don't carry bio
    const v = f === "bio" ? String(data[f] || "") : (data[f] || null);
    if (next[f] !== v) { next[f] = v; changed = true; }
  }
  const bumped = rev > (cur.rev || 0);
  if (bumped) next.rev = rev;
  store.set(uid, next);
  asked.add(uid);
  if (changed) repaint(uid, next);
  if (changed || bumped) {
    subs.forEach((fn) => { try { fn(uid, next, changed); } catch (e) { console.error("[identity]", e); } });
  }
  return changed;
}
/* ── batched lookup ── */
export function ensureIdentities(uids) {
  for (const u of uids || []) {
    const id = key(u);
    if (OID.test(id) && !asked.has(id)) queued.add(id);
  }
  if (queued.size && !flushT) flushT = setTimeout(flush, 40);
}
async function flush() {
  flushT = 0;
  const batch = [...queued].slice(0, LOOKUP_MAX);
  batch.forEach((id) => { queued.delete(id); asked.add(id); });
  try {
    const r = await fetch("/api/users/lookup?ids=" + batch.join(","), { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    const { users = [] } = await r.json();
    users.forEach((u) => mergeIdentity(u.id, u));
  } catch (_) {
    batch.forEach((id) => asked.delete(id));                         // retry next time someone renders them
  }
  if (queued.size && !flushT) flushT = setTimeout(flush, 40);
}
/* ── rendering ── */
function pickSrc(rec, animate) {
  if (!rec) return null;
  const url = animate && !reduceMotion.matches
    ? (rec.avatar || rec.avatarStill)
    : (rec.avatarStill || rec.avatar);
  const safe = url ? safeHttpUrl(url) : null;
  return safe && !broken.has(safe) ? safe : null;
}
const imgHTML = (url) =>
  '<img class="u-av-img" src="' + esc(url) + '" alt="" loading="lazy" decoding="async" ' +
  'draggable="false" referrerpolicy="no-referrer">';
export function avatarHTML(o = {}) {
  const uid = key(o.uid);
  const bound = uid && o.src === undefined;
  const rec = o.src !== undefined ? o.src : (uid ? store.get(uid) : null);
  const name = (bound && rec && rec.username) || o.name || "";
  const tag = o.tag || "span";
  const url = pickSrc(rec, !!o.animate);
  return "<" + tag + ' class="u-av' + (o.cls ? " " + o.cls : "") + '"' +
    (bound ? ' data-av-uid="' + esc(uid) + '"' : "") +
    (o.animate ? ' data-av-anim="1"' : "") +
    ' data-av-name="' + esc(name) + '"' +
    ' style="background:' + avColor(name) + '"' +
    (o.attrs ? " " + o.attrs : "") + ">" +
    '<span class="u-av-ini" aria-hidden="true">' + esc(initial(name)) + "</span>" +
    (url ? imgHTML(url) : "") +
    "</" + tag + ">";
}
function paint(el, rec) {
  const name = (rec && rec.username) || el.dataset.avName || "";
  el.dataset.avName = name;
  el.style.background = avColor(name);
  const ini = el.querySelector(".u-av-ini");
  if (ini) ini.textContent = initial(name);
  if (el.hasAttribute("data-uname")) {
    el.dataset.uname = name;
    if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", "View profile of " + name);
  }
  const url = pickSrc(rec, el.dataset.avAnim === "1");
  const img = el.querySelector("img.u-av-img");
  if (!url) { if (img) img.remove(); return; }
  if (!img) el.insertAdjacentHTML("beforeend", imgHTML(url));
  else if (img.getAttribute("src") !== url) img.setAttribute("src", url);
}
function repaint(uid, rec) {
  const q = CSS.escape(uid);
  document.querySelectorAll('[data-av-uid="' + q + '"]').forEach((el) => paint(el, rec));
  if (rec.username) {
    document.querySelectorAll('[data-name-uid="' + q + '"]').forEach((el) => {
      if (el.textContent !== rec.username) el.textContent = rec.username;
    });
  }
}
/* one capture-phase listener for every avatar <img> on the page:
   a dead URL falls back to the generated initial and is never retried */
document.addEventListener("error", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement) || !t.classList.contains("u-av-img")) return;
  const src = t.getAttribute("src");
  if (src) broken.add(src);
  t.remove();
}, true);
/* user flips "reduce motion" → animated avatars switch to stills live */
reduceMotion.addEventListener("change", () => {
  document.querySelectorAll("[data-av-uid][data-av-anim]").forEach((el) => paint(el, store.get(el.dataset.avUid)));
});
/* ── network ── */
let connects = 0;
onConnect(() => {
  if (connects++ === 0) {
    getSocket().on("user-profile-updated", (p) => { if (p && p.userId) mergeIdentity(p.userId, p); });
    return;
  }
  // reconnect: we may have missed updates while offline → refetch everyone we show
  const ids = [...store.keys()];
  ids.forEach((id) => asked.delete(id));
  ensureIdentities(ids);
});