/* public/js/shared/icon-engine.js
 * ─────────────────────────────────────────────────────────────
 * EMOJI → SVG ICON ENGINE (Twemoji-style, but inline Lucide SVGs that
 * inherit the active theme through currentColor). No imports.
 *
 *  Registry   ICONS        lucide name → inner SVG markup
 *             EMOJI_ICON   literal emoji → lucide name (what the DB / old
 *                          render code still outputs)
 *             KEY_ICON     semantic key → lucide name ("entertainment",
 *                          "owner", "private"…) — one icon per concept
 *
 *  getIcon(key, fallbackEmoji, className) → HTML string
 *             key may be a semantic key, a lucide name or a literal emoji.
 *             Unknown → <span class="wt-emoji">fallbackEmoji</span>.
 *  getIconNode(key, className) → SVGElement | null
 *  registerIcon(name, body, { emoji, keys })   add / override at runtime
 *
 *  startIconEngine({ exclude })   scan the page once, then keep it converted:
 *             a MutationObserver handles everything rendered later
 *             (innerHTML, textContent, appended nodes, edited text nodes).
 *             Its callback runs before the next paint → no emoji flash for
 *             JS-rendered UI. Calling it again just merges more excludes.
 *  replaceEmojiIn(node)           manual one-off pass (e.g. detached trees)
 *
 *  Never touched: <textarea> <input> <select>/<option> <script> <style>
 *  <svg> <code>/<pre>, contenteditable, [data-no-icons], your `exclude`
 *  selectors, attributes (title / aria-label / placeholder) and CSS content.
 *
 *  Performance: one precompiled regex; added subtrees are rejected with a
 *  single textContent test; excluded subtrees are skipped whole by the
 *  TreeWalker; icons are cloned from cached prototypes; the engine's own
 *  DOM writes are dropped with takeRecords().
 * ───────────────────────────────────────────────────────────── */
"use strict";
/* ══════════ 1. REGISTRY ══════════
   Lucide (ISC licence) — 24×24, stroke-only, currentColor. */
const ICONS = {
  /* room types */
  clapperboard: '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  "book-open": '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  /* roles / access */
  crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  /* empty states / chrome */
  house: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  tv: '<rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  /* whiteboard / timer */
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  "folder-open": '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  "skip-forward": '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  /* theme switcher */
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  sunrise: '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  sunset: '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  "cloud-sun": '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
};
/* literal emoji → icon. The variation selector (U+FE0F) is optional on both
   sides, so "🏷" and "🏷️" both match. Delete a line to keep that emoji. */
