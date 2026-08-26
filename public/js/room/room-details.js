/* public/js/room-details.js
 * ─────────────────────────────────────────────────────────────
 * ROOM HEADER + COLLAPSIBLE ROOM-DETAILS CARD (read-only view of S.room).
 * Pure render layer: reads S.room / S.detailsOpen, writes DOM. No socket.
 * Called by socket-core (room-state, participants-update) and by the
 * permissions module (room-saved, room-updated) via renderRoomDetails().
 *
 *   renderHeader()        top-bar name / mode badge / status dot
 *   renderDetails()       full card (name, badge, count, desc, meta, tags,
 *                         avatars) + chatOnline "N in room"
 *   renderRoomDetails()   renderHeader() + renderDetails() — the public one
 *   renderAvatars(list)   avatar strip HTML (max 10, "+N" overflow)
 *   toggleDetails()       expand/collapse the card (no-op until S.room set)
 *   wireRoomDetails()     click / keyboard / a11y wiring formerly inline in
 *                         wireEvents(); call at the same position
 *
 * State touched:  S.detailsOpen (null → bool on first render) — in place.
 * State read:     S.room
 * DOM touched:    dom.hdrName, dom.hdrBadge, dom.hdrDot, dom.details,
 *                 dom.chatOnline
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { MODES } from "./config.js";
import { S } from "./state.js";
import { dom } from "./dom.js";
import { esc, avColor } from "./utils.js";
/* ═══════ RENDER ═══════ */
export function renderHeader() {
  const r = S.room; if (!r) return;
  const cfg = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
  const bc  = "badge-" + (MODES[r.mode] ? r.mode : "casual");
  dom.hdrName.textContent  = r.roomName;
  dom.hdrBadge.className   = "mode-badge " + bc;
  dom.hdrBadge.textContent = cfg.icon + " " + cfg.label;
  dom.hdrBadge.style.display = "";
  dom.hdrDot.className = "status-dot status-" + (r.status || "active");
  dom.hdrDot.style.display = "";
}
export function toggleDetails() {
  if (!S.room) return;                          // still showing the skeleton
  S.detailsOpen = !S.detailsOpen;
  dom.details.classList.toggle("expanded", S.detailsOpen);
  dom.details.setAttribute("aria-expanded", String(S.detailsOpen));
}
export function renderDetails() {
  const r = S.room; if (!r) return;
  if (S.detailsOpen === null) S.detailsOpen = window.innerWidth > 768;  // mobile → collapsed by default
  const cfg   = MODES[r.mode] || { label: r.mode || "Room", icon: "📺" };
  const bc    = "badge-" + (MODES[r.mode] ? r.mode : "casual");
  const parts = r.participants || [];
  dom.details.innerHTML =
    /* ── always-visible header row ── */
    '<div class="rd-head">' +
      '<h2 class="rd-name">' + esc(r.roomName) + "</h2>" +
      '<span class="mode-badge ' + bc + '">' + cfg.icon + " " + cfg.label + "</span>" +
      '<span class="rd-count">👥 ' + parts.length + "/" + (r.maxParticipants || 10) + "</span>" +
      '<svg class="rd-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
    "</div>" +
    /* ── expandable body ── */
    '<div class="rd-body"><div class="rd-body-in">' +
      (r.description ? '<p class="rd-desc">' + esc(r.description) + "</p>" : "") +
      '<div class="rd-meta">' +
        '<span style="display:flex;align-items:center;gap:.3rem">' +
          '<span class="status-dot status-' + (r.status || "active") + '"></span>' +
          esc(r.status || "active") + "</span>" +
        '<span class="rd-meta-sep">·</span>' +
        "<span>Hosted by <strong>" + esc(r.admin ? r.admin.username : "—") + "</strong></span>" +
      "</div>" +
      (r.tags && r.tags.length
        ? '<div class="rd-tags">' + r.tags.map((t) => '<span class="tag">#' + esc(t) + "</span>").join("") + "</div>"
        : "") +
      renderAvatars(parts) +
    "</div></div>";
  dom.details.classList.add("rd-loaded");
  dom.details.classList.toggle("expanded", S.detailsOpen);
  dom.details.setAttribute("aria-expanded", String(S.detailsOpen));
  dom.chatOnline.textContent = parts.length + " in room";
}
// update everything together
export function renderRoomDetails() {
  renderHeader();
  renderDetails();
}
export function renderAvatars(list) {
  if (!list.length) return "";
  const MAX = 10, show = list.slice(0, MAX), extra = list.length - MAX;
  let h = '<div class="rd-avatars">';
  show.forEach((p) => {
    const c = avColor(p.username), ini = (p.username || "?")[0].toUpperCase();
    h += '<div class="avatar-sm" style="background:' + c + '" title="' + esc(p.username) + '">' + ini + "</div>";
  });
  if (extra > 0) h += '<div class="avatar-sm avatar-more">+' + extra + "</div>";
  return h + "</div>";
}
/* moved verbatim from wireEvents() — collapsible room details */
export function wireRoomDetails() {
  /* collapsible room details — click anywhere on the card toggles */
  dom.details.addEventListener("click", toggleDetails);
  dom.details.setAttribute("role", "button");
  dom.details.tabIndex = 0;
  dom.details.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDetails(); }
  });
}