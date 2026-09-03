/* public/js/permissions.js
 * ─────────────────────────────────────────────────────────────
 * PERMISSIONS, ROOM CONFIG SHEET, MEMBER PROFILE CARD, MODERATION.
 *
 * Three surfaces, one permission model:
 *
 *  A. applyPerms()        the only place that translates S.perms into UI:
 *                         locks the player container, disables play/progress,
 *                         shows the lock chip, paints the gear badge with the
 *                         pending-request count, stops the sync leader, and
 *                         re-renders the queue (permission-gated rows).
 *
 *  B. Config sheet (#cfgSheet)
 *     openConfig/closeConfig/isConfigOpen, renderConfig() — a full innerHTML
 *     rebuild composed of collapsible sections via secOpen()/SEC_CLOSE:
 *       access · sync · requests · queuemode · people · banned · room
 *     Room-details form: roomFormValues/readRoomForm/normRoom/serverRoomVals
 *     drive a draft/dirty/conflict state machine:
 *       S.roomDraft     — in-progress edits, survives perms re-renders
 *       S.roomConflict  — someone else saved while my form was dirty
 *       isRoomDirty() / roomFormError() / syncDirtyUI() — Save/Reset/hint line
 *       applyIncomingRoom() — 'room-updated' → keep my draft, mount conflict
 *     Collapse memory lives in S.cfgCollapsed; the open row menu in S.cfgRowMenu.
 *
 *  C. Profile card (#profCard)
 *     openProfile/closeProfile/renderProfile, profCache (userId → identity
 *     from /api/users/:id), setPending/clearPending for the optimistic
 *     ban/unban round-trip. Reuses rowMenuHTML/swHTML/onCfgChange verbatim so
 *     both surfaces emit identical events.
 *
 *  Moderation emits (delegated, data-act driven): perm-request, perm-set-mode,
 *  perm-set-queue-mode, perm-respond, perm-grant/perm-revoke, perm-set-role,
 *  member-kick/-ban/-remove (via MOD_EVT), member-unban, room-update.
 *
 *  Network (wirePermissionsSockets, attached on first onConnect):
 *    'room-permissions' → replaces S.perms/S.members/S.requests/S.banned
 *    'room-saved'       → shallow-merges S.room, clears draft+conflict
 *    'room-updated'     → applyIncomingRoom()
 *    'perm-denied' / 'perm-toast' / 'perm-notice' / 'perm-request'
 *  Centralized hooks: onRoomState phase 10 (applyPerms + renderRoomDetails,
 *  before chat's 20 / queue's 30 / player's 35) and onParticipantsUpdate
 *  (the participant count is the validation floor for Max participants).
 *
 *  Cross-module: imports markLocal/revertToRoomState/P from player.js,
 *  Q from queue.js, addSystemMsg from chat.js, renderRoomDetails from
 *  room-details.js. Nothing imports this module — it is a leaf consumer.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { MODES, ROOM_CAP, ROLE_LABEL, FIELD_LABEL, MOD_EVT } from "./config.js";
import { CHEV_SVG, STEP_UP, STEP_DN, SEC_CLOSE } from "./svg.js";
import { S } from "./state.js";
import { $, dom } from "./dom.js";
import { esc, avColor, toast, safeHttpUrl, fmtJoined, isMe } from "./utils.js";
import { getSocket, emit as sockEmit } from "./socket-ref.js";
import { onConnect, onRoomState, onParticipantsUpdate } from "./socket-core.js";
import { renderRoomDetails } from "./room-details.js";
import { P, markLocal, revertToRoomState } from "./player.js";
import { Q } from "./queue.js";
import { addSystemMsg } from "./chat.js";
/* ═══════════════════════════════════════════
   COLLAPSIBLE SECTION HELPERS
   ═══════════════════════════════════════════ */
/**
 * Opens a collapsible section.
 * @param {string}  id                 stored key in S.cfgCollapsed
 * @param {string}  titleHTML          inner HTML for the <h4> (before the chevron)
 * @param {boolean} [defaultClosed]    initial state when no user toggle yet
 * @param {string}  [extraAttrs]       additional HTML attributes for the <section>
 */
function secOpen(id, titleHTML, defaultClosed, extraAttrs) {
  const closed = S.cfgCollapsed[id] !== undefined
    ? S.cfgCollapsed[id]
    : !!defaultClosed;
  return '<section class="cfg-sec' + (closed ? " collapsed" : "") + '"' +
    ' data-collapsible data-sec-id="' + id + '"' +
    (extraAttrs ? " " + extraAttrs : "") + ">" +
    '<h4 class="cfg-sec-head">' + titleHTML +
      '<span class="cfg-chev">' + CHEV_SVG + "</span></h4>" +
    '<div class="cfg-sec-body"><div class="cfg-sec-inner">';
}
/* ══════════════════════════════════════
   PERMISSIONS UI + ROOM CONFIG SHEET
   ══════════════════════════════════════ */