const EMOJI_ICON = {
  /* ── the set you asked for ── */
  "🎬": "clapperboard",      // Entertainment
  "🎵": "music",             // Music
  "📚": "book-open",         // Study
  "🏷️": "tag",               // unknown room type
  "👑": "crown",             // owner badge
  "🌐": "globe",             // public
  "🔒": "lock",              // private / locked
  "🏠": "house",             // "my rooms" empty state
  "🔍": "search",            // "no results" empty state
  "📺": "tv",                // "no rooms" / "no video"
  "👥": "users",             // member counts, "Everyone"
  /* ── other UI-chrome emoji found in room.html / permissions.js ── */
  "🛡️": "shield",            // MOD
  "✅": "circle-check",      // tasks empty state
  "🎙️": "mic",               // voice empty state
  "📱": "smartphone",        // study "screen too small"
  "💻": "laptop",
  "✏️": "pencil",            // whiteboard
  "🧽": "eraser",
  "📂": "folder-open",
  "💾": "save",
  "⏭": "skip-forward",       // pomodoro skip
  "🧭": "compass",           // theme: auto
  "🌅": "sunrise",           // theme: morning
  "☀️": "sun",               // theme: afternoon
  "🌆": "sunset",            // theme: evening
  "🌙": "moon",              // theme: night
  "🌤️": "cloud-sun",         // theme button
};
/* semantic key → icon (lucide names themselves also work as keys) */
const KEY_ICON = {
  entertainment: "clapperboard",
  study: "book-open",
  "room-type": "tag",
  owner: "crown", host: "crown",
  mod: "shield", moderator: "shield",
  members: "users", everyone: "users",
  public: "globe",
  private: "lock", locked: "lock",
  home: "house", "my-rooms": "house",
  "no-results": "search",
  "no-rooms": "tv", "no-video": "tv",
};
/* ══════════ 2. HELPERS ══════════ */
const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false"';   // width/height="1em": sane size even if the CSS is missing
const ZWJ = 0x200d, VS15 = 0xfe0e;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const bare = (s) => String(s).replace(/\uFE0F/g, "");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cleanClass = (c) => String(c || "").replace(/[^\w\- ]/g, "").trim();
/* engine state */
const SKIP_TAGS = new Set([
  "textarea", "input", "select", "option", "optgroup", "datalist",   // form controls: text only
  "script", "style", "noscript", "template", "title",
  "svg", "math", "canvas", "iframe", "object",
  "code", "pre", "kbd", "samp",
]);
const BASE_SKIP = ['[contenteditable]:not([contenteditable="false"])', "[data-no-icons]"];
const E = {
  running: false, root: null, mo: null,
  extra: [],            // caller-supplied exclude selectors
  selRest: "",          // attribute/class selectors (TreeWalker, after the tag Set)
  selAll: "",           // tags + selRest (for closest())
  emoji: new Map(),     // bare emoji → icon name
  reAll: null, reHas: null,
  protos: new Map(),    // icon name → prototype <svg> to clone
};
function compile() {
  E.emoji.clear();
  for (const k of Object.keys(EMOJI_ICON)) {
    if (own(ICONS, EMOJI_ICON[k])) E.emoji.set(bare(k), EMOJI_ICON[k]);
  }
  const keys = [...E.emoji.keys()].filter(Boolean).sort((a, b) => b.length - a.length).map(escRe);
  if (!keys.length) { E.reAll = E.reHas = null; return; }
  const src = "(?:" + keys.join("|") + ")\\uFE0F?";
  E.reAll = new RegExp(src, "gu");
  E.reHas = new RegExp(src, "u");
}
function rebuildSkip() {
  E.selRest = BASE_SKIP.concat(E.extra).join(",");
  E.selAll = [...SKIP_TAGS].join(",") + "," + E.selRest;
}
function resolve(key) {
  if (key == null || key === "") return null;
  const k = String(key).trim();
  if (own(ICONS, k)) return k;                              // lucide name
  const lower = k.toLowerCase();
  if (own(KEY_ICON, lower) && own(ICONS, KEY_ICON[lower])) return KEY_ICON[lower];   // semantic key
  return E.emoji.get(bare(k)) || null;                      // literal emoji
}
function svgHTML(name, cls, emoji) {
  return '<svg class="wt-ic wt-ic-' + name + (cls ? " " + cls : "") + '" ' + SVG_ATTRS +
    (emoji ? ' data-wt-emoji="' + esc(emoji) + '"' : "") + ">" + ICONS[name] + "</svg>";
}
function proto(name) {
  let n = E.protos.get(name);
  if (!n) {
    const t = document.createElement("template");
    t.innerHTML = svgHTML(name, "", "");
    n = t.content.firstElementChild;
    E.protos.set(name, n);
  }
  return n;
}
function cloneIcon(name, emoji) {
  const n = proto(name).cloneNode(true);
  if (emoji) n.setAttribute("data-wt-emoji", emoji);
  return n;
}
/* ══════════ 3. PUBLIC: ICON HELPERS ══════════ */
export const hasIcon = (key) => !!resolve(key);
/**
 * getIcon("entertainment")            → <svg class="wt-ic wt-ic-clapperboard" …>
 * getIcon("🎬")                       → same icon (DB still stores the emoji)
 * getIcon(type.id, type.icon, "lg")   → icon if known, else <span class="wt-emoji lg">🎮</span>
 */
export function getIcon(key, fallbackEmoji = "", className = "") {
  const cls = cleanClass(className);
  const name = resolve(key) || resolve(fallbackEmoji);
  if (name) return svgHTML(name, cls, "");
  const glyph = fallbackEmoji || (/[^\x00-\x7F]/.test(String(key || "")) ? key : "");
  return '<span class="wt-emoji' + (cls ? " " + cls : "") + '">' + esc(glyph) + "</span>";
}
/** Same as getIcon but a ready DOM node (null when there is no icon). */
export function getIconNode(key, className = "") {
  const name = resolve(key);
  if (!name) return null;
  const n = cloneIcon(name, "");
  const cls = cleanClass(className);
  if (cls) n.classList.add(...cls.split(/\s+/));
  return n;
}
/** Add or override an icon at runtime (e.g. a new room type).
 *  registerIcon("gamepad-2", '<path …/>', { emoji: ["🎮"], keys: ["gaming"] }) */
