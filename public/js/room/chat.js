/* public/js/chat.js
 * ─────────────────────────────────────────────────────────────
 * CHAT LOG + UNREAD BADGES + EPHEMERAL SYSTEM NOTICES.
 *
 * Three cooperating pieces, all previously inline in room.js:
 *
 *  1. Message log
 *     buildMsgEl(msg)        one .chat-msg row (avatar button carries
 *                            data-uid/data-uname for the profile card; the
 *                            click delegate for it still lives in the
 *                            permissions/profile code)
 *     appendMessage(msg,auto)  new live message; measures stickiness BEFORE
 *                            inserting so the log only auto-scrolls when the
 *                            user was already at the bottom
 *     addSystemMsg(text,opts)  grey .chat-sys line; opts.silent = "I did this",
 *                            opts.persist = never auto-expire, opts.ttl,
 *                            opts.cls; returns the element
 *     regroupChat()          re-applies .grouped to consecutive same-sender
 *                            messages inside GROUP_WINDOW
 *     loadInitialMessages()  first 20 via REST, then scroll to bottom
 *     onChatScroll()         infinite scroll upward + Unread/SYS bookkeeping
 *     showTopLoader/hideTopLoader/markStartReached
 *     sendMessage()          emits 'chat-message', clears the input
 *
 *  2. Unread  — the unread counter shared by the Chat tab badge, the
 *     "jump to latest" pill and document.title.
 *       .n      unread count      .stick  should the log snap to bottom when shown
 *       note()  register a new line (returns true if the user should be nudged)
 *       drop()  give a point back when an unseen notice expires
 *       sync()/clear()/jump()/onChatShown()/onScroll()/paint()
 *
 *  3. SYS  — self-destructing system notices so the log stays readable.
 *     Expiry order == insertion order; invisible notices are yanked instantly,
 *     visible ones get at most one animated collapse at a time, never while
 *     the user is actively scrolling (SCROLL_HOLD).
 *
 * Module-private state (was module-scope `let`s in room.js):
 *     oldestMsgId, hasMoreMsgs, loadingOlder, startMarkerShown
 *
 * Network: subscribes to the centralized hooks (onRoomState / onUserJoined /
 * onUserLeft) and attaches its own domain listeners ('chat-message',
 * 'chat-system') on first connect. socket-core NEVER imports this file.
 *
 * DOM: dom.chatMsgs, dom.chatInput, dom.chatUnread, dom.chatJump,
 *      dom.chatJumpN, dom.tabChat, dom.paneChat
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { roomId, GROUP_WINDOW } from "./config.js";
import { S } from "./state.js";
import { $, dom } from "./dom.js";
import { esc, fmtMsgTs, avColor, fmtBadge, isMe, delay } from "./utils.js";
import { getSocket, emit as sockEmit } from "./socket-ref.js";
import { onConnect, onRoomState, onUserJoined, onUserLeft } from "./socket-core.js";
/* ── history pagination bookkeeping ── */
let startMarkerShown = false;
let oldestMsgId = null, hasMoreMsgs = false, loadingOlder = false;
/* ══════════════════════════════════════
   SIDE-PANEL BADGES (unread chat/room updates)
   ══════════════════════════════════════ */
