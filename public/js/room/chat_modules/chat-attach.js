/* public/js/chat-attach.js
 * ─────────────────────────────────────────────────────────────
 * COMPOSER ATTACHMENTS — image links become thumbnails.
 *
 *  • Paste/drop an image link → cut from the textarea immediately.
 *    Typed links are cut once terminated (space/newline) or after IDLE_MS.
 *    Whatever is still in the text gets flushed at send.
 *  • A link attachment remembers WHERE it was cut (`anchor`) and the exact
 *    substring (`chunk`). Every edit shifts anchors, so × re-injects the link
 *    at its original spot without touching text typed since.
 *  • A thumbnail that fails to load is sent back as a plain link, in place.
 *  • takeOutgoing() → [{ text, mediaUrl: img1 }, { text: "", mediaUrl: img2 }, …]
 *    one message per image; the server processes them strictly in order.
 *
 *   wireAttachments({ input, strip, layout })
 *       layout(mutate) — caller measures "pinned", runs mutate(), regrows/re-pins
 *   takeOutgoing()       build the batch (doesn't clear anything)
 *   resetAttachments()   call after the textarea has been cleared
 *   stageGif(url)        GIF picker in "stage" mode
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { MAX_ATTACHMENTS } from "../config.js";
import { normalizeImageUrl, findImageUrls, cutImageUrl, restoreChunk } from "./media-embed.js";
import { openLightbox } from "./lightbox.js";
const IDLE_MS = 900;
const INSTANT = /^(?:insertFromPaste|insertFromDrop|insertReplacementText|insertFromYank)$/;
/* document order. link: anchor = offset in the textarea; gif: anchor = null */
const items = [];
/* links the user un-embedded with × — left alone until they leave the text */
const skip = new Set();
let ta = null, strip = null, layout = (fn) => fn();
let prev = "", sel = null, idleT = 0, composing = false, uid = 0;
const X_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">' +
  '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
const BROKEN_SVG =
  '<svg class="chat-attach-broken" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
