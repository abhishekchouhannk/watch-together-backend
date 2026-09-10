/* public/js/svg.js
 * ─────────────────────────────────────────────────────────────
 * Inline SVG / markup string constants. Pure data, zero imports.
 * Strings are copied byte-for-byte from room.js — do not reformat,
 * the attribute order/spacing is matched by CSS in places.
 *
 * CHEV_SVG / STEP_UP / STEP_DN   config-sheet chevron + number stepper
 * SEC_CLOSE                      closing tags for secOpen() sections
 * playSVG / pauseSVG             small transport icons (control bar)
 * bigPlay / bigPause             centre overlay transport icons
 * volSVG / mutedSVG              volume button icons
 * fsExpandSVG / fsCollapseSVG    fullscreen button icons
 * ───────────────────────────────────────────────────────────── */
"use strict";
export const CHEV_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none">' +
  '<path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const STEP_UP =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none">' +
  '<path d="M2.5 6.5L5 4L7.5 6.5" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const STEP_DN =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none">' +
  '<path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const SEC_CLOSE = "</div></div></section>";
/* SVG icons */
export const playSVG  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
export const pauseSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
export const bigPlay  = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
export const bigPause = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
export const spinnerSVG =
  '<svg class="vc-spin" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">' +
  '<circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="4" ' +
  'stroke-linecap="round" stroke-dasharray="85 30"/></svg>';
export const volSVG   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
export const mutedSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
export const fsExpandSVG  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
export const fsCollapseSVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
export const SVG_MIC_OFF =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`;
export const SVG_WHISPER =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 0 1-5.8-1.6"/></svg>`;
export const SVG_SPEAKER =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
export const SVG_SPEAKER_OFF =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
export const SVG_GAVEL =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 13-7.5 7.5a2.12 2.12 0 0 1-3-3L11 10"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/></svg>`;
export const SVG_USER =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
