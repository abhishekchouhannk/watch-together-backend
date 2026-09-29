/* public/js/room-types.js
 * Dashboard-side room-type catalog. Fetched once from GET /api/rooms/types.
 *
 *   initRoomTypes()          paint fallback immediately, then fetch + re-paint
 *   fillTypeSelect(sel, v)   fill a <select> with all types
 *   renderTypeChips(el, …)   filter chips ("All" + one per type)
 *   typeMeta(id)             { id, label, icon } for any id, known or not
 *   badgeHTML(id)           the colour-coded badge for a room card
 *
 * Never throws. Any failure leaves the hardcoded fallback in place, so the
 * create form always has a valid option (entertainment).
 */
"use strict";
const ENDPOINT   = "/api/rooms/types";
const TIMEOUT_MS = 4000;
const FALLBACK_DEFAULT = "entertainment";
const FALLBACK_TYPES   = [{ id: "entertainment", label: "Entertainment", icon: "🎬" }];
const ID_RE = /^[a-z0-9_-]{1,32}$/;
let catalog = { defaultType: FALLBACK_DEFAULT, types: FALLBACK_TYPES, source: "fallback" };
const catalogListeners = new Set();
/* ── helpers ───────────────────────────────────────────── */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/* "board-game" → "Board game" — label for ids the catalog doesn't know */
const titleCase = (id) => {
  const s = String(id || "").replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
};
/* validate + clamp server data; returns null if unusable */
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.types)) return null;
  const seen = new Set();
  const types = [];
  for (const t of raw.types) {
    if (!t || typeof t.id !== "string" || !ID_RE.test(t.id) || seen.has(t.id)) continue;
    if (typeof t.label !== "string" || !t.label.trim()) continue;
    seen.add(t.id);
    types.push({
      id: t.id,
      label: t.label.trim().slice(0, 40),
      icon: typeof t.icon === "string" ? t.icon.slice(0, 8) : "🏷️",
    });
  }
  if (!types.length) return null;
  const ids = types.map((t) => t.id);
  const defaultType = ids.includes(raw.default) ? raw.default
                    : ids.includes(FALLBACK_DEFAULT) ? FALLBACK_DEFAULT
                    : ids[0];
  return { defaultType, types, source: "server" };
}
/* ── catalog ───────────────────────────────────────────── */
export const getCatalog = () => catalog;
export const onCatalogChange = (fn) => { catalogListeners.add(fn); return () => catalogListeners.delete(fn); };
export async function loadRoomTypes() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ENDPOINT, { credentials: "include", signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const next = sanitize(await r.json());
    if (next) catalog = next;
    else console.warn("[room-types] bad payload, keeping fallback");
  } catch (err) {
    console.warn("[room-types] using fallback:", err && err.message);
  } finally {
    clearTimeout(timer);
  }
  catalogListeners.forEach((fn) => { try { fn(catalog); } catch (_) {} });
  return catalog;
}
/* ── lookups ───────────────────────────────────────────── */
export function typeMeta(id) {
  const hit = catalog.types.find((t) => t.id === id);
  return hit || { id, label: titleCase(id), icon: "🏷️" };   // unknown ids still render
}
/* deterministic hue per id (djb2 hash) → the same type always gets the same colour */
export function hueFor(id) {
  let h = 5381;
  for (const ch of String(id || "")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return ((h % 360) + 360) % 360;
}
/* ── rendering ─────────────────────────────────────────── */
export function badgeHTML(id) {
  const m = typeMeta(id);
  return '<span class="mode-badge type-badge" style="--h:' + hueFor(m.id) + '">' +
    esc(m.icon) + " " + esc(m.label) + "</span>";
}
/* fills a <select>; keeps `value` if it still exists, else the catalog default */
export function fillTypeSelect(select, value) {
  if (!select) return;
  const want = catalog.types.some((t) => t.id === value) ? value : catalog.defaultType;
  select.innerHTML = catalog.types.map((t) =>
    '<option value="' + esc(t.id) + '">' + esc(t.icon) + " " + esc(t.label) + "</option>").join("");
  select.value = want;
}
/* filter chips: "All" (value "") + one per type. `onPick(id)` fires on click. */
export function renderTypeChips(container, { active = "", onPick } = {}) {
  if (!container) return;
  if (onPick) container._onPick = onPick;
  container.dataset.active = active;
  const chip = (id, label, icon) =>
    '<button type="button" class="filter-btn' + (active === id ? " is-active" : "") +
    '" data-type="' + esc(id) + '" aria-pressed="' + (active === id) + '">' +
    (icon ? esc(icon) + " " : "") + esc(label) + "</button>";
  container.innerHTML = chip("", "All", "") +
    catalog.types.map((t) => chip(t.id, t.label, t.icon)).join("");
  if (!container.dataset.bound) {                       // one delegated listener per container
    container.dataset.bound = "1";
    container.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b || !container._onPick) return;
      renderTypeChips(container, { active: b.dataset.type, onPick: container._onPick });
      container._onPick(b.dataset.type);
    });
  }
}
/* re-paint every [data-room-type-select] / [data-room-type-chips] on the page */
function refreshAll() {
  document.querySelectorAll("[data-room-type-select]").forEach((sel) => fillTypeSelect(sel, sel.value));
  document.querySelectorAll("[data-room-type-chips]").forEach((el) =>
    renderTypeChips(el, { active: el.dataset.active || "" }));
}
/* call once on page load. Paints the fallback synchronously (form never empty),
   then upgrades when the server answers. */
export function initRoomTypes() {
  onCatalogChange(refreshAll);
  refreshAll();
  return loadRoomTypes();
}