/* ── anchor bookkeeping ───────────────────────────────────── */
/* a user edit turned P into N; shift anchors that sit after the changed region */
function trackEdit(P, N, before, inputType) {
  if (P === N || !items.some((it) => it.anchor != null)) return;
  const min = Math.min(P.length, N.length);
  let p = 0;
  while (p < min && P.charCodeAt(p) === N.charCodeAt(p)) p++;
  /* the edit can't start after the pre-edit caret ("aa|" + "a" is ambiguous otherwise) */
  if (before && !/Drop|Drag/.test(inputType || "")) p = Math.min(p, before.s);
  let s = 0;
  while (s < min - p && P.charCodeAt(P.length - 1 - s) === N.charCodeAt(N.length - 1 - s)) s++;
  const oldEnd = P.length - s, newEnd = N.length - s, delta = N.length - P.length;
  for (const it of items) {
    if (it.anchor == null || it.anchor <= p) continue;          // typing AT an anchor → link stays before it
    it.anchor = it.anchor >= oldEnd ? it.anchor + delta : newEnd; // inside a replaced selection → clamp
  }
}
function shiftAfterCut(start, end) {
  const n = end - start;
  for (const it of items) {
    if (it.anchor == null || it.anchor <= start) continue;
    it.anchor = it.anchor >= end ? it.anchor - n : start;
  }
}
/* ── extraction ───────────────────────────────────────────── */
function pruneSkip() {
  if (!skip.size) return;
  const live = new Set(findImageUrls(ta.value).map((h) => h.url));
  for (const u of skip) if (!live.has(u)) skip.delete(u);
}
/* mode "terminated" → only finished tokens; "all" → paste / idle / send */
function extract(mode) {
  if (composing) return false;
  pruneSkip();
  let did = false;
  while (items.length < MAX_ATTACHMENTS) {
    const text = ta.value;
    const hit = findImageUrls(text).find((h) => !skip.has(h.url) && (mode === "all" || h.terminated));
    if (!hit) break;
    const cut = cutImageUrl(text, hit);
    /* doc position: after links anchored at/before the cut, before anything after it */
    let idx = items.findIndex((it) => it.anchor == null || it.anchor > cut.start);
    if (idx < 0) idx = items.length;
    shiftAfterCut(cut.start, cut.end);
    ta.setRangeText("", cut.start, cut.end, "preserve");      // caret lands where the link was
    items.splice(idx, 0, {
      id: ++uid, source: "link", url: hit.url, ok: null, el: null,
      anchor: cut.start, chunk: cut.chunk, lead: cut.lead, trail: cut.trail,
    });
    did = true;
  }
  if (did) { prev = ta.value; commit(); }
  return did;
}
/* × — link goes back exactly where it was */
function dismiss(it) {
  const idx = items.indexOf(it);
  if (idx < 0) return;
  items.splice(idx, 1);
  if (it.source === "link" && it.anchor != null) {
    const text = ta.value;
    const at   = Math.min(it.anchor, text.length);
    const ins  = restoreChunk(text, at, it);
    const caretHere = ta.selectionStart === at && ta.selectionEnd === at;
    ta.setRangeText(ins, at, at, caretHere ? "end" : "preserve");
    /* later siblings (incl. ties that came after this one) move right */
    items.forEach((o, i) => {
      if (o.anchor != null && (o.anchor > at || (o.anchor === at && i >= idx))) o.anchor += ins.length;
    });
    skip.add(it.url);
    prev = ta.value;
  }
  commit();
}
/* ── rendering (keyed, so thumbnails don't reload on every change) ── */
function commit() { layout(render); }
function render() {
  if (!strip) return;
  for (const child of Array.from(strip.children))
    if (!items.some((it) => it.el === child)) child.remove();
  items.forEach((it, i) => {
    if (!it.el) it.el = makeThumb(it);
    if (strip.children[i] !== it.el) strip.insertBefore(it.el, strip.children[i] || null);
  });
  strip.hidden = items.length === 0;
}
function makeThumb(it) {
  const el = document.createElement("div");
  el.className = "chat-attach-item loading";
  el.setAttribute("role", "listitem");
  el.innerHTML =
    '<button type="button" class="chat-attach-view" aria-label="Preview">' +
      '<img alt="" referrerpolicy="no-referrer" draggable="false">' + BROKEN_SVG +
    "</button>" +
    '<button type="button" class="chat-attach-x" aria-label="' +
      (it.source === "gif" ? "Remove GIF" : "Remove image and keep the link") + '">' + X_SVG + "</button>";
  const img = el.querySelector("img");
  img.onload  = () => { it.ok = true;  el.classList.remove("loading"); };
  img.onerror = () => {
    it.ok = false;
    el.classList.remove("loading");
    el.classList.add("broken");
    el.title = it.source === "gif" ? "Couldn't load this GIF" : "Couldn't load — will be sent as a link";
  };
  img.src = it.url;
  /* keep the textarea focused and its caret untouched */
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.querySelector(".chat-attach-x").addEventListener("click", () => dismiss(it));
  el.querySelector(".chat-attach-view").addEventListener("click", () => {
    if (it.ok !== false) openLightbox(it.url);
  });
  return el;
}
/* ── public API ───────────────────────────────────────────── */
export function wireAttachments(opts) {
  ta = opts.input;
  strip = opts.strip;
  if (opts.layout) layout = opts.layout;
  prev = ta.value;
  ta.addEventListener("beforeinput", () => { sel = { s: ta.selectionStart, e: ta.selectionEnd }; });
  ta.addEventListener("compositionstart", () => { composing = true; });
  ta.addEventListener("compositionend", () => { composing = false; extract("terminated"); });
  ta.addEventListener("input", (e) => {
    trackEdit(prev, ta.value, sel, e.inputType);
    prev = ta.value;
    sel = null;
    clearTimeout(idleT);
    if (e.isComposing) return;
    extract(INSTANT.test(e.inputType || "") ? "all" : "terminated");
    idleT = setTimeout(() => extract("all"), IDLE_MS);
  });
}
export function takeOutgoing() {
  clearTimeout(idleT);
  extract("all");                                             // flush typed-but-unfinished links
  let text = ta.value;
  /* failed thumbnails → back into the text as links (reverse order keeps anchors valid) */
  const failed = items.filter((it) => it.source === "link" && it.ok === false);
  for (let i = failed.length - 1; i >= 0; i--) {
    const it = failed[i], at = Math.min(it.anchor, text.length);
    text = text.slice(0, at) + restoreChunk(text, at, it) + text.slice(at);
  }
  text = text.trim();
  const media = items.filter((it) => it.ok !== false).map((it) => it.url);
  if (!text && !media.length) return [];
  const batch = [{ text, mediaUrl: media[0] || null }];       // text rides with the first image
  for (let i = 1; i < media.length; i++) batch.push({ text: "", mediaUrl: media[i] });
  return batch;
}
export function resetAttachments() {
  clearTimeout(idleT);
  items.length = 0;
  skip.clear();
  prev = ta ? ta.value : "";
  sel = null;
  commit();
}
export function stageGif(url) {
  const clean = normalizeImageUrl(url);
  if (!clean || items.length >= MAX_ATTACHMENTS) return false;
  items.push({ id: ++uid, source: "gif", url: clean, ok: null, el: null, anchor: null, chunk: "" });
  commit();
  return true;
}
export const attachmentCount = () => items.length;