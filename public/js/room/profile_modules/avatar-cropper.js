/* public/js/room/avatar-cropper.js
 * ─────────────────────────────────────────────────────────────
 * AVATAR LIGHTBOX — preview, position & zoom BEFORE anything is uploaded.
 *
 *   openCropper(file, { validate, minPx }) → Promise<{ file, crop } | null>
 *
 * Nothing is re-encoded in the browser: we measure a square in the image's
 * natural pixels and hand { cropX, cropY, cropSize } to the server, which
 * lets Cloudinary cut it → GIFs stay animated, JPEGs aren't double-compressed.
 *
 * Gestures: drag (mouse / touch / pen), wheel · pinch · slider to zoom,
 * arrows pan (Shift = faster), +/- zoom, 0 resets, Enter uploads.
 * "Choose another" swaps the file in place; Cancel / Esc / backdrop → null.
 * Mounted inside #roomPage so it inherits the theme variables.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { esc } from "../utils.js";
const ZMAX = 4;
let R = null;   // DOM refs (built on first use)
let C = null;   // current session
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
function build() {
  const root = document.createElement("div");
  root.className = "avc";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "avcTitle");
  root.innerHTML =
    '<div class="avc-card">' +
      '<header class="cfg-head"><h3 id="avcTitle">Position your photo</h3>' +
        '<button type="button" class="cfg-x" data-avc="cancel" aria-label="Cancel">✕</button></header>' +
      '<div class="avc-body">' +
        '<div class="avc-stage" tabindex="0" role="img" ' +
          'aria-label="Crop area. Drag or use the arrow keys to move, plus and minus to zoom.">' +
          '<img class="avc-img" alt="" draggable="false">' +
          '<div class="avc-mask" aria-hidden="true"></div>' +
          '<div class="avc-spin" aria-hidden="true"></div>' +
        "</div>" +
        '<div class="avc-zoom">' +
          '<button type="button" class="avc-zbtn" data-avc="zout" aria-label="Zoom out">−</button>' +
          '<input type="range" class="avc-range" min="1" max="' + ZMAX + '" step="0.01" value="1" aria-label="Zoom">' +
          '<button type="button" class="avc-zbtn" data-avc="zin" aria-label="Zoom in">+</button>' +
        "</div>" +
        '<div class="avc-pvs" aria-hidden="true">' +
          '<span class="avc-pv"><span class="avc-pv-c avc-pv-lg"><img alt=""></span>Profile</span>' +
          '<span class="avc-pv"><span class="avc-pv-c avc-pv-md"><img alt=""></span>Header</span>' +
          '<span class="avc-pv"><span class="avc-pv-c avc-pv-sm"><img alt=""></span>Chat</span>' +
        "</div>" +
        '<p class="avc-meta"></p>' +
        '<p class="avc-err" role="alert" hidden></p>' +
      "</div>" +
      '<footer class="avc-foot">' +
        '<button type="button" class="cfg-btn avc-replace" data-avc="replace">Choose another</button>' +
        '<button type="button" class="cfg-btn" data-avc="cancel">Cancel</button>' +
        '<button type="button" class="cfg-btn primary" data-avc="ok" disabled>Upload</button>' +
      "</footer>" +
      '<input type="file" class="avc-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>' +
    "</div>";
  (document.getElementById("roomPage") || document.body).appendChild(root);
  const q = (s) => root.querySelector(s);
  R = {
    root, stage: q(".avc-stage"), img: q(".avc-img"), range: q(".avc-range"),
    meta: q(".avc-meta"), err: q(".avc-err"), ok: q('[data-avc="ok"]'), file: q(".avc-file"),
    pvs: [...root.querySelectorAll(".avc-pv-c")].map((el) => ({ el, img: el.querySelector("img") })),
  };
  wire();
}
function wire() {
  const { root, stage, range } = R;
  // backdrop closes — but only if the press ALSO started on the backdrop (not a drag that ended there)
  root.addEventListener("pointerdown", (e) => { if (C) C.downOnBackdrop = e.target === root; });
  root.addEventListener("click", (e) => {
    if (!C) return;
    if (e.target === root) { if (C.downOnBackdrop) finish(null); return; }
    const b = e.target.closest("[data-avc]");
    if (!b || b.disabled) return;
    const a = b.dataset.avc;
    if (a === "cancel") finish(null);
    else if (a === "ok") confirm();
    else if (a === "replace") { R.file.value = ""; R.file.click(); }
    else if (a === "zin") zoomTo(C.z * 1.25);
    else if (a === "zout") zoomTo(C.z / 1.25);
  });
  root.addEventListener("keydown", onKey);
  root.addEventListener("keyup", (e) => e.stopPropagation());          // keep room shortcuts quiet
  range.addEventListener("input", () => zoomTo(+range.value));
  R.file.addEventListener("change", async () => {
    const f = R.file.files && R.file.files[0];
    if (!f || !C) return;
    const err = C.validate ? await C.validate(f) : null;
    if (err) { setErr(err); return; }                                  // keep the current photo on screen
    load(f);
  });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => stage.addEventListener(t, onUp));
  stage.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", () => { if (C && C.ready) refit(); });
}
export function openCropper(file, opts = {}) {
  if (!R) build();
  if (C) finish(null);
  return new Promise((resolve) => {
    C = {
      resolve, validate: opts.validate || null, minPx: opts.minPx || 64,
      file: null, url: null, w: 0, h: 0, stage: 0, base: 1, z: 1, ox: 0, oy: 0, pvSize: [],
      ptrs: new Map(), pinch: null, ready: false, downOnBackdrop: false, ret: document.activeElement,
    };
    setErr("");
    R.root.hidden = false;
    document.documentElement.classList.add("avc-lock");
    requestAnimationFrame(() => R.root.classList.add("open"));
    load(file);
    R.stage.focus({ preventScroll: true });
  });
}
function load(file) {
  C.ready = false;
  setErr("");
  R.ok.disabled = true;
  R.root.classList.add("loading");
  if (C.url) URL.revokeObjectURL(C.url);
  C.file = file;
  C.url = URL.createObjectURL(file);
  const probe = new Image();
  probe.onload = () => {
    if (!C || C.file !== file) return;
    R.root.classList.remove("loading");
    C.w = probe.naturalWidth; C.h = probe.naturalHeight;
    if (Math.min(C.w, C.h) < C.minPx) { setErr("Too small — photos need to be at least " + C.minPx + "×" + C.minPx + "px"); return; }
    [R.img, ...R.pvs.map((p) => p.img)].forEach((i) => {
      i.src = C.url; i.style.width = C.w + "px"; i.style.height = C.h + "px";
    });
    fit();
    C.ready = true;
    R.ok.disabled = false;
    R.meta.innerHTML = metaHTML(file);
  };
  probe.onerror = () => {
    if (!C || C.file !== file) return;
    R.root.classList.remove("loading");
    setErr("This image couldn't be read — try another file");
  };
  probe.src = C.url;
}
function metaHTML(f) {
  return esc(f.name || "image") + " · " + fmtSize(f.size) + " · " + C.w + "×" + C.h +
    (f.type === "image/gif"
      ? '<br><span class="avc-gif">GIF</span>Animates on your profile card &amp; header; chat and lists show the first frame.'
      : "");
}
function setErr(msg) { R.err.textContent = msg; R.err.hidden = !msg; }
/* ── geometry: image top-left at (ox, oy) in stage px, scaled by base*z ── */
function fit() {
  C.stage = R.stage.clientWidth;
  C.base = C.stage / Math.min(C.w, C.h);                   // "cover" the square
  C.pvSize = R.pvs.map((p) => p.el.clientWidth);
  C.z = 1;
  C.ox = (C.stage - C.w * C.base) / 2;
  C.oy = (C.stage - C.h * C.base) / 2;
  R.range.value = "1";
  paint();
}
function refit() {
  const old = C.stage, now = R.stage.clientWidth;
  if (!old || now === old) return;
  const r = now / old;
  C.stage = now; C.base = now / Math.min(C.w, C.h);
  C.pvSize = R.pvs.map((p) => p.el.clientWidth);
  C.ox *= r; C.oy *= r;
  clampPos(); paint();
}
function clampPos() {
  const s = C.base * C.z;
  C.ox = Math.min(0, Math.max(C.stage - C.w * s, C.ox));
  C.oy = Math.min(0, Math.max(C.stage - C.h * s, C.oy));
}
function paint() {
  const s = C.base * C.z;
  R.img.style.transform = "translate(" + C.ox + "px," + C.oy + "px) scale(" + s + ")";
  R.pvs.forEach((p, i) => {
    const r = C.pvSize[i] / C.stage;
    p.img.style.transform = "translate(" + C.ox * r + "px," + C.oy * r + "px) scale(" + s * r + ")";
  });
}
function zoomTo(z, cx, cy) {
  if (!C || !C.ready) return;
  if (cx == null) { cx = C.stage / 2; cy = C.stage / 2; }
  const nz = Math.min(ZMAX, Math.max(1, z));
  const s0 = C.base * C.z, s1 = C.base * nz;
  C.ox = cx - ((cx - C.ox) / s0) * s1;                      // keep the point under the cursor fixed
  C.oy = cy - ((cy - C.oy) / s0) * s1;
  C.z = nz;
  clampPos(); paint();
  R.range.value = String(nz);
}
/* ── pointer: 1 finger pans, 2 fingers pinch ── */
function stagePt(e) { const r = R.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function onDown(e) {
  if (!C || !C.ready || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  R.stage.setPointerCapture(e.pointerId);
  C.ptrs.set(e.pointerId, stagePt(e));
  if (C.ptrs.size === 2) {
    const [a, b] = [...C.ptrs.values()];
    C.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: C.z };
  }
  R.stage.classList.add("dragging");
}
function onMove(e) {
  if (!C || !C.ptrs.has(e.pointerId)) return;
  const prev = C.ptrs.get(e.pointerId), cur = stagePt(e);
  C.ptrs.set(e.pointerId, cur);
  if (C.ptrs.size === 1) { C.ox += cur.x - prev.x; C.oy += cur.y - prev.y; clampPos(); paint(); }
  else if (C.pinch) {
    const [a, b] = [...C.ptrs.values()];
    zoomTo(C.pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / C.pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
}
function onUp(e) {
  if (!C) return;
  C.ptrs.delete(e.pointerId);
  if (C.ptrs.size < 2) C.pinch = null;
  if (!C.ptrs.size) R.stage.classList.remove("dragging");
}
function onWheel(e) {
  if (!C || !C.ready) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;  // Firefox reports lines
  const p = stagePt(e);
  zoomTo(C.z * Math.exp(-dy * 0.0015), p.x, p.y);
}
function onKey(e) {
  e.stopPropagation();                                       // room shortcuts (N/H/1-7…) stay quiet
  if (!C) return;
  if (e.key === "Escape") { e.preventDefault(); finish(null); return; }
  if (e.key === "Tab") { trapTab(e, R.root); return; }
  if (e.target !== R.stage || !C.ready) return;
  const step = e.shiftKey ? 32 : 8;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (mv) { e.preventDefault(); C.ox += mv[0]; C.oy += mv[1]; clampPos(); paint(); return; }
  if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(C.z * 1.1); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomTo(C.z / 1.1); }
  else if (e.key === "0") { e.preventDefault(); fit(); }
  else if (e.key === "Enter") { e.preventDefault(); confirm(); }
}
function trapTab(e, root) {
  const els = [...root.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !root.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}
function confirm() {
  if (!C || !C.ready) return;
  const s = C.base * C.z;
  const size = Math.max(1, Math.min(Math.round(C.stage / s), C.w, C.h));
  const x = Math.round(Math.min(Math.max(0, -C.ox / s), C.w - size));
  const y = Math.round(Math.min(Math.max(0, -C.oy / s), C.h - size));
  finish({ file: C.file, crop: { cropX: x, cropY: y, cropSize: size } });
}
function finish(result) {
  if (!C) return;
  const { resolve, ret, url } = C;
  C = null;
  R.root.classList.remove("open", "loading");
  R.root.hidden = true;
  document.documentElement.classList.remove("avc-lock");
  if (url) URL.revokeObjectURL(url);
  [R.img, ...R.pvs.map((p) => p.img)].forEach((i) => i.removeAttribute("src"));
  R.meta.textContent = "";
  resolve(result);
  if (ret && document.contains(ret)) ret.focus({ preventScroll: true });
}