/* public/js/room/profile-settings.js
 * ─────────────────────────────────────────────────────────────
 * MY PROFILE — header chip + settings modal (desktop) / drawer (mobile).
 *
 *  Data    GET/PATCH /api/users/me · POST/DELETE /api/users/me/avatar
 *          M.user      last server copy (mirrored to S.me)
 *          M.draft     what's in the inputs; a field is dirty when its
 *                      normalised draft differs from the server copy
 *          M.result[f] { ok, msg } → the ✓ / ✕ after a save attempt
 *          M.clientErr live format errors (red hint, Save disabled, no ✕)
 *  Saves   only dirty + valid fields are sent; the server may accept some
 *          and reject others → each field gets its own ✓ / ✕.
 *  Avatar  separate, immediate flow: file → checks (type, size, magic
 *          bytes) → cropper lightbox → XHR upload with progress →
 *          identity store → every avatar on the page repaints.
 *  Sync    another tab/device saving → 'user-profile-updated' → identity
 *          → rev is newer → refetch /me (clean fields follow, dirty kept).
 *  Keys    keydown/keyup never leave the sheet → room shortcuts stay quiet.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { S } from "../state.js";
import { avatarHTML, mergeIdentity, onIdentity } from "./identity.js";
import { createDatePicker, formatISO } from "./datepicker.js";
import { openCropper } from "./avatar-cropper.js";
const FIELDS = ["username", "bio", "birthday"];
const LABEL = { username: "Username", bio: "Bio", birthday: "Birthday" };
const DEFAULT_LIMITS = {
  usernameMin: 3, usernameMax: 20,
  usernamePattern: "^(?=.{3,20}$)[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$",
  usernameHint: "3–20 characters: letters, numbers and single . _ - between them",
  bioMax: 200, minAge: 15, maxAge: 99, birthdayMin: null, birthdayMax: null,
  avatarMaxBytes: 5 * 1024 * 1024, avatarMinPx: 64,
  avatarTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
};
const ICON_OK  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>';
const ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>';
const RING_C = 2 * Math.PI * 46;
const JOIN_FMT = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
const coarse = window.matchMedia("(pointer: coarse)");
const MAGIC = [
  (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,                                          // jpeg
  (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,                         // png
  (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,                         // gif
  (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
         b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,                       // webp
];
const M = {
  user: null, limits: null, loadErr: false, refreshing: false,
  draft: { username: "", bio: "", birthday: "" },
  result: {}, clientErr: {},
  saving: false, open: false, closeArmed: false,
  av: { busy: false, phase: "", pct: 0, err: "", ok: "", confirm: false, xhr: null },
};
let D = null, picker = null, unameRe = null, lastFocus = null, okTimer = 0, heroKey = "";
/* ── helpers ── */
const L = () => M.limits || DEFAULT_LIMITS;
const mb = (n) => (n / 1048576).toFixed(1).replace(/\.0$/, "") + " MB";
function serverVal(f, u = M.user) {
  if (!u) return "";
  return f === "birthday" ? (u.birthday || "") : (u[f] || "");
}
function norm(f, v) {
  v = v == null ? "" : String(v);
  if (f === "username") return v.trim();
  if (f === "bio") return v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return v;
}
const isDirty = (f) => !!M.user && norm(f, M.draft[f]) !== serverVal(f);
const anyDirty = () => FIELDS.some(isDirty);
function hintFor(f) {
  if (f === "username") return L().usernameHint;
  if (f === "bio") return "Shown on your profile card to people in your rooms.";
  return "You must be " + L().minAge + " or older.";      // privacy note now lives in the label
}
function announce(msg) {
  D.live.textContent = "";
  requestAnimationFrame(() => { D.live.textContent = msg; });
}
function nudge(el) { el.classList.remove("nudge"); void el.offsetWidth; el.classList.add("nudge"); }
/* ── data ── */
function applyLimits(lim) {
  M.limits = { ...DEFAULT_LIMITS, ...(lim || {}) };
  try { unameRe = new RegExp(M.limits.usernamePattern); } catch (_) { unameRe = null; }
  D.username.maxLength = M.limits.usernameMax;
  D.bio.maxLength = M.limits.bioMax;
}
function applyServerUser(u, reset = false) {
  if (!u) return;
  const prev = M.user;
  // fields the user hasn't touched follow the server; in-progress edits are kept
  const follow = FIELDS.filter((f) => reset || !prev || norm(f, M.draft[f]) === serverVal(f, prev));
  M.user = u;
  S.me = u;
  follow.forEach((f) => { M.draft[f] = serverVal(f); delete M.clientErr[f]; });
  mergeIdentity(u.id, u);                       // → navbar, chat, people, profile card repaint
  writeInputs(follow);
  paintAll();
}
async function fetchMe() {
  const r = await fetch("/api/users/me", { credentials: "include", cache: "no-store" });
  if (r.status === 401) { const e = new Error("unauthenticated"); e.unauth = true; throw e; }
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
export async function loadMe() {
  M.loadErr = false;
  paintShell();
  try {
    const { user, limits } = await fetchMe();
    applyLimits(limits);
    applyServerUser(user, true);
  } catch (e) {
    M.loadErr = !e.unauth;
    if (e.unauth) D.meBtn.hidden = true;
  }
  paintAll();
}
async function refreshMe() {
  if (M.refreshing) return;
  M.refreshing = true;
  try {
    const { user, limits } = await fetchMe();
    applyLimits(limits);                        // birthday bounds move at midnight
    applyServerUser(user);
  } catch (_) { /* keep what we have */ } finally { M.refreshing = false; }
}
/* ── validation (client mirror of utils/profileValidators.js) ── */
function validateField(f) {
  const v = norm(f, M.draft[f]);
  let err = "";
  if (isDirty(f)) {
    if (f === "username") {
      if (!v) err = "Username can't be empty";
      else if (unameRe && !unameRe.test(v)) err = L().usernameHint;
    } else if (f === "bio") {
      if (v.length > L().bioMax) err = "Bio can be at most " + L().bioMax + " characters";
    } else if (f === "birthday" && v) {
      const { birthdayMin: lo, birthdayMax: hi } = L();
      if (hi && v > hi) err = "You must be at least " + L().minAge + " years old";
      else if (lo && v < lo) err = "Please enter your real birthday";
    }
  }
  if (err) M.clientErr[f] = err; else delete M.clientErr[f];
}
/* ── save ── */
async function save() {
  if (M.saving || !M.user) return;
  FIELDS.forEach(validateField);
  const send = FIELDS.filter((f) => isDirty(f) && !M.clientErr[f]);
  if (!send.length) { paintForm(); return; }
  const patch = {};
  send.forEach((f) => { patch[f] = norm(f, M.draft[f]); });
  M.saving = true; M.closeArmed = false;
  paintForm();
  let status = 0, body = {};
  try {
    const r = await fetch("/api/users/me", {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    status = r.status;
    body = await r.json().catch(() => ({}));
  } catch (_) { status = 0; }
  M.saving = false;
  if (body.user) applyServerUser(body.user);
  const errs = body.errors || {};
  const whole = body.user ? "" :
    status === 0   ? "Network error — nothing was saved" :
    status === 401 ? "Session expired — please sign in again" :
    status === 429 ? (body.error || "Too many changes — try again shortly") :
    (body.error || "Couldn't save (" + status + ")");
  const good = [], bad = [];
  for (const f of send) {
    const msg = errs[f] || whole;
    if (msg) { M.result[f] = { ok: false, msg }; bad.push(LABEL[f]); }
    else { M.result[f] = { ok: true }; M.draft[f] = serverVal(f); good.push(LABEL[f]); }   // adopt server-normalised value
  }
  writeInputs(send.filter((f) => M.result[f].ok));
  paintForm();
  announce((good.length ? good.join(", ") + " saved. " : "") + (bad.length ? bad.join(", ") + " not saved." : ""));
}
/* ── painting ── */
function paintAll() { paintNav(); paintShell(); paintHero(); paintAccount(); paintForm(); paintAv(); }
function paintNav() {
  const u = M.user;
  if (!u) return;
  D.meBtn.hidden = false;
  D.meBtn.setAttribute("aria-label", "Your profile (" + u.username + ")");
  D.avSlot.innerHTML = avatarHTML({ uid: u.id, name: u.username, cls: "me-av", animate: true });
  D.name.textContent = u.username;
  D.name.dataset.nameUid = u.id;
}
function paintShell() {
  const ready = !!M.user;
  D.form.hidden = !ready;
  D.load.hidden = ready;
  D.loadErr.hidden = !M.loadErr;
  D.loadSk.hidden = M.loadErr;
}
function paintHero() {
  const u = M.user;
  if (!u) return;
  const name = norm("username", M.draft.username) || u.username;
  D.heroName.textContent = name;
  // rebuild only when the visual actually changes (no <img> flicker per keystroke)
  const k = [u.avatar, u.avatarStill, u.avatarFull, u.avatar ? "" : name].join("|");
  if (k === heroKey) return;
  heroKey = k;
  D.heroSlot.innerHTML = avatarHTML({
    name, cls: "me-hero-img", animate: true,
    zoom: "View your photo",                               // photo → click opens the viewer
    label: u.avatar ? "" : "Upload a photo",               // no photo → click opens the picker (see wire())
    src: { avatar: u.avatar, avatarStill: u.avatarStill, avatarFull: u.avatarFull },
  });
}
function paintAccount() {
  const u = M.user;
  if (!u) return;
  D.email.textContent = u.email || "—";
  const t = u.createdAt ? new Date(u.createdAt) : null;
  D.joined.textContent = t && !Number.isNaN(t.getTime()) ? JOIN_FMT.format(t) : "—";
}
function paintField(f) {
  const wrap = D.field[f], r = M.result[f], err = M.clientErr[f];
  wrap.dataset.state = err ? "invalid" : r ? (r.ok ? "ok" : "err") : "";
  const stat = wrap.querySelector(".me-stat");
  stat.innerHTML = r ? (r.ok ? ICON_OK : ICON_ERR) : "";
  stat.title = r ? (r.ok ? LABEL[f] + " saved" : r.msg) : "";
  D.hint[f].textContent = err || (r && !r.ok ? r.msg : "") || hintFor(f);
  const ctl = f === "birthday" ? D.bday : D[f];
  ctl.setAttribute("aria-invalid", err || (r && !r.ok) ? "true" : "false");
}
function paintCounter() {
  const n = M.draft.bio.length, max = L().bioMax;
  D.bioCnt.textContent = n + "/" + max;
  D.bioCnt.classList.toggle("warn", n >= max - 20 && n < max);
  D.bioCnt.classList.toggle("full", n >= max);
}
function paintBday() {
  const v = M.draft.birthday;
  D.bdayVal.textContent = v ? formatISO(v) : "Add your birthday";
  D.bdayVal.classList.toggle("ph", !v);
  D.bdayClear.hidden = !v;
}
function paintFooter() {
  const dirty = anyDirty();
  const bad = FIELDS.some((f) => M.clientErr[f]);
  D.save.disabled = !dirty || bad || M.saving;
  D.reset.disabled = !dirty || M.saving;
  D.save.classList.toggle("is-busy", M.saving);
  D.save.textContent = M.saving ? "Saving…" : "Save changes";
  const note = M.closeArmed ? "Unsaved changes — close again to discard them."
             : dirty ? (bad ? "Fix the highlighted field to save." : "You have unsaved changes.")
             : "";
  D.dirty.textContent = note;
  D.dirty.classList.toggle("is-hidden", !note);
  D.dirty.classList.toggle("warn", M.closeArmed || bad);
}
function paintForm() {
  if (!M.user) return;
  FIELDS.forEach(paintField);
  paintCounter(); paintBday(); paintFooter();
  D.form.classList.toggle("saving", M.saving);
  D.username.readOnly = D.bio.readOnly = M.saving;
  D.bday.disabled = D.bdayClear.disabled = M.saving;
}
function writeInputs(fields = FIELDS) {
  if (fields.includes("username") && D.username.value !== M.draft.username) D.username.value = M.draft.username;
  if (fields.includes("bio") && D.bio.value !== M.draft.bio) D.bio.value = M.draft.bio;
  // birthday is display-only → paintBday()
}
/* ── editing ── */
function edit(f, v) {
  M.draft[f] = v;
  delete M.result[f];                       // ✓/✕ describe the LAST save; editing clears them
  M.closeArmed = false;
  validateField(f);
  paintField(f);
  if (f === "bio") paintCounter();
  if (f === "birthday") paintBday();
  if (f === "username") paintHero();
  paintFooter();
}
function discardDraft() {
  FIELDS.forEach((f) => { M.draft[f] = serverVal(f); });
  M.result = {}; M.clientErr = {}; M.closeArmed = false;
  if (picker) picker.close();
  writeInputs();
  paintHero();
  paintForm();
}
function toggleBday() {
  if (picker.isOpen()) { picker.close(); return; }
  const lim = L();
  picker.open({
    value: M.draft.birthday, min: lim.birthdayMin, max: lim.birthdayMax,
    startYear: lim.birthdayMax ? +lim.birthdayMax.slice(0, 4) - 10 : undefined,
  });
  D.bday.setAttribute("aria-expanded", "true");
  D.bdayPick.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
/* ── avatar ── */
function setAv(patch) { Object.assign(M.av, patch); paintAv(); }
function paintAv() {
  const u = M.user, a = M.av;
  if (!u) return;
  D.heroAv.classList.toggle("busy", a.busy);
  D.heroAv.dataset.phase = a.phase || "";
  D.ringFg.style.strokeDashoffset = String(RING_C * (1 - (a.phase === "up" ? a.pct : 0.28)));
  D.avPct.textContent = a.phase === "up" ? Math.round(a.pct * 100) + "%" : "";
  D.avEdit.disabled = a.busy;
  D.avUpload.textContent = u.avatar ? "Change photo" : "Upload photo";
  D.avUpload.disabled = a.busy;
  D.avRemove.hidden = !u.avatar || a.busy;
  D.avCancel.hidden = !(a.busy && a.phase === "up" && a.xhr);
  D.avActs.hidden = a.confirm;
  D.avConfirm.hidden = !a.confirm;
  D.avMsg.textContent = a.err || a.ok ||
    (a.busy ? (a.phase === "up" ? "Uploading…" : a.phase === "proc" ? "Processing…" : "Removing…")
            : "JPG, PNG, WebP or GIF · up to " + mb(L().avatarMaxBytes));
  D.avMsg.className = "me-av-msg" + (a.err ? " err" : a.ok ? " ok" : "");
}
function avDone(msg) {
  setAv({ busy: false, phase: "", xhr: null, pct: 0, err: "", ok: msg });
  announce(msg);
  clearTimeout(okTimer);
  okTimer = setTimeout(() => setAv({ ok: "" }), 4000);
}
function avFail(msg) {
  setAv({ busy: false, phase: "", xhr: null, pct: 0, ok: "", err: msg });
  announce(msg);
}
async function checkFile(file) {
  const lim = L();
  if (!file) return "No file selected";
  if (!lim.avatarTypes.includes(file.type)) return "Use a JPG, PNG, WebP or GIF image";
  if (!file.size) return "That file is empty";
  if (file.size > lim.avatarMaxBytes) return "That image is " + mb(file.size) + " — the limit is " + mb(lim.avatarMaxBytes);
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!MAGIC.some((ok) => ok(head))) return "That file doesn't look like a real image";
  } catch (_) { return "Couldn't read that file"; }
  return null;
}
/* helper hints show for the focused field only (errors always show — CSS).
   Hiding is deferred while a pointer is down: collapsing a hint on focus-out
   would shift the Birthday button / Save under the cursor mid-click. */
function syncHintFocus(allowHide) {
  if (!D) return;
  const a = document.activeElement;
  for (const f of FIELDS) {
    if (M.open && D.field[f].contains(a)) D.field[f].classList.add("is-focus");
    else if (allowHide) D.field[f].classList.remove("is-focus");
  }
}
async function startAvatarFlow(file) {
  if (M.av.busy) return;
  setAv({ err: "", ok: "", confirm: false });
  const err = await checkFile(file);
  if (err) { avFail(err); return; }
  const res = await openCropper(file, { validate: checkFile, minPx: L().avatarMinPx });
  if (res) uploadAvatar(res.file, res.crop);
}
function uploadAvatar(file, crop) {
  const fd = new FormData();
  // text fields BEFORE the file — multer streams in order
  fd.append("cropX", String(crop.cropX));
  fd.append("cropY", String(crop.cropY));
  fd.append("cropSize", String(crop.cropSize));
  fd.append("avatar", file, file.name || "avatar");
  const xhr = new XMLHttpRequest();               // fetch() can't report upload progress
  setAv({ busy: true, phase: "up", pct: 0, err: "", ok: "", confirm: false, xhr });
  xhr.open("POST", "/api/users/me/avatar");
  xhr.withCredentials = true;
  xhr.responseType = "json";
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) setAv({ pct: e.loaded / e.total }); };
  xhr.upload.onload = () => setAv({ phase: "proc", pct: 1 });
  xhr.onload = () => {
    const b = xhr.response || {};
    if (xhr.status >= 200 && xhr.status < 300 && b.user) { applyServerUser(b.user); avDone("Photo updated"); return; }
    avFail(b.error ||
      (xhr.status === 401 ? "Session expired — please sign in again"
        : xhr.status === 413 ? "That image is too large"
        : "Upload failed (" + xhr.status + ")"));
  };
  xhr.onerror = () => avFail("Network error — the photo wasn't uploaded");
  xhr.onabort = () => avFail("Upload cancelled");
  xhr.send(fd);
}
async function removeAvatar() {
  setAv({ busy: true, phase: "rm", confirm: false, err: "", ok: "" });
  try {
    const r = await fetch("/api/users/me/avatar", { method: "DELETE", credentials: "include" });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.user) throw new Error(b.error || "Couldn't remove your photo (" + r.status + ")");
    applyServerUser(b.user);
    avDone("Photo removed");
  } catch (e) {
    avFail(e instanceof TypeError ? "Network error — try again" : e.message);
  }
}
/* ── modal ── */
export function openProfileSettings() {
  if (!D || M.open) return;
  M.open = true;
  lastFocus = document.activeElement;
  discardDraft();                                  // every open starts from the server copy
  setAv({ err: "", ok: "", confirm: false });      // a running upload keeps its busy state
  D.sheet.inert = false;
  D.sheet.setAttribute("aria-hidden", "false");
  D.sheet.classList.add("open");
  D.back.classList.add("open");
  D.meBtn.setAttribute("aria-expanded", "true");
  document.documentElement.classList.add("me-lock");
  paintAll();
  if (M.user) refreshMe(); else loadMe();
  requestAnimationFrame(() => {
    const t = M.user && !coarse.matches ? D.username : D.sheet;   // no surprise keyboard on phones
    t.focus({ preventScroll: true });
  });
}
function requestClose() {
  if (M.user && anyDirty() && !M.closeArmed) {
    M.closeArmed = true;
    paintFooter();
    D.dirty.scrollIntoView({ block: "nearest", behavior: "smooth" });   // the note is in the body now
    nudge(D.dirty);
    return;
  }
  close();
}
function close() {
  if (!M.open) return;
  M.open = false;
  picker.close();
  const back = lastFocus && document.contains(lastFocus) && lastFocus !== document.body ? lastFocus : D.meBtn;
  back.focus({ preventScroll: true });
  D.sheet.classList.remove("open");
  D.back.classList.remove("open");
  D.sheet.setAttribute("aria-hidden", "true");
  D.sheet.inert = true;
  D.meBtn.setAttribute("aria-expanded", "false");
  document.documentElement.classList.remove("me-lock");
  discardDraft();
  syncHintFocus(true);
}