export const Unread = {
  n: 0,
  stick: true,            // should the log snap to the bottom next time it's shown?
  _title: document.title,
  _raf: 0,
  chatOnScreen() { return dom.paneChat.classList.contains("active"); },
  atBottom(slack) {
    const el = dom.chatMsgs;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= (slack == null ? 120 : slack);
  },
  /* "the user is demonstrably looking at the newest line" */
  watching() { return !document.hidden && this.chatOnScreen() && this.atBottom(); },
  toEnd() { dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight; },
  /* ── called for every NEW line appended to the log (never for history) ── */
  note(opts) {
    opts = opts || {};
    if (opts.stick !== undefined) this.stick = !!opts.stick;
    if (opts.silent) return false;                 // my own message / my own action
    if (this.watching()) return false;             // already on screen at the bottom
    this.n++;
    this.paint();
    return true;                                     // user should be notified
  },
  /* an unseen notice expired → give the badge its point back */
  drop(k) {
    if (!this.n) return;
    this.n = Math.max(0, this.n - (k || 1));
    this.paint();
  },
  /* once the user has seen everything, no element may claim "unread" later */
  _forget() {
    dom.chatMsgs.querySelectorAll("[data-unread]").forEach((el) => delete el.dataset.unread);
  },
  clear() { this.n = 0; this._forget(); this.paint(); },
  sync()  { if (this.watching()) { this.n = 0; this._forget(); } this.paint(); },
  /* chat pane just became visible */
  onChatShown() {
    if (this.stick) this.toEnd();            // content added while display:none loses scrollTop
    this.sync();
  },
  onScroll() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this.chatOnScreen()) this.stick = this.atBottom();
      this.sync();
    });
  },
  jump() { this.toEnd(); this.clear(); },
  paint() {
    const n = this.n, label = fmtBadge(n);
    dom.chatUnread.hidden      = n === 0;
    dom.chatUnread.textContent = label;
    dom.chatUnread.title       = n === 1 ? "1 new update" : n + " new updates";
    dom.tabChat.classList.toggle("has-unread", n > 0);
    dom.tabChat.setAttribute("aria-label", n ? "Chat, " + label + " new updates" : "Chat");
    /* pill only makes sense while the chat is on screen but scrolled away */
    const showPill = n > 0 && this.chatOnScreen() && !this.atBottom();
    dom.chatJump.hidden = !showPill;
    dom.chatJumpN.textContent = label;
    document.title = n > 0 ? "(" + label + ") " + this._title : this._title;
  },
};
/* ══════════════════════════════════════
   EPHEMERAL SYSTEM LOG — notices self-destruct so chat stays readable
   ══════════════════════════════════════ */
