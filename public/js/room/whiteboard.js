/* public/js/room/whiteboard.js
 * Study-room shared whiteboard.
 *
 * - Strokes are vectors in a fixed 1600×1000 logical space, scaled uniformly to fit the
 *   canvas (letterboxed). Resizing re-renders; nothing is wiped, and everyone sees the
 *   same picture regardless of window size.
 * - Outgoing points are batched (FLUSH_MS) and thinned (MIN_DIST); cursors are throttled.
 * - Late join / reconnect / reopen: emit 'wb-sync-request' → server answers 'wb-snapshot'.
 *   Idempotent: a snapshot replaces local state.
 * - Eraser = paint in paper colour (deterministic on replay).
 */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { avColor } from "./utils.js";
import { emit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
const BOARD_W = 1600, BOARD_H = 1000;
const PAPER = "#fbfbf9";
const ERASER_MULT = 5;
const MIN_DIST = 2;            // logical units; skip points closer than this
const FLUSH_MS = 50;           // outgoing stroke batches: ≤ 20/s
const CURSOR_MS = 50;          // outgoing cursor: ≤ 20/s
const CURSOR_TTL = 5000;       // hide a remote cursor after 5s of silence
const MAX_BATCH_PTS = 100;     // must match the server cap
let host, canvas, ctx, cursorLayer;
let view = { w: 0, h: 0, dpr: 1, scale: 1, offX: 0, offY: 0 };
let strokes = [];
const byId = new Map();
let enabled = true;
const tool = { kind: "pen", color: null, size: 4 };
let drawing = null;            // { stroke, pending:[], timer, pid }
let lastCursorAt = 0;
let clearArmed = null;
const cursors = new Map();     // uid → { el, name, x, y, t }
/* ── colours ─────────────────────────────────────────── */
const HEX = /^#[0-9a-f]{6}$/i;
function toHex(c) {
  if (HEX.test(c)) return c.toLowerCase();
  const t = document.createElement("canvas").getContext("2d");
  t.fillStyle = c;
  return HEX.test(t.fillStyle) ? t.fillStyle : "#3b82f6";
}
const myColor = () => toHex(avColor(S.username));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const newId = () => Math.random().toString(36).slice(2, 12);
/* ── view / rendering ────────────────────────────────── */
function layout() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  view.w = w; view.h = h; view.dpr = dpr;
  if (!w || !h) return false;                         // hidden (board closed / mobile block)
  canvas.width = Math.round(w * dpr);                 // resets the bitmap; redraw() follows
  canvas.height = Math.round(h * dpr);
  view.scale = Math.min(w / BOARD_W, h / BOARD_H);
  view.offX = (w - BOARD_W * view.scale) / 2;
  view.offY = (h - BOARD_H * view.scale) / 2;
  return true;
}
function setView() {
  const k = view.dpr * view.scale;
  ctx.setTransform(k, 0, 0, k, view.dpr * view.offX, view.dpr * view.offY);
}
/* paints points [from-1 … end] of one stroke on the current transform */
function paint(s, from) {
  const p = s.pts, n = p.length / 2;
  const col = s.tool === "eraser" ? PAPER : s.color;
  const w = s.tool === "eraser" ? s.size * ERASER_MULT : s.size;
  ctx.strokeStyle = col; ctx.fillStyle = col;
  ctx.lineWidth = w; ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (n === 1) {
    ctx.beginPath(); ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  const start = Math.max(0, from - 1);
  ctx.beginPath();
  ctx.moveTo(p[start * 2], p[start * 2 + 1]);
  for (let i = start + 1; i < n; i++) ctx.lineTo(p[i * 2], p[i * 2 + 1]);
  ctx.stroke();
}
function drawIncr(s, from) {                           // live segment drawing, no full redraw
  if (!view.w) return;
  ctx.save();
  setView();
  ctx.beginPath(); ctx.rect(0, 0, BOARD_W, BOARD_H); ctx.clip();
  paint(s, from);
  ctx.restore();
}
function redraw() {
  if (!view.w) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  setView();
  ctx.beginPath(); ctx.rect(0, 0, BOARD_W, BOARD_H); ctx.clip();
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  for (const s of strokes) paint(s, 0);
  ctx.restore();
  cursors.forEach(placeCursor);
}
/* ── stroke store ────────────────────────────────────── */
function addStroke(s) {
  if (!s || typeof s.id !== "string" || !Array.isArray(s.pts) || s.pts.length < 2 || byId.has(s.id)) return null;
  const stroke = {
    id: s.id, tool: s.tool === "eraser" ? "eraser" : "pen",
    color: HEX.test(s.color) ? s.color : "#000000",
    size: clamp(+s.size || 4, 1, 40),
    pts: s.pts.filter((v) => Number.isFinite(v)),
  };
  if (stroke.pts.length % 2) stroke.pts.pop();
  if (stroke.pts.length < 2) return null;
  strokes.push(stroke);
  byId.set(stroke.id, stroke);
  return stroke;
}
function resetStrokes() { strokes = []; byId.clear(); drawing = null; }
/* ── local drawing ───────────────────────────────────── */
function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return [
    clamp(Math.round((e.clientX - r.left - view.offX) / view.scale), 0, BOARD_W),
    clamp(Math.round((e.clientY - r.top  - view.offY) / view.scale), 0, BOARD_H),
  ];
}
function flush() {
  if (!drawing) return;
  clearTimeout(drawing.timer);
  drawing.timer = null;
  while (drawing.pending.length) {
    emit("wb-stroke-points", { id: drawing.stroke.id, pts: drawing.pending.splice(0, MAX_BATCH_PTS * 2) });
  }
}
function addPoint(x, y) {
  const s = drawing.stroke, n = s.pts.length / 2;
  const dx = x - s.pts[n * 2 - 2], dy = y - s.pts[n * 2 - 1];
  if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) return;
  s.pts.push(x, y);
  drawing.pending.push(x, y);
  drawIncr(s, n);
  if (!drawing.timer) drawing.timer = setTimeout(flush, FLUSH_MS);   // trailing throttle
}
function onDown(e) {
  if (!enabled || !view.w) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = toLogical(e);
  const s = addStroke({ id: newId(), tool: tool.kind, color: tool.color || myColor(), size: tool.size, pts: [x, y] });
  if (!s) return;
  drawing = { stroke: s, pending: [], timer: null, pid: e.pointerId };
  drawIncr(s, 0);
  emit("wb-stroke-start", { id: s.id, tool: s.tool, color: s.color, size: s.size, pts: [x, y] });
}
function onMove(e) {
  if (drawing && e.pointerId === drawing.pid) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    for (const ev of (evs && evs.length ? evs : [e])) {
      const [x, y] = toLogical(ev);
      addPoint(x, y);
    }
  }
  const now = performance.now();
  if (enabled && now - lastCursorAt >= CURSOR_MS) {
    lastCursorAt = now;
    const [x, y] = toLogical(e);
    emit("wb-cursor", { x, y });
  }
}
function onUp(e) {
  if (!drawing || e.pointerId !== drawing.pid) return;
  flush();
  drawing = null;
}
/* ── remote cursors ──────────────────────────────────── */
function placeCursor(c) {
  c.el.style.transform = "translate(" + (view.offX + c.x * view.scale) + "px," + (view.offY + c.y * view.scale) + "px)";
}
function dropCursor(uid) {
  const c = cursors.get(uid);
  if (c) { c.el.remove(); cursors.delete(uid); }
}
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
  if (!enabled) { clearCursors(); drawing = null; }
  renderWhiteboardUI();
}
/* also called from applyPerms() so host-only controls appear/disappear live */
export function renderWhiteboardUI() {
  const host_ = !!(S.perms && S.perms.isAdmin);
  const tools = $("wbHostTools"), open = $("wbOpenBtn"), color = $("wbColor");
  if (tools) tools.hidden = !host_ || !enabled;
  if (open)  open.hidden  = !host_ || enabled;
  if (color) color.disabled = tool.kind === "eraser";
  document.querySelectorAll("#wbToolbar [data-tool]").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.tool === tool.kind));
}
const requestSync = () => emit("wb-sync-request");
/* ── wiring ──────────────────────────────────────────── */
export function wireWhiteboard() {
  host = $("studyBoard"); canvas = $("wbCanvas"); cursorLayer = $("wbCursors");
  if (!host || !canvas) return;
  ctx = canvas.getContext("2d");
  /* resize: re-layout + re-render from the vector store (no wipe) */
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (layout()) redraw(); });
  }).observe(host);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", () => { if (!drawing) emit("wb-cursor", { x: null, y: null }); });
  $("wbToolbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    tool.kind = b.dataset.tool;
    renderWhiteboardUI();
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
  socket.on("wb-snapshot", ({ enabled: en, strokes: list } = {}) => {
    if (!ctx) return;
    resetStrokes();
    (Array.isArray(list) ? list : []).forEach(addStroke);
    setEnabled(en !== false);
    layout(); redraw();
  });
  socket.on("wb-stroke-start", (s) => {
    if (!ctx) return;
    const st = addStroke(s);
    if (st) drawIncr(st, 0);
  });
  socket.on("wb-stroke-points", ({ id, pts } = {}) => {
    const s = byId.get(id);
    if (!s || !Array.isArray(pts)) return;
    const prev = s.pts.length / 2;
    for (const v of pts) if (Number.isFinite(v)) s.pts.push(v);
    drawIncr(s, prev);
  });
  socket.on("wb-cursor", showCursor);
  socket.on("wb-cleared", () => { resetStrokes(); redraw(); });
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