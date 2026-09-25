/* public/js/room/lyrics.js
 * ─────────────────────────────────────────────────────────────
 * Music-room lyrics.
 *   • auto-fetches from LRCLIB whenever the track changes
 *     (player.js calls playerHooks.lyricsSetTrack)
 *   • a 🔍 toggle opens a manual search with paginated results
 *   • a 250 ms poll reads P.time() to move the highlight + auto-scroll
 * No backend / queue / permission code is touched. LRCLIB is CORS-open.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { $ } from "./dom.js";
import { S } from "./state.js";
import { P, playerHooks } from "./player.js";
import { emit as sockEmit, getSocket } from "./socket-ref.js";
import { onConnect } from "./socket-core.js";
const API = "https://lrclib.net/api";
const PAGE_SIZE = 4;
const lyricsCache = new Map();   // itemId → LRC (this session + what the server sends)
let currentLrc = null;           // what's on screen — de-dupes re-renders
let lyricsSockWired = false;
let el = {};
let token = 0;
let lines = null;        // [{ time, text }]
let activeIdx = -1;
let timer = null;
let ro = null;
let results = [];
let page = 0;
export function wireLyrics() {
  el = {
    root:    $("musicLyrics"),
    view:    $("lyricsView"),
    toggle:  $("lyricsSearchToggle"),
    search:  $("lyricsSearch"),
    input:   $("lyricsSearchInput"),
    btn:     $("lyricsSearchBtn"),
    results: $("lyricsResults"),
    nav:     $("lyricsNav"),
  };
  if (!el.root || !el.view || !el.toggle) return;
  el.toggle.addEventListener("click", () => (el.search.hidden ? openSearch() : closeSearch()));
  el.btn.addEventListener("click", runSearch);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });
  if (window.ResizeObserver) {
    let raf = 0;
    ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(reScroll);
    });
    ro.observe(el.view);
  }
  playerHooks.lyricsSetTrack = handleTrack;
}
function storedLyrics(id) {
  if (!id) return null;
  if (lyricsCache.has(id)) return lyricsCache.get(id);
  const items = (S.queue && S.queue.items) || [];
  const it = items.find((x) => x && (x.id === id || x.itemId === id));
  return (it && it.lyrics) || null;
}
/* ═══════ track change ═══════ */
async function handleTrack(info) {
  info = info || {};
  closeSearch();
  el.results.innerHTML = "";
  el.nav.innerHTML = "";
  results = [];
  page = 0;
  const id = S.currentItemId;
  const stored = storedLyrics(id);
  if (stored) { renderLyrics(stored); return; }
  const title = (info.title || "").trim();
  if (info.loading || !title) { showMessage("Looking for lyrics…"); return; }
  showMessage("Looking for lyrics…");
  const mine = ++token;
  try {
    const list = await search(title);
    if (mine !== token) return;
    const hit = list.find((x) => x.syncedLyrics);
    if (hit) {
      if (id) lyricsCache.set(id, hit.syncedLyrics);
      renderLyrics(hit.syncedLyrics);
    } else {
      showMessage("No synced lyrics found — use the search icon above.");
    }
  } catch (_) {
    if (mine !== token) return;
    showMessage("Couldn't reach the lyrics service.");
  }
}
/* ═══════ manual search ═══════ */
function openSearch() {
  el.search.hidden = false;
  el.root.classList.add("searching");
  el.toggle.classList.add("is-open");
  el.toggle.setAttribute("aria-expanded", "true");
  el.input.focus();
  el.input.select();
}
function closeSearch() {
  el.search.hidden = true;
  el.root.classList.remove("searching");
  el.toggle.classList.remove("is-open");
  el.toggle.setAttribute("aria-expanded", "false");
}
async function runSearch() {
  const q = (el.input.value || "").trim();
  if (!q) return;
  el.results.innerHTML = '<div class="mls-status">Searching…</div>';
  el.nav.innerHTML = "";
  el.btn.disabled = true;
  const mine = ++token;
  try {
    const list = await search(q);
    if (mine !== token) return;
    results = list.filter((x) => x.syncedLyrics);
    page = 0;
    renderResults();
  } catch (_) {
    if (mine !== token) return;
    el.results.innerHTML = '<div class="mls-status">Search failed — try again.</div>';
  } finally {
    el.btn.disabled = false;
  }
}
function renderResults() {
  el.nav.innerHTML = "";
  if (!results.length) {
    el.results.innerHTML = '<div class="mls-status">No synced lyrics found.</div>';
    return;
  }
  const start = page * PAGE_SIZE;
  el.results.innerHTML = "";
  results.slice(start, start + PAGE_SIZE).forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mls-result";
    b.innerHTML = '<span class="mls-r-title"></span><span class="mls-r-artist"></span>';
    b.querySelector(".mls-r-title").textContent  = r.trackName || r.name || "Unknown title";
    b.querySelector(".mls-r-artist").textContent = r.artistName || "Unknown artist";
    b.addEventListener("click", () => pickResult(r));
    el.results.appendChild(b);
  });
  if (page > 0) el.nav.appendChild(navBtn("← Back", () => { page--; renderResults(); }));
  if (start + PAGE_SIZE < results.length)
    el.nav.appendChild(navBtn("More →", () => { page++; renderResults(); }, "mls-nav-more"));
}
function pickResult(r) {
  const lrc = r && r.syncedLyrics;
  if (!lrc) return;
  renderLyrics(lrc);
  closeSearch();
  const id = S.currentItemId;
  if (id) {
    lyricsCache.set(id, lrc);
    sockEmit("sync-lyrics", { id, lyrics: lrc });
  }
}
function navBtn(label, onClick, extra) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mls-nav-btn" + (extra ? " " + extra : "");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
async function search(q) {
  const res = await fetch(API + "/search?q=" + encodeURIComponent(q));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error("lrclib " + res.status);
  const data = await res.json();
  return Array.isArray(data) ? data.filter(Boolean) : [];
}
/* ═══════ render ═══════ */
function renderLyrics(lrc) {
  if (lrc && lrc === currentLrc && lines) return;
  const parsed = parseLRC(lrc);
  if (!parsed.length) { showMessage("Those lyrics aren't time-synced."); return; }
  currentLrc = lrc;
  lines = parsed;
  activeIdx = -1;
  el.root.classList.add("has-lyrics");
  el.view.textContent = "";
  const frag = document.createDocumentFragment();
  parsed.forEach((ln, i) => {
    const p = document.createElement("p");
    p.className = ln.text ? "mll" : "mll mll-empty";
    p.textContent = ln.text || "♪";
    if (ln.text) p.addEventListener("click", () => seekToLine(i));
    frag.appendChild(p);
  });
  el.view.appendChild(frag);
  el.view.scrollTop = 0;
  startTimer();
  tick();
}
function showMessage(text) {
  currentLrc = null;
  stopTimer();
  lines = null;
  activeIdx = -1;
  el.root.classList.remove("has-lyrics");
  el.view.textContent = "";
  const p = document.createElement("p");
  p.className = "ml-lyrics-ph";
  p.textContent = text;
  el.view.appendChild(p);
  el.view.scrollTop = 0;
}
/* ═══════ synced highlight ═══════ */
function startTimer() { stopTimer(); timer = setInterval(tick, 250); }
function stopTimer()  { clearInterval(timer); timer = null; }
function tick() {
  if (!lines) return;
  const t = (P && P.ready) ? P.time() : 0;
  const idx = lineAt(t);
  if (idx === activeIdx) return;
  const prev = activeIdx;
  activeIdx = idx;
  const nodes = el.view.children;
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("active", i === idx);
  if (idx >= 0 && nodes[idx]) {
    const jump = prev < 0 || Math.abs(idx - prev) > 3;
    scrollTo(nodes[idx], jump ? "auto" : "smooth");
  }
}
function reScroll() {
  if (!lines || activeIdx < 0) return;
  const node = el.view.children[activeIdx];
  if (node) scrollTo(node, "auto");
}
function scrollTo(node, behavior) {
  const c = el.view;
  const top = node.offsetTop - c.clientHeight / 2 + node.clientHeight / 2;
  c.scrollTo({ top: Math.max(0, top), behavior });
}
function lineAt(t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function seekToLine(i) {
  const ln = lines && lines[i];
  if (!ln) return;
  if (!(S.perms && S.perms.canSync)) return;   // silently ignore for non-controllers
  P.act("seek", ln.time);
}
/* ═══════ LRC parser — handles [mm:ss.xx] and [mm:ss:xx] ═══════ */
function parseLRC(lrc) {
  const out = [];
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  (lrc || "").split(/\r?\n/).forEach((raw) => {
    re.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
      const frac = m[3] ? Number((m[3] + "000").slice(0, 3)) / 1000 : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    if (!stamps.length) return;                 // metadata tag or blank line
    const text = raw.replace(re, "").trim();
    stamps.forEach((time) => out.push({ time, text }));
  });
  return out.sort((a, b) => a.time - b.time);
}
onConnect(() => {
  if (lyricsSockWired) return;
  lyricsSockWired = true;
  getSocket().on("sync-lyrics", ({ id, lyrics } = {}) => {
    if (!el.root || S.roomType !== "music") return;
    if (!id || !lyrics) return;
    lyricsCache.set(id, lyrics);
    if (id === S.currentItemId) renderLyrics(lyrics);
  });
});