export const SYS = {
  TTL:      5 * 1000,  // lifetime of a notice
  GAP:      1000,           // min *stillness* between two animated removals
  OUT_MS:   560,            // must be ≥ the CSS exit duration (500ms) + slack
  SCROLL_HOLD: 1200,        // never animate right after the user scrolled
  MAX_LIVE: 15,             // burst guard: pull in expiry when notices pile up
  EARLY:    8000,
  items: [],                // [{el, exp}] — insertion order == expiry order
  timer: 0, lastOut: 0, holdUntil: 0, animating: false,
  /* ── register a notice ── */
  track(el, ttl) {
    this.items.push({ el, exp: Date.now() + (ttl || this.TTL) });
    this.trim();
    this.schedule();
  },
  /* a wall of notices shouldn't sit around for the full 5 min */
  trim() {
    const over = this.items.length - this.MAX_LIVE;
    if (over <= 0) return;
    const soon = Date.now() + this.EARLY;
    for (let i = 0; i < over; i++)
      if (this.items[i].exp > soon) this.items[i].exp = soon;
  },
  hold(ms) { this.holdUntil = Math.max(this.holdUntil, Date.now() + ms); },
  schedule() {
    clearTimeout(this.timer); this.timer = 0;
    if (this.animating || !this.items.length) return;
    this.timer = setTimeout(() => this.sweep(), Math.max(this.items[0].exp - Date.now(), 50));
  },
  sweep() {
    clearTimeout(this.timer); this.timer = 0;
    if (this.animating) return;                       // the callback re-arms us
    const now = Date.now();
    let pending = null;
    /* everything the user can't see goes instantly & silently */
    while (this.items.length) {
      const it = this.items[0];
      if (!it.el.isConnected) { this.items.shift(); continue; }
      if (it.exp > now) break;                        // ordered ⇒ nothing else is due
      if (this.visible(it.el)) { pending = it; break; }
      this.items.shift();
      this.yank(it.el);
    }
    /* at most ONE animated removal, and only when the view is calm */
    if (pending) {
      const wait = Math.max(this.GAP - (now - this.lastOut), this.holdUntil - now);
      if (wait > 0) { this.timer = setTimeout(() => this.sweep(), wait); return; }
      this.items.shift();
      this.animating = true;
      this.fade(pending.el, () => {
        this.animating = false;
        this.lastOut  = Date.now();                   // 2s of stillness AFTER the collapse
        this.schedule();
      });
      return;
    }
    this.schedule();
  },
  /* is this notice actually on screen *and* being looked at? */
  visible(el) {
    if (document.hidden) return false;
    if (!dom.paneChat.classList.contains("active")) return false;
    const c = dom.chatMsgs;
    if (!c.clientHeight || !el.offsetParent) return false;   // display:none ⇒ not rendered
    const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    return r.bottom > cr.top + 4 && r.top < cr.bottom - 4;
  },
  /* instant removal, scroll-stable, badge-accurate */
  yank(el) {
    const c = dom.chatMsgs;
    const shown  = dom.paneChat.classList.contains("active") && c.clientHeight > 0;
    const above  = shown && el.getBoundingClientRect().bottom <= c.getBoundingClientRect().top;
    const before = shown ? c.scrollHeight : 0;
    const top    = c.scrollTop;
    this.uncount(el);
    el.remove();
    if (above) {                                      // content above the viewport vanished →
      const delta = before - c.scrollHeight;          // pull scrollTop back by exactly that much
      if (delta > 0) c.scrollTop = Math.max(0, top - delta);
    }
  },
  /* animated removal: fade, then collapse the gap */
  fade(el, done) {
    const c = dom.chatMsgs;
    const pinned = Unread.atBottom(8);
    el.style.height   = el.offsetHeight + "px";       // height:auto can't transition
    el.style.overflow = "hidden";
    void el.offsetHeight;                             // commit the start height
    el.classList.add("sys-out");
    el.style.height   = "0px";                        // …now the delayed collapse runs
    /* hold the bottom while the gap closes so the log never "drops" */
    let stop = false;
    if (pinned) {
      const keep = () => { if (stop) return; c.scrollTop = c.scrollHeight; requestAnimationFrame(keep); };
      requestAnimationFrame(keep);
    }
    setTimeout(() => {
      stop = true;
      this.uncount(el);
      el.remove();
      if (pinned) c.scrollTop = c.scrollHeight;
      done && done();
    }, this.OUT_MS);
  },
  /* a notice that dies unseen must not leave a ghost on the tab badge */
  uncount(el) {
    if (el.dataset.unread === "1") { delete el.dataset.unread; Unread.drop(1); }
  },
};
/* ═══════ CHAT ═══════ */
export function sendMessage() {
  const text = dom.chatInput.value.trim();
  if (!text || !getSocket()) return;
  sockEmit("chat-message", { text });
  dom.chatInput.value = "";
  dom.chatInput.focus();
  Unread.stick = true;
  Unread.clear();
}
export async function loadInitialMessages() {
  try {
    const r = await fetch("/api/rooms/" + roomId + "/messages?limit=20", { credentials: "include" });
    if (!r.ok) return;
    const d = await r.json();
    hasMoreMsgs = d.hasMore;
    oldestMsgId = d.messages.length ? d.messages[0].id : null;
    const frag = document.createDocumentFragment();
    d.messages.forEach((m) => frag.appendChild(buildMsgEl(m)));
    dom.chatMsgs.appendChild(frag);
    regroupChat();
    dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight;
    if (!hasMoreMsgs) markStartReached();
  } catch (_) {}
}
export async function onChatScroll() {
  Unread.onScroll();
  SYS.hold(SYS.SCROLL_HOLD);            // ← never collapse under a moving finger
  if (dom.chatMsgs.scrollTop > 40 || !hasMoreMsgs || loadingOlder || !oldestMsgId) return;
  loadingOlder = true;
  const prev = dom.chatMsgs.scrollHeight;
  showTopLoader();
  try {
    const fp = fetch("/api/rooms/" + roomId + "/messages?limit=20&before=" + oldestMsgId, { credentials: "include" }).then((r) => r.json());
    const d = (await Promise.all([fp, delay(450)]))[0];
    hasMoreMsgs = d.hasMore;
    hideTopLoader();
    if (d.messages.length) {
      oldestMsgId = d.messages[0].id;
      const frag = document.createDocumentFragment();
      d.messages.forEach((m) => frag.appendChild(buildMsgEl(m)));
      dom.chatMsgs.insertBefore(frag, dom.chatMsgs.firstChild);
      regroupChat();
      dom.chatMsgs.scrollTop = dom.chatMsgs.scrollHeight - prev;
    }
    if (!hasMoreMsgs) markStartReached();
  } catch (_) { hideTopLoader(); }
  loadingOlder = false;
}
/* who can act on a message, from the viewer's seat */
function msgPerms(msg) {
  const mine = isMe(msg.senderId);
  return {
    mine,
    canEdit:   mine && !msg.deleted,
    canDelete: !msg.deleted && (mine || !!(S.perms && S.perms.canManage)),
  };
}
function deletedByText(msg) {
  const role = msg.deletedByRole, name = msg.deletedByName;
  if (!role || role === "self") return "";
  return " by " + esc(name || (role === "admin" ? "the host" : "a moderator"));
}
function msgBubbleHTML(msg) {
  if (msg.deleted)
    return '<div class="msg-text msg-deleted">Message deleted' + deletedByText(msg) + "</div>";
  return '<div class="msg-text">' + esc(msg.text) +
    (msg.editedAt
      ? ' <span class="msg-edited" title="' + esc("Edited " + fmtMsgTs(msg.editedAt)) + '">(edited)</span>'
      : "") +
    "</div>";
}
/* idempotent — (re)build the ⋯ trigger for the current viewer/role */
function decorateActions(div, msg) {
  const old = div.querySelector(".msg-actions");
  if (old) old.remove();
  const p = msgPerms(msg);
  if (!p.canEdit && !p.canDelete) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-actions";
  btn.dataset.act = "menu";
  btn.title = "Message actions";
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-label", "Message actions");
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
    '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  div.appendChild(btn);
}
/* reconstruct a minimal msg object from a rendered row */
function readMsg(el) {
  return {
    id:            el.dataset.id,
    senderId:      el.dataset.senderId || null,
    deleted:       el.classList.contains("deleted"),
    editedAt:      el.dataset.edited ? 1 : null,
    deletedByRole: el.dataset.delRole || null,
    deletedByName: el.dataset.delName || null,
  };
}
export function buildMsgEl(msg) {
  const self = msg.senderId && S.userId && msg.senderId.toString() === S.userId;
  const c = avColor(msg.username), ini = (msg.username || "?")[0].toUpperCase();
  const uid = msg.senderId ? msg.senderId.toString() : "";
  const div = document.createElement("div");
  div.className = "chat-msg" + (self ? " self" : "") + (msg.deleted ? " deleted" : "");
  div.dataset.sender   = msg.senderId || msg.username;
  div.dataset.senderId = uid;
  div.dataset.id       = msg.id || "";
  div.dataset.ts       = new Date(msg.timestamp || Date.now()).getTime();
  if (msg.editedAt)      div.dataset.edited  = "1";
  if (msg.deletedByRole) div.dataset.delRole = msg.deletedByRole;
  if (msg.deletedByName) div.dataset.delName = msg.deletedByName;
  const av = uid
    ? '<button type="button" class="msg-av" style="background:' + c + '" ' +
        'data-uid="' + esc(uid) + '" data-uname="' + esc(msg.username || "") + '" ' +
        'title="View profile" aria-label="View profile of ' + esc(msg.username || "user") + '">' +
        ini + "</button>"
    : '<div class="msg-av" style="background:' + c + '">' + ini + "</div>";
  div.innerHTML =
    av +
    '<div class="msg-body">' +
      '<div class="msg-head">' +
        '<span class="msg-name' + (self ? " self" : "") + '">' + esc(msg.username) + "</span>" +
        '<span class="msg-ts">' + fmtMsgTs(msg.timestamp) + "</span>" +
      "</div>" +
      msgBubbleHTML(msg) +
    "</div>";
  decorateActions(div, msg);
  return div;
}
export function appendMessage(msg, auto) {
  const self = isMe(msg.senderId);
  const stick = self || Unread.atBottom();          // measure BEFORE inserting
  dom.chatMsgs.appendChild(buildMsgEl(msg));
  regroupChat();
  if (auto && stick) Unread.toEnd();
  Unread.note({ silent: self, stick });
}
/* opts.silent → this line describes something *I* just did */
export function addSystemMsg(text, opts) {
  opts = opts || {};
  const stick = Unread.atBottom();
  const div = document.createElement("div");
  div.className = "chat-sys" + (opts.cls ? " " + opts.cls : "");
  div.textContent = text;
  dom.chatMsgs.appendChild(div);
  if (stick) Unread.toEnd();
  if (Unread.note({ silent: !!opts.silent, stick })) div.dataset.unread = "1";
  if (!opts.persist) SYS.track(div, opts.ttl);        // ← auto-expires
  return div;
}
// Marks consecutive same-sender messages as grouped
export function regroupChat() {
  let prev = null;
  Array.from(dom.chatMsgs.children).forEach((el) => {
    if (!el.classList.contains("chat-msg")) { prev = null; return; } // sys msgs / loaders break grouping
    const sender = el.dataset.sender, ts = parseInt(el.dataset.ts, 10);
    const grouped = prev && prev.sender === sender && !isNaN(ts) && (ts - prev.ts) < GROUP_WINDOW;
    el.classList.toggle("grouped", grouped);
    prev = { sender, ts };
  });
}
// "Loading earlier messages…" loader at the top of the chat
export function showTopLoader() {
  if (dom.chatMsgs.querySelector(".chat-loader")) return;
  const el = document.createElement("div");
  el.className = "chat-loader";
  el.innerHTML = '<span class="chat-spinner"></span><span>Loading earlier messages…</span>';
  dom.chatMsgs.insertBefore(el, dom.chatMsgs.firstChild);
}
export function hideTopLoader() { const el = dom.chatMsgs.querySelector(".chat-loader"); if (el) el.remove(); }
export function markStartReached() {
  if (startMarkerShown) return;
  startMarkerShown = true;
  const el = document.createElement("div");
  el.className = "chat-start";
  el.textContent = "✨ This is the beginning of the conversation";
  dom.chatMsgs.insertBefore(el, dom.chatMsgs.firstChild);
}
/*
   New delete/edit chat messages functionality and helper functions
*/
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}
function rowById(id) {
  return id ? dom.chatMsgs.querySelector('.chat-msg[data-id="' + cssEsc(id) + '"]') : null;
}
function liveText(el) {
  const t = el.querySelector(".msg-text");
  if (!t) return "";
  const clone = t.cloneNode(true);
  const tag = clone.querySelector(".msg-edited");
  if (tag) tag.remove();
  return clone.textContent.trim();
}
function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
}
function enterEdit(el) {
  if (!el || el.classList.contains("editing") || el.classList.contains("deleted")) return;
  const textEl = el.querySelector(".msg-text");
  if (!textEl) return;
  const current = liveText(el);
  el.classList.add("editing");
  const box = document.createElement("div");
  box.className = "msg-edit";
  box.innerHTML =
    '<textarea class="msg-edit-input" maxlength="500" rows="1"></textarea>' +
    '<div class="msg-edit-actions">' +
      '<button type="button" class="msg-edit-cancel">Cancel</button>' +
      '<button type="button" class="msg-edit-save">Save</button>' +
    "</div>";
  textEl.after(box);
  const ta = box.querySelector("textarea");
  ta.value = current;
  autoGrow(ta);
  ta.focus();
  ta.setSelectionRange(current.length, current.length);
  const cancel = () => exitEdit(el);
  const save = () => {
    const next = ta.value.trim();
    if (next && next !== current && getSocket())
      sockEmit("chat-edit", { id: el.dataset.id, text: next });
    exitEdit(el);                               // server broadcast repaints the bubble
  };
  box.querySelector(".msg-edit-cancel").onclick = cancel;
  box.querySelector(".msg-edit-save").onclick   = save;
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
  });
}
function exitEdit(el) {
  if (!el) return;
  el.classList.remove("editing");
  const box = el.querySelector(".msg-edit");
  if (box) box.remove();
}
const MsgMenu = {
  el: null, forId: null,
  ensure() {
    if (this.el) return this.el;
    const m = document.createElement("div");
    m.className = "msg-menu";
    m.hidden = true;
    document.body.appendChild(m);
    this.el = m;
    return m;
  },
  open(anchor, row) {
    const id = row.dataset.id;
    if (!id) return;
    if (this.forId === id && !this.el.hidden) { this.close(); return; }
    const p = msgPerms(readMsg(row));
    let html = "";
    if (p.canEdit)   html += '<button type="button" class="msg-menu-item" data-act="edit">Edit</button>';
    if (p.canDelete) html +=
      '<button type="button" class="msg-menu-item danger" data-act="del">Delete</button>' +
      '<div class="msg-menu-confirm" data-confirm hidden>' +
        "<span>Delete this message?</span>" +
        '<button type="button" class="msg-menu-item danger" data-act="del-yes">Yes, delete</button>' +
        '<button type="button" class="msg-menu-item" data-act="del-no">Cancel</button>' +
      "</div>";
    if (!html) return;
    const m = this.ensure();
    m.innerHTML = html;
    m.hidden = false;
    this.forId = id;
    const r = anchor.getBoundingClientRect();
    let left = r.right - m.offsetWidth;
    let top  = r.bottom + 4;
    if (top + m.offsetHeight > window.innerHeight - 8) top = r.top - m.offsetHeight - 4;
    m.style.left = Math.round(Math.max(8, left)) + "px";
    m.style.top  = Math.round(Math.max(8, top))  + "px";
  },
  confirm(on) {
    if (!this.el) return;
    const del  = this.el.querySelector('[data-act="del"]');
    const conf = this.el.querySelector("[data-confirm]");
    if (del)  del.hidden  = on;
    if (conf) conf.hidden = !on;
  },
  close() {
    if (this.el) { this.el.hidden = true; this.el.innerHTML = ""; }
    this.forId = null;
  },
};