function trapTab(e, root) {
  const els = [...root.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || a === root)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}
function onSheetKey(e) {
  e.stopPropagation();                             // room shortcuts must not fire while typing here
  if (e.key === "Escape") {
    e.preventDefault();
    if (picker.isOpen()) { picker.close(); D.bday.focus(); } else requestClose();
    return;
  }
  if (e.key === "Tab") { trapTab(e, D.sheet); return; }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && M.user) { e.preventDefault(); save(); }
}
/* ── wiring ── */
function cacheDom() {
  const ids = {
    meBtn: "meBtn", avSlot: "meAvSlot", name: "meName",
    sheet: "meSheet", back: "meBackdrop", close: "meClose",
    load: "meLoad", loadSk: "meLoadSk", loadErr: "meLoadErr", retry: "meRetry",
    form: "meForm",
    heroAv: "meHeroAv", heroSlot: "meHeroSlot", heroName: "meHeroName",
    avEdit: "meAvEdit", avPct: "meAvPct", ringFg: "meRingFg",
    avActs: "meAvActs", avUpload: "meAvUpload", avRemove: "meAvRemove", avCancel: "meAvCancel",
    avConfirm: "meAvConfirm", avYes: "meAvRemoveYes", avNo: "meAvRemoveNo", avMsg: "meAvMsg", avFile: "meAvFile",
    username: "meUsername", bio: "meBio", bioCnt: "meBioCnt",
    bday: "meBday", bdayVal: "meBdayVal", bdayClear: "meBdayClear", bdayPick: "meBdayPick",
    email: "meEmail", joined: "meJoined",
    live: "meLive", dirty: "meDirty", reset: "meReset", save: "meSave",
  };
  const d = {};
  for (const [k, id] of Object.entries(ids)) {
    d[k] = document.getElementById(id);
    if (!d[k]) { console.warn("[profile] missing #" + id + " — profile settings disabled"); return null; }
  }
  d.field = {}; d.hint = {};
  for (const f of FIELDS) {
    d.field[f] = d.form.querySelector('.me-field[data-field="' + f + '"]');
    d.hint[f] = d.field[f].querySelector(".me-hint");
  }
  return d;
}
function wire() {
  D.meBtn.addEventListener("click", () => (M.open ? requestClose() : openProfileSettings()));
  D.close.addEventListener("click", requestClose);
  D.back.addEventListener("click", requestClose);
  D.retry.addEventListener("click", () => loadMe());
  D.sheet.addEventListener("keydown", onSheetKey);
  D.sheet.addEventListener("keyup", (e) => e.stopPropagation());
  D.form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  D.username.addEventListener("input", () => edit("username", D.username.value));
  D.bio.addEventListener("input", () => edit("bio", D.bio.value));
  D.bday.addEventListener("click", toggleBday);
  D.bdayClear.addEventListener("click", () => { picker.close(); edit("birthday", ""); D.bday.focus(); });
  D.reset.addEventListener("click", () => { discardDraft(); announce("Changes reset"); D.username.focus(); });
  /* focus-only helper hints */
  let pointerHeld = false;
  const release = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    setTimeout(() => syncHintFocus(true), 0);          // after the click has landed
  };
  document.addEventListener("pointerdown", () => { if (M.open) pointerHeld = true; }, true);
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  D.sheet.addEventListener("focusin", () => syncHintFocus(!pointerHeld));
  D.sheet.addEventListener("focusout", () => { if (!pointerHeld) setTimeout(() => syncHintFocus(true), 0); });
  /* avatar */
  D.avUpload.addEventListener("click", () => D.avFile.click());
  D.avEdit.addEventListener("click", () => D.avFile.click());
  D.heroSlot.addEventListener("click", (e) => {
    if (M.av.busy || e.target.closest(".is-zoomable")) return;   // photo → identity.js opens the viewer
    D.avFile.click();                                             // no photo yet → tapping the initial uploads one
  });
  D.avFile.addEventListener("change", () => {
    const f = D.avFile.files && D.avFile.files[0];
    D.avFile.value = "";                               // lets the same file be picked again later
    if (f) startAvatarFlow(f);
  });
  D.avRemove.addEventListener("click", () => { setAv({ confirm: true, err: "", ok: "" }); D.avNo.focus(); });
  D.avNo.addEventListener("click", () => { setAv({ confirm: false }); D.avRemove.focus(); });
  D.avYes.addEventListener("click", removeAvatar);
  D.avCancel.addEventListener("click", () => { if (M.av.xhr) M.av.xhr.abort(); });
  /* drop an image straight onto the avatar */
  const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  ["dragenter", "dragover"].forEach((t) => D.heroAv.addEventListener(t, (e) => {
    if (!hasFiles(e) || M.av.busy) return;
    e.preventDefault();
    D.heroAv.classList.add("drag");
  }));
  D.heroAv.addEventListener("dragleave", (e) => {
    if (!D.heroAv.contains(e.relatedTarget)) D.heroAv.classList.remove("drag");
  });
  D.heroAv.addEventListener("drop", (e) => {
    D.heroAv.classList.remove("drag");
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && !M.av.busy) startAvatarFlow(f);
  });
}
/* another tab / device changed MY profile → refetch (rev only grows) */
onIdentity((uid, rec) => {
  if (!M.user || uid !== M.user.id) return;
  if ((rec.rev || 0) > (M.user.rev || 0)) refreshMe();
});
function init() {
  D = cacheDom();
  if (!D) return;
  picker = createDatePicker({
    host: D.bdayPick,
    label: "Choose your birthday",
    onPick: (iso) => { edit("birthday", iso); D.bday.focus({ preventScroll: true }); },
    onClose: () => {
      D.bday.setAttribute("aria-expanded", "false");
      if (M.open && (!D.sheet.contains(document.activeElement) || document.activeElement === document.body)) {
        D.bday.focus({ preventScroll: true });
      }
    },
  });
  D.sheet.inert = true;
  applyLimits(null);
  wire();
  loadMe();
}
init();