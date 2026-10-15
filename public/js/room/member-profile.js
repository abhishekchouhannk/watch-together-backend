/* public/js/room/member-profile.js
 * ─────────────────────────────────────────────────────────────
 * MEMBER PROFILE CARD (#profCard) — identity + moderation for ONE user.
 *
 *   openProfile(userId, fallbackName)   open (cached identity, else fetch)
 *   closeProfile() · isProfileOpen() · refreshProfile()
 *   wireMemberProfile()                 card delegation + the GLOBAL avatar opener:
 *                                       a click on any element carrying
 *                                       data-profile="<uid>" (or a legacy
 *                                       .msg-av[data-uid]) opens the card — chat,
 *                                       voice, games, settings sheet, anywhere.
 *
 *  identity   /api/users/:id → profCache + mergeIdentity() so every avatar and
 *             name on the page benefits from the fetch.
 *  moderation the shared widgets in moderation-ui.js, so the card emits exactly
 *             what the room-settings sheet emits.
 *  S.profile  { userId, username, confirm, loading, error, data, pending }
 *             confirm: null|'ban'|'remove' · pending: null|'ban'|'unban'
 *             (optimistic state until the room-permissions broadcast reconciles it)
 *
 *  Re-renders on: identity changes, presence (online dot), and refreshProfile()
 *  called by the room-settings socket handlers when perms/members/bans change.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { ROLE_LABEL, MOD_EVT } from "./config.js";
import { S } from "./state.js";
import { dom } from "./dom.js";
import { esc, fmtJoined } from "./utils.js";
import { emit as sockEmit } from "./socket-ref.js";
import { onParticipantsUpdate } from "./socket-core.js";
import { avatarHTML as userAvHTML, getIdentity, mergeIdentity, onIdentity } from "../shared/identity.js";
import { openProfileSettings } from "../shared/profile-settings.js";
import { scopeTxt, cap, swHTML, rowMenuHTML, onModChange } from "./moderation-ui.js";

const profCache = new Map();      // userId → { username, avatar, bio, createdAt }

export const isProfileOpen = () => dom.profCard.classList.contains("open");
export const refreshProfile = () => { if (isProfileOpen()) renderProfile(); };

export function openProfile(userId, fallbackName) {
  if (!userId) return;
  userId = String(userId);
  const cached = profCache.get(userId) || null;
  S.profile = {
    userId,
    username: fallbackName || "",
    confirm:  null,
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
export function closeProfile() {
  if (S.profile) clearTimeout(S.profile._pt);
  S.profile = null;
  dom.profCard.classList.remove("open");
  dom.profBackdrop.classList.remove("open");
  dom.profCard.setAttribute("aria-hidden", "true");
}

/* the ban/unban round-trip is async — hold an optimistic state until the
   room-permissions broadcast reconciles it (or 5s passes, i.e. it failed) */
function setPending(kind) {
  if (!S.profile) return;
  S.profile.pending = kind;
  clearTimeout(S.profile._pt);
  S.profile._pt = setTimeout(() => {
    if (S.profile && S.profile.pending === kind) { S.profile.pending = null; renderProfile(); }
  }, 5000);
}
function clearPending(p) { p.pending = null; clearTimeout(p._pt); }

