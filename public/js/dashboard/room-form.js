/* public/js/dashboard/room-form.js
 * ─────────────────────────────────────────────────────────────
 * ONE modal for "Create a room" and "Edit room" (#roomModal).
 * Same rules as the in-room Room details form and the server
 * (services/roomAdmin.js): name 3–60, description ≤200, ≤8 tags of ≤24,
 * max participants between max(2, people in the room now) and 10,
 * room type locked after creation.
 *
 *   openCreate(returnFocusEl)
 *   openEdit(room, returnFocusEl)   prefilled from the card, then refreshed
 *                                   from GET /:roomId/settings if untouched
 * Edit sends only changed fields + `base` (what you saw). A 409 means
 * someone changed the same field meanwhile: their value is loaded for
 * those fields, your other edits are kept, you review and save again.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { $, esc, toast, api, lockScroll, trapTab } from "./ui.js";
import { fillTypeSelect, typeMeta } from "../room-types.js";

export const ROOM_CAP = 10;
const RULES = { nameMin: 3, nameMax: 60, descMax: 200, tagMax: 24, tagsMax: 8 };
const FIELDS = ["roomName", "description", "tags", "isPublic", "maxParticipants"];
const LABEL = { roomName: "name", description: "description", tags: "tags", isPublic: "visibility", maxParticipants: "max participants" };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normTag = (t) => String(t || "").replace(/^#+/, "").replace(/\s+/g, " ").trim();
export const editableOf = (r) => ({
  roomName: r.roomName || "",
  description: r.description || "",
  tags: Array.isArray(r.tags) ? r.tags.slice() : [],
  isPublic: r.isPublic !== false,
  maxParticipants: Number(r.maxParticipants) || ROOM_CAP,
});

export function createRoomForm({ onCreated, onSaved } = {}) {
  const d = {
    overlay: $("roomModal"), title: $("roomModalTitle"), form: $("roomForm"),
    name: $("f_name"), desc: $("f_desc"), descCnt: $("f_descCnt"),
    type: $("f_roomType"), typeRO: $("f_typeRO"), typeNote: $("f_typeNote"),
    max: $("f_max"), maxNote: $("f_maxNote"), privacy: $("privacyToggle"),
    tagIn: $("f_tagInput"), tagAdd: $("addTagBtn"), tagList: $("tagChips"), tagCnt: $("f_tagCnt"),
    err: $("roomFormError"), submit: $("roomSubmitBtn"), cancel: $("roomCancelBtn"), close: $("roomModalClose"),
  };
  d.box = d.overlay.querySelector(".modal");
  const F = { open: false, mode: "create", rid: null, base: null, tags: [], isPublic: true, floor: 2, busy: false, ret: null, seq: 0 };

  /* ── values ── */
  function values() {
    return {
      roomName: d.name.value.replace(/\s+/g, " ").trim(),
      description: d.desc.value.trim(),
      tags: F.tags.slice(),
      isPublic: F.isPublic,
      maxParticipants: parseInt(d.max.value, 10),
    };
  }
  function setValues(v) {
    d.name.value = v.roomName;
    d.desc.value = v.description;
    F.tags = v.tags.slice();
    setPrivacy(v.isPublic);
    d.max.value = String(v.maxParticipants);
    paintTags();
    paint();
  }
  const dirtyKeys = (v) => (F.mode === "edit" && F.base ? FIELDS.filter((k) => !same(v[k], F.base[k])) : []);

  function setFloor(room) {
    const here = ((room && room.participants) || []).length;
    F.floor = Math.max(2, here);
    d.max.min = String(F.floor);
    d.max.max = String(ROOM_CAP);
    d.maxNote.textContent = F.mode === "edit"
      ? "(" + here + " here now · " + F.floor + "–" + ROOM_CAP + ")"
      : "(2–" + ROOM_CAP + ")";
  }
  function setPrivacy(pub) {
    F.isPublic = !!pub;
    d.privacy.querySelectorAll(".seg-btn").forEach((b) => {
      const on = (b.dataset.privacy === "public") === F.isPublic;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  /* ── tags ── */
  function paintTags() {
    d.tagList.innerHTML = F.tags.map((t, i) =>
      '<span class="chip">#' + esc(t) +
      '<button type="button" class="chip-x" data-i="' + i + '" aria-label="Remove tag ' + esc(t) + '">×</button></span>').join("");
    d.tagCnt.textContent = F.tags.length + "/" + RULES.tagsMax;
    const full = F.tags.length >= RULES.tagsMax;
    d.tagIn.disabled = full;
    d.tagAdd.disabled = full;
    d.tagIn.placeholder = full ? "Tag limit reached" : "e.g. anime";
  }
  function addTag() {
    const v = normTag(d.tagIn.value);
    if (!v) return;
    if (v.length > RULES.tagMax) { showErr("Tags can be at most " + RULES.tagMax + " characters"); return; }
    if (F.tags.length >= RULES.tagsMax) return;
    if (!F.tags.some((t) => t.toLowerCase() === v.toLowerCase())) F.tags.push(v);
    d.tagIn.value = "";
    paintTags();
    paint();
    if (!d.tagIn.disabled) d.tagIn.focus();
  }

  /* ── validation / painting ── */
  function validate(v) {
    let err = "", field = null;
    if (v.roomName.length < RULES.nameMin || v.roomName.length > RULES.nameMax) {
      err = "Room name must be " + RULES.nameMin + "–" + RULES.nameMax + " characters."; field = d.name;
    } else if (v.description.length > RULES.descMax) {
      err = "Description can be at most " + RULES.descMax + " characters."; field = d.desc;
    } else if (!Number.isInteger(v.maxParticipants) || v.maxParticipants < F.floor || v.maxParticipants > ROOM_CAP) {
      err = F.floor > 2
        ? "Max participants must be between " + F.floor + " (people in the room now) and " + ROOM_CAP + "."
        : "Max participants must be between 2 and " + ROOM_CAP + ".";
      field = d.max;
    } else if (v.tags.length > RULES.tagsMax) {
      err = "At most " + RULES.tagsMax + " tags."; field = d.tagIn;
    }
    [d.name, d.desc, d.max].forEach((el) => el.classList.toggle("is-invalid", el === field));
    return { err, field };
  }
  function showErr(msg) { d.err.textContent = msg; d.err.hidden = !msg; }
  function clearErr() { showErr(""); [d.name, d.desc, d.max].forEach((el) => el.classList.remove("is-invalid")); }
  function paint() {
    d.descCnt.textContent = d.desc.value.length + "/" + RULES.descMax;
    const edit = F.mode === "edit";
    d.submit.disabled = F.busy || (edit && !dirtyKeys(values()).length);
    d.submit.classList.toggle("is-busy", F.busy);
    d.submit.textContent = F.busy ? (edit ? "Saving…" : "Creating…") : (edit ? "Save changes" : "Create Room");
  }
  function setBusy(b) { F.busy = b; paint(); }

  /* ── open / close ── */
  function show(ret) {
    F.open = true;
    F.ret = ret || document.activeElement;
    clearErr();
    d.overlay.classList.add("active");
    d.overlay.setAttribute("aria-hidden", "false");
    lockScroll(true);
    setTimeout(() => { if (F.open) d.name.focus(); }, 120);
  }
  function close() {
    if (!F.open || F.busy) return;
    F.open = false;
    F.seq++;                                            // drop any in-flight refresh
    d.overlay.classList.remove("active");
    d.overlay.setAttribute("aria-hidden", "true");
    lockScroll(false);
    if (F.ret && F.ret.isConnected) F.ret.focus({ preventScroll: true });
  }

  function openCreate(ret) {
    F.mode = "create"; F.rid = null; F.base = null;
    d.title.textContent = "Create a Room";
    d.type.hidden = false; d.typeRO.hidden = true; d.typeNote.hidden = true;
    fillTypeSelect(d.type, d.type.value);
    setFloor(null);
    setValues({ roomName: "", description: "", tags: [], isPublic: true, maxParticipants: ROOM_CAP });
    show(ret);
  }

  function openEdit(room, ret) {
    F.mode = "edit";
    F.rid = String(room.roomId || room._id || "");
    d.title.textContent = "Edit room";
    const m = typeMeta(room.roomType);
    d.type.hidden = true; d.typeRO.hidden = false; d.typeNote.hidden = false;
    d.typeRO.value = m.icon + " " + m.label;
    setFloor(room);
    F.base = editableOf(room);
    setValues(F.base);
    show(ret);
    refreshFromServer();
  }
  async function refreshFromServer() {
    const seq = ++F.seq, rid = F.rid;
    try {
      const { room } = await api("/api/rooms/" + encodeURIComponent(rid) + "/settings");
      if (seq !== F.seq || !F.open) return;
      setFloor(room);
      if (!dirtyKeys(values()).length) { F.base = editableOf(room); setValues(F.base); }
      else paint();
    } catch (e) {
      if (e.auth || seq !== F.seq || !F.open) return;
      if (e.status === 404) { showErr("This room no longer exists."); d.submit.disabled = true; }
      else if (e.status === 403) { showErr("Only the room's host can edit it."); d.submit.disabled = true; }
      /* other errors: keep the card values, the save will re-validate */
    }
  }

  /* ── submit ── */
  async function onSubmit(e) {
    e.preventDefault();
    if (F.busy) return;
    const v = values();
    const { err, field } = validate(v);
    if (err) { showErr(err); if (field) field.focus(); return; }
    clearErr();
    if (F.mode === "create") await submitCreate(v);
    else await submitEdit(v);
  }
  async function submitCreate(v) {
    setBusy(true);
    try {
      const data = await api("/api/rooms/create", { method: "POST", body: { ...v, roomType: d.type.value } });
      setBusy(false);
      close();
      toast("Room created!", "success");
      if (onCreated) onCreated(data.room || null);
    } catch (e) {
      setBusy(false);
      if (!e.auth) showErr(e.message || "Could not create the room.");
    }
  }
  async function submitEdit(v) {
    const keys = dirtyKeys(v);
    if (!keys.length) { close(); return; }
    const body = { base: {} };
    keys.forEach((k) => { body[k] = v[k]; body.base[k] = F.base[k]; });
    setBusy(true);
    try {
      const data = await api("/api/rooms/" + encodeURIComponent(F.rid), { method: "PATCH", body });
      setBusy(false);
      close();
      toast("Room updated", "success");
      if (onSaved) onSaved(data.room);
    } catch (e) {
      setBusy(false);
      if (e.auth) return;
      if (e.status === 409 && e.data && e.data.room) { resolveConflict(v, e.data); return; }
      showErr(e.message || "Couldn't save the room.");
    }
  }
  function resolveConflict(mine, data) {
    const theirs = editableOf(data.room);
    const conflicts = data.conflicts || [];
    const next = {};
    FIELDS.forEach((k) => {
      const changedByMe = !same(mine[k], F.base[k]);
      next[k] = changedByMe && !conflicts.includes(k) ? mine[k] : theirs[k];
    });
    F.base = theirs;
    setFloor(data.room);
    setValues(next);
    showErr("Someone else changed the " + conflicts.map((k) => LABEL[k]).join(", ") +
      " while you were editing. Their version is loaded and your other edits are kept — review and save again.");
  }

  /* ── wiring ── */
  d.form.addEventListener("submit", onSubmit);
  d.cancel.addEventListener("click", close);
  d.close.addEventListener("click", close);
  d.overlay.addEventListener("click", (e) => { if (e.target === d.overlay) close(); });
  d.tagAdd.addEventListener("click", addTag);
  d.tagIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });
  d.tagList.addEventListener("click", (e) => {
    const x = e.target.closest(".chip-x");
    if (!x) return;
    F.tags.splice(Number(x.dataset.i), 1);
    paintTags();
    paint();
    d.tagIn.focus();
  });
  d.privacy.addEventListener("click", (e) => {
    const b = e.target.closest("[data-privacy]");
    if (!b) return;
    setPrivacy(b.dataset.privacy === "public");
    paint();
  });
  [d.name, d.desc, d.max].forEach((el) => el.addEventListener("input", () => {
    el.classList.remove("is-invalid");
    if (!d.err.hidden && F.mode === "create") showErr("");
    paint();
  }));
  document.addEventListener("keydown", (e) => {
    if (!F.open) return;
    if (e.key === "Escape" && !F.busy) { e.preventDefault(); close(); }
    else if (e.key === "Tab") trapTab(e, d.box);
  });

  return { openCreate, openEdit, close, isOpen: () => F.open };
}