const participantsHere = () => ((S.room && S.room.participants) || []).length;
const participantFloor = () => Math.max(2, participantsHere());
/* first blocking problem with the room-details form, or null */
function roomFormError() {
  if (!$("cfgMax")) return null;
  const v = readRoomForm();
  const name = String(v.roomName || "").trim();
  if (name.length < 3)  return { id: "cfgName", msg: "Room name needs at least 3 characters" };
  if (name.length > 60) return { id: "cfgName", msg: "Room name can be 60 characters at most" };
  const here = participantsHere();
  const n = Number(v.maxParticipants);
  if (!Number.isInteger(n)) return { id: "cfgMax", msg: "Max participants must be a whole number" };
  if (n > ROOM_CAP)         return { id: "cfgMax", msg: `Rooms can't hold more than ${ROOM_CAP} people` };
  if (n < 2)               return { id: "cfgMax", msg: "Rooms need space for at least 2 people" };
  if (n < here)            return { id: "cfgMax",
    msg: `${here} ${here === 1 ? "person is" : "people are"} here right now — remove someone first` };
  return null;
}
export function applyPerms() {
  const p = S.perms;
  dom.container.classList.toggle("locked", !p.canSync);
  $("playBtn").disabled     = !p.canSync;
  $("progressBar").disabled = !p.canSync;
  dom.vcLock.style.display  = p.canSync ? "none" : "";
  const n = (p.canGrantSync || p.canGrantQueue) ? S.requests.length : 0;
  dom.gearBadge.classList.toggle("is-hidden", n === 0);
  dom.gearBadge.textContent = n;
  if (!p.canSync) P.stopLeader();
  Q.render();
}
// Check if the config sheet is open
export const isConfigOpen = () => dom.cfgSheet.classList.contains("open");
export function openConfig() {
  S.cfgCollapsed = {};          // wipe any per-session toggles → defaults apply
  S.cfgRowMenu   = null;
  renderConfig();
  dom.cfgSheet.classList.add("open");
  dom.cfgBackdrop.classList.add("open");
  dom.cfgSheet.setAttribute("aria-hidden", "false");
}
export function closeConfig() {
  S.roomDraft = null;
  S.roomConflict = null;
  dom.cfgSheet.classList.remove("open");
  dom.cfgBackdrop.classList.remove("open");
  dom.cfgSheet.setAttribute("aria-hidden", "true");
}
/* one access row + its request affordance */
function accessRow(label, granted, state, scope, openToAll) {
  let h = '<div class="cfg-row"><span>' + label + "</span>" +
    '<span class="pill ' + (granted ? "pill-ok" : "pill-no") + '">' +
    (granted ? (openToAll ? "Everyone" : "Allowed") : "Host-controlled") + "</span></div>";
  if (granted || !scope) return h;
  if (state === "pending")     h += '<p class="cfg-note">⏳ Requested</p>';
  else if (state === "denied") h += '<p class="cfg-note">🚫 Declined</p>';
  else h += '<button class="cfg-btn primary" data-act="request" data-scope="' + scope +
            '">Request ' + label.toLowerCase() + "</button>";
  return h;
}
export function renderConfig() {
  const p = S.perms, r = S.room || {};
  const online = new Set((r.participants || []).map((x) => (x.userId || "").toString()));
  const host = !!p.isAdmin, mod = !!p.isMod;
  let h = "";
  /* ── your access (non-host) ── */
  if (!host) {
    h += secOpen("access", "Your access");
    if (mod) {
      h += '<div class="cfg-banner"><span class="role-tag role-mod">🛡️ MOD</span>' +
           "<span>You're a mod here</span></div>" +
           accessRow("Playback control", true, null, null) +
           accessRow("Queue control",    true, null, null);
    } else {
      h += accessRow("Playback control", p.canSync,  p.requestState,      "sync",  p.syncMode  === "everyone");
      h += accessRow("Queue control",    p.canQueue, p.queueRequestState, "queue", p.queueMode === "everyone");
    }
    h += SEC_CLOSE;
  }
  /* ── sync mode (host + mods) ── */
  if (p.canGrantSync) {
    h += secOpen("sync", "Who can play / pause / seek");
    h += '<div class="seg">' +
           '<button class="seg-btn' + (p.syncMode === "host" ? " on" : "") +
             '" data-act="mode" data-mode="host">🔒 Host only</button>' +
           '<button class="seg-btn' + (p.syncMode === "everyone" ? " on" : "") +
             '" data-act="mode" data-mode="everyone">👥 Everyone</button>' +
         "</div>" + SEC_CLOSE;
    if (S.requests.length) {
      h += secOpen("requests", 'Requests <span class="cnt">' + S.requests.length + "</span>");
      S.requests.forEach((m) => {
        const lbl = m.scope === "queue" ? "queue" : "playback";
        h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(m.username) +
               '<span class="cfg-uname">' + esc(m.username) + "</span>" +
               '<span class="scope-tag scope-' + lbl + '">' + lbl + "</span></span>" +
             '<span class="cfg-acts">' +
               '<button class="cfg-mini ok" data-act="respond" data-approve="1" data-scope="' + m.scope + '" data-id="' + m.userId + '">Approve</button>' +
               '<button class="cfg-mini no" data-act="respond" data-approve="0" data-scope="' + m.scope + '" data-id="' + m.userId + '">Deny</button>' +
             "</span></div>";
      });
      h += SEC_CLOSE;
    }
  }
  /* ── queue mode (host + mods) ── */
  if (p.canGrantQueue) {
    h += secOpen("queuemode", "Who can manage the queue");
    h += '<div class="seg">' +
           '<button class="seg-btn' + (p.queueMode === "host" ? " on" : "") +
             '" data-act="qmode" data-mode="host">🔒 Host &amp; mods</button>' +
           '<button class="seg-btn' + (p.queueMode === "everyone" ? " on" : "") +
             '" data-act="qmode" data-mode="everyone">👥 Everyone</button>' +
         "</div>" + SEC_CLOSE;
  }
  /* ── people (host + mods) ── */
  if (p.canManage) {
    h += secOpen("people", 'People <span class="cnt">' + S.members.length + "</span>", true);
    S.members.forEach((m) => {
      const isHostRow = m.role === "admin";
      const menuOpen  = !!(S.cfgRowMenu && S.cfgRowMenu.id === m.userId);
      const canPerm   = (p.canGrantSync || p.canGrantQueue) && !isHostRow;
      h += '<div class="cfg-row"><span class="cfg-user">' +
              memberAvBtnHTML(m) +
              '<button class="cfg-uname cfg-uname-btn" data-act="profile" data-uid="' + m.userId +
                '" data-uname="' + esc(m.username) + '" title="View profile">' + esc(m.username) +
                (online.has(m.userId) ? '<i class="dot-on" title="In room"></i>' : "") +
              "</button>" +
            "</span>" +
            '<span class="cfg-acts">' +
              roleTagHTML(m, p.canSetRoles) +
              (canPerm
                ? '<button class="cfg-more' + (menuOpen ? " on" : "") + '" data-act="row-menu" ' +
                    'data-id="' + m.userId + '" aria-expanded="' + menuOpen + '" ' +
                    'title="Permissions" aria-label="Permissions for ' + esc(m.username) + '">⋯</button>'
                : "") +
            "</span></div>";
      if (canPerm && menuOpen) h += permMenuHTML(m, p);
    });
    h += SEC_CLOSE;
  }
  /* ── banned (host only) ── */
  if (p.canBan && S.banned.length) {
    h += secOpen("banned", 'Banned <span class="cnt">' + S.banned.length + "</span>", true);
    S.banned.forEach((b) => {
      h += '<div class="cfg-row"><span class="cfg-user">' + avatarHTML(b.username) +
             '<span class="cfg-uname">' + esc(b.username) + "</span></span>" +
           '<span class="cfg-acts">' +
             '<button class="cfg-mini ok" data-act="unban" data-id="' + b.userId + '">Unban</button>' +
           "</span></div>" +
           (b.reason ? '<p class="cfg-note" style="margin-top:0">"' + esc(b.reason) + '"</p>' : "");
    });
    h += '<p class="cfg-note">Can\'t rejoin until unbanned.</p>' + SEC_CLOSE;
  }
  /* ── room details (host + mods → editable) ── */
  if (p.canEditRoom) {
    const f    = roomFormValues();
    const tags = parseTags(f.tags);
    const full = tags.length >= 8;
    h += secOpen("room", "Room details", true, 'data-sec="room"');
    if (S.roomConflict) h += conflictHTML(S.roomConflict);
    h += '<label class="cfg-field"><span>Name</span>' +
            '<input id="cfgName" data-room-field type="text" maxlength="60" value="' + esc(f.roomName) + '"></label>' +
         '<label class="cfg-field"><span>Description</span>' +
            '<textarea id="cfgDesc" data-room-field rows="2" maxlength="200">' + esc(f.description) + "</textarea></label>" +
         '<label class="cfg-field"><span>Mode</span>' +
            '<select id="cfgMode" data-room-field>' +
              Object.keys(MODES).map((k) =>
                '<option value="' + k + '"' + (f.mode === k ? " selected" : "") + ">" +
                MODES[k].icon + " " + MODES[k].label + "</option>").join("") +
            "</select></label>" +
         /* tags: <div>, not <label> — a label would hijack clicks on the chip ✕ buttons */
         '<div class="cfg-field"><span>Tags ' +
            '<span class="cfg-note" id="cfgTagCnt" style="margin:0">' + tags.length + "/8</span></span>" +
            '<input id="cfgTags" data-room-field type="hidden" value="' + esc(tags.join(",")) + '">' +
            '<div class="tag-add">' +
              '<input id="cfgTagIn" type="text" maxlength="24" placeholder="Add a tag" autocomplete="off"' +
                (full ? " disabled" : "") + ">" +
              '<button type="button" class="cfg-mini alt" data-act="tag-add"' + (full ? " disabled" : "") + ">Add</button>" +
            "</div>" +
            '<div class="tag-list" id="cfgTagList">' + tagChipsHTML(tags) + "</div>" +
         "</div>" +
         '<label class="cfg-field"><span>Visibility</span>' +
            '<select id="cfgVis" data-room-field>' +
              '<option value="public"'  + (f.isPublic  ? " selected" : "") + ">Public</option>" +
              '<option value="private"' + (!f.isPublic ? " selected" : "") + ">Private</option>" +
            "</select></label>" +
         '<label class="cfg-field"><span>Max participants ' +
            '<span class="cfg-note" id="cfgMaxHint" style="margin:0">(' + participantsHere() +
              " here now · " + participantFloor() + "–" + ROOM_CAP + ")</span></span>" +
            '<div class="num-stepper">' +
              '<input id="cfgMax" data-room-field type="number" step="1" min="' + participantFloor() +
                '" max="' + ROOM_CAP + '" value="' + f.maxParticipants + '">' +
              '<span class="num-btns">' +
                '<button type="button" class="num-btn" data-act="step-up" tabindex="-1">' + STEP_UP + "</button>" +
                '<button type="button" class="num-btn" data-act="step-down" tabindex="-1">' + STEP_DN + "</button>" +
              "</span></div></label>" +
         '<div class="cfg-actions">' +
            '<button class="cfg-btn primary" id="cfgSave" data-act="save-room">Save changes</button>' +
            '<button class="cfg-btn" id="cfgReset" data-act="reset-room" disabled>Reset</button>' +
         "</div>" +
         '<p class="cfg-dirty is-hidden" id="cfgDirtyNote"></p>';
    h += SEC_CLOSE;
  }
  dom.cfgBody.innerHTML = h;
  syncDirtyUI();
}
/* ── incoming room-details change ── */
function conflictHTML(c) {
  const fields = (c.changed || []).map((k) => FIELD_LABEL[k] || k).join(", ");
  return '<div class="cfg-conflict" role="status">' +
    '<div class="pp-txt"><strong>' + esc(c.by) + "</strong> updated the room" +
      (fields ? " <em>(" + esc(fields) + ")</em>" : "") +
      ". Your edits were kept — save to overwrite, or discard to load theirs.</div>" +
    '<div class="pp-acts">' +
      '<button class="cfg-mini ok" data-act="ack-conflict">OK, keep mine</button>' +
      '<button class="cfg-mini alt" data-act="reset-room">Discard mine</button>' +
    "</div></div>";
}
function mountConflict() {
  const head = dom.cfgBody.querySelector('[data-sec="room"] h4');
  if (!head) return;
  const old = dom.cfgBody.querySelector(".cfg-conflict");
  if (old) old.remove();                              // refresh text if a 2nd edit lands
  head.insertAdjacentHTML("afterend", conflictHTML(S.roomConflict));
}
function nudgeConflict() {
  const el = dom.cfgBody.querySelector(".cfg-conflict");
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el.classList.remove("nudge");
  void el.offsetWidth;                                // restart the animation
  el.classList.add("nudge");
  setTimeout(() => el.classList.remove("nudge"), 600);
}
/* ⚠ shallow-MERGES S.room (property-level, keeps the shared reference valid) */
function applyIncomingRoom(room, by, changed) {
  S.room = Object.assign({}, S.room, room);
  renderRoomDetails();                                // header/title/tags update for everyone
  if (!isConfigOpen() || !isRoomDirty()) {            // nothing to protect → just refresh
    S.roomDraft = null;
    S.roomConflict = null;
    refreshPanels();
    return;
  }
  /* dirty form: keep the draft, queue an acknowledgement */
  const prev = (S.roomConflict && S.roomConflict.changed) || [];
  S.roomConflict = { by, changed: [...new Set([...prev, ...(changed || [])])] };
  mountConflict();
  syncDirtyUI();                                      // blocks Save, shows the warning line
}
function rowMenuHTML(m, isOnline, state) {
  const c = (state || S.cfgRowMenu || {}).confirm;
  if (c === "ban" || c === "remove") {
    const ban = c === "ban";
    return '<div class="cfg-rowmenu confirm">' +
      '<div class="pp-txt">' + (ban
        ? "<strong>Ban " + esc(m.username) + "?</strong> They'll be kicked out now and can't rejoin until you unban them."
        : "<strong>Remove " + esc(m.username) + "?</strong> They lose their role and permissions here, but can join again.") +
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
/* "a, #B,b ,c" → ["a","b","c"] — dedupes, strips #, lowercases, caps at 8 */
const parseTags = (v) => [...new Set(
  String(v == null ? "" : v).split(",")
    .map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean)
)].slice(0, 8);
/* canonical form of the six editable fields — mirrors the server's sanitizer */
function normRoom(v) {
  return {
    roomName:        String(v.roomName || "").trim().replace(/\s+/g, " "),
    description:     String(v.description || "").trim(),
    mode:            v.mode || "casual",
    tags:            parseTags(v.tags).join(","),
    isPublic:        !!v.isPublic,
    maxParticipants: parseInt(v.maxParticipants, 10) || 0,
  };
}
function tagChipsHTML(tags) {
  return tags.map((t) =>
    '<span class="tag-chip">#' + esc(t) +
      '<button type="button" class="tag-x" data-act="tag-del" data-tag="' + esc(t) +
        '" aria-label="Remove ' + esc(t) + '">✕</button></span>').join("");
}
/* the hidden #cfgTags keeps the comma string, so readRoomForm / isRoomDirty /
   roomDraft work exactly as before — only the visible UI changed */
function setTags(tags) {
  const hid = $("cfgTags");
  if (!hid) return;
  hid.value = tags.join(",");
  $("cfgTagList").innerHTML = tagChipsHTML(tags);
  const full = tags.length >= 8;
  const inp = $("cfgTagIn"), cnt = $("cfgTagCnt");
  const btn = dom.cfgBody.querySelector('[data-act="tag-add"]');
  if (inp) inp.disabled = full;
  if (btn) btn.disabled = full;
  if (cnt) cnt.textContent = tags.length + "/8";
  S.roomDraft = readRoomForm();
  syncDirtyUI();
}
function addTagFromInput() {
  const inp = $("cfgTagIn");
  if (!inp || !inp.value.trim()) return;
  setTags(parseTags($("cfgTags").value + "," + inp.value));   // "a, b" adds both
  inp.value = "";
  inp.focus();
}
/* what's in the DB right now (S.room is kept in sync by room-saved/room-updated) */
function serverRoomVals() {
  const r = S.room || {};
  return normRoom({
    roomName: r.roomName, description: r.description, mode: r.mode || "casual",
    tags: (r.tags || []).join(","), isPublic: r.isPublic !== false,
    maxParticipants: r.maxParticipants || 10,
  });
}
const isRoomDirty = () =>
  !!S.roomDraft && JSON.stringify(normRoom(S.roomDraft)) !== JSON.stringify(serverRoomVals());
function roomFormValues() {
  const r = S.room || {}, d = S.roomDraft || {};
  const pick = (k, fb) => (d[k] !== undefined ? d[k] : fb);
  return {
    roomName:        pick("roomName", r.roomName || ""),
    description:     pick("description", r.description || ""),
    mode:            pick("mode", r.mode || "casual"),
    tags:            pick("tags", (r.tags || []).join(", ")),
    isPublic:        pick("isPublic", r.isPublic !== false),
    maxParticipants: pick("maxParticipants", r.maxParticipants || 10),
  };
}
function readRoomForm() {
  return {
    roomName:        $("cfgName").value,
    description:     $("cfgDesc").value,
    mode:            $("cfgMode").value,
    tags:            $("cfgTags").value,
    isPublic:        $("cfgVis").value === "public",
    maxParticipants: $("cfgMax").value,
  };
}
/* live state of Reset / Save / the hint line — no re-render, so typing isn't interrupted */
function syncDirtyUI() {
  const reset = $("cfgReset"), save = $("cfgSave"), note = $("cfgDirtyNote"), maxIn = $("cfgMax");
  if (!reset || !save || !note) return;
  /* keep the native clamp honest as people come and go */
  if (maxIn) { maxIn.min = String(participantFloor()); maxIn.max = String(ROOM_CAP); }
  const dirty = isRoomDirty();
  const err   = roomFormError();
  const blocked = !!S.roomConflict || !!err;
  reset.disabled = !dirty;
  dom.cfgBody.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
  if (err && $(err.id)) $(err.id).classList.add("invalid");
  note.textContent = S.roomConflict
    ? "⚠️ Someone else changed the room — dismiss the note above, then save."
    : err   ? "⚠️ " + err.msg
    : dirty ? "Unsaved changes" : "";
  note.classList.toggle("warn", blocked);
  note.classList.toggle("is-hidden", !note.textContent);
  save.classList.toggle("is-blocked", blocked);
  save.setAttribute("aria-disabled", blocked ? "true" : "false");
  /* grey out the arrow that would go out of range */
  if (maxIn) {
    const n  = Number(maxIn.value);
    const up = dom.cfgBody.querySelector('[data-act="step-up"]');
    const dn = dom.cfgBody.querySelector('[data-act="step-down"]');
    if (up) up.disabled = Number.isInteger(n) && n >= ROOM_CAP;
    if (dn) dn.disabled = Number.isInteger(n) && n <= participantFloor();
  }
}
function refreshMaxHint() {
  const hint = $("cfgMaxHint");
  if (!hint) return;
  const here = participantsHere();
  hint.textContent = "(" + here + " here now · " + participantFloor() + "–" + ROOM_CAP + ")";
}
function nudgeNote() {
  const note = $("cfgDirtyNote");
  if (!note) return;
  note.classList.remove("nudge"); void note.offsetWidth; note.classList.add("nudge");
  setTimeout(() => note.classList.remove("nudge"), 600);
}
const refreshConfig  = () => { if (isConfigOpen())  renderConfig();  };
const refreshProfile = () => { if (isProfileOpen()) renderProfile(); };
/* anything that used to call refreshConfig() on a server broadcast
   (room-permissions, member list changes, participants changes) should call this */
const refreshPanels  = () => { refreshConfig(); refreshProfile(); };
function avatarHTML(name) {
  return '<span class="cfg-av" style="background:' + avColor(name) + '">' + (name || "?")[0].toUpperCase() + "</span>";
}
/* avatar as a button — same look, opens the existing profile panel */
function memberAvBtnHTML(m) {
  return '<button class="cfg-av cfg-av-btn" data-act="profile" data-uid="' + m.userId +
    '" data-uname="' + esc(m.username) + '" style="background:' + avColor(m.username) +
    '" title="View profile">' + (m.username || "?")[0].toUpperCase() + "</button>";
}
/* role tag — static for host row / non-role-setters, toggleable otherwise */
function roleTagHTML(m, canSetRoles) {
  if (!canSetRoles || m.role === "admin")
    return '<span class="role-tag role-' + m.role + '">' + ROLE_LABEL[m.role] + "</span>";
  const next = m.role === "mod" ? "member" : "mod";
  return '<button class="role-tag role-' + m.role + ' role-toggle" data-act="role-toggle" ' +
    'data-id="' + m.userId + '" data-role="' + next + '" ' +
    'title="Switch to ' + ROLE_LABEL[next] + '">' + ROLE_LABEL[m.role] +
    '<span class="role-swap">⇄</span></button>';
}
/* ellipsis menu now holds the perm switches (rowMenuHTML stays as-is for the profile panel) */
function permMenuHTML(m, p) {
  const isModRow    = m.role === "mod";
  const syncLocked  = isModRow || p.syncMode  === "everyone" || !p.canGrantSync;
  const queueLocked = isModRow || p.queueMode === "everyone" || !p.canGrantQueue;
  return '<div class="cfg-rowmenu cfg-permmenu">' +
    '<span class="perm-item"><span>Playback</span>' +
      swHTML("sync",  m.userId, m.canSync,  syncLocked,  "Can play / pause / seek") + "</span>" +
    '<span class="perm-item"><span>Queue</span>' +
      swHTML("queue", m.userId, m.canQueue, queueLocked, "Can manage the queue") + "</span>" +
  "</div>";
}
function swHTML(scope, id, on, locked, title) {
  const ic = scope === "sync" ? "▶" : "☰";
  return '<label class="sw sw-ic' + (locked ? " sw-lock" : "") + '" title="' + title + '">' +
    '<span class="sw-tag">' + ic + "</span>" +
    '<input type="checkbox" data-act="' + scope + '" data-id="' + id + '"' +
      (on ? " checked" : "") + (locked ? " disabled" : "") + ">" +
    '<span class="sw-track"><span class="sw-knob"></span></span></label>';
}
/* delegated actions inside the sheet */
function onCfgClick(e) {
  /* ── collapsible header toggle ── */
  const head = e.target.closest(".cfg-sec-head");
  if (head) {
    const sec = head.closest("[data-collapsible]");
    if (sec) {
      const id      = sec.dataset.secId;
      const opening = sec.classList.contains("collapsed");
      if (opening) {
        /* room details never shares the sheet: opening it closes the rest,
          opening anything else closes it */
        dom.cfgBody.querySelectorAll("[data-collapsible]").forEach((s) => {
          if (s === sec) return;
          const sid = s.dataset.secId;
          if (id === "room" || sid === "room") {
            s.classList.add("collapsed");
            S.cfgCollapsed[sid] = true;
          }
        });
      }
      sec.classList.toggle("collapsed", !opening);
      S.cfgCollapsed[id] = !opening;
      return;
    }
  }
  /* ── data-act buttons ── */
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
  const act = el.dataset.act;
  /* number stepper */
  if (act === "step-up" || act === "step-down") {
    const input = $("cfgMax");
    if (!input) return;
    const dir = act === "step-up" ? 1 : -1;
    const min = Number(input.min) || participantFloor();
    const max = Number(input.max) || ROOM_CAP;
    const cur = parseInt(input.value, 10) || min;
    const next = Math.max(min, Math.min(max, cur + dir));
    if (next !== cur) {
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }
  if (act === "profile") { openProfile(el.dataset.uid, el.dataset.uname); return; }
  if (act === "role-toggle") {
    sockEmit("perm-set-role", { userId: el.dataset.id, role: el.dataset.role });
    return;   // 'room-permissions' broadcast re-renders with the new tag
  }
  if (act === "request") sockEmit("perm-request", { scope: el.dataset.scope || "sync" });
  if (act === "mode")    sockEmit("perm-set-mode",       { mode: el.dataset.mode });
  if (act === "qmode")   sockEmit("perm-set-queue-mode", { mode: el.dataset.mode });
  if (act === "respond") sockEmit("perm-respond", {
    userId: el.dataset.id, approve: el.dataset.approve === "1", scope: el.dataset.scope || "sync",
  });
  if (act === "row-menu") {
    const id = el.dataset.id;
    S.cfgRowMenu = (S.cfgRowMenu && S.cfgRowMenu.id === id) ? null : { id, confirm: null };
    renderConfig(); return;
  }
  if (act === "menu-close")  { S.cfgRowMenu = null; renderConfig(); return; }
  if (act === "unban") { sockEmit("member-unban", { userId: el.dataset.id }); return; }
  if (act === "save-room") {
    if (!getSocket()) return;
    if (S.roomConflict) return nudgeConflict();
    addTagFromInput();  // don't lose a half-entered tag
    const payload = readRoomForm();
    S.roomDraft = payload;
    el.disabled = true;
    sockEmit("room-update", payload);
    setTimeout(() => { el.disabled = false; }, 1200);
    return;
  }
  if (act === "reset-room") {
    S.roomDraft = null;
    S.roomConflict = null;
    renderConfig();
    return;
  }
  if (act === "ack-conflict") {
    S.roomConflict = null;
    const b = dom.cfgBody.querySelector(".cfg-conflict");
    if (b) b.remove();
    syncDirtyUI();
    return;
  }
  if (act === "tag-add") { addTagFromInput(); return; }
  if (act === "tag-del") {
    setTags(parseTags($("cfgTags").value).filter((t) => t !== el.dataset.tag));
    return;
  }
}
/* scroll-to-step on the number field */
function onCfgWheel(e) {
  const input = e.target.closest('.num-stepper input[type="number"]');
  if (!input) return;
  e.preventDefault();
  const dir = e.deltaY < 0 ? 1 : -1;
  const min = parseInt(input.min, 10) || 2;
  const max = parseInt(input.max, 10) || 50;
  const cur = parseInt(input.value, 10) || min;
  const next = Math.max(min, Math.min(max, cur + dir));
  if (next !== cur) {
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
function onCfgChange(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  if (a === "sync" || a === "queue")
    sockEmit(el.checked ? "perm-grant" : "perm-revoke", { userId: el.dataset.id, scope: a });
  if (a === "role")
    sockEmit("perm-set-role", { userId: el.dataset.id, role: el.value });
}
/* remember room-detail edits so a perms broadcast doesn't wipe the form */
function onCfgRoomInput(e) {
  if (!e.target.closest("[data-room-field]")) return;
  S.roomDraft = readRoomForm();
  syncDirtyUI();                       // Reset lights up immediately
}
function onCfgKeydown(e) {
  if (e.target.id !== "cfgTagIn") return;
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTagFromInput(); }
}
function dom_cfgDelegate() {
  dom.cfgBody.addEventListener("click",  onCfgClick);
  dom.cfgBody.addEventListener("change", onCfgChange);
  dom.cfgBody.addEventListener("input",  onCfgRoomInput);
  dom.cfgBody.addEventListener("change", onCfgRoomInput);          // selects
  dom.cfgBody.addEventListener("keydown", onCfgKeydown);
  dom.cfgBody.addEventListener("wheel",  onCfgWheel, { passive: false });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", dom_cfgDelegate, { once: true });
} else {
  dom_cfgDelegate();
}
/* host-side approve/deny prompt */
function showRequestPrompt(userId, username, scope) {
  const key = userId + ":" + scope;
  if (dom.toasts.querySelector('[data-req="' + key + '"]')) return;
  const label = scope === "queue" ? "manage the queue" : "control playback";
  const el = document.createElement("div");
  el.className = "perm-prompt";
  el.dataset.req = key;
  el.innerHTML =
    '<div class="pp-txt"><strong>' + esc(username) + "</strong> wants to " + label + "</div>" +
    '<div class="pp-acts"><button class="cfg-mini ok">Approve</button><button class="cfg-mini no">Deny</button></div>';
  const [ok, no] = el.querySelectorAll("button");
  ok.onclick = () => { sockEmit("perm-respond", { userId, scope, approve: true  }); el.remove(); };
  no.onclick = () => { sockEmit("perm-respond", { userId, scope, approve: false }); el.remove(); };
  dom.toasts.appendChild(el);
  setTimeout(() => el.remove(), 30000);
}
/* ══════════════════════════════════════
   MEMBER PROFILE PANEL
   identity = /api/users/:id · moderation = reused from the config sheet
   ══════════════════════════════════════ */
const profCache = new Map();      // userId → { username, avatar, createdAt }
const isProfileOpen = () => dom.profCard.classList.contains("open");
function openProfile(userId, fallbackName) {
  if (!userId) return;
  const cached = profCache.get(userId) || null;
  S.profile = {
    userId,
    username: fallbackName || "",
    confirm:  null,               // null | 'ban' | 'remove'  (mirrors S.cfgRowMenu.confirm)
    loading:  !cached,
    error:    false,
    data:     cached,
  };
  renderProfile();
  dom.profCard.classList.add("open");
  dom.profBackdrop.classList.add("open");
  dom.profCard.setAttribute("aria-hidden", "false");
  dom.profClose.focus();
  if (!cached) fetchProfile(userId);
}
/* the ban/unban round-trip is async — hold an optimistic state until the
   room-permissions broadcast reconciles it (or 5s passes, i.e. it failed) */
function setPending(kind) {
  if (!S.profile) return;
  S.profile.pending = kind;                       // 'ban' | 'unban'
  clearTimeout(S.profile._pt);
  S.profile._pt = setTimeout(() => {
    if (S.profile && S.profile.pending === kind) { S.profile.pending = null; renderProfile(); }
  }, 5000);
}
function clearPending(p) { p.pending = null; clearTimeout(p._pt); }
function closeProfile() {
  if (S.profile) clearTimeout(S.profile._pt);
  S.profile = null;
  dom.profCard.classList.remove("open");
  dom.profBackdrop.classList.remove("open");
  dom.profCard.setAttribute("aria-hidden", "true");
}
/* mirrors the "Banned" section of the config sheet — same button, same event */
function profBanSec(name, userId, ban, pending) {
  const busy   = pending === "ban" || pending === "unban";
  const label  = pending === "ban"   ? "Banning…"
               : pending === "unban" ? "Unbanning…"
               : "✓ Unban";
  return profSec("Banned",
    '<div class="prof-ban">' +
      '<div class="pp-txt"><strong>' + esc(name) + "</strong> is banned from this room. " +
        "They can't rejoin and won't see it in Discover.</div>" +
      (ban && ban.reason ? '<p class="cfg-note prof-reason">"' + esc(ban.reason) + '"</p>' : "") +
      '<div class="pp-acts">' +
        '<button class="cfg-mini ok" data-act="unban" data-id="' + userId + '"' +
          (busy ? " disabled" : "") + ">" + label + "</button>" +
      "</div>" +
    "</div>");
}
async function fetchProfile(userId) {
  try {
    const r = await fetch("/api/users/" + encodeURIComponent(userId), { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    profCache.set(userId, d);
    if (S.profile && S.profile.userId === userId) {
      S.profile.data = d; S.profile.loading = false; renderProfile();
    }
  } catch (_) {
    if (S.profile && S.profile.userId === userId) {
      S.profile.loading = false; S.profile.error = true; renderProfile();
    }
  }
}
/* generated avatar underneath, optional <img> on top; the img removes itself on error */
function profAvatarHTML(name, url) {
  const u = safeHttpUrl(url);
  return '<span class="prof-av" style="background:' + avColor(name) + '">' +
    (name || "?")[0].toUpperCase() +
    (u ? '<img src="' + esc(u) + '" alt="">' : "") +
    "</span>";
}
const profSec = (title, inner) => '<div class="cfg-sec"><h4>' + title + "</h4>" + inner + "</div>";
function renderProfile() {
  const p = S.profile;
  if (!p) return;
  const me     = S.perms || {};
  const online = new Set(((S.room && S.room.participants) || []).map((x) => (x.userId || "").toString()));
  const m      = (S.members || []).find((x) => x.userId === p.userId) || null;
  const d      = p.data || {};
  /* S.banned is only ever populated for the host (canBan) — mods/members see nothing */
  const ban = me.canBan ? ((S.banned || []).find((b) => b.userId === p.userId) || null) : null;
  /* reconcile the optimistic flag against the authoritative list */
  if (p.pending === "ban"   &&  ban) clearPending(p);
  if (p.pending === "unban" && !ban) clearPending(p);
  const isBanned = !!ban || p.pending === "ban";
  const name      = d.username || (m && m.username) || (ban && ban.username) || p.username || "Unknown";
  const role      = m ? m.role : null;
  const isSelf    = !!S.userId && p.userId === S.userId;
  const isHostRow = role === "admin";
  const isModRow  = role === "mod";
  /* ── 1. identity — EVERYONE sees exactly this much ── */
  let h = '<div class="prof-id">' +
      profAvatarHTML(name, d.avatar) +
      '<div class="prof-name">' + esc(name) +
        (online.has(p.userId) ? '<i class="dot-on" title="In room"></i>' : "") +
        (isBanned ? '<span class="role-tag role-banned">Banned</span>'
          : role  ? '<span class="role-tag role-' + role + '">' + ROLE_LABEL[role] + "</span>" : "") +
        (isSelf ? '<span class="prof-self">You</span>' : "") +
      "</div>" +
      '<div class="prof-meta">' +
        (p.loading ? '<span class="prof-skel"></span>'
          : p.error ? "Profile unavailable"
          : d.createdAt ? "Joined " + esc(fmtJoined(d.createdAt))
          : "Join date unknown") +
      "</div>" +
    "</div>";
  /* ── 2. host/mod only, never targets yourself ── */
  if (me.canManage && !isSelf) {
    /* a) banned → the only thing left to do is lift it (host only, since S.banned is host-only) */
    if (isBanned) {
      h += profBanSec(name, p.userId, ban, p.pending);
    }
    /* b) still a member → the normal perms / role / moderation stack */
    else if (m) {
      if (isHostRow) {
        h += profSec("Permissions",
          '<p class="cfg-note">The host always has playback and queue control.</p>');
      } else if (isModRow) {
        h += profSec("Permissions",
          '<p class="cfg-note">🛡️ Moderators always have playback and queue control — it can\'t be revoked.' +
          (me.canSetRoles ? " Change their role below to adjust this." : "") + "</p>");
      } else if (me.canGrantSync || me.canGrantQueue) {
        const syncLocked  = me.syncMode  === "everyone" || !me.canGrantSync;
        const queueLocked = me.queueMode === "everyone" || !me.canGrantQueue;
        h += profSec("Permissions",
          '<div class="cfg-row"><span>Playback control</span><span class="cfg-acts">' +
            swHTML("sync", m.userId, m.canSync, syncLocked, "Can play / pause / seek") +
          "</span></div>" +
          '<div class="cfg-row"><span>Queue control</span><span class="cfg-acts">' +
            swHTML("queue", m.userId, m.canQueue, queueLocked, "Can manage the queue") +
          "</span></div>" +
          (syncLocked || queueLocked
            ? '<p class="cfg-note">Some controls are open to everyone right now — switch that off in ' +
              "Room settings to grant them individually.</p>"
            : ""));
      }
      if (me.canSetRoles && !isHostRow) {
        h += profSec("Role",
          '<div class="cfg-row"><span>Room role</span><span class="cfg-acts">' +
            '<select class="cfg-sel" data-act="role" data-id="' + m.userId + '">' +
              '<option value="member"' + (role === "member" ? " selected" : "") + ">Member</option>" +
              '<option value="mod"'    + (isModRow ? " selected" : "") + ">Mod</option>" +
            "</select></span></div>" +
          '<p class="cfg-note">Mods can edit room details and grant playback control, but can\'t change roles.</p>');
      }
      if (me.canBan && !isHostRow) {
        h += profSec("Moderation",
          rowMenuHTML(m, online.has(m.userId), p) +
          (p.confirm ? "" :
            '<p class="cfg-note">Kick boots them from this session. Remove deletes their membership ' +
            "and permissions. Ban also blocks them from rejoining.</p>"));
      }
    }
    /* c) removed / unbanned / never joined */
    else {
      h += '<div class="cfg-sec"><p class="cfg-note">Not a member of this room — they can join again.</p></div>';
    }
  }
  dom.profBody.innerHTML = h;
  const img = dom.profBody.querySelector(".prof-av img");
  if (img) img.addEventListener("error", () => img.remove(), { once: true });
}
/* ── delegated clicks inside the card (change events reuse onCfgChange verbatim) ── */
function onProfClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el || !S.profile || el.tagName === "SELECT" || el.tagName === "INPUT") return;
  const a = el.dataset.act;
  if (a === "ask-ban")    { S.profile.confirm = "ban";    renderProfile(); return; }
  if (a === "ask-remove") { S.profile.confirm = "remove"; renderProfile(); return; }
  if (a === "menu-close") { S.profile.confirm = null;     renderProfile(); return; }
  if (MOD_EVT[a]) {                                   // do-kick | do-ban | do-remove
    sockEmit(MOD_EVT[a], { userId: el.dataset.id });
    S.profile.confirm = null;
    if (a === "do-remove") { closeProfile(); return; } // membership gone, nothing to undo here
    if (a === "do-ban")    setPending("ban");          // ← stay open, flips to the Unban card
    renderProfile();
    return;
  }
  if (a === "unban") {                                 // same event the config sheet emits
    sockEmit("member-unban", { userId: el.dataset.id });
    setPending("unban");
    renderProfile();
    return;
  }
}
function onChatAvatarClick(e) {
  const av = e.target.closest(".msg-av[data-uid]");
  if (!av) return;
  openProfile(av.dataset.uid, av.dataset.uname);
}
function dom_profDelegate() {
  dom.profBody.addEventListener("click",  onProfClick);
  dom.profBody.addEventListener("change", onCfgChange);   // ← sync / queue / role, same emits
  dom.profClose.addEventListener("click", closeProfile);
  dom.profBackdrop.addEventListener("click", closeProfile);
  dom.chatMsgs.addEventListener("click", onChatAvatarClick);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isProfileOpen()) { e.stopPropagation(); closeProfile(); }
  }, true);                                               // capture → closes before the cfg sheet
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", dom_profDelegate, { once: true });
} else {
  dom_profDelegate();
}
/* ══════════════════════════════════════
   WIRING — the gear button / sheet close affordances.
   dom.vcLock lived inside wirePlayerControls() originally; it opens this
   sheet, so it is registered here (player.js must not import openConfig).
   ══════════════════════════════════════ */