async function fetchProfile(userId) {
  try {
    const r = await fetch("/api/users/" + encodeURIComponent(userId), { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    profCache.set(userId, d);
    if (S.profile && S.profile.userId === userId) { S.profile.data = d; S.profile.loading = false; }
    mergeIdentity(userId, d);                 // chat / people / navbar get it too
    if (S.profile && S.profile.userId === userId) renderProfile();
  } catch (_) {
    if (S.profile && S.profile.userId === userId) {
      S.profile.loading = false; S.profile.error = true; renderProfile();
    }
  }
}

/* ── render ── */
const profSec = (title, inner) => '<div class="cfg-sec"><h4>' + title + "</h4>" + inner + "</div>";

/* mirrors the "Banned" section of the settings sheet — same button, same event */
function profBanSec(name, userId, ban, pending) {
  const busy  = pending === "ban" || pending === "unban";
  const label = pending === "ban" ? "Banning…" : pending === "unban" ? "Unbanning…" : "✓ Unban";
  return profSec("Banned",
    '<div class="prof-ban">' +
      '<div class="pp-txt"><strong>' + esc(name) + "</strong> is banned from this room. " +
        "They can't rejoin and won't see it in Discover.</div>" +
      (ban && ban.reason ? '<p class="cfg-note prof-reason">"' + esc(ban.reason) + '"</p>' : "") +
      '<div class="pp-acts">' +
        '<button class="cfg-mini ok" data-act="unban" data-id="' + userId + '"' + (busy ? " disabled" : "") + ">" +
          label + "</button>" +
      "</div></div>");
}

export function renderProfile() {
  const p = S.profile;
  if (!p) return;
  const me     = S.perms || {};
  const online = new Set(((S.room && S.room.participants) || []).map((x) => (x.userId || "").toString()));
  const m      = (S.members || []).find((x) => x.userId === p.userId) || null;
  const d      = p.data || {};
  const live   = getIdentity(p.userId) || {};                       // freshest identity (rev-guarded)
  const ban    = me.canBan ? ((S.banned || []).find((b) => b.userId === p.userId) || null) : null;
  if (p.pending === "ban"   &&  ban) clearPending(p);
  if (p.pending === "unban" && !ban) clearPending(p);
  const isBanned  = !!ban || p.pending === "ban";
  const name      = live.username || d.username || (m && m.username) || (ban && ban.username) || p.username || "Unknown";
  const bio       = (live.bio !== undefined ? live.bio : d.bio) || "";
  const role      = m ? m.role : null;
  const isSelf    = !!S.userId && p.userId === S.userId;
  const isHostRow = role === "admin";
  const isModRow  = role === "mod";

  /* ── 1. identity — everyone sees exactly this much ── */
  let h = '<div class="prof-id">' +
      userAvHTML({ uid: p.userId, name, cls: "prof-av", animate: true, zoom: true }) +
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
      (bio ? '<p class="prof-bio">' + esc(bio) + "</p>"
           : isSelf && !p.loading ? '<button type="button" class="prof-bio-add" data-act="edit-me">＋ Add a bio</button>' : "") +
    "</div>";
  if (isSelf) {
    h += '<div class="cfg-sec prof-self-acts">' +
           '<button type="button" class="cfg-btn" data-act="edit-me">Edit profile</button></div>';
  }

  /* ── 2. host/mod only, never targets yourself ── */
  if (me.canManage && !isSelf) {
    if (isBanned) {
      h += profBanSec(name, p.userId, ban, p.pending);
    } else if (m) {
      if (isHostRow) {
        h += profSec("Permissions",
          '<p class="cfg-note">The host always has ' + scopeTxt("sync").label + " and " + scopeTxt("queue").label + ".</p>");
      } else if (isModRow) {
        h += profSec("Permissions",
          '<p class="cfg-note">🛡️ Moderators always have ' + scopeTxt("sync").label + " and " + scopeTxt("queue").label +
          " — it can't be revoked." + (me.canSetRoles ? " Change their role below to adjust this." : "") + "</p>");
      } else if (me.canGrantSync || me.canGrantQueue) {
        const syncLocked  = me.syncMode  === "everyone" || !me.canGrantSync;
        const queueLocked = me.queueMode === "everyone" || !me.canGrantQueue;
        h += profSec("Permissions",
          '<div class="cfg-row"><span>' + esc(cap(scopeTxt("sync").label)) + '</span><span class="cfg-acts">' +
            swHTML("sync", m.userId, m.canSync, syncLocked, scopeTxt("sync").on) + "</span></div>" +
          '<div class="cfg-row"><span>' + esc(cap(scopeTxt("queue").label)) + '</span><span class="cfg-acts">' +
            swHTML("queue", m.userId, m.canQueue, queueLocked, scopeTxt("queue").on) + "</span></div>" +
          (syncLocked || queueLocked
            ? '<p class="cfg-note">Some controls are open to everyone right now — switch that off in ' +
              "Room settings to grant them individually.</p>" : ""));
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
    } else {
      h += '<div class="cfg-sec"><p class="cfg-note">Not a member of this room — they can join again.</p></div>';
    }
  }
  dom.profBody.innerHTML = h;
}

/* ── delegated clicks inside the card (change events go through onModChange) ── */
function onProfClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el || !S.profile || el.tagName === "SELECT" || el.tagName === "INPUT") return;
  const a = el.dataset.act;
  if (a === "edit-me")    { closeProfile(); openProfileSettings(); return; }
  if (a === "ask-ban")    { S.profile.confirm = "ban";    renderProfile(); return; }
  if (a === "ask-remove") { S.profile.confirm = "remove"; renderProfile(); return; }
  if (a === "menu-close") { S.profile.confirm = null;     renderProfile(); return; }
  if (MOD_EVT[a]) {                                   // do-kick | do-ban | do-remove
    sockEmit(MOD_EVT[a], { userId: el.dataset.id });
    S.profile.confirm = null;
    if (a === "do-remove") { closeProfile(); return; }
    if (a === "do-ban")    setPending("ban");          // stay open, flips to the Unban card
    renderProfile();
    return;
  }
  if (a === "unban") {
    sockEmit("member-unban", { userId: el.dataset.id });
    setPending("unban");
    renderProfile();
  }
}

/* ── the page-wide opener ──
   Contract: render any avatar/name with data-profile="<uid>" and it opens the card.
   The name comes from identity's data-av-name (live across renames) or data-uname.
   Zoomable avatars (the card's own hero) are identity's lightbox business — skipped. */
function onAvatarClick(e) {
  if (e.defaultPrevented) return;
  const el = e.target.closest("[data-profile], .msg-av[data-uid]");
  if (!el || el.classList.contains("is-zoomable")) return;
  const uid = el.dataset.profile || el.dataset.uid;
  if (!uid) return;
  openProfile(uid, el.dataset.avName || el.dataset.uname || "");
}

let wired = false;
export function wireMemberProfile() {
  if (wired) return;
  wired = true;
  dom.profBody.addEventListener("click",  onProfClick);
  dom.profBody.addEventListener("change", onModChange);
  dom.profClose.addEventListener("click", closeProfile);
  dom.profBackdrop.addEventListener("click", closeProfile);
  document.addEventListener("click", onAvatarClick);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isProfileOpen()) { e.stopPropagation(); closeProfile(); }
  }, true);                                               // capture → closes before the settings sheet
}

/* a rename / new photo / bio while the card is open → re-render it */
onIdentity((uid) => { if (S.profile && S.profile.userId === uid) renderProfile(); });
/* someone came or went → the online dot and the Kick button's enabled state */
onParticipantsUpdate(refreshProfile);