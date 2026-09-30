/* public/js/room/whiteboard.js   (v2: camera engine)
 *
 * WORLD: strokes are vectors in world coordinates (±WORLD_LIM, 0.1 precision) and never
 * change when the view does. CAMERA: cam = { x, y, z } — (x, y) is the world point at the
 * canvas' top-left, z the zoom. screen = (world − cam) · z.
 *
 * The canvas always fills its container. Resizing only changes the viewport size
 * (reconcile()); it never rescales. The paper + dot grid are CSS on the (transparent)
 * canvas, so the eraser is a real destination-out erase.
 *
 * Input:  left-drag draw · right/middle-drag pan · Ctrl+wheel zoom · wheel pan
 *         touch: 1 finger draw, 2 fingers pinch-zoom + pan
 *         Ctrl/Cmd+Z undo · Ctrl+Y / Ctrl+Shift+Z redo
 * Network: see socket/roomHandlers.js (wb-*). Snapshots are idempotent.
 */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { avColor } from "./utils.js";
import { emit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
const WORLD_LIM = 50000;               // keep in step with the server
const MIN_Z = 0.1, MAX_Z = 8;
const PAPER = "#fbfbf9";
const ERASER_MULT = 5;
const FLUSH_MS = 50;                   // outgoing stroke batches ≤ 20/s
const CURSOR_MS = 50;                  // outgoing cursor ≤ 20/s
const CURSOR_TTL = 5000;
const MAX_BATCH_PTS = 100;             // must match the server cap
const TOUCH_HOLD_MS = 90;              // delay before a touch stroke is sent (lets a 2nd finger cancel it)
const MM = { frac: 0.18, minW: 120, maxW: 220, minH: 80, maxH: 180,
             maxK: 4,                  // minimap never shows more than 4× the viewport per axis
             minK: 1.6 };              // …and never less than 1.6× (some context)
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const newId = () => Math.random().toString(36).slice(2, 12);
function toHex(c) {
  if (HEX.test(c)) return c.toLowerCase();
  const t = document.createElement("canvas").getContext("2d");
  t.fillStyle = c;
  return HEX.test(t.fillStyle) ? t.fillStyle : "#3b82f6";
}
const myColor = () => toHex(avColor(S.username));
/* ── state ───────────────────────────────────────────── */
let host, canvas, ctx, cursorLayer, mini, mctx, zoomLabel;
const mlayer = document.createElement("canvas");          // minimap strokes (supports erasing)
const mlctx = mlayer.getContext("2d");
const cam = { x: 0, y: 0, z: 1 };
const view = { w: 0, h: 0, dpr: 1 };
let last = null;                       // previous container geometry (for resize anchoring)
let camPlaced = false;                 // first layout centres the world origin once
let strokes = [];                      // render order; includes undone ones (flagged)
const byId = new Map();
let enabled = true;
const tool = { kind: "pen", color: null, size: 4 };
const hist = { undo: 0, redo: 0 };
let drawing = null;                    // { stroke, pending[], timer, hold, pid, started }
let pan = null;                        // { pid, x, y }
let gesture = null;                    // { cx, cy, dist }
const touches = new Map();             // touch pointerId → {x, y} (client coords)
let lastCursorAt = 0, clearArmed = null, miniDrag = null, miniMap = null;
const cursors = new Map();             // uid → { el, name, x, y, t }
/* ── render scheduling ───────────────────────────────── */
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
/* ── strokes ─────────────────────────────────────────── */
const strokeWidth = (s) => (s.tool === "eraser" ? s.size * ERASER_MULT : s.size);
function growBB(s, from) {
  const pad = strokeWidth(s) / 2 + 1 / MIN_Z;           // covers the 1-screen-px minimum at min zoom
  const p = s.pts, bb = s.bb;
  for (let i = from * 2; i < p.length; i += 2) {
    if (p[i] - pad < bb[0]) bb[0] = p[i] - pad;
    if (p[i + 1] - pad < bb[1]) bb[1] = p[i + 1] - pad;
    if (p[i] + pad > bb[2]) bb[2] = p[i] + pad;
    if (p[i + 1] + pad > bb[3]) bb[3] = p[i + 1] + pad;
  }
}
function addStroke(s) {
  if (!s || typeof s.id !== "string" || !Array.isArray(s.pts) || byId.has(s.id)) return null;
  const pts = s.pts.filter((v) => Number.isFinite(v)).map((v) => clamp(v, -WORLD_LIM, WORLD_LIM));
  if (pts.length % 2) pts.pop();
  if (pts.length < 2) return null;
  const stroke = {
    id: s.id, tool: s.tool === "eraser" ? "eraser" : "pen",
    color: HEX.test(s.color) ? s.color : "#000000",
    size: clamp(+s.size || 4, 1, 40), pts, undone: !!s.undone,
    bb: [Infinity, Infinity, -Infinity, -Infinity],
  };
  growBB(stroke, 0);
  strokes.push(stroke);
  byId.set(stroke.id, stroke);
  return stroke;
}
function resetStrokes() {
  if (drawing) { clearTimeout(drawing.timer); clearTimeout(drawing.hold); }
  drawing = null;
  strokes = [];
  byId.clear();
}
/* ── camera ──────────────────────────────────────────── */
function clampCam() {
  const vw = view.w / cam.z, vh = view.h / cam.z;
  cam.x = clamp(cam.x, -WORLD_LIM - vw / 2, WORLD_LIM - vw / 2);   // view centre stays inside the world
  cam.y = clamp(cam.y, -WORLD_LIM - vh / 2, WORLD_LIM - vh / 2);
}
function zoomAt(factor, sx, sy) {                       // sx, sy: canvas-relative CSS px
  const z2 = clamp(cam.z * factor, MIN_Z, MAX_Z);
  const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
  cam.z = z2;
  cam.x = wx - sx / z2;
  cam.y = wy - sy / z2;
  clampCam();
  requestRender();
}
function centerOn(wx, wy) {
  cam.x = wx - view.w / (2 * cam.z);
  cam.y = wy - view.h / (2 * cam.z);
  clampCam();
  requestRender();
}
function worldFromClient(cx, cy) {                      // unrounded
  const r = canvas.getBoundingClientRect();
  return [cam.x + (cx - r.left) / cam.z, cam.y + (cy - r.top) / cam.z];
}
const toWorld = (cx, cy) => {
  const [x, y] = worldFromClient(cx, cy);
  return [r1(clamp(x, -WORLD_LIM, WORLD_LIM)), r1(clamp(y, -WORLD_LIM, WORLD_LIM))];
};
/* Resize = change the viewport, never the drawing. The board behaves like a window onto a
   fixed world: content keeps its place on SCREEN, and the edge that moves clips it.
   - container moved by layout (rect.left/top changed)            → shift by that delta
   - OS window edge dragged (screenX/Y changed AND size changed)  → shift by the size delta
   screenX/Y are only used as an "the top/left edge moved" trigger; the amount comes from
   CSS-pixel sizes, which dodges their unit inconsistencies across browsers/DPI. */
function reconcile() {
  const r = canvas.getBoundingClientRect();
  const cur = { w: canvas.clientWidth, h: canvas.clientHeight, left: r.left, top: r.top,
                sx: window.screenX, sy: window.screenY };
  if (!cur.w || !cur.h) { last = null; view.w = view.h = 0; return false; }   // hidden
  if (last) {
    let shiftX = cur.left - last.left, shiftY = cur.top - last.top;
    if (cur.w !== last.w && cur.sx !== last.sx) shiftX -= cur.w - last.w;
    if (cur.h !== last.h && cur.sy !== last.sy) shiftY -= cur.h - last.h;
    cam.x += shiftX / cam.z;
    cam.y += shiftY / cam.z;
  } else if (!camPlaced) {                              // first ever layout: origin at the centre
    cam.x = -cur.w / (2 * cam.z);
    cam.y = -cur.h / (2 * cam.z);
    camPlaced = true;
  }
  last = cur;
  view.w = cur.w; view.h = cur.h; view.dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cur.w * view.dpr), bh = Math.round(cur.h * view.dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  clampCam();
  return true;
}
/* ── main canvas ─────────────────────────────────────── */
function paint(s, from) {
  const p = s.pts, n = p.length / 2, erase = s.tool === "eraser";
  const w = Math.max(strokeWidth(s), 1 / cam.z);         // never thinner than 1 screen px
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = erase ? "#000" : s.color;
  ctx.lineWidth = w; ctx.lineCap = ctx.lineJoin = "round";
  if (n === 1) {
    ctx.beginPath(); ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    const start = Math.max(0, from - 1);
    ctx.beginPath();
    ctx.moveTo(p[start * 2], p[start * 2 + 1]);
    for (let i = start + 1; i < n; i++) ctx.lineTo(p[i * 2], p[i * 2 + 1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}
function setWorldTransform() {
  const k = view.dpr * cam.z;
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
}
function drawIncr(s, from) {                            // live segments; no full redraw
  if (!view.w || s.undone) return;
  ctx.save(); setWorldTransform(); paint(s, from); ctx.restore();
}
/* dot grid lives in CSS; keep it registered to world coordinates */
function syncGrid() {
  let g = 40;
  while (g * cam.z < 16) g *= 2;                        // never denser than 16px
  const s = g * cam.z;
  const ox = (((-cam.x * cam.z - s / 2) % s) + s) % s;
  const oy = (((-cam.y * cam.z - s / 2) % s) + s) % s;
  canvas.style.backgroundSize = s + "px " + s + "px";
  canvas.style.backgroundPosition = ox + "px " + oy + "px";
}
function drawMain() {
  if (!view.w) return;
  syncGrid();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  setWorldTransform();
  const x0 = cam.x, y0 = cam.y, x1 = cam.x + view.w / cam.z, y1 = cam.y + view.h / cam.z;
  for (const s of strokes) {
    if (s.undone) continue;
    if (s.bb[2] < x0 || s.bb[0] > x1 || s.bb[3] < y0 || s.bb[1] > y1) continue;   // culled, not lost
    paint(s, 0);
  }
  ctx.restore();
  cursors.forEach(placeCursor);
  if (zoomLabel) zoomLabel.textContent = Math.round(cam.z * 100) + "%";
}
/* ── minimap ─────────────────────────────────────────── */
function drawMini() {
  if (!mini || !view.w || !enabled) return;
  const dpr = view.dpr;
  const mw = clamp(Math.round(view.w * MM.frac), MM.minW, MM.maxW);
  const mh = clamp(Math.round(mw * view.h / view.w), MM.minH, MM.maxH);
  const bw = Math.round(mw * dpr), bh = Math.round(mh * dpr);
  if (mini.width !== bw || mini.height !== bh) {
    mini.width = mlayer.width = bw;
    mini.height = mlayer.height = bh;
    mini.style.width = mw + "px";
    mini.style.height = mh + "px";
  }
  /* extent: the viewport ∪ the content, but capped so it stays a *reasonable* slice */
  const vw = view.w / cam.z, vh = view.h / cam.z;
  let x0 = cam.x, y0 = cam.y, x1 = cam.x + vw, y1 = cam.y + vh;
  for (const s of strokes) {
    if (s.undone || s.tool === "eraser") continue;
    if (s.bb[0] < x0) x0 = s.bb[0];
    if (s.bb[1] < y0) y0 = s.bb[1];
    if (s.bb[2] > x1) x1 = s.bb[2];
    if (s.bb[3] > y1) y1 = s.bb[3];
  }
  let ew = x1 - x0, eh = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (ew > vw * MM.maxK || eh > vh * MM.maxK) {         // content too spread out → radar around the viewport
    cx = cam.x + vw / 2; cy = cam.y + vh / 2;
    ew = vw * MM.maxK; eh = vh * MM.maxK;
  } else {
    ew = Math.max(ew * 1.1, vw * MM.minK);
    eh = Math.max(eh * 1.1, vh * MM.minK);
  }
  const k = Math.min(mw / ew, mh / eh);
  const X = (wx) => mw / 2 + (wx - cx) * k;
  const Y = (wy) => mh / 2 + (wy - cy) * k;
  const ex0 = cx - mw / 2 / k, ex1 = cx + mw / 2 / k, ey0 = cy - mh / 2 / k, ey1 = cy + mh / 2 / k;
  miniMap = { cx, cy, k, mw, mh };
  mlctx.setTransform(1, 0, 0, 1, 0, 0);
  mlctx.clearRect(0, 0, bw, bh);
  mlctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const minStep2 = (1.5 / k) * (1.5 / k);
  for (const s of strokes) {
    if (s.undone || s.bb[2] < ex0 || s.bb[0] > ex1 || s.bb[3] < ey0 || s.bb[1] > ey1) continue;
    const erase = s.tool === "eraser", p = s.pts, n = p.length / 2;
    const w = Math.max(1, strokeWidth(s) * k);
    mlctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    mlctx.strokeStyle = mlctx.fillStyle = erase ? "#000" : s.color;
    mlctx.lineWidth = w; mlctx.lineCap = mlctx.lineJoin = "round";
    if (n === 1) {
      mlctx.beginPath(); mlctx.arc(X(p[0]), Y(p[1]), w / 2, 0, Math.PI * 2); mlctx.fill();
      continue;
    }
    mlctx.beginPath();
    mlctx.moveTo(X(p[0]), Y(p[1]));
    let lx = p[0], ly = p[1];
    for (let i = 1; i < n; i++) {                       // thin out: ≥1.5 minimap px apart
      const x = p[i * 2], y = p[i * 2 + 1], dx = x - lx, dy = y - ly;
      if (dx * dx + dy * dy < minStep2 && i < n - 1) continue;
      mlctx.lineTo(X(x), Y(y)); lx = x; ly = y;
    }
    mlctx.stroke();
  }
  mlctx.globalCompositeOperation = "source-over";
  /* opaque compose: solid paper first, so nothing underneath ever shows through */
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = PAPER;
  mctx.fillRect(0, 0, bw, bh);
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
  const r = mini.getBoundingClientRect(), m = miniDrag.map;   // map frozen at pointerdown: no feedback loop
  centerOn(m.cx + (e.clientX - r.left - m.mw / 2) / m.k, m.cy + (e.clientY - r.top - m.mh / 2) / m.k);
}
/* ── drawing ─────────────────────────────────────────── */
function flush() {
  const d = drawing;
  if (!d) return;
  clearTimeout(d.timer); d.timer = null;
  while (d.pending.length) {
    emit("wb-stroke-points", { id: d.stroke.id, pts: d.pending.splice(0, MAX_BATCH_PTS * 2) });
  }
}
function commitStroke() {                              // first network emission of this stroke
  const d = drawing;
  if (!d || d.started) return;
  clearTimeout(d.hold);
  d.started = true;
  const s = d.stroke;
  emit("wb-stroke-start", { id: s.id, tool: s.tool, color: s.color, size: s.size, pts: [s.pts[0], s.pts[1]] });
  d.pending = s.pts.slice(2);                          // anything gathered during the touch hold
  hist.undo++; hist.redo = 0;                          // mirrors the server; wb-history corrects drift
  renderWhiteboardUI();
  flush();
}
function finishStroke() {
  if (!drawing) return;
  commitStroke();
  flush();
  drawing = null;
}
function discardStroke() {                             // a second finger arrived before we sent anything
  const d = drawing;
  if (!d) return;
  clearTimeout(d.hold); clearTimeout(d.timer);
  strokes = strokes.filter((s) => s !== d.stroke);
  byId.delete(d.stroke.id);
  drawing = null;
  requestRender();
}
function startStroke(e) {
  const [x, y] = toWorld(e.clientX, e.clientY);
  const s = addStroke({ id: newId(), tool: tool.kind, color: tool.color || myColor(), size: tool.size, pts: [x, y] });
  if (!s) return;
  drawing = { stroke: s, pending: [], timer: null, hold: null, pid: e.pointerId, started: false };
  canvas.setPointerCapture(e.pointerId);
  drawIncr(s, 0);
  if (e.pointerType === "touch") drawing.hold = setTimeout(commitStroke, TOUCH_HOLD_MS);
  else commitStroke();
}
function addPoint(x, y) {
  const d = drawing, s = d.stroke, n = s.pts.length / 2;
  const dx = x - s.pts[n * 2 - 2], dy = y - s.pts[n * 2 - 1];
  const minDist = Math.min(2, 1.5 / cam.z);            // ≈1.5 screen px, capped at 2 world units
  if (dx * dx + dy * dy < minDist * minDist) return;
  s.pts.push(x, y);
  growBB(s, n);
  drawIncr(s, n);
  if (d.started) {
    d.pending.push(x, y);
    if (!d.timer) d.timer = setTimeout(flush, FLUSH_MS);  // trailing throttle
  }
  requestRender(false);                                // minimap only
}
/* ── pointer input ───────────────────────────────────── */
function beginGesture() {
  if (drawing) { if (!drawing.started) discardStroke(); else finishStroke(); }
  const [a, b] = [...touches.values()];
  if (!a || !b) { gesture = null; return; }
  gesture = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
function updateGesture() {
  const [a, b] = [...touches.values()];
  if (!a || !b || !gesture) return;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = worldFromClient(gesture.cx, gesture.cy);     // world point under the old centre…
  cam.z = clamp(cam.z * (dist / gesture.dist), MIN_Z, MAX_Z);
  cam.x = wx - (cx - r.left) / cam.z;                           // …stays under the new centre
  cam.y = wy - (cy - r.top) / cam.z;
  gesture = { cx, cy, dist };
  clampCam();
  requestRender();
}
function onDown(e) {
  if (!enabled || !view.w) return;
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) return beginGesture();
    if (touches.size > 2) return;
  } else if (e.button === 2 || e.button === 1) {        // right / middle: pan
    e.preventDefault();
    pan = { pid: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("is-panning");
    return;
  } else if (e.button !== 0) return;
  startStroke(e);
}
function onMove(e) {
  if (e.pointerType === "touch") {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture && touches.size >= 2) return updateGesture();
  }
  if (pan && e.pointerId === pan.pid) {
    cam.x -= (e.clientX - pan.x) / cam.z;
    cam.y -= (e.clientY - pan.y) / cam.z;
    pan.x = e.clientX; pan.y = e.clientY;
    clampCam();
    requestRender();
  } else if (drawing && e.pointerId === drawing.pid) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    for (const ev of (evs && evs.length ? evs : [e])) {
      const [x, y] = toWorld(ev.clientX, ev.clientY);
      addPoint(x, y);
    }
  }
  const now = performance.now();
  if (enabled && e.pointerType !== "touch" && now - lastCursorAt >= CURSOR_MS) {
    lastCursorAt = now;
    const [x, y] = toWorld(e.clientX, e.clientY);
    emit("wb-cursor", { x, y });
  }
}
function onUp(e) {
  if (e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (touches.size < 2) gesture = null; else beginGesture();   // fresh baseline: no jump
  }
  if (pan && e.pointerId === pan.pid) {
    pan = null;
    canvas.classList.remove("is-panning");
    return;
  }
  if (drawing && e.pointerId === drawing.pid) finishStroke();
}
function onWheel(e) {
  e.preventDefault();                                  // also blocks the browser's own Ctrl+wheel page zoom
  if (!view.w) return;
  const r = canvas.getBoundingClientRect();
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
  else if (e.deltaMode === 2) { dx *= r.width; dy *= r.height; }
  if (e.ctrlKey) zoomAt(Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top);
  else { cam.x += dx / cam.z; cam.y += dy / cam.z; clampCam(); requestRender(); }   // scroll / trackpad pans
}
/* ── undo / redo ─────────────────────────────────────── */
const undo = () => { if (enabled && !drawing && hist.undo > 0) emit("wb-undo"); };
const redo = () => { if (enabled && !drawing && hist.redo > 0) emit("wb-redo"); };
function onKey(e) {
  if (S.roomType !== "study" || !enabled || !view.w) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target;
  if (t && t.closest && t.closest("textarea, [contenteditable='true'], input:not([type=range]):not([type=color])")) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
}
/* ── remote cursors (world coords → placed by the camera) ── */
function placeCursor(c) {
  c.el.style.transform = "translate(" + (c.x - cam.x) * cam.z + "px," + (c.y - cam.y) * cam.z + "px)";
}
function dropCursor(uid) { const c = cursors.get(uid); if (c) { c.el.remove(); cursors.delete(uid); } }
function clearCursors() { [...cursors.keys()].forEach(dropCursor); }
function showCursor({ uid, name, x, y }) {
  if (!enabled || S.userId === uid) return;
  if (x == null || y == null) return dropCursor(uid);
  let c = cursors.get(uid);
  if (!c) {
    const el = document.createElement("div");
    el.className = "wb-cursor";
    el.style.setProperty("--c", avColor(name));
    el.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1 1l5.5 14 2.2-5.6L14 7z"/></svg><span></span>';
    el.querySelector("span").textContent = name || "?";
    cursorLayer.appendChild(el);
    c = { el, name, x, y, t: 0 };
    cursors.set(uid, c);
  }
  c.x = x; c.y = y; c.t = Date.now();
  placeCursor(c);
}
/* ── enable / UI ─────────────────────────────────────── */
function setEnabled(on) {
  enabled = !!on;
  const layoutEl = $("studyLayout");
  if (layoutEl) layoutEl.dataset.wb = enabled ? "on" : "off";
  if (!enabled) { clearCursors(); if (drawing) discardStroke(); }
  renderWhiteboardUI();
}
/* also called from applyPerms() so host-only controls follow permission changes live */
export function renderWhiteboardUI() {
  const isHost = !!(S.perms && S.perms.isAdmin);
  const tools = $("wbHostTools"), open = $("wbOpenBtn"), color = $("wbColor");
  if (tools) tools.hidden = !isHost || !enabled;
  if (open)  open.hidden  = !isHost || enabled;
  if (color) color.disabled = tool.kind === "eraser";
  const u = $("wbUndo"), r = $("wbRedo");
  if (u) u.disabled = hist.undo <= 0;
  if (r) r.disabled = hist.redo <= 0;
  document.querySelectorAll("#wbToolbar [data-tool]").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.tool === tool.kind));
}
const requestSync = () => emit("wb-sync-request");
/* ── wiring ──────────────────────────────────────────── */
export function wireWhiteboard() {
  host = $("studyBoard"); canvas = $("wbCanvas"); cursorLayer = $("wbCursors");
  mini = $("wbMini"); zoomLabel = $("wbZoom");
  if (!host || !canvas) return;
  ctx = canvas.getContext("2d");
  if (mini) mctx = mini.getContext("2d");
  /* resize: change the viewport only, then repaint synchronously (no blank flash) */
  new ResizeObserver(() => { if (reconcile()) { drawMain(); drawMini(); } }).observe(host);
  /* a pure window MOVE fires no resize; keep the stored geometry fresh so the next resize is measured correctly */
  setInterval(() => {
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
    if (!drawing && e.pointerType !== "touch") emit("wb-cursor", { x: null, y: null });
  });
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("contextmenu", (e) => e.preventDefault());   // right-drag pans; no browser menu
  document.addEventListener("keydown", onKey);
  if (mini) {                                          // minimap: fixed in place, click/drag to jump
    mini.addEventListener("pointerdown", (e) => {
      if (!miniMap) return;
      e.preventDefault(); e.stopPropagation();
      mini.setPointerCapture(e.pointerId);
      miniDrag = { map: { ...miniMap } };
      jumpFromMini(e);
    });
    mini.addEventListener("pointermove", (e) => jumpFromMini(e));
    mini.addEventListener("pointerup", () => { miniDrag = null; });
    mini.addEventListener("pointercancel", () => { miniDrag = null; });
  }
  $("wbToolbar").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tool]");
    if (t) { tool.kind = t.dataset.tool; renderWhiteboardUI(); return; }
    const a = e.target.closest("[data-act]");
    if (!a || !view.w) return;
    const cx = view.w / 2, cy = view.h / 2;
    if (a.dataset.act === "undo") undo();
    else if (a.dataset.act === "redo") redo();
    else if (a.dataset.act === "zoom-in") zoomAt(1.25, cx, cy);
    else if (a.dataset.act === "zoom-out") zoomAt(0.8, cx, cy);
    else if (a.dataset.act === "zoom-reset") zoomAt(1 / cam.z, cx, cy);
  });
  $("wbColor").addEventListener("input", (e) => { tool.color = e.target.value; });
  $("wbSize").addEventListener("input", (e) => { tool.size = +e.target.value || 4; });
  /* host controls */
  const isHost = () => !!(S.perms && S.perms.isAdmin);
  const clearBtn = $("wbClear");
  clearBtn.addEventListener("click", () => {
    if (!isHost()) return;
    if (clearArmed) {                                  // second click within 3s → do it
      clearTimeout(clearArmed); clearArmed = null;
      clearBtn.textContent = "Clear";
      emit("wb-clear");
      return;
    }
    clearBtn.textContent = "Sure?";
    clearArmed = setTimeout(() => { clearArmed = null; clearBtn.textContent = "Clear"; }, 3000);
  });
  $("wbClose").addEventListener("click", () => isHost() && emit("wb-set-enabled", { enabled: false }));
  $("wbOpenBtn").addEventListener("click", () => isHost() && emit("wb-set-enabled", { enabled: true }));
  setInterval(() => {                                  // hide stale remote cursors
    const cutoff = Date.now() - CURSOR_TTL;
    cursors.forEach((c, uid) => { if (c.t < cutoff) dropCursor(uid); });
  }, 1000);
  renderWhiteboardUI();
}
/* ── network ─────────────────────────────────────────── */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;
  sockWired = true;
  const socket = getSocket();
  const setHist = (h) => {
    hist.undo = Math.max(0, (h && h.undo) | 0);
    hist.redo = Math.max(0, (h && h.redo) | 0);
    renderWhiteboardUI();
  };
  socket.on("wb-snapshot", ({ enabled: en, strokes: list, history } = {}) => {
    if (!ctx) return;
    resetStrokes();
    (Array.isArray(list) ? list : []).forEach(addStroke);
    setHist(history);
    setEnabled(en !== false);
    if (reconcile()) drawMain();
    requestRender();
  });
  socket.on("wb-stroke-start", (s) => {
    if (!ctx) return;
    const st = addStroke(s);
    if (st) { drawIncr(st, 0); requestRender(false); }
  });
  socket.on("wb-stroke-points", ({ id, pts } = {}) => {
    const s = byId.get(id);
    if (!s || !Array.isArray(pts)) return;
    const prev = s.pts.length / 2;
    for (const v of pts) if (Number.isFinite(v)) s.pts.push(clamp(v, -WORLD_LIM, WORLD_LIM));
    if (s.pts.length % 2) s.pts.pop();
    growBB(s, prev);
    drawIncr(s, prev);
    requestRender(false);
  });
  socket.on("wb-stroke-visibility", ({ id, undone } = {}) => {
    const s = byId.get(id);
    if (!s) return;
    s.undone = !!undone;
    requestRender();                                   // erasing/un-erasing needs a full repaint
  });
  socket.on("wb-purge", ({ ids } = {}) => {
    if (!Array.isArray(ids) || !ids.length) return;
    const dead = new Set(ids);
    strokes = strokes.filter((s) => !dead.has(s.id));
    ids.forEach((id) => byId.delete(id));
    requestRender();
  });
  socket.on("wb-history", setHist);
  socket.on("wb-cursor", showCursor);
  socket.on("wb-cleared", () => { resetStrokes(); setHist(null); requestRender(); });
  socket.on("wb-enabled", ({ enabled: en } = {}) => {
    setEnabled(en !== false);
    if (enabled) requestSync();                        // reopened → refresh from the server
  });
  socket.on("user-left", ({ username } = {}) => {
    cursors.forEach((c, uid) => { if (c.name === username) dropCursor(uid); });
  });
});
/* join / reconnect: apply the flag now, then ask for the strokes */
onRoomState(({ room }) => {
  if (!room || room.roomType !== "study") return;
  setEnabled(!(room.whiteboard && room.whiteboard.enabled === false));
  const c = $("wbColor");
  if (c) { tool.color = tool.color || myColor(); c.value = tool.color; }
  requestSync();
}, 27);