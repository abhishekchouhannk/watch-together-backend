/* public/js/room/study.js
 * Study room: Pomodoro timer (+ whiteboard placeholder, not wired yet).
 *
 * The server stores { phase, running, endsAt, remainingMs }. The client
 * never trusts its own clock for the countdown: it computes
 * remaining = endsAt - (Date.now() + clockOffset) while running.
 */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { emit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
const PHASE_LABEL = { focus: "Focus", short_break: "Short break", long_break: "Long break" };
const TICK_MS = 250;
let pomo = null;          // last serialized pomodoro state from the server
let clockOffset = 0;      // serverNow − local Date.now()
let tickId = null;
let listening = false;
const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const canControl = () => !!(S.perms && S.perms.canSync);
function remainingMs() {
  if (!pomo) return 0;
  if (!pomo.running) return pomo.remainingMs ?? 0;
  return Math.max(0, new Date(pomo.endsAt).getTime() - (Date.now() + clockOffset));
}
function render() {
  if (!pomo) return;
  const aside = $("studyPomo");
  if (aside) aside.dataset.phase = pomo.phase;
  const phase = $("pomoPhase");
  if (phase) phase.textContent = PHASE_LABEL[pomo.phase] || "Focus";
  const time = $("pomoTime");
  if (time) time.textContent = fmt(remainingMs());
  const toggle = $("pomoToggle");
  if (toggle) {
    toggle.textContent = pomo.running ? "Pause" : "Start";
    toggle.disabled = !canControl();
  }
  ["pomoReset", "pomoSkip"].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = !canControl();
  });
  const cycle = $("pomoCycle");
  if (cycle) cycle.textContent = `Session ${pomo.cycle}`;
  const hint = $("pomoHint");
  if (hint) hint.hidden = canControl();
}
/* tick only while running; the server sends the real transitions */
function syncTicker() {
  if (pomo && pomo.running && tickId == null) tickId = setInterval(render, TICK_MS);
  if ((!pomo || !pomo.running) && tickId != null) { clearInterval(tickId); tickId = null; }
}
function applyPomodoro(state) {
  if (!state) return;
  pomo = state;
  clockOffset = (state.serverNow || Date.now()) - Date.now();
  render();
  syncTicker();
}
export function wireStudy() {
  const on = (id, event) => {
    const el = $(id);
    if (el) el.addEventListener("click", () => {
      if (canControl()) emit(event);
    });
  };
  // the toggle's event depends on state, so bind it explicitly:
  const toggle = $("pomoToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      if (!canControl()) return;
      emit(pomo && pomo.running ? "pomodoro-pause" : "pomodoro-start");
    });
  }
  on("pomoReset", "pomodoro-reset");
  on("pomoSkip", "pomodoro-skip");
  onConnect(() => {
    if (listening) return;                 // onConnect fires on every reconnect
    listening = true;
    getSocket().on("pomodoro-update", applyPomodoro);
  });
}
/* join-time seed (phase 25: after layout (5), before player (35)) */
onRoomState(({ room }) => {
  if (room && room.pomodoro) applyPomodoro(room.pomodoro);
}, 25);