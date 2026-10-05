/* public/js/shared/identity.js
 * ─────────────────────────────────────────────────────────────
 * IDENTITY STORE — the one place that knows what a user looks like NOW.
 * Page-agnostic (room + dashboard). No sockets in here.
 *
 *  Fed by   /api/users/me · /api/users/:id · batched /api/users/lookup ·
 *           other tabs (BroadcastChannel "wt:identity") · and, in rooms
 *           only, room/identity-socket.js ('user-profile-updated').
 *           `rev` (server updatedAt) makes every write order-independent.
 *
 *  avatarHTML(opts) / avatarEl(opts)   THE avatar renderer
 *     uid · name · cls · tag · attrs · animate · label · zoom · src
 *  [data-name-uid]          textContent patched on rename, everywhere
 *  ensureIdentities(ids)    batched lookup, one request per tick
 *  resyncIdentities()       refetch everyone shown (reconnect / tab focus)
 *  publishIdentity(uid, u)  push a fresh server copy to the other tabs
 *  onIdentity(fn)           fn(uid, record, changed)
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { esc, avColor, safeHttpUrl } from "./util.js";
import { openLightbox } from "./lightbox.js";
const OID = /^[0-9a-f]{24}$/i;
const LOOKUP_MAX = 100;
const FIELDS = ["username", "avatar", "avatarStill", "avatarFull", "bio"];
const ZOOM_LABEL = "View {name}'s photo";
const store  = new Map();   // uid → record
const subs   = new Set();
const broken = new Set();   // avatar URLs that failed to load this session
const queued = new Set();   // waiting for the next lookup batch
const asked  = new Set();   // fetched / in flight / known
let flushT = 0;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const key = (uid) => (uid == null ? "" : String(uid));
const initial = (name) => (Array.from(String(name || "").trim())[0] || "?").toUpperCase();
const fill = (tpl, name) => String(tpl || "").split("{name}").join(name || "user");
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
/* ── cross-tab (room tab ⇄ dashboard tab), instant, no server round-trip ── */
const bc = typeof BroadcastChannel === "function" ? new BroadcastChannel("wt:identity") : null;
if (bc) {
  bc.onmessage = (e) => {
    const m = e.data;
    if (m && m.uid && m.data) mergeIdentity(m.uid, m.data);          // rev-guarded → no echo loops
  };
}
export function publishIdentity(uid, data) {
  if (!bc || !uid || !data) return;
  const out = { rev: data.rev };
  for (const f of FIELDS) if (data[f] !== undefined) out[f] = data[f];   // public fields only
  try { bc.postMessage({ uid: String(uid), data: out }); } catch (_) {}
}
/* ── batched lookup ── */
export function ensureIdentities(uids) {
  for (const u of uids || []) {
    const id = key(u);
    if (OID.test(id) && !asked.has(id)) queued.add(id);
  }
  if (queued.size && !flushT) flushT = setTimeout(flush, 40);
}
export function resyncIdentities() {
  const ids = [...store.keys()];
  ids.forEach((id) => asked.delete(id));
  ensureIdentities(ids);
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
    batch.forEach((id) => asked.delete(id));                         // retry on the next render
  }
  if (queued.size && !flushT) flushT = setTimeout(flush, 40);
}
/* ── url picking ── */
function pickSrc(rec, animate) {
  if (!rec) return null;
  const url = animate && !reduceMotion.matches
    ? (rec.avatar || rec.avatarStill)
    : (rec.avatarStill || rec.avatar);
  const safe = url ? safeHttpUrl(url) : null;
  return safe && !broken.has(safe) ? safe : null;
}
function fullSrc(rec) {
  const u = rec && (rec.avatarFull || rec.avatar);
  return (u && safeHttpUrl(u)) || null;
}
const imgHTML = (url) =>
  '<img class="u-av-img" src="' + esc(url) + '" alt="" loading="lazy" decoding="async" ' +
  'draggable="false" referrerpolicy="no-referrer">';
