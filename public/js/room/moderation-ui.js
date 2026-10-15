/* public/js/room/moderation-ui.js
 * ─────────────────────────────────────────────────────────────
 * SHARED MODERATION WIDGETS — used by BOTH the room-settings sheet and the
 * member profile card, so the two surfaces look identical and emit identical
 * events. Pure render helpers + one change handler. No sockets attached here.
 *
 *   scopeTxt(scope) · cap(s)             per-room-type wording for the two grant slots
 *   swHTML(scope, id, on, locked, title) grant switch → perm-grant / perm-revoke (onModChange)
 *   rowMenuHTML(m, isOnline, state)      kick / remove / ban menu + its confirm step
 *   cfgAvHTML(name, uid)                 small static avatar
 *   memberAvBtnHTML(m)                   avatar as a profile button (data-profile → global opener)
 *   onModChange(e)                       change handler for the switches + the role <select>
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { S } from "./state.js";
import { esc } from "./utils.js";
import { emit as sockEmit } from "./socket-ref.js";
import { avatarHTML as userAvHTML, nameOf } from "../shared/identity.js";

/* per-room-type wording for the two grant slots; the server sends perms.labels */
const FALLBACK_TXT = {
  sync:  { label: "playback control", short: "Playback", ask: "control playback",
           modeTitle: "Who can play / pause / seek", on: "Can play / pause / seek" },
  queue: { label: "queue control", short: "Queue", ask: "manage the queue",
           modeTitle: "Who can manage the queue", on: "Can manage the queue" },
};
export const scopeTxt = (scope) =>
  (S.perms && S.perms.labels && S.perms.labels[scope]) || FALLBACK_TXT[scope];
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* small non-clickable avatar — photo-aware and live-updating when uid is passed */
export function cfgAvHTML(name, uid) {
  return userAvHTML({ uid, name, cls: "cfg-av" });
}
/* avatar as a button — data-profile is what member-profile.js listens for, page-wide */
export function memberAvBtnHTML(m) {
  const n = nameOf(m.userId, m.username);
  return userAvHTML({
    uid: m.userId, name: n, tag: "button", cls: "cfg-av cfg-av-btn",
    attrs: 'type="button" data-profile="' + esc(m.userId) + '"',
    label: "View {name}'s profile",
  });
}

const SLOT_ICON = {
  study:  { sync: "⏱", queue: "✓" },
  gaming: { sync: "🎮", queue: "🕹️" },
  media:  { sync: "▶", queue: "☰" },
};
export function swHTML(scope, id, on, locked, title) {
  const ic = (SLOT_ICON[S.roomType] || SLOT_ICON.media)[scope];
  return '<label class="sw sw-ic' + (locked ? " sw-lock" : "") + '" title="' + esc(title) + '">' +
    '<span class="sw-tag">' + ic + "</span>" +
    '<input type="checkbox" data-act="' + scope + '" data-id="' + id + '"' +
      (on ? " checked" : "") + (locked ? " disabled" : "") + ">" +
    '<span class="sw-track"><span class="sw-knob"></span></span></label>';
}

/* `state` = the object carrying `.confirm` (S.cfgRowMenu in the sheet, S.profile in the card) */
export function rowMenuHTML(m, isOnline, state) {
  const c = (state || S.cfgRowMenu || {}).confirm;
  const nm = nameOf(m.userId, m.username);
  if (c === "ban" || c === "remove") {
    const ban = c === "ban";
    return '<div class="cfg-rowmenu confirm">' +
      '<div class="pp-txt">' + (ban
        ? "<strong>Ban " + esc(nm) + "?</strong> They'll be kicked out now and can't rejoin until you unban them."
        : "<strong>Remove " + esc(nm) + "?</strong> They lose their role and permissions here, but can join again.") +
      "</div><div class=\"pp-acts\">" +
        '<button class="cfg-mini no" data-act="do-' + c + '" data-id="' + m.userId + '">' +
          (ban ? "🚫 Ban" : "✕ Remove") + "</button>" +
        '<button class="cfg-mini alt" data-act="menu-close">Cancel</button>' +
      "</div></div>";
  }
  return '<div class="cfg-rowmenu">' +
    '<button class="cfg-mini alt" data-act="do-kick" data-id="' + m.userId + '"' +
      (isOnline ? "" : " disabled") +
      ' title="Boot from this session — they keep their permissions and can rejoin">👟 Kick</button>' +
    '<button class="cfg-mini alt" data-act="ask-remove" data-id="' + m.userId + '"' +
      ' title="Delete their membership and permissions">✕ Remove</button>' +
    '<button class="cfg-mini no" data-act="ask-ban" data-id="' + m.userId + '"' +
      ' title="Remove and block them from rejoining">🚫 Ban</button>' +
  "</div>";
}

/* change events: grant switches + role select — identical emits from both surfaces */
export function onModChange(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  if (a === "sync" || a === "queue")
    sockEmit(el.checked ? "perm-grant" : "perm-revoke", { userId: el.dataset.id, scope: a });
  if (a === "role")
    sockEmit("perm-set-role", { userId: el.dataset.id, role: el.value });
}