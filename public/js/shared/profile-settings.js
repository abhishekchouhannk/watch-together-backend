/* public/js/shared/profile-settings.js
 * ─────────────────────────────────────────────────────────────
 * MY PROFILE — header chip + settings modal (desktop) / drawer (mobile).
 * Page-agnostic: room.html AND dashboard.html. No sockets, no room state.
 * The page calls initProfileUI() ONCE; it injects the chip + modal itself.
 *
 *   initProfileUI({ chipHost, root, onUnauthenticated }) → Promise<user|null>
 *     chipHost            element the header chip is appended to
 *     root                element the modal mounts in (must see the theme vars)
 *     onUnauthenticated   called on 401 (dashboard → redirect to login)
 *   openProfileSettings()  e.g. "Edit profile" on your own profile card
 *   getMe() / onMe(fn)     current user + change subscription
 *   refreshProfile()       silent re-fetch (dashboard: on tab focus)
 *
 *  Data    GET/PATCH /api/users/me · POST/DELETE /api/users/me/avatar
 *          M.user      last server copy
 *          M.draft     what's in the inputs (dirty = normalised ≠ server)
 *          M.result[f] { ok, msg } → ✓ / ✕ after a save
 *          M.clientErr live format errors (red hint, Save disabled)
 *  Live    every server copy → identity.js (all avatars/names on the page
 *          repaint) + publishIdentity (other tabs, instant). Another tab
 *          saving bumps `rev` → we refetch; clean fields follow, dirty kept.
 *  Hints   helper text only for the focused field, errors always; hiding is
 *          deferred while a pointer is down so nothing shifts under a click.
 *  Keys    keydown/keyup never leave the sheet → page shortcuts stay quiet.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { avatarHTML, mergeIdentity, onIdentity, publishIdentity } from "./identity.js";
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
const ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
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
/* ── markup (one source of truth for every page) ── */
const CHIP_HTML =
  '<button class="me-btn" id="meBtn" type="button" aria-haspopup="dialog" aria-controls="meSheet" ' +
  'aria-expanded="false" title="Your profile" hidden>' +
  '<span class="me-av-slot" id="meAvSlot"></span><span class="me-name" id="meName"></span></button>';