/* ── rendering ── */
export function avatarHTML(o = {}) {
  const uid = key(o.uid);
  const bound = !!uid && o.src === undefined;
  const rec = o.src !== undefined ? o.src : (uid ? store.get(uid) : null);
  const name = (bound && rec && rec.username) || o.name || "";
  const tag = o.tag || "span";
  const url = pickSrc(rec, !!o.animate);
  const zoomTpl = o.zoom ? (typeof o.zoom === "string" ? o.zoom : ZOOM_LABEL) : "";
  const full = o.zoom && url ? fullSrc(rec) : null;
  const text = full ? fill(zoomTpl, name) : o.label ? fill(o.label, name) : "";
  let a = ' class="u-av' + (o.cls ? " " + o.cls : "") + (full ? " is-zoomable" : "") + '"';
  if (bound) a += ' data-av-uid="' + esc(uid) + '"';
  if (o.animate) a += ' data-av-anim="1"';
  a += ' data-av-name="' + esc(name) + '" style="background:' + avColor(name) + '"';
  if (o.label) a += ' data-av-label="' + esc(o.label) + '"';
  if (o.zoom) a += ' data-av-zoom="' + esc(zoomTpl) + '"';
  if (full) a += ' data-av-full="' + esc(full) + '" role="button" tabindex="0" aria-label="' + esc(text) + '"';
  else if (o.label && tag === "button") a += ' aria-label="' + esc(text) + '"';
  if (text) a += ' title="' + esc(text) + '"';
  if (o.attrs) a += " " + o.attrs;
  return "<" + tag + a + ">" +
    '<span class="u-av-ini" aria-hidden="true">' + esc(initial(name)) + "</span>" +
    (url ? imgHTML(url) : "") +
    "</" + tag + ">";
}
/** Same thing as a DOM node — for modules that build with createElement. */
export function avatarEl(o) {
  const t = document.createElement("template");
  t.innerHTML = avatarHTML(o);
  return t.content.firstElementChild;
}
function applyLabel(el, name) {
  if (el.dataset.avLabel === undefined || el.classList.contains("is-zoomable")) return;
  const t = fill(el.dataset.avLabel, name);
  el.title = t;
  if (el.tagName === "BUTTON") el.setAttribute("aria-label", t);
}
function setZoom(el, full, name) {
  if (el.dataset.avZoom === undefined) return;
  if (full) {
    const t = fill(el.dataset.avZoom, name);
    el.classList.add("is-zoomable");
    el.dataset.avFull = full;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.title = t;
    el.setAttribute("aria-label", t);
  } else if (el.classList.contains("is-zoomable")) {
    el.classList.remove("is-zoomable");
    delete el.dataset.avFull;
    ["role", "tabindex", "aria-label", "title"].forEach((x) => el.removeAttribute(x));
  }
}
function paint(el, rec) {
  const name = (rec && rec.username) || el.dataset.avName || "";
  el.dataset.avName = name;
  el.style.background = avColor(name);
  const ini = el.querySelector(".u-av-ini");
  if (ini) ini.textContent = initial(name);
  if (el.hasAttribute("data-uname")) {                              // chat / people buttons
    el.dataset.uname = name;
    if (el.hasAttribute("aria-label") && el.dataset.avLabel === undefined) {
      el.setAttribute("aria-label", "View profile of " + name);
    }
  }
  const url = pickSrc(rec, el.dataset.avAnim === "1");
  const img = el.querySelector("img.u-av-img");
  if (!url) { if (img) img.remove(); }
  else if (!img) el.insertAdjacentHTML("beforeend", imgHTML(url));
  else if (img.getAttribute("src") !== url) img.setAttribute("src", url);
  setZoom(el, url ? fullSrc(rec) : null, name);
  applyLabel(el, name);
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
/* broken photo → initial shows through, never retried, stops being zoomable */
document.addEventListener("error", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement) || !t.classList.contains("u-av-img")) return;
  const src = t.getAttribute("src");
  if (src) broken.add(src);
  const host = t.closest(".u-av");
  t.remove();
  if (host) { setZoom(host, null); applyLabel(host, host.dataset.avName); }
}, true);
/* click / Enter / Space on a zoomable avatar → lightbox (capture: modals can't swallow it) */
function openZoom(el) { if (el.dataset.avFull) openLightbox(el.dataset.avFull); }
document.addEventListener("click", (e) => {
  const el = e.target.closest && e.target.closest(".u-av.is-zoomable");
  if (!el || e.button !== 0) return;
  e.preventDefault();
  openZoom(el);
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target;
  if (!(el instanceof Element) || !el.matches(".u-av.is-zoomable")) return;
  e.preventDefault();
  e.stopPropagation();
  openZoom(el);
}, true);
/* "reduce motion" flipped → animated avatars switch to stills live */
reduceMotion.addEventListener("change", () => {
  document.querySelectorAll("[data-av-uid][data-av-anim]").forEach((el) => paint(el, store.get(el.dataset.avUid)));
});