export function registerIcon(name, body, { emoji = [], keys = [] } = {}) {
  if (!name || typeof body !== "string") return;
  ICONS[name] = body;
  E.protos.delete(name);
  emoji.forEach((e) => { EMOJI_ICON[e] = name; });
  keys.forEach((k) => { KEY_ICON[String(k).toLowerCase()] = name; });
  compile();
  if (E.running) scan(E.root);
}
/* ══════════ 4. DOM REPLACER ══════════ */
/* one text node → [text, <svg>, text…]; returns true when something changed */
function swap(t) {
  const text = t.nodeValue, re = E.reAll;
  re.lastIndex = 0;
  let m, last = 0, frag = null;
  while ((m = re.exec(text))) {
    const start = m.index, end = start + m[0].length;
    // part of a longer emoji sequence (ZWJ) or explicitly text-style (VS15) → leave it
    if (text.charCodeAt(start - 1) === ZWJ) continue;
    const next = text.charCodeAt(end);
    if (next === ZWJ || next === VS15) continue;
    const name = E.emoji.get(bare(m[0]));
    if (!name) continue;
    if (!frag) frag = document.createDocumentFragment();
    if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
    frag.appendChild(cloneIcon(name, m[0]));
    last = end;
  }
  if (!frag) return false;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  t.parentNode.replaceChild(frag, t);
  return true;
}
/* walk a subtree; excluded elements are rejected WITH their whole subtree */
const FILTER = {
  acceptNode(n) {
    if (n.nodeType === 1) {
      return SKIP_TAGS.has(n.localName) || n.matches(E.selRest)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    }
    return E.reHas.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  },
};
function scan(root) {
  if (!E.reHas || !root) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, FILTER);
  const hits = [];
  while (w.nextNode()) hits.push(w.currentNode);            // collect first, mutate after
  for (let i = 0; i < hits.length; i++) swap(hits[i]);
}
function handleText(t) {
  if (!t.isConnected || !E.reHas.test(t.nodeValue)) return; // cheapest test first
  const p = t.parentElement;
  if (!p || p.closest(E.selAll)) return;
  swap(t);
}
function handleEl(el) {
  if (!el.isConnected || el.localName === "svg") return;
  if (!E.reHas.test(el.textContent)) return;                // one string test rejects most subtrees
  if (el.closest(E.selAll)) return;
  scan(el);
}
function onMutations(records) {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === "characterData") {
      if (r.target.nodeType === 3) handleText(r.target);
      continue;
    }
    const added = r.addedNodes;
    for (let j = 0; j < added.length; j++) {
      const n = added[j];
      if (n.nodeType === 3) handleText(n);
      else if (n.nodeType === 1) handleEl(n);
    }
  }
  if (E.mo) E.mo.takeRecords();                             // drop the records our own swaps queued
}
/* excludes can arrive late (second start call): validate, merge, and put the
   emoji back anywhere that is excluded from now on */
function addExcludes(list) {
  const fresh = [];
  for (const sel of list || []) {
    if (typeof sel !== "string" || !sel.trim() || E.extra.includes(sel)) continue;
    try { document.documentElement.matches(sel); }
    catch (_) { console.warn("[icon-engine] ignoring invalid exclude selector:", sel); continue; }
    E.extra.push(sel);
    fresh.push(sel);
  }
  if (!fresh.length) return;
  rebuildSkip();
  if (!E.running) return;
  E.root.querySelectorAll(fresh.join(",")).forEach((host) => {
    host.querySelectorAll("svg.wt-ic[data-wt-emoji]").forEach((svg) => {
      svg.replaceWith(document.createTextNode(svg.getAttribute("data-wt-emoji")));
    });
  });
}
/* ══════════ 5. PUBLIC: ENGINE ══════════ */
/** Manual one-off pass over a node or subtree (respects all exclusions). */
export function replaceEmojiIn(node) {
  if (!node || !E.reHas) return;
  if (node.nodeType === 3) {
    const p = node.parentElement;
    if (p && !p.closest(E.selAll) && E.reHas.test(node.nodeValue)) swap(node);
    return;
  }
  if (node.nodeType === 1 && node.closest(E.selAll)) return;
  scan(node);
}
export function stopIconEngine() {
  if (E.mo) { E.mo.disconnect(); E.mo = null; }
  E.running = false;
}
const handle = {
  stop: stopIconEngine,
  rescan: () => { if (E.running) scan(E.root); },
  exclude: (list) => addExcludes(Array.isArray(list) ? list : [list]),
};
/**
 * startIconEngine({ exclude: [".msg-text", "#queueList"] })
 * Idempotent: a second call only merges its `exclude` list.
 */
export function startIconEngine({ root = null, exclude = [], observe = true } = {}) {
  if (typeof document === "undefined") return handle;
  addExcludes(exclude);
  if (E.running) return handle;
  E.root = root || document.documentElement;
  E.running = true;
  scan(E.root);                                             // static markup already in the page
  if (observe && typeof MutationObserver === "function") {
    E.mo = new MutationObserver(onMutations);
    E.mo.observe(E.root, { childList: true, subtree: true, characterData: true });
  }
  return handle;
}
compile();
rebuildSkip();