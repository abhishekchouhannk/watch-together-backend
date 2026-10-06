/* public/js/dashboard/room-actions.js
 * ─────────────────────────────────────────────────────────────
 * Owner-only actions on room cards:
 *   ⋯ button  or  right-click (also the keyboard ContextMenu key)
 *     → small themed menu: Edit room · Delete room
 *   Delete → confirmation dialog with a live preview of exactly what
 *            goes (GET /:roomId/delete-preview), then DELETE /:roomId.
 * Non-owned cards keep the browser's native right-click menu.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { $, toast, api, fmtNum, lockScroll, trapTab } from "./ui.js";

const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const ridOf = (r) => String(r.roomId || r._id || "");

export function wireRoomActions({ grid, getRoom, onEdit, onDeleted }) {
  /* ══════════ MENU ══════════ */
  const menu = document.createElement("div");
  menu.className = "rc-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.innerHTML =
    '<div class="rc-menu-head" aria-hidden="true"></div>' +
    '<button type="button" class="rc-item" role="menuitem" data-act="edit" tabindex="-1">' + ICON_EDIT + "<span>Edit room</span></button>" +
    '<div class="rc-sep" role="separator"></div>' +
    '<button type="button" class="rc-item danger" role="menuitem" data-act="delete" tabindex="-1">' + ICON_TRASH + "<span>Delete room</span></button>";
  document.body.appendChild(menu);
  const items = [...menu.querySelectorAll(".rc-item")];
  let cur = null;                                        // { room, card, anchor }

  function openMenu(room, card, { x = null, y = null, anchor = null } = {}) {
    closeMenu(false);
    cur = { room, card, anchor };
    menu.querySelector(".rc-menu-head").textContent = room.roomName || "Room";
    menu.setAttribute("aria-label", "Actions for " + (room.roomName || "room"));
    menu.classList.remove("open");
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight, pad = 8, vw = innerWidth, vh = innerHeight;
    let left, top;
    if (x == null && anchor) {                            // ⋯ button / keyboard: hang below, right-aligned
      const r = anchor.getBoundingClientRect();
      left = r.right - w; top = r.bottom + 6;
      if (top + h > vh - pad) top = r.top - h - 6;
      menu.style.transformOrigin = "top right";
    } else {                                              // pointer: open at the cursor
      left = x; top = y;
      if (left + w > vw - pad) left = x - w;
      if (top + h > vh - pad) top = y - h;
      menu.style.transformOrigin = "top left";
    }
    menu.style.left = Math.max(pad, Math.min(left, vw - w - pad)) + "px";
    menu.style.top = Math.max(pad, Math.min(top, vh - h - pad)) + "px";
    card.classList.add("menu-target");
    if (anchor) anchor.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => menu.classList.add("open"));
    items[0].focus({ preventScroll: true });
  }
  function closeMenu(restore) {
    if (!cur) return;
    const { card, anchor } = cur;
    cur = null;
    menu.classList.remove("open");
    menu.hidden = true;
    card.classList.remove("menu-target");
    if (anchor) anchor.setAttribute("aria-expanded", "false");
    if (restore && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".card-more");
    if (!btn) return;
    e.preventDefault();
    const card = btn.closest(".room-card");
    const room = card && getRoom(card.dataset.rid);
    if (!room) return;
    if (cur && cur.card === card) { closeMenu(true); return; }
    openMenu(room, card, { anchor: btn });
  });
  grid.addEventListener("contextmenu", (e) => {
    const card = e.target.closest(".room-card");
    if (!card || card.dataset.owned !== "1") return;     // not yours → native menu
    const room = getRoom(card.dataset.rid);
    if (!room) return;
    e.preventDefault();
    const more = card.querySelector(".card-more");
    const keyboard = e.clientX === 0 && e.clientY === 0; // ContextMenu key / Shift+F10
    openMenu(room, card, keyboard && more ? { anchor: more } : { x: e.clientX, y: e.clientY, anchor: more });
  });
  menu.addEventListener("click", (e) => {
    const it = e.target.closest(".rc-item");
    if (!it || !cur) return;
    const { room, anchor } = cur;
    closeMenu(false);
    if (it.dataset.act === "edit") onEdit(room, anchor);
    else if (it.dataset.act === "delete") openDelete(room, anchor);
  });
  menu.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (cur && !menu.contains(e.target) && !e.target.closest(".card-more")) closeMenu(false);
  }, true);
  window.addEventListener("scroll", () => closeMenu(false), { passive: true, capture: true });
  window.addEventListener("resize", () => closeMenu(false));
  window.addEventListener("blur", () => closeMenu(false));

  /* ══════════ DELETE DIALOG ══════════ */
  const d = {
    overlay: $("deleteModal"), box: $("deleteBox"), name: $("delName"), list: $("delList"),
    live: $("delLive"), err: $("delError"), cancel: $("delCancel"), confirm: $("delConfirm"),
  };
  const X = { open: false, room: null, busy: false, seq: 0, ret: null };

  function skeleton() {
    return [70, 55, 62, 48].map((w) =>
      '<li class="is-sk"><span class="sk" style="width:' + w + '%"></span></li>').join("");
  }
  function paintPreview(p) {
    const rows = [];
    if (p) {
      [
        [p.messages, "chat message", "chat messages"],
        [p.whiteboards, "saved whiteboard", "saved whiteboards"],
        [p.queue, "queued item", "queued items"],
        [p.tasks, "task", "tasks"],
        [p.reports, "report", "reports"],
        [p.events, "activity-log entry", "activity-log entries"],
      ].forEach(([n, one, many]) => { if (n > 0) rows.push("<b>" + fmtNum(n) + "</b> " + (n === 1 ? one : many)); });
      rows.push(p.members
        ? "<b>" + fmtNum(p.members) + "</b> member" + (p.members === 1 ? "" : "s") + "' roles & permissions" +
          (p.banned ? " and <b>" + fmtNum(p.banned) + "</b> ban" + (p.banned === 1 ? "" : "s") : "")
        : "Roles, permissions and bans");
    } else {
      rows.push("Chat history, whiteboards, queue and tasks", "Reports and the activity log", "Roles, permissions and bans");
    }
    d.list.innerHTML = rows.map((r) => "<li><span>" + r + "</span></li>").join("");
    const online = p ? p.online : 0;
    d.live.hidden = !online;
    if (online) {
      d.live.textContent = (online === 1 ? "1 person is" : fmtNum(online) + " people are") +
        " in this room right now — they'll be removed immediately.";
    }
  }
  function resetButtons() {
    X.busy = false;
    d.confirm.disabled = false;
    d.cancel.disabled = false;
    d.confirm.classList.remove("is-busy");
    d.confirm.textContent = "Delete room";
  }
  function openDelete(room, ret) {
    X.open = true; X.room = room; X.ret = ret || document.activeElement;
    resetButtons();
    d.name.textContent = room.roomName || "this room";
    d.list.innerHTML = skeleton();
    d.live.hidden = true;
    d.err.hidden = true;
    d.overlay.classList.add("active");
    d.overlay.setAttribute("aria-hidden", "false");
    lockScroll(true);
    setTimeout(() => { if (X.open) d.cancel.focus(); }, 60);     // safe default
    loadPreview(room);
  }
  async function loadPreview(room) {
    const seq = ++X.seq;
    try {
      const { preview } = await api("/api/rooms/" + encodeURIComponent(ridOf(room)) + "/delete-preview");
      if (seq === X.seq && X.open) paintPreview(preview);
    } catch (e) {
      if (e.auth || seq !== X.seq || !X.open) return;
      if (e.status === 404) {
        closeDelete(false);
        onDeleted(ridOf(room));
        toast("That room was already deleted", "success");
        return;
      }
      if (e.status === 403) { d.err.textContent = e.message; d.err.hidden = false; d.confirm.disabled = true; }
      paintPreview(null);
    }
  }
  function closeDelete(restore) {
    if (!X.open || X.busy) return;
    X.open = false;
    X.seq++;
    d.overlay.classList.remove("active");
    d.overlay.setAttribute("aria-hidden", "true");
    lockScroll(false);
    if (restore && X.ret && X.ret.isConnected) X.ret.focus({ preventScroll: true });
  }
  async function confirmDelete() {
    if (X.busy || !X.room) return;
    const room = X.room, rid = ridOf(room);
    X.busy = true;
    d.confirm.disabled = true;
    d.cancel.disabled = true;
    d.confirm.classList.add("is-busy");
    d.confirm.textContent = "Deleting…";
    d.err.hidden = true;
    try {
      const res = await api("/api/rooms/" + encodeURIComponent(rid), { method: "DELETE" });
      resetButtons();
      closeDelete(false);
      onDeleted(rid);
      toast("“" + (room.roomName || "Room") + "” was deleted", "success");
      if (res.incomplete && res.incomplete.length) console.warn("[room delete] incomplete cascade:", res.incomplete);
    } catch (e) {
      resetButtons();
      if (e.auth) return;
      if (e.status === 404) { closeDelete(false); onDeleted(rid); toast("That room was already deleted", "success"); return; }
      d.err.textContent = e.message || "Couldn't delete the room.";
      d.err.hidden = false;
    }
  }

  d.cancel.addEventListener("click", () => closeDelete(true));
  d.confirm.addEventListener("click", confirmDelete);
  d.overlay.addEventListener("click", (e) => { if (e.target === d.overlay) closeDelete(true); });
  d.overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeDelete(true); }
    else if (e.key === "Tab") trapTab(e, d.box);
  });

  return { closeMenu: () => closeMenu(false), openDelete };
}