export function wirePermissions() {
  dom.configBtn.onclick = openConfig;
  $("cfgClose").onclick = closeConfig;
  dom.cfgBackdrop.onclick = closeConfig;
  dom.vcLock.onclick = (e) => { e.stopPropagation(); openConfig(); };
}
/* ══════════════════════════════════════
   NETWORK
   ══════════════════════════════════════ */
let sockWired = false;
export function wirePermissionsSockets() {
  if (sockWired) return;        // 'connect' also fires on reconnect — attach once
  sockWired = true;
  const socket = getSocket();
  /* ── permissions ── */
  socket.on("room-permissions", ({ perms, members, requests, banned }) => {
    S.perms    = perms;
    S.members  = members  || [];
    S.requests = requests || [];
    S.banned   = banned   || [];
    if (S.cfgRowMenu && !S.members.some((m) => m.userId === S.cfgRowMenu.id)) S.cfgRowMenu = null;
    applyPerms();
    refreshPanels();
  });
  socket.on("room-saved", ({ room }) => {               // my own save came back
    S.room = Object.assign({}, S.room, room);
    S.roomDraft = null;
    S.roomConflict = null;
    renderRoomDetails();
    refreshPanels();
  });
  socket.on("room-updated", ({ room, by, changed }) => applyIncomingRoom(room, by, changed));
  socket.on("perm-denied", ({ message, video }) => {
    toast(message || "Not allowed", "error");
    if (video) { markLocal(video.currentTime, video.isPlaying); revertToRoomState(video); }
  });
  socket.on("perm-toast", ({ message, type }) => toast(message, type));
  socket.on("perm-notice", ({ text, byId }) => addSystemMsg(text, { silent: isMe(byId) }));
  socket.on("perm-request", ({ userId, username, scope }) => showRequestPrompt(userId, username, scope || "sync"));
}
onConnect(() => wirePermissionsSockets());
/* phase 10 — runs before chat (20), queue (30) and the player's load (35) */
onRoomState(() => {
  applyPerms();
  renderRoomDetails();
}, 10);
/* presence moves the validation floor (S.room/details already updated by socket-core) */
onParticipantsUpdate(() => {
  if (isConfigOpen()) { refreshMaxHint(); syncDirtyUI(); }
});