/* 
   Socket events related functions
*/
function applyEdit({ id, text, editedAt }) {
  const el = rowById(id);
  if (!el || el.classList.contains("deleted")) return;
  exitEdit(el);
  el.dataset.edited = "1";
  const textEl = el.querySelector(".msg-text");
  if (textEl)
    textEl.innerHTML = esc(text) +
      ' <span class="msg-edited" title="' + esc("Edited " + fmtMsgTs(editedAt)) + '">(edited)</span>';
}
function applyDelete({ id, byId, byName, byRole }) {
  if (MsgMenu.forId === id) MsgMenu.close();
  const el = rowById(id);
  if (!el) return;
  exitEdit(el);
  el.classList.add("deleted");
  delete el.dataset.edited;
  el.dataset.delRole = byRole || "";
  el.dataset.delName = byName || "";
  const trigger = el.querySelector(".msg-actions");
  if (trigger) trigger.remove();
  const textEl = el.querySelector(".msg-text");
  if (textEl) {
    textEl.className = "msg-text msg-deleted";
    textEl.innerHTML = "Message deleted" +
      deletedByText({ deletedByRole: byRole, deletedByName: byName });
  }
  regroupChat();
}
function applyClear({ byId, byName }) {
  MsgMenu.close();
  dom.chatMsgs.querySelectorAll(".chat-msg, .chat-loader, .chat-start")
    .forEach((el) => el.remove());
  oldestMsgId = null;
  hasMoreMsgs = false;
  loadingOlder = false;
  startMarkerShown = false;
  addSystemMsg((isMe(byId) ? "You" : (byName || "The host")) + " cleared the chat",
               { silent: isMe(byId) });
  markStartReached();
  Unread.toEnd();
}

