/* public/js/gif-picker.js
 * ─────────────────────────────────────────────────────────────
 * GIPHY PICKER — popover anchored above the composer.
 *
 *   wireGifPicker({ onPick })   call once; onPick({ url, title }) on selection
 *   openGifPicker() / closeGifPicker() / toggleGifPicker() / isGifPickerOpen()
 *
 * Trending on first open, debounced search, offset pagination on scroll.
 * Results are laid out in an order-preserving 2-column masonry; every tile
 * reserves its aspect ratio up front, so nothing shifts while thumbnails load.
 * Height is fitted to the space above the composer, so the popover never
 * gets clipped by .chat-section{overflow:hidden}.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { GIPHY_KEY, GIPHY_RATING } from "../config.js";
import { $ } from "../dom.js";
import { esc } from "../utils.js";
import { normalizeImageUrl } from "./media-embed.js";
const API      = "https://api.giphy.com/v1/gifs/";
const PAGE     = 24;
const DEBOUNCE = 350;
const MAX_H    = 352;   // px — matches ~22rem
const st = {
  q: null,              // current query ("" = trending, null = never loaded)
  offset: 0, more: true, busy: false, err: false,
  seq: 0, ctrl: null, timer: 0,
  colH: [0, 0],         // accumulated tile heights (in "ratios") per column
  onPick: null,
};
let ui = null;
function refs() {
  if (ui) return ui;
  return (ui = {
    root:     $("gifPicker"),
    btn:      $("gifBtn"),
    input:    $("gifSearch"),
    label:    $("gifLabel"),
    scroll:   $("gifScroll"),
    status:   $("gifStatus"),
    cols:     Array.from($("gifGrid").children),
    composer: $("chatComposer"),
    pane:     $("paneChat"),
  });
}
export const isGifPickerOpen = () => !!ui && !ui.root.hidden;
/* size the popover to the room between the pane top and the composer */
function fit() {
  const u = refs();
  const room = u.composer.getBoundingClientRect().top - u.pane.getBoundingClientRect().top - 10;
  u.root.style.setProperty("--gif-h", Math.max(140, Math.min(MAX_H, Math.floor(room))) + "px");
}
export function openGifPicker() {
  const u = refs();
  u.root.hidden = false;
  u.btn.classList.add("active");
  u.btn.setAttribute("aria-expanded", "true");
  fit();
  if (st.q === null) search("");                           // first open → trending
  else maybeMore();
  /* don't pop the virtual keyboard on touch devices */
  if (matchMedia("(hover: hover)").matches) u.input.focus({ preventScroll: true });
}
export function closeGifPicker() {
  if (!ui || ui.root.hidden) return;
  ui.root.hidden = true;
  ui.btn.classList.remove("active");
  ui.btn.setAttribute("aria-expanded", "false");
  clearTimeout(st.timer);
}
export function toggleGifPicker() { isGifPickerOpen() ? closeGifPicker() : openGifPicker(); }
function search(q) {
  q = (q || "").trim();
  if (q === st.q) return;
  const u = refs();
  if (st.ctrl) st.ctrl.abort();
  Object.assign(st, { q, offset: 0, more: true, busy: false, err: false, ctrl: null, colH: [0, 0] });
  u.cols.forEach((c) => c.replaceChildren());
  u.scroll.scrollTop = 0;
  u.label.textContent = q ? 'Results for "' + q + '"' : "Trending";
  loadPage();
}
async function loadPage() {
  if (st.busy || !st.more || st.err) return;
  if (!GIPHY_KEY || GIPHY_KEY.startsWith("YOUR_")) { setStatus("nokey"); return; }
  st.busy = true;
  const seq  = ++st.seq;
  const ctrl = (st.ctrl = new AbortController());
  setStatus("loading");
  const params = new URLSearchParams({
    api_key: GIPHY_KEY, limit: String(PAGE), offset: String(st.offset), rating: GIPHY_RATING,
  });
  if (st.q) { params.set("q", st.q); params.set("lang", "en"); }
  try {
    const r = await fetch(API + (st.q ? "search" : "trending") + "?" + params, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (seq !== st.seq) return;
    const raw = Array.isArray(d.data) ? d.data : [];
    st.offset += raw.length;                                 // raw count → filtered items never repeat
    const total = d.pagination && d.pagination.total_count;
    st.more = raw.length === PAGE && (total == null || st.offset < total);
    render(raw.map(toGif).filter(Boolean));
    setStatus(st.offset === 0 ? "empty" : "");
  } catch (err) {
    if (err.name === "AbortError" || seq !== st.seq) return;
    st.err = true;
    setStatus("error");
  } finally {
    if (seq === st.seq) {
      st.busy = false;
      st.ctrl = null;
      maybeMore();                                           // tall popover, short page → keep filling
    }
  }
}
/* pick renditions: a ~200px-tall GIF to SEND, a light 200px-wide webp to PREVIEW */
function toGif(g) {
  const im = g && g.images;
  if (!im) return null;
  const send  = im.fixed_height || im.downsized || im.original;
  const thumb = im.fixed_width_downsampled || im.fixed_width || im.fixed_height_small || send;
  const url   = send && normalizeImageUrl(send.url);           // must pass the server's rule
  if (!url || !thumb || !(thumb.webp || thumb.url)) return null;
  const w = +thumb.width || 200, h = +thumb.height || 150;
  return { url, thumb: thumb.webp || thumb.url, title: g.title || "GIF", w, h };
}
function render(items) {
  const u = refs();
  const frags = [document.createDocumentFragment(), document.createDocumentFragment()];
  for (const g of items) {
    const i = st.colH[0] <= st.colH[1] ? 0 : 1;               // shortest column, in order
    st.colH[i] += g.h / g.w + 0.04;                           // + gap fudge
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gif-tile";
    b.dataset.url = g.url;
    b.title = g.title;
    b.setAttribute("aria-label", g.title);
    b.style.aspectRatio = g.w + " / " + g.h;
    b.innerHTML = '<img src="' + esc(g.thumb) + '" alt="" loading="lazy" decoding="async" ' +
                  'referrerpolicy="no-referrer" draggable="false">';
    b.firstChild.addEventListener("load", () => b.classList.add("ready"), { once: true });
    frags[i].appendChild(b);
  }
  u.cols[0].appendChild(frags[0]);
  u.cols[1].appendChild(frags[1]);
}
function maybeMore() {
  const u = refs(), s = u.scroll;
  if (u.root.hidden || st.busy || !st.more || st.err) return;
  if (s.scrollHeight - s.scrollTop - s.clientHeight < 240) loadPage();
}
function setStatus(kind) {
  const s = refs().status;
  s.dataset.kind = kind || "";
  if (kind === "loading")    s.innerHTML = '<span class="chat-spinner"></span>';
  else if (kind === "empty") s.textContent = 'No GIFs found for "' + st.q + '"';
  else if (kind === "error") s.innerHTML = "Couldn't reach GIPHY. " +
                               '<button type="button" class="gif-retry" data-gif-retry>Retry</button>';
  else if (kind === "nokey") s.textContent = "Add your GIPHY API key in config.js";
  else                       s.textContent = "";
  s.hidden = !kind;
}
export function wireGifPicker({ onPick } = {}) {
  st.onPick = onPick || null;
  const u = refs();
  u.btn.addEventListener("click", toggleGifPicker);
  u.input.addEventListener("input", () => {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => search(u.input.value), DEBOUNCE);
  });
  u.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(st.timer); search(u.input.value); }
  });
  u.scroll.addEventListener("scroll", maybeMore, { passive: true });
  u.root.addEventListener("click", (e) => {
    if (e.target.closest("[data-gif-retry]")) { st.err = false; loadPage(); return; }
    const tile = e.target.closest(".gif-tile");
    if (!tile) return;
    closeGifPicker();
    if (st.onPick) st.onPick({ url: tile.dataset.url, title: tile.title });
  });
  /* dismissers */
  document.addEventListener("pointerdown", (e) => {
    if (!isGifPickerOpen()) return;
    if (u.root.contains(e.target) || u.btn.contains(e.target)) return;
    closeGifPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isGifPickerOpen()) { closeGifPicker(); u.btn.focus(); }
  });
  window.addEventListener("resize", () => { if (isGifPickerOpen()) fit(); });
}