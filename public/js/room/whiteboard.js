/* public/js/room/whiteboard.js   (v3: multi-board workspace)
 *
 * WORKSPACE   server keeps live boards (tabs) per room; saved boards live in Mongo.
 *             Everyone shares the tab list; each user has their own active tab + per-board camera.
 *             Board content loads lazily on first view (wb-board-sync → wb-board-snapshot).
 * WORLD       strokes/shapes/text are objects in world coordinates; camera {x,y,z} views them.
 *             The canvas fills its container; resizing only changes the viewport.
 * OBJECTS     tool = pen | eraser | shape(kind) | text.  ids are "userId:random" everywhere.
 * SELECTION   Alt+drag marquee, Alt+click toggle, drag inside the selection to move (auto-pans at edges).
 * TEXT        DOM contenteditable overlay (own native undo while focused); HTML allowlist-sanitised.
 */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { avColor, toast, esc, fmtBadge } from "./utils.js";
import { emit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
/* ── constants ──────────────────────────────────────── */
const WORLD_LIM = 50000;                 // keep in step with the server
const MIN_Z = 0.1, MAX_Z = 8;
const ERASER_MULT = 5;
const FLUSH_MS = 50, CURSOR_MS = 50, CURSOR_TTL = 5000;
const MAX_BATCH_PTS = 100, TOUCH_HOLD_MS = 90;
const DRAG_PX = 4;                       // travel before a click becomes a drag
const EDGE_PX = 48, EDGE_SPEED = 16;     // auto-pan zone / max px per frame
const SHAPES = ["line", "arrow", "rect", "square", "circle", "oval"];
const TEXT_MIN = 8, TEXT_MAX = 200, TEXT_PER_SLIDER = 4;
const MAX_SEL_IDS = 500;
const MM = { frac: 0.18, minW: 120, maxW: 220, minH: 80, maxH: 180, maxK: 4, minK: 1.6 };
const PAPER = "#fbfbf9";
/* ── tiny utils ─────────────────────────────────────── */
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const mkId = () => S.userId + ":" + Math.random().toString(36).slice(2, 12);
function toHex(c) {
  if (HEX.test(c)) return c.toLowerCase();
  const t = document.createElement("canvas").getContext("2d");
  t.fillStyle = c;
  return HEX.test(t.fillStyle) ? t.fillStyle : "#3b82f6";
}
const myColor = () => toHex(avColor(S.username));
/* rich-text allowlist (mirrors the server) */
const HTML_TAGS = new Set(["b", "strong", "i", "em", "u", "br", "div", "p", "span", "font"]);
const COLOR_OK = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;
function cleanHtml(html) {
  return String(html || "").slice(0, 6000).split(/(<[^>]*>)/).map((part) => {
    if (part[0] !== "<") return part.replace(/</g, "&lt;");
    const m = /^<(\/?)([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(part);
    if (!m || !HTML_TAGS.has(m[2].toLowerCase())) return "";
    const tag = m[2].toLowerCase();
    if (m[1]) return "</" + tag + ">";
    if (tag === "font") {
      const c = /\bcolor\s*=\s*["']?([^"'\s>]+)["']?/i.exec(m[3]);
      return c && COLOR_OK.test(c[1]) ? '<font color="' + c[1] + '">' : "<font>";
    }
    return "<" + tag + ">";
  }).join("");
}
/* ── state ──────────────────────────────────────────── */
let host, stage, canvas, ctx, textLayer, selLayer, cursorLayer, mini, mctx, zoomLabel;
let tabList, modalEl, popEl, marqueeEl;
const mlayer = document.createElement("canvas");            // minimap strokes (supports erasing)
const mlctx = mlayer.getContext("2d");
const cam = { x: 0, y: 0, z: 1 };
const view = { w: 0, h: 0, dpr: 1 };
let last = null, noShiftUntil = 0, needPlace = false;
const bstates = new Map();             // boardId → BoardState
let order = [];                        // tab order
let B = null;                          // active BoardState
let savedList = [];
let enabled = true;
let pendingActivate = null;
const tool = { kind: "pen", shape: "rect", color: null, size: 4 };
let drawing = null, pan = null, gesture = null, selOp = null, editing = null, textTap = null;
const touches = new Map();
let lastCursorAt = 0, clearArmed = null, miniDrag = null, miniMap = null, textSendT = null;
let pseudoFs = false, fsPlaceholder = null, modalCancel = null;
const cursors = new Map();             // uid → { el, name, x, y, t }
const textEls = new Map();             // active board: strokeId → element
const selEls = new Map();              // "me" | uid → element
const mkBoard = (m) => ({
  id: m.id, name: m.name, savedId: m.savedId || null, dirty: !!m.dirty,
  loaded: false, syncing: false, strokes: [], byId: new Map(),
  hist: { undo: 0, redo: 0 }, cam: null, selection: new Set(), remoteSel: new Map(),
});
/* ── render scheduling ──────────────────────────────── */
let rafId = 0, dirtyMain = false, dirtyMini = false;
function requestRender(main = true) {
  if (main) dirtyMain = true;
  dirtyMini = true;
  if (!rafId) rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (dirtyMain) { dirtyMain = false; drawMain(); }
    if (dirtyMini) { dirtyMini = false; drawMini(); }
  });
}
/* ═══════════════ GEOMETRY ═══════════════ */
const strokeWidth = (s) => (s.tool === "eraser" ? s.size * ERASER_MULT : s.size);
const selectable = (s) => s && !s.undone && !s.deleted && s.tool !== "eraser";
/* square / circle are the rect / oval constrained to a square anchored at the start corner */
function shapeRect(s) {
  let [x0, y0, x1, y1] = s.pts;
  if (s.kind === "square" || s.kind === "circle") {
    const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + (x1 < x0 ? -side : side);
    y1 = y0 + (y1 < y0 ? -side : side);
  }
  return [x0, y0, x1, y1];
}
function arrowHead(x0, y0, x1, y1, size) {
  const a = Math.atan2(y1 - y0, x1 - x0), hl = Math.max(14, size * 4);
  return [x1 - hl * Math.cos(a - 0.45), y1 - hl * Math.sin(a - 0.45), x1, y1,
          x1 - hl * Math.cos(a + 0.45), y1 - hl * Math.sin(a + 0.45)];
}
/* every object as polylines — used for bounds, hit-testing and marquee selection */
function outlines(s) {
  if (s.tool === "text") { const b = s.bb; return [[b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3], b[0], b[1]]]; }
  if (s.tool !== "shape") return [s.pts];
  if (s.kind === "line") return [s.pts];
  if (s.kind === "arrow") return [s.pts, arrowHead(s.pts[0], s.pts[1], s.pts[2], s.pts[3], s.size)];
  const [x0, y0, x1, y1] = shapeRect(s);
  if (s.kind === "rect" || s.kind === "square") return [[x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2, out = [];
  for (let i = 0; i <= 36; i++) { const a = (i / 36) * Math.PI * 2; out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
  return [out];
}
function recomputeBB(s) {
  if (s.tool === "text") {
    s.bb = [s.pts[0], s.pts[1], s.pts[0] + (s.w || 160), s.pts[1] + (s.h || s.size * 1.4)];
    return;
  }
  const pad = strokeWidth(s) / 2;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const pl of outlines(s)) for (let i = 0; i < pl.length; i += 2) {
    if (pl[i] < a) a = pl[i]; if (pl[i + 1] < b) b = pl[i + 1];
    if (pl[i] > c) c = pl[i]; if (pl[i + 1] > d) d = pl[i + 1];
  }
  s.bb = [a - pad, b - pad, c + pad, d + pad];
}
function growBB(s, from) {                                 // freehand: append-only bounds
  const pad = strokeWidth(s) / 2, p = s.pts, bb = s.bb;
  for (let i = from * 2; i < p.length; i += 2) {
    if (p[i] - pad < bb[0]) bb[0] = p[i] - pad;
    if (p[i + 1] - pad < bb[1]) bb[1] = p[i + 1] - pad;
    if (p[i] + pad > bb[2]) bb[2] = p[i] + pad;
    if (p[i + 1] + pad > bb[3]) bb[3] = p[i + 1] + pad;
  }
}
function translate(s, dx, dy) {                            // same delta for every member: distances preserved
  for (let i = 0; i < s.pts.length; i += 2) { s.pts[i] = r1(s.pts[i] + dx); s.pts[i + 1] = r1(s.pts[i + 1] + dy); }
  s.bb[0] += dx; s.bb[2] += dx; s.bb[1] += dy; s.bb[3] += dy;
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function segHitsRect(ax, ay, bx, by, x0, y0, x1, y1) {      // Liang–Barsky
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay, p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
function hitStroke(s, wx, wy, tol) {
  const b = s.bb;
  if (wx < b[0] - tol || wx > b[2] + tol || wy < b[1] - tol || wy > b[3] + tol) return false;
  if (s.tool === "text") return wx >= b[0] && wx <= b[2] && wy >= b[1] && wy <= b[3];
  const r = strokeWidth(s) / 2 + tol;
  for (const pl of outlines(s)) {
    if (pl.length === 2) { if (Math.hypot(wx - pl[0], wy - pl[1]) <= r) return true; continue; }
    for (let i = 0; i + 3 < pl.length; i += 2) if (distSeg(wx, wy, pl[i], pl[i + 1], pl[i + 2], pl[i + 3]) <= r) return true;
  }
  return false;
}
function hitRect(s, x0, y0, x1, y1) {
  const b = s.bb;
  if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) return false;
  if (s.tool === "text") return true;
  for (const pl of outlines(s)) {
    if (pl.length === 2) { if (pl[0] >= x0 && pl[0] <= x1 && pl[1] >= y0 && pl[1] <= y1) return true; continue; }
    for (let i = 0; i + 3 < pl.length; i += 2) if (segHitsRect(pl[i], pl[i + 1], pl[i + 2], pl[i + 3], x0, y0, x1, y1)) return true;
  }
  return false;
}
function hitTest(wx, wy) {                                 // topmost object under a world point
  const tol = 8 / cam.z;
  for (let i = B.strokes.length - 1; i >= 0; i--) {
    const s = B.strokes[i];
    if (selectable(s) && hitStroke(s, wx, wy, tol)) return s;
  }
  return null;
}
function boundsOf(ids) {
  let b = null;
  for (const id of ids) {
    const s = B.byId.get(id);
    if (!selectable(s)) continue;
    b = b ? [Math.min(b[0], s.bb[0]), Math.min(b[1], s.bb[1]), Math.max(b[2], s.bb[2]), Math.max(b[3], s.bb[3])] : [...s.bb];
  }
  return b;
}
/* ── object store ────────────────────────────────────── */
function addStroke(bs, s) {
  if (!s || typeof s.id !== "string" || bs.byId.has(s.id)) return null;
  if (!["pen", "eraser", "shape", "text"].includes(s.tool)) return null;
  let pts = (Array.isArray(s.pts) ? s.pts : []).filter((v) => Number.isFinite(v)).map((v) => clamp(v, -WORLD_LIM, WORLD_LIM));
  if (pts.length % 2) pts.pop();
  if (pts.length < 2) return null;
  const st = {
    id: s.id, tool: s.tool, color: HEX.test(s.color) ? s.color : "#000000",
    size: s.tool === "text" ? clamp(+s.size || 24, TEXT_MIN, TEXT_MAX) : clamp(+s.size || 4, 1, 40),
    undone: !!s.undone, deleted: !!s.deleted, html: "", w: 0, h: 0, bb: null,
  };
  if (s.tool === "shape") {
    st.kind = SHAPES.includes(s.kind) ? s.kind : "rect";
    pts = pts.length >= 4 ? [pts[0], pts[1], pts[2], pts[3]] : [pts[0], pts[1], pts[0], pts[1]];
  } else if (s.tool === "text") { pts = pts.slice(0, 2); st.html = cleanHtml(s.html); }
  st.pts = pts;
  if (s.tool === "pen" || s.tool === "eraser") { st.bb = [Infinity, Infinity, -Infinity, -Infinity]; growBB(st, 0); }
  else recomputeBB(st);
  bs.strokes.push(st); bs.byId.set(st.id, st);
  return st;
}
function pruneSelection() {
  if (!B) return;
  const before = B.selection.size;
  for (const id of [...B.selection]) if (!selectable(B.byId.get(id))) B.selection.delete(id);
  if (B.selection.size !== before) announceSelection();
}
function announceSelection() {
  if (B) emit("wb-select", { b: B.id, ids: [...B.selection].slice(0, MAX_SEL_IDS) });
}
function setSelection(ids) {
  B.selection = new Set(ids);
  announceSelection();
  syncSliderFromSelection();
  renderSelection();
  renderToolState();
}
const selectionIds = () => [...B.selection].filter((id) => selectable(B.byId.get(id)));
/* ═══════════════ CAMERA ═══════════════ */
function clampCam() {
  const vw = view.w / cam.z, vh = view.h / cam.z;
  cam.x = clamp(cam.x, -WORLD_LIM - vw / 2, WORLD_LIM - vw / 2);
  cam.y = clamp(cam.y, -WORLD_LIM - vh / 2, WORLD_LIM - vh / 2);
}
function placeOrigin() { cam.x = -view.w / (2 * cam.z); cam.y = -view.h / (2 * cam.z); needPlace = false; }
function zoomAt(factor, sx, sy) {
  const z2 = clamp(cam.z * factor, MIN_Z, MAX_Z);
  const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
  cam.z = z2; cam.x = wx - sx / z2; cam.y = wy - sy / z2;
  clampCam(); requestRender();
}
function centerOn(wx, wy) {
  cam.x = wx - view.w / (2 * cam.z); cam.y = wy - view.h / (2 * cam.z);
  clampCam(); requestRender();
}
function worldFromClient(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return [cam.x + (cx - r.left) / cam.z, cam.y + (cy - r.top) / cam.z];
}
const toWorld = (cx, cy) => {
  const [x, y] = worldFromClient(cx, cy);
  return [r1(clamp(x, -WORLD_LIM, WORLD_LIM)), r1(clamp(y, -WORLD_LIM, WORLD_LIM))];
};
/* Resize = change the viewport, never the drawing. Content keeps its place on SCREEN; the edge that
   moves clips it. (layout moved the container → shift by that; OS window top/left edge dragged → shift
   by the size delta. screenX/Y are only a trigger — amounts come from CSS-pixel sizes.) */
function reconcile() {
  const r = canvas.getBoundingClientRect();
  const cur = { w: canvas.clientWidth, h: canvas.clientHeight, left: r.left, top: r.top, sx: window.screenX, sy: window.screenY };
  if (!cur.w || !cur.h) { last = null; view.w = view.h = 0; return false; }
  if (last && performance.now() >= noShiftUntil) {
    let shiftX = cur.left - last.left, shiftY = cur.top - last.top;
    if (cur.w !== last.w && cur.sx !== last.sx) shiftX -= cur.w - last.w;
    if (cur.h !== last.h && cur.sy !== last.sy) shiftY -= cur.h - last.h;
    cam.x += shiftX / cam.z; cam.y += shiftY / cam.z;
  }
  last = cur;
  view.w = cur.w; view.h = cur.h; view.dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cur.w * view.dpr), bh = Math.round(cur.h * view.dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  if (needPlace) placeOrigin();
  clampCam();
  return true;
}
/* ═══════════════ RENDERING ═══════════════ */
function paint(s, from) {
  if (s.tool === "text") return;
  const erase = s.tool === "eraser";
  const w = Math.max(strokeWidth(s), 1 / cam.z);
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = erase ? "#000" : s.color;
  ctx.lineWidth = w; ctx.lineCap = ctx.lineJoin = "round";
  if (s.tool === "shape") paintShape(s);
  else {
    const p = s.pts, n = p.length / 2;
    if (n === 1) { ctx.beginPath(); ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2); ctx.fill(); }
    else {
      const start = Math.max(0, from - 1);
      ctx.beginPath(); ctx.moveTo(p[start * 2], p[start * 2 + 1]);
      for (let i = start + 1; i < n; i++) ctx.lineTo(p[i * 2], p[i * 2 + 1]);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}
function paintShape(s) {
  ctx.beginPath();
  if (s.kind === "line" || s.kind === "arrow") {
    const [x0, y0, x1, y1] = s.pts;
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    if (s.kind === "arrow") { const h = arrowHead(x0, y0, x1, y1, s.size); ctx.moveTo(h[0], h[1]); ctx.lineTo(h[2], h[3]); ctx.lineTo(h[4], h[5]); }
  } else {
    const [x0, y0, x1, y1] = shapeRect(s);
    if (s.kind === "rect" || s.kind === "square") ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}
/* B / I / U reflect the formatting at the caret or under the selection */
function syncFormatButtons() {
  if (!host) return;
  host.querySelectorAll("[data-fmt]").forEach((b) => {
    b.disabled = !editing;
    let on = false;
    if (editing) {
      try { on = document.queryCommandState(b.dataset.fmt); } catch (_) { on = false; }
    }
    b.classList.toggle("is-on", on);
  });
}
function setWorldTransform() {
  const k = view.dpr * cam.z;
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
}
function drawIncr(s, from) {                                // live freehand segments; shapes/text repaint fully
  if (!view.w || s.undone || s.deleted) return;
  if (s.tool === "shape" || s.tool === "text") { requestRender(); return; }
  ctx.save(); setWorldTransform(); paint(s, from); ctx.restore();
}
function syncGrid() {                                       // CSS dot grid registered to world coordinates
  let g = 40;
  while (g * cam.z < 16) g *= 2;
  const s = g * cam.z;
  canvas.style.backgroundSize = s + "px " + s + "px";
  canvas.style.backgroundPosition =
    ((((-cam.x * cam.z - s / 2) % s) + s) % s) + "px " + ((((-cam.y * cam.z - s / 2) % s) + s) % s) + "px";
}
function drawMain() {
  if (!view.w) return;
  syncGrid();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (B && B.loaded) {
    ctx.save(); setWorldTransform();
    const m = 2 / cam.z;
    const x0 = cam.x - m, y0 = cam.y - m, x1 = cam.x + view.w / cam.z + m, y1 = cam.y + view.h / cam.z + m;
    for (const s of B.strokes) {
      if (s.undone || s.deleted || s.tool === "text") continue;
      if (s.bb[2] < x0 || s.bb[0] > x1 || s.bb[3] < y0 || s.bb[1] > y1) continue;   // culled, not lost
      paint(s, 0);
    }
    ctx.restore();
  }
  renderTexts(); renderSelection();
  cursors.forEach(placeCursor);
  if (zoomLabel) zoomLabel.textContent = Math.round(cam.z * 100) + "%";
  renderEmpty();
}
/* ── text layer (DOM) ── */
function measure(s, el) { s.w = el.offsetWidth; s.h = el.offsetHeight; recomputeBB(s); el._measured = true; }
function clearTextLayer() { textEls.forEach((el) => el.remove()); textEls.clear(); }
function renderTexts() {
  if (!B || !B.loaded) { clearTextLayer(); return; }
  const seen = new Set();
  const x0 = cam.x, y0 = cam.y, x1 = cam.x + view.w / cam.z, y1 = cam.y + view.h / cam.z;
  for (const s of B.strokes) {
    if (s.tool !== "text" || s.undone || s.deleted) continue;
    seen.add(s.id);
    let el = textEls.get(s.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "wb-text"; el.dataset.id = s.id;
      el.addEventListener("input", onTextInput);
      el.addEventListener("blur", onTextBlur);
      el.addEventListener("keydown", onTextKey);
      el.addEventListener("keyup", syncFormatButtons);
      el.addEventListener("paste", onTextPaste);
      textLayer.appendChild(el); textEls.set(s.id, el);
    }
    let changed = false;
    const isEd = editing && editing.s === s;
    if (el._html !== s.html && !isEd) { el.innerHTML = cleanHtml(s.html); el._html = s.html; changed = true; }
    if (el._size !== s.size) { el.style.fontSize = s.size + "px"; el._size = s.size; changed = true; }
    if (el._color !== s.color) { el.style.color = s.color; el._color = s.color; }
    const vis = !(s.bb[2] < x0 || s.bb[0] > x1 || s.bb[3] < y0 || s.bb[1] > y1);
    el.style.display = vis ? "" : "none";
    if (vis) {
      el.style.transform = "translate(" + (s.pts[0] - cam.x) * cam.z + "px," + (s.pts[1] - cam.y) * cam.z + "px) scale(" + cam.z + ")";
      if (changed || !el._measured) measure(s, el);
    }
  }
  for (const [id, el] of textEls) if (!seen.has(id)) { el.remove(); textEls.delete(id); }
}
/* ── selection boxes: mine + everyone else's (translucent, with a name flag) ── */
function renderSelection() {
  const want = new Map();
  if (B && B.loaded) {
    const mine = boundsOf(B.selection);
    if (mine) want.set("me", { b: mine, color: myColor(), label: "" });
    B.remoteSel.forEach((r, uid) => {
      const bb = boundsOf(r.ids);
      if (bb) want.set(uid, { b: bb, color: avColor(r.name), label: r.name });
    });
  }
  want.forEach((v, k) => {
    let el = selEls.get(k);
    if (!el) {
      el = document.createElement("div"); el.className = "wb-selbox"; el.innerHTML = "<span></span>";
      selLayer.appendChild(el); selEls.set(k, el);
    }
    el.style.left = (v.b[0] - cam.x) * cam.z - 6 + "px";
    el.style.top = (v.b[1] - cam.y) * cam.z - 6 + "px";
    el.style.width = (v.b[2] - v.b[0]) * cam.z + 12 + "px";
    el.style.height = (v.b[3] - v.b[1]) * cam.z + 12 + "px";
    el.style.setProperty("--c", v.color);
    el.firstChild.textContent = v.label;
    el.classList.toggle("is-mine", k === "me");
  });
  for (const [k, el] of selEls) if (!want.has(k)) { el.remove(); selEls.delete(k); }
}
/* ── minimap ── */
function drawMini() {
  if (!mini || !view.w || !enabled) return;
  const dpr = view.dpr;
  const mw = clamp(Math.round(view.w * MM.frac), MM.minW, MM.maxW);
  const mh = clamp(Math.round((mw * view.h) / view.w), MM.minH, MM.maxH);
  const bw = Math.round(mw * dpr), bh = Math.round(mh * dpr);
  if (mini.width !== bw || mini.height !== bh) {
    mini.width = mlayer.width = bw; mini.height = mlayer.height = bh;
    mini.style.width = mw + "px"; mini.style.height = mh + "px";
  }
  const vw = view.w / cam.z, vh = view.h / cam.z;
  let x0 = cam.x, y0 = cam.y, x1 = cam.x + vw, y1 = cam.y + vh;
  const list = B && B.loaded ? B.strokes : [];
  for (const s of list) {
    if (!selectable(s)) continue;
    if (s.bb[0] < x0) x0 = s.bb[0]; if (s.bb[1] < y0) y0 = s.bb[1];
    if (s.bb[2] > x1) x1 = s.bb[2]; if (s.bb[3] > y1) y1 = s.bb[3];
  }
  let ew = x1 - x0, eh = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (ew > vw * MM.maxK || eh > vh * MM.maxK) { cx = cam.x + vw / 2; cy = cam.y + vh / 2; ew = vw * MM.maxK; eh = vh * MM.maxK; }
  else { ew = Math.max(ew * 1.1, vw * MM.minK); eh = Math.max(eh * 1.1, vh * MM.minK); }
  const k = Math.min(mw / ew, mh / eh);
  const X = (wx) => mw / 2 + (wx - cx) * k, Y = (wy) => mh / 2 + (wy - cy) * k;
  const ex0 = cx - mw / 2 / k, ex1 = cx + mw / 2 / k, ey0 = cy - mh / 2 / k, ey1 = cy + mh / 2 / k;
  miniMap = { cx, cy, k, mw, mh };
  mlctx.setTransform(1, 0, 0, 1, 0, 0); mlctx.clearRect(0, 0, bw, bh);
  mlctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const minStep2 = (1.5 / k) * (1.5 / k);
  for (const s of list) {
    if (s.undone || s.deleted || s.bb[2] < ex0 || s.bb[0] > ex1 || s.bb[3] < ey0 || s.bb[1] > ey1) continue;
    if (s.tool === "text") {                                  // text = a pale box in the minimap
      mlctx.globalCompositeOperation = "source-over"; mlctx.fillStyle = "rgba(80,85,105,.35)";
      mlctx.fillRect(X(s.bb[0]), Y(s.bb[1]), Math.max(2, (s.bb[2] - s.bb[0]) * k), Math.max(2, (s.bb[3] - s.bb[1]) * k));
      continue;
    }
    const erase = s.tool === "eraser", w = Math.max(1, strokeWidth(s) * k);
    mlctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    mlctx.strokeStyle = mlctx.fillStyle = erase ? "#000" : s.color;
    mlctx.lineWidth = w; mlctx.lineCap = mlctx.lineJoin = "round";
    for (const p of outlines(s)) {
      const n = p.length / 2;
      if (n === 1) { mlctx.beginPath(); mlctx.arc(X(p[0]), Y(p[1]), w / 2, 0, Math.PI * 2); mlctx.fill(); continue; }
      mlctx.beginPath(); mlctx.moveTo(X(p[0]), Y(p[1]));
      let lx = p[0], ly = p[1];
      for (let i = 1; i < n; i++) {
        const x = p[i * 2], y = p[i * 2 + 1], dx = x - lx, dy = y - ly;
        if (dx * dx + dy * dy < minStep2 && i < n - 1) continue;
        mlctx.lineTo(X(x), Y(y)); lx = x; ly = y;
      }
      mlctx.stroke();
    }
  }
  mlctx.globalCompositeOperation = "source-over";
  mctx.setTransform(1, 0, 0, 1, 0, 0);                       // opaque: solid paper first
  mctx.fillStyle = PAPER; mctx.fillRect(0, 0, bw, bh);
  mctx.drawImage(mlayer, 0, 0);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const accent = getComputedStyle(host).getPropertyValue("--acc").trim() || "#6366f1";
  const rx = X(cam.x), ry = Y(cam.y), rw = vw * k, rh = vh * k;
  mctx.globalAlpha = 0.14; mctx.fillStyle = accent; mctx.fillRect(rx, ry, rw, rh);
  mctx.globalAlpha = 1; mctx.strokeStyle = accent; mctx.lineWidth = 1.5;
  mctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(1, rw - 1.5), Math.max(1, rh - 1.5));
}
function jumpFromMini(e) {
  if (!miniDrag) return;
  const r = mini.getBoundingClientRect(), m = miniDrag.map;
  centerOn(m.cx + (e.clientX - r.left - m.mw / 2) / m.k, m.cy + (e.clientY - r.top - m.mh / 2) / m.k);
}
function renderEmpty() {
  const el = $("wbEmpty");
  if (!el) return;
  const manage = !!(S.perms && S.perms.canManageBoards);
  let msg = "";
  if (!B) msg = manage ? "No board is open. Create one with ＋, or open a saved one from 📂."
                       : "No board is open. Ask the host to open one.";
  else if (!B.loaded) msg = "Loading board…";
  el.textContent = msg;
  el.hidden = !msg;
}
/* ═══════════════ FREEHAND / SHAPE DRAWING ═══════════════ */
function flush() {
  const d = drawing;
  if (!d) return;
  clearTimeout(d.timer); d.timer = null;
  while (d.pending.length) emit("wb-stroke-points", { b: B.id, id: d.stroke.id, pts: d.pending.splice(0, MAX_BATCH_PTS * 2) });
}
function noteOp() { B.hist.undo++; B.hist.redo = 0; renderToolState(); }       // mirrors the server; wb-history corrects drift
function commitStroke() {                                   // first network emission of this object
  const d = drawing;
  if (!d || d.started) return;
  clearTimeout(d.hold);
  d.started = true;
  const s = d.stroke;
  emit("wb-stroke-start", { b: B.id, id: s.id, tool: s.tool, kind: s.kind, color: s.color, size: s.size, pts: [s.pts[0], s.pts[1]] });
  if (s.tool === "shape") d.pending = s.pts[2] !== s.pts[0] || s.pts[3] !== s.pts[1] ? [s.pts[2], s.pts[3]] : [];
  else d.pending = s.pts.slice(2);
  noteOp();
  flush();
}
function finishStroke() {
  const d = drawing;
  if (!d) return;
  if (d.stroke.tool === "shape" && !d.started) return discardStroke();     // a click, not a drag
  commitStroke(); flush();
  drawing = null;
}
function discardStroke() {
  const d = drawing;
  if (!d) return;
  clearTimeout(d.hold); clearTimeout(d.timer);
  B.strokes = B.strokes.filter((s) => s !== d.stroke);
  B.byId.delete(d.stroke.id);
  drawing = null;
  requestRender();
}
function startStroke(e) {
  const [x, y] = toWorld(e.clientX, e.clientY);
  const isShape = tool.kind === "shape";
  const s = addStroke(B, { id: mkId(), tool: tool.kind, kind: isShape ? tool.shape : undefined,
                           color: tool.color || myColor(), size: tool.size, pts: [x, y] });
  if (!s) return;
  drawing = { stroke: s, pending: [], timer: null, hold: null, pid: e.pointerId, started: false };
  canvas.setPointerCapture(e.pointerId);
  drawIncr(s, 0);
  if (isShape) return;                                      // shapes commit on first movement
  if (e.pointerType === "touch") drawing.hold = setTimeout(commitStroke, TOUCH_HOLD_MS);
  else commitStroke();
}
function addPoint(x, y) {
  const d = drawing, s = d.stroke;
  if (s.tool === "shape") {
    if (x === s.pts[2] && y === s.pts[3]) return;
    s.pts[2] = x; s.pts[3] = y; recomputeBB(s);
    if (!d.started) commitStroke();
    else { d.pending = [x, y]; if (!d.timer) d.timer = setTimeout(flush, FLUSH_MS); }
    requestRender();
    return;
  }
  const n = s.pts.length / 2;
  const dx = x - s.pts[n * 2 - 2], dy = y - s.pts[n * 2 - 1];
  const minDist = Math.min(2, 1.5 / cam.z);
  if (dx * dx + dy * dy < minDist * minDist) return;
  s.pts.push(x, y); growBB(s, n); drawIncr(s, n);
  if (d.started) { d.pending.push(x, y); if (!d.timer) d.timer = setTimeout(flush, FLUSH_MS); }
  requestRender(false);
}
/* ═══════════════ SELECTION · MARQUEE · GROUP MOVE ═══════════════ */
function startSelOp(e, inSel, plainMove) {
  const [wx, wy] = worldFromClient(e.clientX, e.clientY);
  selOp = { pid: e.pointerId, mode: "pending", inSel, sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY,
            startW: [wx, wy], applied: { x: 0, y: 0 }, pend: { x: 0, y: 0 }, timer: null, raf: 0, ids: null, shift: e.shiftKey, rect: null };
  canvas.setPointerCapture(e.pointerId);
  if (plainMove) beginMove();
}
function beginMove() {
  selOp.mode = "move"; selOp.ids = selectionIds().slice(0, MAX_SEL_IDS);
  canvas.classList.add("is-moving");
  selTick();
}
function selTick() {
  const o = selOp;
  if (!o) return;
  o.raf = 0;
  if (o.mode !== "move" && o.mode !== "marquee") return;
  /* edge auto-pan: pointer near/over the edge scrolls the camera so the drag can go past what's visible */
  const r = canvas.getBoundingClientRect(), lx = o.cx - r.left, ly = o.cy - r.top;
  const push = (v, max) => (v < EDGE_PX ? -(EDGE_PX - v) : v > max - EDGE_PX ? v - (max - EDGE_PX) : 0);
  const vx = push(lx, r.width), vy = push(ly, r.height);
  if (vx || vy) {
    cam.x += (clamp(vx / EDGE_PX, -1.5, 1.5) * EDGE_SPEED) / cam.z;
    cam.y += (clamp(vy / EDGE_PX, -1.5, 1.5) * EDGE_SPEED) / cam.z;
    clampCam(); requestRender();
  }
  const [wx, wy] = worldFromClient(o.cx, o.cy);               // re-derived every frame: follows the camera
  if (o.mode === "move") moveTo(wx, wy); else marqueeTo(wx, wy);
  o.raf = requestAnimationFrame(selTick);
}
function moveTo(wx, wy) {
  const o = selOp;
  let dx = r1(wx - o.startW[0] - o.applied.x), dy = r1(wy - o.startW[1] - o.applied.y);
  const bb = boundsOf(o.ids);
  if (bb) {                                                   // clamp the GROUP so relative distances survive the world edge
    dx = r1(clamp(dx, -WORLD_LIM - bb[0], WORLD_LIM - bb[2]));
    dy = r1(clamp(dy, -WORLD_LIM - bb[1], WORLD_LIM - bb[3]));
  }
  if (!dx && !dy) return;
  for (const id of o.ids) { const s = B.byId.get(id); if (s) translate(s, dx, dy); }
  o.applied.x = r1(o.applied.x + dx); o.applied.y = r1(o.applied.y + dy);
  o.pend.x = r1(o.pend.x + dx); o.pend.y = r1(o.pend.y + dy);
  if (!o.timer) o.timer = setTimeout(flushMove, FLUSH_MS);
  requestRender();
}
function flushMove() {
  const o = selOp;
  if (!o) return;
  clearTimeout(o.timer); o.timer = null;
  if (o.pend.x || o.pend.y) { emit("wb-move", { b: B.id, ids: o.ids, dx: o.pend.x, dy: o.pend.y }); o.pend.x = o.pend.y = 0; }
}
function marqueeTo(wx, wy) {
  const o = selOp;
  o.rect = [Math.min(o.startW[0], wx), Math.min(o.startW[1], wy), Math.max(o.startW[0], wx), Math.max(o.startW[1], wy)];
  const r = o.rect;
  marqueeEl.hidden = false;
  marqueeEl.style.left = (r[0] - cam.x) * cam.z + "px"; marqueeEl.style.top = (r[1] - cam.y) * cam.z + "px";
  marqueeEl.style.width = (r[2] - r[0]) * cam.z + "px"; marqueeEl.style.height = (r[3] - r[1]) * cam.z + "px";
}
function endSelOp(cancel) {
  const o = selOp;
  if (!o) return;
  selOp = null;
  cancelAnimationFrame(o.raf);
  canvas.classList.remove("is-moving");
  marqueeEl.hidden = true;
  if (o.mode === "move") {
    clearTimeout(o.timer);
    if (o.pend.x || o.pend.y) emit("wb-move", { b: B.id, ids: o.ids, dx: o.pend.x, dy: o.pend.y });
    emit("wb-move-end", { b: B.id });
    if (o.applied.x || o.applied.y) noteOp();
  } else if (o.mode === "marquee" && !cancel && o.rect) {
    const [x0, y0, x1, y1] = o.rect;
    const hit = B.strokes.filter((s) => selectable(s) && hitRect(s, x0, y0, x1, y1)).map((s) => s.id);
    setSelection(o.shift ? [...B.selection, ...hit] : hit);
  } else if (o.mode === "pending" && !cancel) {               // a click: toggle the object under it, or clear
    const h = hitTest(o.startW[0], o.startW[1]);
    if (h) { const next = new Set(B.selection); next.has(h.id) ? next.delete(h.id) : next.add(h.id); setSelection([...next]); }
    else if (!o.shift && B.selection.size) setSelection([]);
  }
}
function deleteSelection() {
  const ids = selectionIds();
  if (!ids.length) return;
  emit("wb-delete", { b: B.id, ids });
  noteOp();
  setSelection([]);
}
/* ═══════════════ TEXT ═══════════════ */
function sizableText() {
  if (editing) return editing.s;
  if (B && B.selection.size === 1) {
    const s = B.byId.get([...B.selection][0]);
    if (s && s.tool === "text" && selectable(s)) return s;
  }
  return null;
}
function sendText(s) {
  if (!B || !s) return;
  emit("wb-text-update", { b: B.id, id: s.id, html: s.html, size: s.size, color: s.color });
}
function queueTextSend(s) { clearTimeout(textSendT); textSendT = setTimeout(() => sendText(s), 250); }
function setTextSize(s, v) {
  s.size = clamp(Math.round(v), TEXT_MIN, TEXT_MAX);
  queueTextSend(s); syncSliderFromSelection(); requestRender();
}
function syncSliderFromSelection() {
  const t = sizableText(), sl = $("wbSize");
  if (t && sl) sl.value = clamp(Math.round(t.size / TEXT_PER_SLIDER), +sl.min, +sl.max);
}
function openTextAt(wx, wy) {
  const hit = hitTest(wx, wy);
  if (hit && hit.tool === "text") { setSelection([hit.id]); return beginEdit(hit, false); }
  const s = addStroke(B, { id: mkId(), tool: "text", color: tool.color || myColor(),
                           size: clamp(tool.size * TEXT_PER_SLIDER, TEXT_MIN, TEXT_MAX), pts: [wx, wy], html: "" });
  if (s) { renderTexts(); beginEdit(s, true); }
}
function beginEdit(s, isNew) {
  endEdit();
  renderTexts();
  const el = textEls.get(s.id);
  if (!el) return;
  editing = { s, el, started: !isNew, range: null };
  el.contentEditable = "true";
  el.classList.add("is-editing");
  el.style.pointerEvents = "auto";
  el.focus();
  const sel = window.getSelection(), rg = document.createRange();   // caret at the end
  rg.selectNodeContents(el); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg);
  renderToolState();
}
function endEdit() {
  if (!editing) return;
  const { s, el, started } = editing;
  editing = null;
  el.contentEditable = "false"; el.classList.remove("is-editing"); el.style.pointerEvents = "none";
  clearTimeout(textSendT);
  if (!el.textContent.trim()) {
    if (!started) { B.strokes = B.strokes.filter((x) => x !== s); B.byId.delete(s.id); }   // never sent: just drop it
    else { emit("wb-delete", { b: B.id, ids: [s.id] }); noteOp(); }
  } else if (started) sendText(s);
  window.getSelection().removeAllRanges();
  renderToolState(); requestRender();
}
function onTextInput() {
  if (!editing) return;
  syncFormatButtons();
  const { s, el } = editing;
  s.html = cleanHtml(el.innerHTML); el._html = s.html;
  measure(s, el);
  if (!editing.started) {
    if (!el.textContent.trim()) return;
    editing.started = true;                                   // first real content → create it for everyone
    emit("wb-stroke-start", { b: B.id, id: s.id, tool: "text", color: s.color, size: s.size, pts: [s.pts[0], s.pts[1]], html: s.html });
    noteOp();
  } else queueTextSend(s);
  requestRender(false);
}
function onTextBlur(e) {
  if (!editing || e.currentTarget !== editing.el) return;
  if (e.relatedTarget && host.contains(e.relatedTarget)) return;   // focus moved to a toolbar control (e.g. colour picker)
  endEdit();
}
function onTextKey(e) { if (e.key === "Escape") { e.stopPropagation(); endEdit(); } }
function onTextPaste(e) {                                     // plain text only: no foreign markup
  e.preventDefault();
  document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain"));
}
function saveRange() {
  if (!editing) return;
  const sel = window.getSelection();
  if (sel.rangeCount && editing.el.contains(sel.anchorNode)) editing.range = sel.getRangeAt(0).cloneRange();
  syncFormatButtons();
}
function restoreRange() {
  if (!editing || !editing.range) return;
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(editing.range);
}
function formatText(cmd) {
  if (!editing) return;
  editing.el.focus();
  document.execCommand("styleWithCSS", false, false);          // → <b>/<i>/<u>/<font>, which the sanitiser keeps
  document.execCommand(cmd);
  onTextInput();
  syncFormatButtons();
}
function applyColor(color) {
  tool.color = color;
  if (editing) {
    editing.el.focus(); restoreRange();
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("foreColor", false, color);          // colours the selection (or what you type next)
    onTextInput();
  } else {
    const t = sizableText();
    if (t) { t.color = color; queueTextSend(t); requestRender(); }
  }
}
/* ═══════════════ POINTER / WHEEL / KEYS ═══════════════ */
function beginGesture() {
  if (drawing) { if (!drawing.started) discardStroke(); else finishStroke(); }
  if (selOp) endSelOp(selOp.mode !== "move");
  const [a, b] = [...touches.values()];
  gesture = a && b ? { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 } : null;
}
function updateGesture() {
  const [a, b] = [...touches.values()];
  if (!a || !b || !gesture) return;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = worldFromClient(gesture.cx, gesture.cy);
  cam.z = clamp(cam.z * (dist / gesture.dist), MIN_Z, MAX_Z);
  cam.x = wx - (cx - r.left) / cam.z; cam.y = wy - (cy - r.top) / cam.z;
  gesture = { cx, cy, dist };
  clampCam(); requestRender();
}
function onDown(e) {
  if (!enabled || !view.w || !B || !B.loaded) return;
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) return beginGesture();
    if (touches.size > 2) return;
  } else if (e.button === 2 || e.button === 1) {              // right / middle: pan
    e.preventDefault();
    pan = { pid: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId); canvas.classList.add("is-panning");
    return;
  } else if (e.button !== 0) return;
  if (editing) endEdit();
  const [wx, wy] = worldFromClient(e.clientX, e.clientY);
  const sb = B.selection.size ? boundsOf(B.selection) : null, tol = 6 / cam.z;
  const inSel = !!sb && wx >= sb[0] - tol && wx <= sb[2] + tol && wy >= sb[1] - tol && wy <= sb[3] + tol;
  if (e.altKey || tool.kind === "select") return startSelOp(e, inSel, false);
  if (inSel) return startSelOp(e, true, true);               // plain drag inside the selection moves it
  if (B.selection.size) setSelection([]);
  if (tool.kind === "text") {                                 // create/edit on pointer-UP (focus survives the click)
    textTap = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, wx, wy };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  startStroke(e);
}
function onMove(e) {
  if (e.pointerType === "touch") {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture && touches.size >= 2) return updateGesture();
  }
  if (pan && e.pointerId === pan.pid) {
    cam.x -= (e.clientX - pan.x) / cam.z; cam.y -= (e.clientY - pan.y) / cam.z;
    pan.x = e.clientX; pan.y = e.clientY;
    clampCam(); requestRender();
  } else if (selOp && e.pointerId === selOp.pid) {
    selOp.cx = e.clientX; selOp.cy = e.clientY;
    if (selOp.mode === "pending" && Math.hypot(e.clientX - selOp.sx, e.clientY - selOp.sy) > DRAG_PX) {
      if (selOp.inSel) beginMove(); else { selOp.mode = "marquee"; selTick(); }
    }
  } else if (drawing && e.pointerId === drawing.pid) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    for (const ev of evs && evs.length ? evs : [e]) { const [x, y] = toWorld(ev.clientX, ev.clientY); addPoint(x, y); }
  }
  const now = performance.now();
  if (enabled && B && e.pointerType !== "touch" && now - lastCursorAt >= CURSOR_MS) {
    lastCursorAt = now;
    const [x, y] = toWorld(e.clientX, e.clientY);
    emit("wb-cursor", { b: B.id, x, y });
  }
}
function onUp(e) {
  if (e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (touches.size < 2) gesture = null; else beginGesture();
  }
  if (pan && e.pointerId === pan.pid) { pan = null; canvas.classList.remove("is-panning"); return; }
  if (selOp && e.pointerId === selOp.pid) return endSelOp(false);
  if (textTap && e.pointerId === textTap.pid) {
    const t = textTap; textTap = null;
    if (Math.hypot(e.clientX - t.sx, e.clientY - t.sy) <= DRAG_PX) openTextAt(t.wx, t.wy);
    return;
  }
  if (drawing && e.pointerId === drawing.pid) finishStroke();
}
function onWheel(e) {
  e.preventDefault();                                         // also blocks the browser's own Ctrl+wheel page zoom
  if (!view.w) return;
  const r = canvas.getBoundingClientRect();
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= r.width; dy *= r.height; }
  if (e.ctrlKey) {
    const t = sizableText();                                  // Ctrl+wheel resizes a focused / selected text box…
    if (t) return setTextSize(t, t.size * Math.exp(-dy * 0.0015) + (Math.abs(dy) < 1 ? 0 : Math.sign(-dy) * 0.5));
    zoomAt(Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top);   // …otherwise it zooms the board
  } else { cam.x += dx / cam.z; cam.y += dy / cam.z; clampCam(); requestRender(); }
}
const undo = () => { if (enabled && B && !drawing && !selOp && B.hist.undo > 0) emit("wb-undo", { b: B.id }); };
const redo = () => { if (enabled && B && !drawing && !selOp && B.hist.redo > 0) emit("wb-redo", { b: B.id }); };
function onKey(e) {
  if (S.roomType !== "study" || !enabled) return;
  if (e.key === "Escape") {
    if (modalCancel) { modalCancel(); return; }
    if (!popEl.hidden) { popEl.hidden = true; return; }
    if (editing) return;                                      // the text box handles its own Esc
    if (B && B.selection.size) { setSelection([]); return; }
    if (pseudoFs) toggleFs();
    return;
  }
  if (!view.w) return;
  const t = e.target;
  if (t && t.closest && t.closest("textarea, [contenteditable='true'], input:not([type=range]):not([type=color])")) return;
  if ((e.key === "Delete" || e.key === "Backspace") && B && B.selection.size) { e.preventDefault(); deleteSelection(); return; }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
  else if (k === "s" && B && S.perms && S.perms.canManageBoards) { e.preventDefault(); emit("wb-board-save", { b: B.id }); }
}
/* ═══════════════ REMOTE CURSORS ═══════════════ */
function placeCursor(c) { c.el.style.transform = "translate(" + (c.x - cam.x) * cam.z + "px," + (c.y - cam.y) * cam.z + "px)"; }
function dropCursor(uid) { const c = cursors.get(uid); if (c) { c.el.remove(); cursors.delete(uid); } }
function clearCursors() { [...cursors.keys()].forEach(dropCursor); }
function showCursor({ uid, name, x, y, b }) {
  if (!enabled || S.userId === uid || !B || b !== B.id) return dropCursor(uid);   // only people on MY board
  if (x == null || y == null) return dropCursor(uid);
  let c = cursors.get(uid);
  if (!c) {
    const el = document.createElement("div");
    el.className = "wb-cursor"; el.style.setProperty("--c", avColor(name));
    el.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1 1l5.5 14 2.2-5.6L14 7z"/></svg><span></span>';
    el.querySelector("span").textContent = name || "?";
    cursorLayer.appendChild(el);
    c = { el, name, x, y, t: 0 }; cursors.set(uid, c);
  }
  c.x = x; c.y = y; c.t = Date.now();
  placeCursor(c);
}
/* ═══════════════ BOARDS · TABS · DIALOGS ═══════════════ */
const canManage = () => !!(S.perms && S.perms.canManageBoards);
function requestBoardSync(bs) {
  if (bs.syncing) return;
  bs.syncing = true;
  emit("wb-board-sync", { b: bs.id });
}
function cancelOps() {
  if (editing) endEdit();
  if (drawing) { if (drawing.started) finishStroke(); else discardStroke(); }
  if (selOp) endSelOp(selOp.mode !== "move");
  touches.clear(); gesture = null; pan = null; textTap = null;
}
function activate(id) {
  if (B && B.id === id) return;
  cancelOps();
  if (B) {
    B.cam = needPlace ? null : { x: cam.x, y: cam.y, z: cam.z };
    if (B.selection.size) { emit("wb-select", { b: B.id, ids: [] }); B.selection = new Set(); }
  }
  B = id ? bstates.get(id) || null : null;
  clearTextLayer(); clearCursors();
  if (B) {
    if (B.cam) { Object.assign(cam, B.cam); needPlace = false; }
    else { cam.z = 1; needPlace = true; if (view.w) placeOrigin(); }
    if (!B.loaded) requestBoardSync(B);
  }
  clampCam(); renderWorkspaceUI(); renderToolState(); requestRender();
  const tab = tabList && tabList.querySelector(".is-active");
  if (tab) tab.scrollIntoView({ inline: "nearest", block: "nearest" });
}
function applyWorkspace(p) {
  if (!p || !Array.isArray(p.boards)) return;
  setEnabled(p.enabled !== false);
  order = p.boards.map((m) => m.id);
  for (const m of p.boards) {
    const bs = bstates.get(m.id);
    if (bs) { bs.name = m.name; bs.savedId = m.savedId || null; bs.dirty = !!m.dirty; }
    else bstates.set(m.id, mkBoard(m));
  }
  for (const id of [...bstates.keys()]) if (!order.includes(id)) bstates.delete(id);
  savedList = Array.isArray(p.saved) ? p.saved : [];
  if (pendingActivate && bstates.has(pendingActivate)) { const id = pendingActivate; pendingActivate = null; activate(id); }
  else if (!B || !bstates.has(B.id)) { B = null; activate(order[0] || null); }
  else B = bstates.get(B.id);
  if (B && !B.loaded) requestBoardSync(B);
  renderWorkspaceUI(); renderToolState(); requestRender();
}
/* promise-based dialog that lives inside the board (so it also works in fullscreen) */
function modal({ title, text, buttons }) {
  return new Promise((resolve) => {
    modalEl.innerHTML = '<div class="wb-modal-card" role="dialog" aria-modal="true"><h4>' + esc(title) + "</h4><p>" + esc(text) +
      '</p><div class="wb-modal-acts">' + buttons.map((b, i) =>
        '<button type="button" class="wb-mbtn ' + (b.kind || "") + '" data-i="' + i + '">' + esc(b.label) + "</button>").join("") + "</div></div>";
    modalEl.hidden = false;
    const done = (v) => { modalEl.hidden = true; modalEl.innerHTML = ""; modalEl.onclick = null; modalCancel = null; resolve(v); };
    modalCancel = () => done(null);
    modalEl.onclick = (e) => {
      const b = e.target.closest("[data-i]");
      if (b) done(buttons[+b.dataset.i].v); else if (e.target === modalEl) done(null);
    };
    const first = modalEl.querySelector(".primary, .wb-mbtn");
    if (first) first.focus();
  });
}
async function requestClose(id) {
  const bs = bstates.get(id);
  if (!bs || !canManage()) return;
  let mode = "discard";
  if (bs.dirty) {                                             // protect unsaved work
    const r = await modal({ title: "Unsaved changes", text: "“" + bs.name + "” has unsaved changes. What do you want to do?",
      buttons: [{ label: "Save & close", v: "save", kind: "primary" }, { label: "Discard", v: "discard", kind: "danger" }, { label: "Cancel", v: null }] });
    if (!r) return;
    mode = r;
  }
  emit("wb-board-close", { b: id, mode });
}
async function openSaved(savedId) {
  if (!canManage()) return;
  const live = order.map((id) => bstates.get(id)).find((b) => b.savedId === savedId);
  if (!live) return emit("wb-board-open", { savedId });
  if (!live.dirty) return activate(live.id);
  const r = await modal({ title: "Board already open",
    text: "“" + live.name + "” is open with unsaved changes. Reloading the saved copy would overwrite them.",
    buttons: [{ label: "Switch to open tab", v: "switch", kind: "primary" }, { label: "Discard changes & reload", v: "reload", kind: "danger" }, { label: "Cancel", v: null }] });
  if (r === "switch") activate(live.id);
  else if (r === "reload") emit("wb-board-open", { savedId, reload: true });
}
async function deleteSaved(savedId) {
  const s = savedList.find((x) => x.id === savedId);
  if (!s || !canManage()) return;
  const ok = await modal({ title: "Delete saved board?", text: "“" + s.name + "” will be removed for everyone. Open copies stay open as unsaved boards.",
    buttons: [{ label: "Delete", v: true, kind: "danger" }, { label: "Cancel", v: null }] });
  if (ok) emit("wb-saved-delete", { savedId });
}
function renameBoard(id) {
  const bs = bstates.get(id);
  if (!bs || !canManage()) return;
  const n = (window.prompt("Board name", bs.name) || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (n && n !== bs.name) emit("wb-board-rename", { b: id, name: n });
}
const fmtWhen = (t) => { try { return new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch (_) { return ""; } };
function renderTabs() {
  if (!tabList) return;
  const manage = canManage();
  tabList.innerHTML = order.map((id) => {
    const b = bstates.get(id);
    return '<div class="wb-tab' + (B && B.id === id ? " is-active" : "") + '" role="tab" data-b="' + esc(id) + '" title="' + esc(b.name) + '">' +
      (b.dirty ? '<i class="wb-dot" title="Unsaved changes"></i>' : "") +
      '<span class="wb-tab-name">' + esc(b.name) + "</span>" +
      (manage ? '<button type="button" class="wb-tab-x" data-x="' + esc(id) + '" aria-label="Close board">×</button>' : "") + "</div>";
  }).join("");
}
function boardRowsHTML() {
  const manage = canManage();
  const openSaved_ = new Set(order.map((id) => bstates.get(id).savedId).filter(Boolean));
  let h = "";
  if (order.length) {
    h += '<div class="bp-sec">Open now</div>';
    order.forEach((id) => {
      const b = bstates.get(id);
      h += '<div class="bp-row' + (B && B.id === id ? " is-active" : "") + '">' +
        '<button type="button" class="bp-main" data-act="switch" data-b="' + esc(id) + '"><span class="bp-name">' + esc(b.name) +
        '</span><span class="bp-meta">' + (b.dirty ? "● Unsaved changes" : b.savedId ? "Saved" : "Not saved yet") + "</span></button>" +
        (manage ? '<span class="bp-acts"><button type="button" class="bp-act" data-act="save" data-b="' + esc(id) + '" title="Save">💾</button>' +
          '<button type="button" class="bp-act" data-act="rename" data-b="' + esc(id) + '" title="Rename">✎</button>' +
          '<button type="button" class="bp-act" data-act="close" data-b="' + esc(id) + '" title="Close">✕</button></span>' : "") + "</div>";
    });
  }
  const rest = savedList.filter((s) => !openSaved_.has(s.id));
  if (rest.length) {
    h += '<div class="bp-sec">Saved</div>';
    rest.forEach((s) => {
      h += '<div class="bp-row"><div class="bp-main bp-static"><span class="bp-name">' + esc(s.name) + '</span><span class="bp-meta">' +
        s.count + " objects" + (s.by ? " · " + esc(s.by) : "") + (s.updatedAt ? " · " + esc(fmtWhen(s.updatedAt)) : "") + "</span></div>" +
        (manage ? '<span class="bp-acts"><button type="button" class="bp-act bp-txt" data-act="open" data-s="' + esc(s.id) + '">Open</button>' +
          '<button type="button" class="bp-act" data-act="del" data-s="' + esc(s.id) + '" title="Delete saved board">🗑</button></span>' : "") + "</div>";
    });
  }
  return h || '<div class="bp-empty">No boards yet.</div>';
}
function renderBoardsPane() {
  const list = $("bpList");
  if (list) list.innerHTML = boardRowsHTML();
  if (popEl && !popEl.hidden) popEl.innerHTML = boardRowsHTML();
  const badge = $("boardCount");
  if (badge) { badge.textContent = fmtBadge(order.length); badge.dataset.zero = order.length ? "0" : "1"; }
  const nb = $("bpNew");
  if (nb) nb.hidden = !canManage();
}
function renderWorkspaceUI() {
  renderTabs(); renderBoardsPane();
  const manage = canManage();
  $("wbTabAdd").hidden = !manage;
  const sv = $("wbSave");
  sv.hidden = !manage;
  sv.disabled = !B || (!B.dirty && !!B.savedId);
  renderEmpty();
}
function onBoardAction(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const { act, b, s } = el.dataset;
  if (act === "switch") { activate(b); if (popEl) popEl.hidden = true; }
  else if (act === "save") emit("wb-board-save", { b });
  else if (act === "rename") renameBoard(b);
  else if (act === "close") requestClose(b);
  else if (act === "open") { openSaved(s); popEl.hidden = true; }
  else if (act === "del") deleteSaved(s);
}
/* ═══════════════ FULLSCREEN ═══════════════ */
const isFs = () => document.fullscreenElement === host || pseudoFs;
function applyFs() {
  noShiftUntil = performance.now() + 500;                     // keep the camera as-is while the container changes size
  last = null;
  host.classList.toggle("is-fs", isFs());
  const b = $("wbFs");
  b.textContent = isFs() ? "🗗" : "⛶";
  b.title = isFs() ? "Exit fullscreen (Esc)" : "Fullscreen";
}
async function toggleFs() {
  if (isFs()) {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) {} }
    if (pseudoFs) {                                            // put the board back where it lives
      pseudoFs = false;
      if (fsPlaceholder) { fsPlaceholder.replaceWith(host); fsPlaceholder = null; }
    }
    return applyFs();
  }
  noShiftUntil = performance.now() + 500; last = null;
  if (host.requestFullscreen) { try { await host.requestFullscreen(); return applyFs(); } catch (_) { /* fall through */ } }
  /* fallback (e.g. iPad Safari): a fixed overlay. A fixed element inside an animated/transformed ancestor
     is positioned against that ancestor, so re-parent it to the page root first. */
  pseudoFs = true;
  fsPlaceholder = document.createComment("wb");
  host.replaceWith(fsPlaceholder);
  $("roomPage").appendChild(host);
  applyFs();
}
/* ═══════════════ TOOL / UI STATE ═══════════════ */
function setTool(kind, shape) {
  if (editing) endEdit();
  tool.kind = kind;
  if (shape) tool.shape = shape;
  renderToolState();
}
function setEnabled(on) {
  enabled = !!on;
  const layoutEl = $("studyLayout");
  if (layoutEl) layoutEl.dataset.wb = enabled ? "on" : "off";
  if (!enabled) { cancelOps(); clearCursors(); }
  renderToolState();
}
/* frequent, cheap: toolbar state only */
function renderToolState() {
  if (!host) return;
  const isHost = !!(S.perms && S.perms.isAdmin);
  const live = !!(B && B.loaded);
  $("wbHostTools").hidden = !isHost || !enabled || !B;
  const open = $("wbOpenBtn");
  if (open) open.hidden = !isHost || enabled;
  $("wbColor").disabled = tool.kind === "eraser";
  $("wbUndo").disabled = !live || B.hist.undo <= 0;
  $("wbRedo").disabled = !live || B.hist.redo <= 0;
  host.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("is-on",
    b.dataset.tool === tool.kind && (b.dataset.tool !== "shape" || b.dataset.shape === tool.shape)));
  syncFormatButtons();
  canvas.dataset.tool = tool.kind;
}
/* exported: also called from applyPerms() when permissions change */
export function renderWhiteboardUI() {
  if (!host) return;
  renderToolState();
  renderWorkspaceUI();
}
const requestSync = () => emit("wb-sync-request");
/* ═══════════════ WIRING ═══════════════ */
export function wireWhiteboard() {
  host = $("studyBoard"); stage = $("wbMain"); canvas = $("wbCanvas");
  textLayer = $("wbTextLayer"); selLayer = $("wbSelLayer"); cursorLayer = $("wbCursors");
  mini = $("wbMini"); zoomLabel = $("wbZoom");
  tabList = $("wbTabList"); modalEl = $("wbModal"); popEl = $("wbOpenPop");
  if (!host || !stage || !canvas) return;
  ctx = canvas.getContext("2d");
  if (mini) mctx = mini.getContext("2d");
  marqueeEl = document.createElement("div");
  marqueeEl.className = "wb-marquee"; marqueeEl.hidden = true;
  selLayer.appendChild(marqueeEl);
  /* resize: viewport only, then repaint synchronously (no blank flash) */
  new ResizeObserver(() => { if (reconcile()) { drawMain(); drawMini(); } }).observe(stage);
  setInterval(() => {                                          // a pure window MOVE fires no resize
    if (!last) return;
    const r = canvas.getBoundingClientRect();
    if (canvas.clientWidth === last.w && canvas.clientHeight === last.h) {
      last.left = r.left; last.top = r.top; last.sx = window.screenX; last.sy = window.screenY;
    }
  }, 250);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", (e) => {
    if (!drawing && !selOp && B && e.pointerType !== "touch") emit("wb-cursor", { b: B.id, x: null, y: null });
  });
  canvas.addEventListener("dblclick", (e) => {                 // double-click any text to edit it
    if (!B || !B.loaded) return;
    const [wx, wy] = worldFromClient(e.clientX, e.clientY);
    const h = hitTest(wx, wy);
    if (h && h.tool === "text") { setSelection([h.id]); beginEdit(h, false); }
  });
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("contextmenu", (e) => e.preventDefault());   // right-drag pans; no browser menu
  document.addEventListener("keydown", onKey);
  document.addEventListener("selectionchange", saveRange);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) pseudoFs = pseudoFs; applyFs(); });
  if (mini) {                                                  // minimap: fixed in place; click/drag to jump
    mini.addEventListener("pointerdown", (e) => {
      if (!miniMap) return;
      e.preventDefault(); e.stopPropagation();
      mini.setPointerCapture(e.pointerId);
      miniDrag = { map: { ...miniMap } };
      jumpFromMini(e);
    });
    mini.addEventListener("pointermove", jumpFromMini);
    mini.addEventListener("pointerup", () => { miniDrag = null; });
    mini.addEventListener("pointercancel", () => { miniDrag = null; });
  }
  /* toolbars (top + dock share one handler). mousedown is cancelled on buttons so a focused text box keeps
     its caret/selection while you press B / I / U. */
  host.addEventListener("mousedown", (e) => { if (e.target.closest(".wb-btn, .wb-tabbtn") && !e.target.closest("input")) e.preventDefault(); });
  const onToolClick = (e) => {
    const t = e.target.closest("[data-tool]");
    if (t) return setTool(t.dataset.tool, t.dataset.shape);
    const f = e.target.closest("[data-fmt]");
    if (f) return formatText(f.dataset.fmt);
    const a = e.target.closest("[data-act]");
    if (!a || !view.w) return;
    const cx = view.w / 2, cy = view.h / 2;
    if (a.dataset.act === "undo") undo();
    else if (a.dataset.act === "redo") redo();
    else if (a.dataset.act === "zoom-in") zoomAt(1.25, cx, cy);
    else if (a.dataset.act === "zoom-out") zoomAt(0.8, cx, cy);
    else if (a.dataset.act === "zoom-reset") zoomAt(1 / cam.z, cx, cy);
  };
  $("wbToolbar").addEventListener("click", onToolClick);
  $("wbDock").addEventListener("click", onToolClick);
  $("wbColor").addEventListener("input", (e) => applyColor(e.target.value));
  $("wbSize").addEventListener("input", (e) => {
    tool.size = +e.target.value || 4;
    const t = sizableText();
    if (t) setTextSize(t, tool.size * TEXT_PER_SLIDER);
  });
  /* host controls */
  const isHost = () => !!(S.perms && S.perms.isAdmin);
  const clearBtn = $("wbClear");
  clearBtn.addEventListener("click", () => {
    if (!isHost() || !B) return;
    if (clearArmed) { clearTimeout(clearArmed); clearArmed = null; clearBtn.textContent = "Clear"; emit("wb-clear", { b: B.id }); return; }
    clearBtn.textContent = "Sure?";
    clearArmed = setTimeout(() => { clearArmed = null; clearBtn.textContent = "Clear"; }, 3000);
  });
  $("wbClose").addEventListener("click", () => isHost() && emit("wb-set-enabled", { enabled: false }));
  $("wbOpenBtn").addEventListener("click", () => isHost() && emit("wb-set-enabled", { enabled: true }));
  /* tabs + boards UI */
  tabList.addEventListener("click", (e) => {
    const x = e.target.closest("[data-x]");
    if (x) return requestClose(x.dataset.x);
    const t = e.target.closest("[data-b]");
    if (t) activate(t.dataset.b);
  });
  tabList.addEventListener("dblclick", (e) => { const t = e.target.closest("[data-b]"); if (t) renameBoard(t.dataset.b); });
  tabList.addEventListener("auxclick", (e) => {               // middle-click closes, like an editor tab
    if (e.button !== 1) return;
    const t = e.target.closest("[data-b]");
    if (t) { e.preventDefault(); requestClose(t.dataset.b); }
  });
  $("wbTabAdd").addEventListener("click", () => emit("wb-board-new", {}));
  $("wbTabOpen").addEventListener("click", (e) => {
    e.stopPropagation();
    popEl.hidden = !popEl.hidden;
    if (!popEl.hidden) popEl.innerHTML = boardRowsHTML();
  });
  $("wbSave").addEventListener("click", () => B && emit("wb-board-save", { b: B.id }));
  $("wbFs").addEventListener("click", toggleFs);
  popEl.addEventListener("click", onBoardAction);
  document.addEventListener("click", (e) => { if (!popEl.hidden && !popEl.contains(e.target) && !e.target.closest("#wbTabOpen")) popEl.hidden = true; });
  const list = $("bpList");
  if (list) list.addEventListener("click", onBoardAction);
  const nb = $("bpNew");
  if (nb) nb.addEventListener("click", () => emit("wb-board-new", {}));
  setInterval(() => {                                          // hide stale remote cursors
    const cutoff = Date.now() - CURSOR_TTL;
    cursors.forEach((c, uid) => { if (c.t < cutoff) dropCursor(uid); });
  }, 1000);
  renderWhiteboardUI();
}
/* ═══════════════ NETWORK ═══════════════ */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;
  sockWired = true;
  const socket = getSocket();
  const loadedBoard = (p) => { const bs = p && bstates.get(p.b); return bs && bs.loaded ? bs : null; };
  const refresh = (bs) => { if (bs === B) { pruneSelection(); requestRender(); } };
  socket.on("wb-workspace", applyWorkspace);
  socket.on("wb-board-created", ({ b } = {}) => {
    if (bstates.has(b)) activate(b); else pendingActivate = b;   // may arrive before the workspace update
  });
  socket.on("wb-board-reloaded", ({ b } = {}) => {
    const bs = bstates.get(b);
    if (!bs) return;
    Object.assign(bs, { loaded: false, syncing: false, strokes: [], selection: new Set(), remoteSel: new Map() });
    bs.byId = new Map();
    if (bs === B) { clearTextLayer(); requestBoardSync(bs); renderEmpty(); requestRender(); }
  });
  socket.on("wb-dirty", ({ b, dirty } = {}) => {
    const bs = bstates.get(b);
    if (bs) { bs.dirty = !!dirty; renderWorkspaceUI(); }
  });
  socket.on("wb-board-snapshot", ({ b, strokes, history } = {}) => {
    const bs = bstates.get(b);
    if (!bs) return;
    bs.strokes = []; bs.byId = new Map(); bs.selection = new Set(); bs.remoteSel = new Map();
    (Array.isArray(strokes) ? strokes : []).forEach((s) => addStroke(bs, s));
    bs.hist.undo = Math.max(0, (history && history.undo) | 0);
    bs.hist.redo = Math.max(0, (history && history.redo) | 0);
    bs.loaded = true; bs.syncing = false;
    if (bs === B) { clearTextLayer(); renderWorkspaceUI(); renderToolState(); requestRender(); }
  });
  socket.on("wb-stroke-start", (p) => {
    const bs = loadedBoard(p);
    if (!bs) return;
    const s = addStroke(bs, p);
    if (s && bs === B) { drawIncr(s, 0); requestRender(false); }
  });
  socket.on("wb-stroke-points", (p) => {
    const bs = loadedBoard(p), s = bs && bs.byId.get(p.id);
    if (!s || !Array.isArray(p.pts)) return;
    if (s.tool === "shape") {
      if (p.pts.length >= 2) { s.pts[2] = clamp(p.pts[0], -WORLD_LIM, WORLD_LIM); s.pts[3] = clamp(p.pts[1], -WORLD_LIM, WORLD_LIM); recomputeBB(s); }
      if (bs === B) requestRender();
      return;
    }
    const prev = s.pts.length / 2;
    for (const v of p.pts) if (Number.isFinite(v)) s.pts.push(clamp(v, -WORLD_LIM, WORLD_LIM));
    if (s.pts.length % 2) s.pts.pop();
    growBB(s, prev);
    if (bs === B) { drawIncr(s, prev); requestRender(false); }
  });
  socket.on("wb-stroke-visibility", (p) => {
    const bs = loadedBoard(p), s = bs && bs.byId.get(p.id);
    if (!s) return;
    s.undone = !!p.undone;
    refresh(bs);
  });
  socket.on("wb-deleted", (p) => {
    const bs = loadedBoard(p);
    if (!bs || !Array.isArray(p.ids)) return;
    p.ids.forEach((id) => { const s = bs.byId.get(id); if (s) s.deleted = !!p.deleted; });
    refresh(bs);
  });
  socket.on("wb-move", (p) => {
    const bs = loadedBoard(p);
    if (!bs || !Array.isArray(p.ids)) return;
    p.ids.forEach((id) => { const s = bs.byId.get(id); if (s) translate(s, +p.dx || 0, +p.dy || 0); });
    if (bs === B) requestRender();
  });
  socket.on("wb-purge", (p) => {
    const bs = loadedBoard(p);
    if (!bs || !Array.isArray(p.ids)) return;
    const dead = new Set(p.ids);
    bs.strokes = bs.strokes.filter((s) => !dead.has(s.id));
    dead.forEach((id) => bs.byId.delete(id));
    refresh(bs);
  });
  socket.on("wb-text-update", (p) => {
    const bs = loadedBoard(p), s = bs && bs.byId.get(p.id);
    if (!s || s.tool !== "text") return;
    if (editing && editing.s === s) return;                     // don't fight the local caret
    if (typeof p.html === "string") s.html = cleanHtml(p.html);
    if (Number.isFinite(+p.size)) s.size = clamp(+p.size, TEXT_MIN, TEXT_MAX);
    if (HEX.test(p.color)) s.color = p.color;
    if (bs === B) requestRender();
  });
  socket.on("wb-select", ({ b, uid, name, ids } = {}) => {
    const bs = bstates.get(b);
    if (!bs || uid === S.userId) return;
    if (Array.isArray(ids) && ids.length) bs.remoteSel.set(uid, { name, ids }); else bs.remoteSel.delete(uid);
    if (bs === B) renderSelection();
  });
  socket.on("wb-history", ({ b, undo: u, redo: r } = {}) => {
    const bs = bstates.get(b);
    if (!bs) return;
    bs.hist.undo = Math.max(0, u | 0); bs.hist.redo = Math.max(0, r | 0);
    if (bs === B) renderToolState();
  });
  socket.on("wb-cursor", showCursor);
  socket.on("wb-cleared", ({ b } = {}) => {
    const bs = bstates.get(b);
    if (!bs) return;
    bs.strokes = []; bs.byId = new Map(); bs.selection = new Set(); bs.remoteSel = new Map();
    bs.hist.undo = bs.hist.redo = 0;
    if (bs === B) { if (editing) endEdit(); clearTextLayer(); renderToolState(); requestRender(); }
  });
  socket.on("wb-enabled", ({ enabled: en } = {}) => {
    setEnabled(en !== false);
    if (enabled) requestSync();
  });
  socket.on("user-left", ({ username } = {}) => {
    cursors.forEach((c, uid) => { if (c.name === username) dropCursor(uid); });
    bstates.forEach((bs) => bs.remoteSel.forEach((r, uid) => { if (r.name === username) bs.remoteSel.delete(uid); }));
    renderSelection();
  });
});
/* join / reconnect: anything we hold may have gone stale while offline → reload lazily */
onRoomState(({ room }) => {
  if (!room || room.roomType !== "study") return;
  bstates.forEach((bs) => { bs.loaded = false; bs.syncing = false; });
  setEnabled(!(room.whiteboard && room.whiteboard.enabled === false));
  const c = $("wbColor");
  if (c) { tool.color = tool.color || myColor(); c.value = tool.color; }
  requestSync();
}, 27);