/* ══════════════════════════════════════
   WIRING — two halves, called from wireEvents() at the ORIGINAL positions
   so document-level listener order is unchanged.
   ══════════════════════════════════════ */
/* the send button / Enter key / log scroll — the early block of wireEvents() */
export function wireChatInput() {
  $("sendBtn").onclick = sendMessage;
  dom.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  dom.chatMsgs.addEventListener("scroll", onChatScroll);
}
/* ── side-panel unread ── — the late block of wireEvents() */
export function wireChatUnread() {
  dom.chatJump.onclick = () => Unread.jump();
  /* the click fires before/after Q.switchTab depending on order — defer a frame so the
     pane's .active class is already settled */
  dom.tabChat.addEventListener("click", () =>
    requestAnimationFrame(() => { Unread.onChatShown(); SYS.sweep(); }));
  document.addEventListener("visibilitychange", () => { Unread.sync(); SYS.sweep(); });
  window.addEventListener("focus", () => Unread.sync());
  Unread.paint();
}
function resetClearBtn() {
  const b = dom.chatClear;
  if (!b) return;
  b.dataset.confirm = "0";
  b.classList.remove("confirm");
  b.title = "Clear chat for everyone";
  clearTimeout(b._t);
}
/* call this again whenever the viewer's role changes (member → mod, etc.) */
export function applyChatPerms() {
  if (dom.chatClear) dom.chatClear.hidden = !(S.perms && S.perms.isAdmin);
  dom.chatMsgs.querySelectorAll(".chat-msg")
    .forEach((el) => decorateActions(el, readMsg(el)));
}
/* message edit/delete + host clear — wired from room-main after wireChatUnread() */
export function wireChatActions() {
  // open the per-message menu
  dom.chatMsgs.addEventListener("click", (e) => {
    const trigger = e.target.closest('.msg-actions[data-act="menu"]');
    if (!trigger) return;
    const row = trigger.closest(".chat-msg");
    if (!row) return;
    e.stopPropagation();
    MsgMenu.open(trigger, row);
  });
  // menu item clicks (menu lives on <body>)
  MsgMenu.ensure().addEventListener("click", (e) => {
    const item = e.target.closest("[data-act]");
    if (!item) return;
    const id  = MsgMenu.forId;
    const act = item.dataset.act;
    if (act === "edit")        { MsgMenu.close(); enterEdit(rowById(id)); }
    else if (act === "del")    { MsgMenu.confirm(true); }
    else if (act === "del-no") { MsgMenu.confirm(false); }
    else if (act === "del-yes") {
      if (id && getSocket()) sockEmit("chat-delete", { id });
      MsgMenu.close();
    }
  });
  // dismissers
  document.addEventListener("click", (e) => {
    if (MsgMenu.el && !MsgMenu.el.hidden &&
        !MsgMenu.el.contains(e.target) && !e.target.closest(".msg-actions"))
      MsgMenu.close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") MsgMenu.close(); });
  dom.chatMsgs.addEventListener("scroll", () => MsgMenu.close());
  window.addEventListener("resize", () => MsgMenu.close());
  // host: clear chat (two-click confirm, matching your row-menu pattern)
  if (dom.chatClear) {
    dom.chatClear.addEventListener("click", () => {
      const b = dom.chatClear;
      if (b.dataset.confirm === "1") {
        if (getSocket()) sockEmit("chat-clear");
        resetClearBtn();
      } else {
        b.dataset.confirm = "1";
        b.classList.add("confirm");
        b.title = "Click again to clear for everyone";
        clearTimeout(b._t);
        b._t = setTimeout(resetClearBtn, 3000);
      }
    });
  }
  applyChatPerms();
}
/* ══════════════════════════════════════
   NETWORK — own domain events + centralized hooks.
   socket-core does NOT import this module; we subscribe to it.
   ══════════════════════════════════════ */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;        // 'connect' also fires on reconnect — attach once
  sockWired = true;
  const socket = getSocket();
  socket.on("chat-message", (msg) => appendMessage(msg, true));
  socket.on("chat-system", ({ text, byId }) => addSystemMsg(text, { silent: isMe(byId) }));
  socket.on("chat-edited",  applyEdit);
  socket.on("chat-deleted", applyDelete);
  socket.on("chat-cleared", applyClear);
});
/* phase 20: after applyPerms/renderRoomDetails (10), before queue/video (30).
   Returning the promise makes socket-core await the history fetch, exactly as
   the original `await loadInitialMessages()` did. */
onRoomState(() => {
  addSystemMsg("You joined the room", { silent: true });
  return loadInitialMessages().then(applyChatPerms);   // ← perms are ready by phase 20
}, 20);
onUserJoined(({ username }) => addSystemMsg(username + " joined"));
onUserLeft(({ username }) => addSystemMsg(username + " left"));