/* public/js/theme.js
 * ─────────────────────────────────────────────────────────────
 * TIME-OF-DAY THEME SWITCHER (sky background + data-theme attr).
 * Self-contained: no socket, no room state other than S.themeMode.
 *
 *   resolveTod()              current theme key for "auto" mode; prefers the
 *                             global getTimeOfDay() if the page defines one
 *   initTheme()               read localStorage pref → apply (no animation)
 *   applyTheme(key, animate)  swap sky image + dom.root.dataset.theme
 *   highlightActiveThemeOpt() mark the .theme-opt matching S.themeMode
 *   setThemeMode(mode)        persist + apply (animated) + close menu
 *   openThemeMenu/closeThemeMenu
 *   wireTheme()               the three theme listeners formerly inline in
 *                             wireEvents(); call it at the SAME position so
 *                             document-level listener order is unchanged
 *
 * State touched:  S.themeMode (string) — mutated in place only.
 * DOM touched:    dom.root, dom.sky, dom.themeSwitcher, dom.themeBtn,
 *                 dom.themeBtnIcon, dom.themeMenu
 * Globals read:   getTimeOfDay (optional, classic script)
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { THEMES, THEME_STORAGE_KEY } from "./config.js";
import { S } from "./state.js";
import { dom } from "./dom.js";
export function resolveTod() {
  try { if (typeof getTimeOfDay === "function") return getTimeOfDay(); } catch (_) {}
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}
/* ═══════ THEME SWITCHER ═══════ */
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch (_) {}
  S.themeMode = saved && (saved === "auto" || THEMES[saved]) ? saved : "auto";
  applyTheme(S.themeMode === "auto" ? resolveTod() : S.themeMode, false);
  highlightActiveThemeOpt();
}
export function applyTheme(themeKey, animate) {
  if (!THEMES[themeKey]) themeKey = "morning";
  const imgUrl = "url('/assets/" + themeKey + "/sky.png')";
  if (animate) {
    dom.sky.style.opacity = "0";
    setTimeout(() => {
      dom.root.dataset.theme = themeKey;
      dom.sky.style.backgroundImage = imgUrl;
      dom.root.style.setProperty("--sky-img", imgUrl);
      requestAnimationFrame(() => (dom.sky.style.opacity = "1"));
    }, 180);
  } else {
    dom.root.dataset.theme = themeKey;
    dom.sky.style.backgroundImage = imgUrl;
    dom.root.style.setProperty("--sky-img", imgUrl);
  }
  dom.themeBtnIcon.textContent = S.themeMode === "auto" ? "🧭" : (THEMES[themeKey] ? THEMES[themeKey].icon : "🌤️");
}
export function highlightActiveThemeOpt() {
  dom.themeMenu.querySelectorAll(".theme-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === S.themeMode);
  });
}
export function setThemeMode(mode) {
  S.themeMode = mode;
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch (_) {}
  applyTheme(mode === "auto" ? resolveTod() : mode, true);
  highlightActiveThemeOpt();
  closeThemeMenu();
}
export function openThemeMenu() {
  dom.themeSwitcher.classList.add("open");
  dom.themeBtn.setAttribute("aria-expanded", "true");
}
export function closeThemeMenu() {
  dom.themeSwitcher.classList.remove("open");
  dom.themeBtn.setAttribute("aria-expanded", "false");
}
/* moved verbatim from wireEvents() — theme dropdown */
export function wireTheme() {
  dom.themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.themeSwitcher.classList.contains("open") ? closeThemeMenu() : openThemeMenu();
  });
  dom.themeMenu.addEventListener("click", (e) => {
    const opt = e.target.closest(".theme-opt");
    if (!opt) return;
    setThemeMode(opt.dataset.theme);
  });
  document.addEventListener("click", (e) => {
    if (!dom.themeSwitcher.contains(e.target)) closeThemeMenu();
  });
}