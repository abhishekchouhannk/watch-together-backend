/* public/js/lightbox.js
 * ─────────────────────────────────────────────────────────────
 * FULLSCREEN IMAGE VIEWER
 *   openLightbox(url) / closeLightbox() / isLightboxOpen()
 *   wireLightbox(container)  left-click on a .msg-media-link inside `container`
 *                            opens the viewer. Ctrl/⌘/Shift/middle-click still
 *                            open a new tab natively (the href is kept).
 * Dismiss: × button, backdrop click, Esc. Focus is trapped while open and
 * returned to the opener afterwards. Appended to <body> so no transformed
 * ancestor can trap position:fixed.
 * ───────────────────────────────────────────────────────────── */
"use strict";
const OUT_MS = 180;
let root = null, img = null, closeBtn = null, openLink = null;
let lastFocus = null, closeT = 0, seq = 0;
function ensure() {
  if (root) return;
  root = document.createElement("div");
  root.className = "lb";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Image viewer");
  root.innerHTML =
    '<div class="lb-stage">' +
      '<span class="lb-spinner" aria-hidden="true"></span>' +
      '<img class="lb-img" alt="" referrerpolicy="no-referrer" draggable="false">' +
      '<div class="lb-error">Image unavailable</div>' +
    "</div>" +
    '<a class="lb-btn lb-open" target="_blank" rel="noopener noreferrer nofollow" ' +
       'title="Open original" aria-label="Open original in a new tab">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M14 4h6v6"/><line x1="20" y1="4" x2="11" y2="13"/>' +
        '<path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>' +
    "</a>" +
    '<button type="button" class="lb-btn lb-close" title="Close (Esc)" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">' +
        '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' +
    "</button>";
  document.body.appendChild(root);
  img      = root.querySelector(".lb-img");
  closeBtn = root.querySelector(".lb-close");
  openLink = root.querySelector(".lb-open");
  closeBtn.addEventListener("click", closeLightbox);
  /* backdrop = the overlay or the empty stage around the image */
  root.addEventListener("click", (e) => {
    if (e.target === root || e.target.classList.contains("lb-stage")) closeLightbox();
  });
  /* capture on window → runs before the app's document-level Esc handlers */
  window.addEventListener("keydown", (e) => {
    if (!isLightboxOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeLightbox();
    } else if (e.key === "Tab") {                       // two focusables → simple trap
      e.preventDefault();
      (document.activeElement === closeBtn ? openLink : closeBtn).focus();
    }
  }, true);
}
/* GIPHY: the chat shows the 200px rendition; view the full one here */
function hiRes(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)giphy\.com$/i.test(u.hostname)) return url;
    const parts = u.pathname.split("/");
    if (/^(?:\d+w?(?:_d)?|giphy-downsized(?:-[a-z]+)?)\.gif$/i.test(parts[parts.length - 1])) {
      parts[parts.length - 1] = "giphy.gif";
      u.pathname = parts.join("/");
      return u.href;
    }
  } catch (_) {}
  return url;
}
export const isLightboxOpen = () => !!root && root.classList.contains("open");
export function openLightbox(url) {
  if (!url) return;
  ensure();
  clearTimeout(closeT);
  const s = ++seq;
  const full = hiRes(url);
  let fellBack = full === url;
  if (!isLightboxOpen()) lastFocus = document.activeElement;
  root.classList.remove("error");
  root.classList.add("loading");
  img.onload = () => { if (s === seq) root.classList.remove("loading"); };
  img.onerror = () => {
    if (s !== seq) return;
    if (!fellBack) { fellBack = true; img.src = url; return; }   // hi-res missing → what the chat showed
    root.classList.remove("loading");
    root.classList.add("error");
  };
  img.src = full;
  openLink.href = url;
  root.hidden = false;
  void root.offsetWidth;                                         // commit before the fade-in
  root.classList.add("open");
  document.documentElement.classList.add("lb-lock");
  closeBtn.focus({ preventScroll: true });
}
export function closeLightbox() {
  if (!isLightboxOpen()) return;
  ++seq;
  root.classList.remove("open");
  document.documentElement.classList.remove("lb-lock");
  closeT = setTimeout(() => {
    root.hidden = true;
    img.onload = img.onerror = null;
    img.removeAttribute("src");
  }, OUT_MS);
  if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}
export function wireLightbox(container) {
  container.addEventListener("click", (e) => {
    const a = e.target.closest(".msg-media-link");
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openLightbox(a.getAttribute("href"));
  });
}