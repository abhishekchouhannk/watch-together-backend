/* public/js/room/study.js
 * Study room: Pomodoro timer (+ whiteboard placeholder, not wired yet).
 * Server stores { phase, running, endsAt, remainingMs }; the client derives the
 * countdown from endsAt + a clock-skew offset. Never streams ticks.
 */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { emit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
const PHASE_LABEL = { focus: "Focus", short_break: "Short break", long_break: "Long break" };
const TICK_MS = 250;
let pomo = null;
let clockOffset = 0;                  // serverNow − local Date.now()
let tickId = null;
let listening = false;
const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const canControl = () => !!(S.perms && S.perms.canControlTimer);
function remainingMs() {
  if (!pomo) return 0;
  if (!pomo.running) return pomo.remainingMs ?? 0;
  return Math.max(0, new Date(pomo.endsAt).getTime() - (Date.now() + clockOffset));
}
/* also called from applyPerms() so the buttons flip the moment permissions change */
export function renderTimer() {
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
  ["pomoReset", "pomoSkip"].forEach((id) => { const b = $(id); if (b) b.disabled = !canControl(); });
  const cycle = $("pomoCycle");
  if (cycle) cycle.textContent = `Session ${pomo.cycle}`;
  const hint = $("pomoHint");
  if (hint) hint.hidden = canControl();
}
function syncTicker() {
  if (pomo && pomo.running && tickId == null) tickId = setInterval(renderTimer, TICK_MS);
  if ((!pomo || !pomo.running) && tickId != null) { clearInterval(tickId); tickId = null; }
}
function applyPomodoro(state) {
  if (!state) return;
  pomo = state;
  clockOffset = (state.serverNow || Date.now()) - Date.now();
  renderTimer();
  syncTicker();
}
export function wireStudy() {
  const toggle = $("pomoToggle");
  if (toggle) toggle.addEventListener("click", () => {
    if (canControl()) emit(pomo && pomo.running ? "pomodoro-pause" : "pomodoro-start");
  });
  const on = (id, event) => {
    const el = $(id);
    if (el) el.addEventListener("click", () => { if (canControl()) emit(event); });
  };
  on("pomoReset", "pomodoro-reset");
  on("pomoSkip", "pomodoro-skip");
  onConnect(() => {
    if (listening) return;              // onConnect fires on every reconnect
    listening = true;
    getSocket().on("pomodoro-update", applyPomodoro);
  });
}
onRoomState(({ room }) => { if (room && room.pomodoro) applyPomodoro(room.pomodoro); }, 25);