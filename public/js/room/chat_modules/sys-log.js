/* public/js/sys-log.js
 * ─────────────────────────────────────────────────────────────
 * SYSTEM TRANSCRIPT — the persistent receipt log, shown IN the chat pane.
 *
 *  View switch  setSysView(on) / toggleSysView() / isSysView()
 *               #paneChat[data-view="chat"|"sys"]. Both views stay laid out
 *               (visibility, not display) so neither loses its scroll position.
 *               hooks.onViewChange(view) lets chat.js lock/unlock the composer.
 *  Left tools   members/mods → a plain "Sys" toggle
 *               host         → an upward-expanding menu holding Sys + Clear chat
 *               setToolsMode(isAdmin) moves the ONE Sys button between the two.
 *  Data         GET /api/rooms/:id/events (before/after cursors) + live 'sys-event'.
 *               First page loads the first time the view is opened. Events that
 *               land mid-fetch are buffered; inserts are de-duplicated and kept in
 *               ObjectId order; reconnects fetch only what was missed.
 *  Attention    none, on purpose — no badge, no unread, aria-live="off".
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { roomId } from "../config.js";
import { $ } from "../dom.js";
import { esc, fmtMsgFull, isMe, delay } from "../utils.js";
import { getSocket } from "../socket-ref.js";
import { onConnect, onRoomState } from "../socket-core.js";
const PAGE = 30;
const KIND_LABEL = {
  presence: "Presence", chat: "Chat", queue: "Queue", playback: "Playback",
  perm: "Permissions", room: "Room", voice: "Voice", other: "System",
};
const Log = {
  gen: 0, loaded: false, loading: false, loadingOlder: false,
  hasMore: false, oldestId: null, newestId: null,
  stick: true, startShown: false,
  ids: new Set(), buffer: [],
};
const view = { sys: false };
let hooks = { onViewChange() {}, onToolsClose() {} };
let U = null, wired = false;
function refs() {
  return U || (U = {
    pane:     $("paneChat"),
    chatWrap: document.querySelector("#paneChat .chat-scroll-wrap"),
    wrap:     $("sysLogWrap"),
    log:      $("sysLog"),
    tools:    $("chatTools"),
    toggle:   $("sysToggle"),
    trigger:  $("chatToolsTrigger"),
    menu:     $("chatToolsMenu"),
    clear:    $("chatClearBtn"),
  });
}
/* ── scroll helpers ── */
const atBottom = (slack = 60) => {
  const l = refs().log;
  return l.scrollHeight - l.scrollTop - l.clientHeight <= slack;
};
const toEnd = () => { const l = refs().log; l.scrollTop = l.scrollHeight; };
/* ── formatting ── */
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayKey = (d) => d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
function dayLabel(d) {
  const now = new Date();
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((a - b) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}
/* "{actor} removed {target} as moderator" → <b>You</b> removed <b>bob</b> as moderator.
   Single pass, so a name/title containing "{actor}" is never re-expanded. */
function eventHTML(ev) {
  return esc(ev.text || "").replace(/\{(actor|target|detail)\}/g, (_, key, off) => {
    if (key === "detail")
      return ev.detail ? '<span class="sl-detail">' + esc(ev.detail) + "</span>" : "";
    const id   = key === "actor" ? ev.actorId   : ev.targetId;
    const name = key === "actor" ? ev.actorName : ev.targetName;
    const label = id && isMe(id) ? (off === 0 ? "You" : "you")
                                 : esc(name || (key === "actor" ? "Someone" : "someone"));
    return '<b class="sl-who">' + label + "</b>";
  });
}
function rowEl(ev) {
  const at   = new Date(ev.at || Date.now());
  const kind = KIND_LABEL[ev.kind] ? ev.kind : "other";
  const el = document.createElement("div");
  el.className   = "sl-row";
  el.dataset.id  = ev.id;
  el.dataset.kind = kind;
  el.dataset.day = dayKey(at);
  el.dataset.ts  = String(at.getTime());
  el.innerHTML =
    '<time class="sl-time" datetime="' + at.toISOString() + '" title="' + esc(fmtMsgFull(at)) + '">' +
      esc(timeFmt.format(at)) + "</time>" +
    '<span class="sl-dot" title="' + KIND_LABEL[kind] + '" aria-hidden="true"></span>' +
    '<span class="sl-text">' + eventHTML(ev) + "</span>";
  return el;
}
/* sticky day pills between days — rebuilt after every insert (cheap at log sizes) */
function regroupLog() {
  const log = refs().log;
  log.querySelectorAll(".sl-day").forEach((d) => d.remove());
  let prev = null;
  for (const row of Array.from(log.children)) {
    if (!row.classList.contains("sl-row")) continue;
    if (row.dataset.day === prev) continue;
    prev = row.dataset.day;
    const d = document.createElement("div");
    d.className = "sl-day";
    d.innerHTML = "<span>" + esc(dayLabel(new Date(+row.dataset.ts))) + "</span>";
    log.insertBefore(d, row);
  }
}
/* ── bookkeeping / DOM inserts ── */
function track(ev) {
  if (!ev || !ev.id || Log.ids.has(ev.id)) return null;
  Log.ids.add(ev.id);
  if (!Log.oldestId || ev.id < Log.oldestId) Log.oldestId = ev.id;   // 24-hex: string order == id order
  if (!Log.newestId || ev.id > Log.newestId) Log.newestId = ev.id;
  return rowEl(ev);
}
/* normally appends; slots in earlier if an event arrives out of order */
function placeRow(ev) {
  const el = track(ev);
  if (!el) return false;
  const log = refs().log;
  let ref = null;
  for (let n = log.lastElementChild; n; n = n.previousElementSibling) {
    if (!n.classList.contains("sl-row")) continue;
    if (n.dataset.id < ev.id) break;
    ref = n;
  }
  log.insertBefore(el, ref);
  return true;
}
function insertLive(ev) {
  const stick = atBottom();
  if (!placeRow(ev)) return;
  regroupLog();
  if (stick) toEnd();
}
function showLoader() {
  const log = refs().log;
  if (log.querySelector(".sl-loader")) return;
  const el = document.createElement("div");
  el.className = "sl-loader";
  el.innerHTML = '<span class="chat-spinner"></span><span>Loading activity…</span>';
  log.insertBefore(el, log.firstChild);
}
function hideLoader() { const el = refs().log.querySelector(".sl-loader"); if (el) el.remove(); }
function markStart() {
  if (Log.startShown) return;
  Log.startShown = true;
  const el = document.createElement("div");
  el.className = "sl-start";
  el.textContent = "Start of the room's activity log";
  refs().log.insertBefore(el, refs().log.firstChild);
}
function showError() {
  const log = refs().log;
  if (log.querySelector(".sl-error")) return;
  const el = document.createElement("div");
  el.className = "sl-error";
  el.innerHTML = "Couldn't load the transcript. <button type=\"button\" data-sl-retry>Retry</button>";
  log.insertBefore(el, log.firstChild);
}
function resetLog() {
  Log.gen++;
  refs().log.replaceChildren();
  Object.assign(Log, {
    loaded: false, loading: false, loadingOlder: false, hasMore: false,
    oldestId: null, newestId: null, startShown: false, stick: true,
  });
  Log.ids.clear();
  Log.buffer.length = 0;
}
/* ── network ── */
async function getPage(params) {
  const r = await fetch("/api/rooms/" + roomId + "/events?" + new URLSearchParams(params),
                        { credentials: "include" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
export async function preloadSysLog() { return loadInitial(); }
async function loadInitial() {
  if (Log.loaded || Log.loading) return;
  const gen = ++Log.gen;
  Log.loading = true;
  showLoader();
  try {
    const d = await getPage({ limit: PAGE });
    if (gen !== Log.gen) return;
    hideLoader();
    Log.hasMore = !!d.hasMore;
    const frag = document.createDocumentFragment();
    for (const ev of d.events || []) { const el = track(ev); if (el) frag.appendChild(el); }
    refs().log.appendChild(frag);
    Log.loaded = true;
    for (const ev of Log.buffer.splice(0)) placeRow(ev);     // landed while we were fetching
    regroupLog();
    if (!Log.hasMore) markStart();
    Log.stick = true;
    toEnd();
  } catch (_) {
    if (gen !== Log.gen) return;
    hideLoader();
    showError();
  } finally {
    if (gen === Log.gen) Log.loading = false;
  }
}
async function loadOlder() {
  if (!Log.loaded || Log.loadingOlder || !Log.hasMore || !Log.oldestId) return;
  const gen = Log.gen;
  Log.loadingOlder = true;
  const log = refs().log;
  showLoader();
  try {
    const [d] = await Promise.all([getPage({ limit: PAGE, before: Log.oldestId }), delay(400)]);
    if (gen !== Log.gen) return;
    hideLoader();
    Log.hasMore = !!d.hasMore;
    const frag = document.createDocumentFragment();
    for (const ev of d.events || []) { const el = track(ev); if (el) frag.appendChild(el); }
    const keep = log.scrollHeight - log.scrollTop;           // distance from the bottom
    log.insertBefore(frag, log.firstChild);
    regroupLog();
    log.scrollTop = log.scrollHeight - keep;                  // reading position unchanged
    if (!Log.hasMore) markStart();
  } catch (_) {
    if (gen === Log.gen) hideLoader();
  } finally {
    if (gen === Log.gen) Log.loadingOlder = false;
  }
}
/* reconnect: fetch only what we missed; if that's a lot, start over */
async function catchUp() {
  if (!Log.loaded) return;
  if (!Log.newestId) { resetLog(); if (view.sys) loadInitial(); return; }
  try {
    const d = await getPage({ limit: 100, after: Log.newestId });
    if (d.hasMore) { resetLog(); if (view.sys) loadInitial(); return; }
    (d.events || []).forEach(insertLive);
  } catch (_) { /* next reconnect will try again */ }
}
function onSysEvent(ev) {
  if (Log.loaded) insertLive(ev);
  else if (Log.loading) Log.buffer.push(ev);
  /* not loaded yet → the first fetch will include it */
}
function onLogScroll() {
  Log.stick = atBottom();
  if (refs().log.scrollTop <= 40) loadOlder();
}
/* ── view switch ── */
export const isSysView = () => view.sys;
export function setSysView(on) {
  on = !!on;
  if (on === view.sys) return;
  const u = refs();
  view.sys = on;
  u.pane.dataset.view = on ? "sys" : "chat";
  u.toggle.setAttribute("aria-pressed", String(on));
  u.toggle.classList.toggle("active", on);
  u.trigger.classList.toggle("sys-on", on);
  u.wrap.inert = !on;
  u.wrap.setAttribute("aria-hidden", String(!on));
  if (u.chatWrap) { u.chatWrap.inert = on; u.chatWrap.setAttribute("aria-hidden", String(on)); }
  hooks.onViewChange(on ? "sys" : "chat");
  if (on) {
    if (Log.loaded) regroupLog();                 // "Today" may have become "Yesterday"
    else loadInitial();
    requestAnimationFrame(() => { if (Log.stick) toEnd(); });
  }
}
export function toggleSysView() { setSysView(!view.sys); }
/* the chat TAB was re-shown (display:none drops scroll offsets) */
export function onSysPaneShown() {
  if (view.sys && Log.stick) requestAnimationFrame(toEnd);
}
/* ── host tools menu ── */
function openTools() {
  const u = refs();
  u.menu.hidden = false;
  u.tools.classList.add("open");
  u.trigger.setAttribute("aria-expanded", "true");
}
export function closeChatTools() {
  const u = refs();
  if (!u.menu || u.menu.hidden) return;
  u.menu.hidden = true;
  u.tools.classList.remove("open");
  u.trigger.setAttribute("aria-expanded", "false");
  hooks.onToolsClose();
}
/* host → trigger + menu (Sys inside); everyone else → plain Sys toggle */
export function setToolsMode(isAdmin) {
  const u = refs();
  if (!u.tools || !u.toggle) return;
  isAdmin = !!isAdmin;
  u.tools.dataset.mode = isAdmin ? "host" : "member";
  u.trigger.hidden = !isAdmin;
  if (u.clear) u.clear.hidden = !isAdmin;
  if (isAdmin) {
    if (u.toggle.parentElement !== u.menu) u.menu.appendChild(u.toggle);     // below the trash
  } else {
    closeChatTools();
    if (u.toggle.parentElement !== u.tools) u.tools.insertBefore(u.toggle, u.tools.firstChild);
  }
}
export function wireSysLog(opts = {}) {
  if (wired) return;
  wired = true;
  hooks = { ...hooks, ...opts };
  const u = refs();
  u.toggle.addEventListener("click", () => { toggleSysView(); closeChatTools(); });
  u.trigger.addEventListener("click", () => (u.menu.hidden ? openTools() : closeChatTools()));
  document.addEventListener("pointerdown", (e) => {
    if (!u.menu.hidden && !u.tools.contains(e.target)) closeChatTools();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !u.menu.hidden) { closeChatTools(); u.trigger.focus(); }
  });
  u.log.addEventListener("scroll", onLogScroll, { passive: true });
  u.log.addEventListener("click", (e) => {
    const retry = e.target.closest("[data-sl-retry]");
    if (!retry) return;
    retry.closest(".sl-error").remove();
    loadInitial();
  });
  window.addEventListener("resize", () => { if (view.sys && Log.stick) toEnd(); });
}
/* ── network wiring ── */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;
  sockWired = true;
  getSocket().on("sys-event", onSysEvent);
});
/* don't return the promise — never hold up room-state for the transcript */
onRoomState(() => { catchUp(); }, 25);