const hintHTML = (id) => '<p class="me-hint" id="' + id + '"><span class="me-hint-t"></span></p>';
const SHEET_HTML = `
<div class="me-backdrop" id="meBackdrop"></div>
<section class="me-sheet" id="meSheet" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="meTitle" tabindex="-1">
  <header class="cfg-head">
    <h3 id="meTitle">Your profile</h3>
    <button class="cfg-x" id="meClose" type="button" aria-label="Close">✕</button>
  </header>
  <div class="cfg-body me-body" id="meBody">
    <div class="me-load" id="meLoad">
      <div class="me-load-sk" id="meLoadSk">
        <div class="me-sk me-sk-av"></div>
        <div class="me-sk-col"><div class="me-sk" style="width:60%;height:1rem"></div><div class="me-sk" style="width:40%;height:.8rem"></div></div>
      </div>
      <div class="me-load-err" id="meLoadErr" hidden>
        <p>Couldn't load your profile.</p>
        <button type="button" class="cfg-mini alt" id="meRetry">Try again</button>
      </div>
    </div>
    <form class="me-form" id="meForm" novalidate autocomplete="off" hidden>
      <div class="me-hero">
        <div class="me-hero-av" id="meHeroAv" data-phase="">
          <span class="me-hero-slot" id="meHeroSlot"></span>
          <span class="me-av-pct" id="meAvPct" aria-hidden="true"></span>
          <svg class="me-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="me-ring-bg" cx="50" cy="50" r="46"/>
            <circle class="me-ring-fg" id="meRingFg" cx="50" cy="50" r="46"/>
          </svg>
          <button type="button" class="me-av-edit" id="meAvEdit" title="Change photo" aria-label="Change profile photo">${ICON_CAMERA}</button>
        </div>
        <div class="me-hero-side">
          <div class="me-hero-name" id="meHeroName"></div>
          <div class="me-av-acts" id="meAvActs">
            <button type="button" class="cfg-mini alt" id="meAvUpload">Upload photo</button>
            <button type="button" class="cfg-mini no" id="meAvRemove" hidden>Remove</button>
            <button type="button" class="cfg-mini alt" id="meAvCancel" hidden>Cancel upload</button>
          </div>
          <div class="me-av-confirm" id="meAvConfirm" hidden>
            <span>Remove your photo?</span>
            <button type="button" class="cfg-mini no" id="meAvRemoveYes">Remove</button>
            <button type="button" class="cfg-mini alt" id="meAvRemoveNo">Keep</button>
          </div>
          <p class="me-av-msg" id="meAvMsg"></p>
          <input type="file" id="meAvFile" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
        </div>
      </div>
      <div class="cfg-sec">
        <h4>Profile</h4>
        <div class="cfg-field me-field" data-field="username">
          <label class="me-lbl" for="meUsername">Username</label>
          <div class="me-ctl">
            <input id="meUsername" type="text" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="meUsernameHint">
            <span class="me-stat" aria-hidden="true"></span>
          </div>
          ${hintHTML("meUsernameHint")}
        </div>
        <div class="cfg-field me-field" data-field="bio">
          <div class="me-lbl"><label for="meBio">Bio</label><span class="me-cnt" id="meBioCnt">0/200</span></div>
          <div class="me-ctl me-ctl-ta">
            <textarea id="meBio" rows="3" placeholder="A line or two about you" aria-describedby="meBioHint"></textarea>
            <span class="me-stat" aria-hidden="true"></span>
          </div>
          ${hintHTML("meBioHint")}
        </div>
        <div class="cfg-field me-field" data-field="birthday">
          <div class="me-lbl"><span id="meBdayLbl">Birthday</span><span class="me-lbl-note">(only you can see this)</span></div>
          <div class="me-ctl">
            <button type="button" class="me-date" id="meBday" aria-haspopup="dialog" aria-expanded="false"
                    aria-labelledby="meBdayLbl meBdayVal" aria-describedby="meBdayHint">
              ${ICON_CAL}<span class="me-date-v" id="meBdayVal"></span>
            </button>
            <button type="button" class="me-date-x" id="meBdayClear" aria-label="Clear birthday" hidden>✕</button>
            <span class="me-stat" aria-hidden="true"></span>
          </div>
          <div id="meBdayPick"></div>
          ${hintHTML("meBdayHint")}
        </div>
        <div class="cfg-actions me-actions">
          <button class="cfg-btn primary" id="meSave" type="submit" disabled>Save changes</button>
          <button class="cfg-btn" id="meReset" type="button" disabled>Reset</button>
        </div>
        <p class="cfg-dirty is-hidden" id="meDirty"></p>
      </div>
      <div class="cfg-sec">
        <h4>Account</h4>
        <div class="me-ro"><span class="me-ro-k">Email</span><span class="me-ro-v" id="meEmail"></span></div>
        <div class="me-ro"><span class="me-ro-k">Joined</span><span class="me-ro-v" id="meJoined"></span></div>
      </div>
      <p class="me-sr" id="meLive" aria-live="polite"></p>
    </form>
  </div>
</section>`;
/* ── state ── */
const M = {
  user: null, limits: null, loadErr: false, refreshing: false,
  draft: { username: "", bio: "", birthday: "" },
  result: {}, clientErr: {},
  saving: false, open: false, closeArmed: false,
  av: { busy: false, phase: "", pct: 0, err: "", ok: "", confirm: false, xhr: null },
  root: null, onUnauth: null,
};
const meSubs = new Set();
let D = null, picker = null, unameRe = null, lastFocus = null, okTimer = 0, heroKey = "", initP = null;
/* ── public API ── */
export const getMe = () => M.user;
export function onMe(fn) {
  meSubs.add(fn);
  if (M.user) { try { fn(M.user); } catch (e) { console.error("[profile]", e); } }
  return () => meSubs.delete(fn);
}
export const refreshProfile = () => refreshMe();
export function initProfileUI({ chipHost = null, root = null, onUnauthenticated = null } = {}) {
  if (initP) return initP;
  M.root = root || document.body;
  M.onUnauth = onUnauthenticated;
  if (!document.getElementById("meBtn") && chipHost) chipHost.insertAdjacentHTML("beforeend", CHIP_HTML);
  if (!document.getElementById("meSheet")) M.root.insertAdjacentHTML("beforeend", SHEET_HTML);
  D = cacheDom();
  if (!D) return (initP = Promise.resolve(null));
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
  initP = loadMe().then(() => M.user);
  return initP;
}
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
  return "You must be " + L().minAge + " or older.";
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
  follow.forEach((f) => { M.draft[f] = serverVal(f); delete M.clientErr[f]; });
  mergeIdentity(u.id, u);                       // → every avatar / name on this page
  publishIdentity(u.id, u);                     // → every other open tab
  writeInputs(follow);
  paintAll();
  meSubs.forEach((fn) => { try { fn(u); } catch (e) { console.error("[profile]", e); } });
}
async function fetchMe() {
  const r = await fetch("/api/users/me", { credentials: "include", cache: "no-store" });
  if (r.status === 401) { const e = new Error("unauthenticated"); e.unauth = true; throw e; }
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function loadMe() {
  M.loadErr = false;
  paintShell();
  try {
    const { user, limits } = await fetchMe();
    applyLimits(limits);
    applyServerUser(user, true);
  } catch (e) {
    if (e.unauth) {
      if (D.meBtn) D.meBtn.hidden = true;
      if (M.onUnauth) M.onUnauth();
    } else {
      M.loadErr = true;
    }
  }
  paintAll();
}
async function refreshMe() {
  if (M.refreshing || !D) return;
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
    }
    else if (f === "bio") {
      if (v.length > L().bioMax) err = "Bio can be at most " + L().bioMax + " characters";
    }
    else if (f === "birthday" && v) {
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
    else { M.result[f] = { ok: true }; M.draft[f] = serverVal(f); good.push(LABEL[f]); }
  }
  writeInputs(send.filter((f) => M.result[f].ok));
  paintForm();
  announce((good.length ? good.join(", ") + " saved. " : "") + (bad.length ? bad.join(", ") + " not saved." : ""));
}
/* ── painting ── */
function paintAll() { paintNav(); paintShell(); paintHero(); paintAccount(); paintForm(); paintAv(); }
function paintNav() {
  const u = M.user;
  if (!u || !D.meBtn) return;
  D.meBtn.hidden = false;
  D.meBtn.setAttribute("aria-label", "Your profile (" + u.username + ")");
  if (D.avSlot) D.avSlot.innerHTML = avatarHTML({ uid: u.id, name: u.username, cls: "me-av", animate: true });
  if (D.name) { D.name.textContent = u.username; D.name.dataset.nameUid = u.id; }
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
  const k = [u.avatar, u.avatarStill, u.avatarFull, u.avatar ? "" : name].join("|");
  if (k === heroKey) return;                     // no <img> flicker per keystroke
  heroKey = k;
  D.heroSlot.innerHTML = avatarHTML({
    name, cls: "me-hero-img", animate: true,
    zoom: "View your photo",
    label: u.avatar ? "" : "Upload a photo",
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
}
function syncHintFocus(allowHide) {
  if (!D) return;
  const a = document.activeElement;
  for (const f of FIELDS) {
    if (M.open && D.field[f].contains(a)) D.field[f].classList.add("is-focus");
    else if (allowHide) D.field[f].classList.remove("is-focus");
  }
}
/* ── editing ── */
function edit(f, v) {
  M.draft[f] = v;
  delete M.result[f];
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
async function startAvatarFlow(file) {
  if (M.av.busy) return;
  setAv({ err: "", ok: "", confirm: false });
  const err = await checkFile(file);
  if (err) { avFail(err); return; }
  const res = await openCropper(file, { validate: checkFile, minPx: L().avatarMinPx, root: M.root });
  if (res) uploadAvatar(res.file, res.crop);
}
function uploadAvatar(file, crop) {
  const fd = new FormData();
  fd.append("cropX", String(crop.cropX));          // text fields BEFORE the file — multer streams in order
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
  discardDraft();
  setAv({ err: "", ok: "", confirm: false });
  D.sheet.inert = false;
  D.sheet.setAttribute("aria-hidden", "false");
  D.sheet.classList.add("open");
  D.back.classList.add("open");
  if (D.meBtn) D.meBtn.setAttribute("aria-expanded", "true");
  document.documentElement.classList.add("me-lock");
  paintAll();
  if (M.user) refreshMe(); else loadMe();
  requestAnimationFrame(() => {
    const t = M.user && !coarse.matches ? D.username : D.sheet;    // no surprise keyboard on phones
    t.focus({ preventScroll: true });
  });
}
function requestClose() {
  if (M.user && anyDirty() && !M.closeArmed) {
    M.closeArmed = true;
    paintFooter();
    D.dirty.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  if (back) back.focus({ preventScroll: true });
  D.sheet.classList.remove("open");
  D.back.classList.remove("open");
  D.sheet.setAttribute("aria-hidden", "true");
  D.sheet.inert = true;
  if (D.meBtn) D.meBtn.setAttribute("aria-expanded", "false");
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
  e.stopPropagation();                             // page shortcuts must not fire while typing here
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
  const required = {
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
  for (const [k, id] of Object.entries(required)) {
    d[k] = document.getElementById(id);
    if (!d[k]) { console.warn("[profile] missing #" + id + " — profile settings disabled"); return null; }
  }
  d.meBtn  = document.getElementById("meBtn");      // optional: a page may not show the chip
  d.avSlot = document.getElementById("meAvSlot");
  d.name   = document.getElementById("meName");
  d.field = {}; d.hint = {};
  for (const f of FIELDS) {
    d.field[f] = d.form.querySelector('.me-field[data-field="' + f + '"]');
    const p = d.field[f].querySelector(".me-hint");
    let t = p.querySelector(".me-hint-t");
    if (!t) { t = document.createElement("span"); t.className = "me-hint-t"; p.replaceChildren(t); }
    d.hint[f] = t;
  }
  return d;
}
function wire() {
  if (D.meBtn) D.meBtn.addEventListener("click", () => (M.open ? requestClose() : openProfileSettings()));
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
  /* focus-only helper hints (collapse deferred while a pointer is down) */
  let pointerHeld = false;
  const release = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    setTimeout(() => syncHintFocus(true), 0);      // after the click has landed
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
    if (M.av.busy || e.target.closest(".is-zoomable")) return;    // photo → identity.js opens the viewer
    D.avFile.click();                                              // no photo yet → tap the initial to upload
  });
  D.avFile.addEventListener("change", () => {
    const f = D.avFile.files && D.avFile.files[0];
    D.avFile.value = "";
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