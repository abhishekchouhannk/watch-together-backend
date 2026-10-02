/* public/js/room/datepicker.js
 * ─────────────────────────────────────────────────────────────
 * THEMED INLINE DATE PICKER — replaces the OS <input type="date">.
 * Renders into a host element in normal flow under its trigger, so a
 * scrolling modal body can never clip it (works in the mobile drawer too).
 *   days ⇄ (title) → years → months → days
 * Values are plain "YYYY-MM-DD" strings; all maths is UTC-only, so a
 * birthday never drifts a day because of the viewer's timezone.
 * Keyboard (days): ←→↑↓ day/week · PgUp/PgDn month · Shift+Pg year ·
 * Home/End · Enter/Space pick · Esc close.
 * ───────────────────────────────────────────────────────────── */
"use strict";
const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (y, m, d) => String(y).padStart(4, "0") + "-" + pad2(m + 1) + "-" + pad2(d);   // m: 0–11
const isoOf = (p) => toISO(p.y, p.m, p.d);
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export function parseISO(s) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!mt) return null;
  const y = +mt[1], m = +mt[2] - 1, d = +mt[3];
  const t = new Date(Date.UTC(y, m, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d ? { y, m, d } : null;
}
const addDays = (p, n) => {
  const t = new Date(Date.UTC(p.y, p.m, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
};
function addMonths(p, n) {
  const t = p.y * 12 + p.m + n, y = Math.floor(t / 12), m = t - y * 12;
  return { y, m, d: Math.min(p.d, daysIn(y, m)) };
}
const F_MY   = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const F_MON  = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const F_LONG = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const F_WD   = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
export const formatISO = (iso) => { const p = parseISO(iso); return p ? F_LONG.format(Date.UTC(p.y, p.m, p.d)) : ""; };
/* locale's first weekday (0 = Sun); Intl.Locale weekInfo where supported */
const FIRST_DOW = (() => {
  try {
    const l = new Intl.Locale(navigator.language || "en-US");
    const wi = (l.getWeekInfo && l.getWeekInfo()) || l.weekInfo;
    return wi ? wi.firstDay % 7 : 0;
  } catch (_) { return 0; }
})();
// 2024-01-07 was a Sunday
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => F_WD.format(Date.UTC(2024, 0, 7 + ((FIRST_DOW + i) % 7))).slice(0, 2));
const CHEV = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export function createDatePicker({ host, onPick, onClose, label = "Choose a date" }) {
  const st = { open: false, view: "days", y: 2000, m: 0, sel: null, focus: null, lo: "1900-01-01", hi: "2100-12-31" };
  host.hidden = true;
  host.classList.add("dp-host");
  const inRange = (s) => s >= st.lo && s <= st.hi;
  const clamp = (p) => { const s = isoOf(p); return s < st.lo ? parseISO(st.lo) : s > st.hi ? parseISO(st.hi) : p; };
  const nav = (dir, lbl, ok) =>
    '<button type="button" class="dp-nav" data-dp="' + dir + '" aria-label="' + lbl + '"' + (ok ? "" : " disabled") + ">" +
    (dir === "prev" ? "‹" : "›") + "</button>";
  function open({ value = "", min, max, startYear } = {}) {
    st.lo = min || "1900-01-01";
    st.hi = max || "2100-12-31";
    st.sel = parseISO(value);
    if (st.sel && !inRange(isoOf(st.sel))) st.sel = null;
    const hi = parseISO(st.hi);
    st.focus = st.sel || clamp({ y: startYear || hi.y, m: 0, d: 1 });
    st.y = st.focus.y; st.m = st.focus.m;
    st.view = st.sel ? "days" : "years";          // birthdays: start by picking the year
    st.open = true;
    host.hidden = false;
    render(true);
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    host.hidden = true;
    host.innerHTML = "";
    if (onClose) onClose();
  }
  function daysHTML() {
    const { y, m } = st;
    const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() - FIRST_DOW + 7) % 7;
    const n = daysIn(y, m);
    let f = st.focus && st.focus.y === y && st.focus.m === m && inRange(isoOf(st.focus)) ? st.focus : null;
    if (!f && st.sel && st.sel.y === y && st.sel.m === m) f = st.sel;
    let fDay = f ? f.d : 0;
    if (!fDay) for (let d = 1; d <= n; d++) if (inRange(toISO(y, m, d))) { fDay = d; break; }
    let h = '<div class="dp-wk" aria-hidden="true">' + WEEKDAYS.map((w) => "<span>" + w + "</span>").join("") + "</div>" +
            '<div class="dp-days">';
    for (let i = 0; i < lead; i++) h += '<span class="dp-pad"></span>';
    for (let d = 1; d <= n; d++) {
      const s = toISO(y, m, d), on = !!st.sel && isoOf(st.sel) === s;
      h += '<button type="button" class="dp-day' + (on ? " on" : "") + '" data-dp="day" data-iso="' + s + '"' +
           ' tabindex="' + (d === fDay ? 0 : -1) + '"' + (d === fDay ? ' data-focus="1"' : "") +
           ' aria-label="' + F_LONG.format(Date.UTC(y, m, d)) + '" aria-pressed="' + on + '"' +
           (inRange(s) ? "" : " disabled") + ">" + d + "</button>";
    }
    return h + "</div>";
  }
  function monthsHTML() {
    let h = '<div class="dp-months">';
    for (let m = 0; m < 12; m++) {
      const ok = toISO(st.y, m, daysIn(st.y, m)) >= st.lo && toISO(st.y, m, 1) <= st.hi;
      const on = !!st.sel && st.sel.y === st.y && st.sel.m === m;
      h += '<button type="button" class="dp-cell' + (on ? " on" : "") + '" data-dp="month" data-m="' + m + '"' +
           (m === st.m && ok ? ' data-focus="1"' : "") + (ok ? "" : " disabled") + ">" +
           F_MON.format(Date.UTC(2000, m, 1)) + "</button>";
    }
    return h + "</div>";
  }
  function yearsHTML() {
    const lo = parseISO(st.lo).y, hi = parseISO(st.hi).y;
    let h = '<div class="dp-years">';
    for (let y = hi; y >= lo; y--) {                 // newest first
      const on = !!st.sel && st.sel.y === y;
      h += '<button type="button" class="dp-cell' + (on ? " on" : "") + '" data-dp="year" data-y="' + y + '"' +
           (y === st.y ? ' data-focus="1"' : "") + ">" + y + "</button>";
    }
    return h + "</div>";
  }
  function render(focus) {
    let head, body;
    if (st.view === "days") {
      head = nav("prev", "Previous month", toISO(st.y, st.m, 1) > st.lo) +
             '<button type="button" class="dp-title" data-dp="to-years" aria-label="Choose year">' +
               F_MY.format(Date.UTC(st.y, st.m, 1)) + CHEV + "</button>" +
             nav("next", "Next month", toISO(st.y, st.m, daysIn(st.y, st.m)) < st.hi);
      body = daysHTML();
    } else if (st.view === "months") {
      head = nav("prev", "Previous year", st.y > parseISO(st.lo).y) +
             '<button type="button" class="dp-title" data-dp="to-years" aria-label="Choose year">' + st.y + CHEV + "</button>" +
             nav("next", "Next year", st.y < parseISO(st.hi).y);
      body = monthsHTML();
    } else {
      head = '<span class="dp-title dp-title-static">Pick a year</span>';
      body = yearsHTML();
    }
    host.innerHTML =
      '<div class="dp" role="dialog" aria-label="' + label + '">' +
        '<div class="dp-head">' + head + "</div>" + body +
        '<div class="dp-foot">' +
          (st.sel ? '<button type="button" class="dp-link dp-clear" data-dp="clear">Clear</button>' : "<span></span>") +
          '<button type="button" class="dp-link" data-dp="close">Cancel</button>' +
        "</div>" +
      "</div>";
    if (st.view === "years") {                       // centre the current year without scrolling the page
      const box = host.querySelector(".dp-years"), cur = box && box.querySelector('[data-focus="1"]');
      if (cur) box.scrollTop = cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2;
    }
    if (focus) {
      const t = host.querySelector('[data-focus="1"]') || host.querySelector("button:not(:disabled)");
      if (t) t.focus({ preventScroll: true });
    }
  }
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dp]");
    if (!b || b.disabled || !host.contains(b)) return;
    const a = b.dataset.dp;
    if (a === "prev" || a === "next") {
      const dir = a === "prev" ? -1 : 1;
      if (st.view === "days") { const t = addMonths({ y: st.y, m: st.m, d: 1 }, dir); st.y = t.y; st.m = t.m; }
      else st.y += dir;
      render(false);
      const again = host.querySelector('[data-dp="' + a + '"]:not(:disabled)') || host.querySelector(".dp-title");
      if (again) again.focus({ preventScroll: true });
      return;
    }
    if (a === "to-years") { st.view = "years"; render(true); return; }
    if (a === "year")     { st.y = +b.dataset.y; st.view = "months"; render(true); return; }
    if (a === "month")    { st.m = +b.dataset.m; st.view = "days"; st.focus = null; render(true); return; }
    if (a === "day")      { st.sel = parseISO(b.dataset.iso); close(); if (onPick) onPick(b.dataset.iso); return; }
    if (a === "clear")    { st.sel = null; close(); if (onPick) onPick(""); return; }
    if (a === "close")    close();
  });
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (st.view !== "days") return;
    const t = e.target.closest && e.target.closest(".dp-day");
    if (!t) return;
    let f = parseISO(t.dataset.iso);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) f = addDays(f, step);
    else if (e.key === "PageUp" || e.key === "PageDown") f = addMonths(f, (e.key === "PageUp" ? -1 : 1) * (e.shiftKey ? 12 : 1));
    else if (e.key === "Home" || e.key === "End") f = { ...f, d: e.key === "Home" ? 1 : daysIn(f.y, f.m) };
    else return;
    e.preventDefault();
    f = clamp(f);
    st.focus = f; st.y = f.y; st.m = f.m;
    render(true);
  });
  return { open, close, isOpen: () => st.open };
}