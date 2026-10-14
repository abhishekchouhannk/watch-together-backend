/* public/js/room/side-tabs.js
 * Side-panel tabs, fully data-driven:  .sp-tab[data-tab="x"] ⇄ .sp-pane[data-tab="x"].
 * Adding a tab = adding those two elements in room.html. Nothing here knows tab
 * names or contents — modules that care about a switch use onTabChange().
 * Leaf module: no imports. */
"use strict";
let root = null, current = null;
const listeners = new Set();
const tabs  = () => [...root.querySelectorAll(".sp-tab[data-tab]")];
const panes = () => [...root.querySelectorAll(".sp-pane[data-tab]")];
const isShown = (el) => getComputedStyle(el).display !== "none";   // hidden per room type by CSS

export function switchTab(name) {
  if (!root) return false;
  const tab = tabs().find((t) => t.dataset.tab === name);
  if (!tab || !isShown(tab)) return false;
  for (const t of tabs()) {
    const on = t === tab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  }
  for (const p of panes()) p.classList.toggle("active", p.dataset.tab === name);
  const prev = current;
  current = name;
  if (prev !== name) listeners.forEach((fn) => fn(name, prev));
  return true;
}
export const activeTab = () => current;
export function onTabChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/* after the room type is applied: if the active tab is hidden here, fall back to the first visible one */
export function ensureVisibleTab() {
  if (!root) return;
  const active = tabs().find((t) => t.classList.contains("active"));
  if (active && isShown(active)) { current = active.dataset.tab; return; }
  const first = tabs().find(isShown);
  if (first) switchTab(first.dataset.tab);
}
export function initSideTabs(container = document.getElementById("chatSection")) {
  if (!container || root) return;
  root = container;
  root.addEventListener("click", (e) => {
    const tab = e.target.closest(".sp-tab[data-tab]");
    if (tab && root.contains(tab)) switchTab(tab.dataset.tab);
  });
  ensureVisibleTab();
}