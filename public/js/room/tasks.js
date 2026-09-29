/* public/js/room/tasks.js
 * Study-room task list (side-panel "Tasks" tab).
 *
 * Server-authoritative: every mutation is an emit (task-add / task-toggle /
 * task-remove / task-clear-done); the server answers with 'tasks-update' carrying
 * the full list → applyRemote() reconciles and re-renders.
 *
 * Completion is per assignee. Pending assignees render as dimmed grey avatars,
 * finished ones in full colour (the server sorts finished ones to the left).
 * When every assignee is done the avatars collapse into a single tick.
 *
 * Shared state: creates S.tasks = { items } ONCE; applyRemote mutates it in place.
 * Reads S.perms.canManageTasks, S.members, S.room.participants, S.userId.
 */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { toast, esc, avColor, fmtBadge } from "./utils.js";
import { emit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
const TICK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const REMOVE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const st = (S.tasks = { items: [] });
let audience = "room";                 // "room" | "me" | "pick"
const picked = new Set();              // userIds chosen in the picker
const canManage = () => !!(S.perms && S.perms.canManageTasks);
const initial = (n) => esc(((n || "?")[0] || "?").toUpperCase());
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function avatarsHTML(t) {
  if (t.done) {                                     // everyone finished → one tick, same size as an avatar
    const names = t.assignees.map((a) => a.username).join(", ");
    return '<span class="tk-av tk-av-all" title="' + esc("Completed by " + names) +
      '" aria-label="Completed">' + TICK + "</span>";
  }
  return t.assignees.map((a) =>
    '<span class="tk-av' + (a.done ? " is-done" : "") + '" style="background:' + avColor(a.username) +
    '" title="' + esc(a.username + (a.done ? " — done" : " — pending")) + '">' + initial(a.username) + "</span>"
  ).join("");
}
function itemHTML(t, manage) {
  const mine = t.assignees.find((a) => a.userId === S.userId);
  const doneN = t.assignees.filter((a) => a.done).length;
  const check = mine
    ? '<button class="tk-check' + (mine.done ? " on" : "") + '" data-act="toggle" aria-pressed="' + !!mine.done +
        '" title="' + (mine.done ? "Mark as not done" : "Mark as done") + '">' + (mine.done ? TICK : "") + "</button>"
    : '<span class="tk-check tk-check-na" title="Assigned to other people"></span>';
  const sub = [
    t.assignees.length > 1 && !t.done ? doneN + "/" + t.assignees.length + " done" : "",
    t.addedByName ? "by " + esc(t.addedByName) : "",
  ].filter(Boolean).join(" · ");
  return '<li class="tk-item' + (t.done ? " done" : "") + '" data-id="' + esc(t.id) + '">' +
    check +
    '<div class="tk-body">' +
      '<div class="tk-text">' + esc(t.text) + "</div>" +
      '<div class="tk-meta"><span class="tk-avs">' + avatarsHTML(t) + "</span>" +
        (sub ? '<span class="tk-sub">' + sub + "</span>" : "") + "</div>" +
    "</div>" +
    (manage ? '<button class="tk-x" data-act="remove" title="Remove task" aria-label="Remove task">' + REMOVE + "</button>" : "") +
  "</li>";
}
function renderPicker() {
  const box = $("taskPicker");
  if (!box) return;
  box.hidden = audience !== "pick";
  if (audience !== "pick") return;
  const online = new Set(((S.room && S.room.participants) || []).map((p) => String(p.userId)));
  const people = [...(S.members || [])].sort((a, b) =>
    (Number(online.has(b.userId)) - Number(online.has(a.userId))) ||
    (a.username || "").localeCompare(b.username || ""));
  for (const id of [...picked]) if (!people.some((p) => p.userId === id)) picked.delete(id);
  box.innerHTML = people.map((p) =>
    '<button type="button" class="tk-pick' + (picked.has(p.userId) ? " on" : "") + '" data-uid="' + esc(p.userId) + '">' +
    esc(p.username || "?") + (p.userId === S.userId ? " (you)" : "") + "</button>").join("");
}
export function renderTasks() {
  const list = $("taskList");
  if (!list) return;
  const manage = canManage();
  $("taskEmpty").hidden = st.items.length > 0;
  $("taskBar").hidden   = !manage;
  $("taskLock").hidden  = manage;
  $("taskClearBtn").disabled = !manage || !st.items.some((t) => t.done);
  const pending = st.items.filter((t) => t.assignees.some((a) => a.userId === S.userId && !a.done)).length;
  const badge = $("taskCount");
  if (badge) {
    badge.textContent = fmtBadge(pending);
    badge.dataset.zero = pending ? "0" : "1";
    badge.title = pending === 1 ? "1 task waiting for you" : pending + " tasks waiting for you";
  }
  list.innerHTML = st.items.map((t) => itemHTML(t, manage)).join("");
  renderPicker();
}
function applyRemote(p) {
  if (!p || !Array.isArray(p.items)) return;
  st.items = p.items;
  renderTasks();
}
function addTask() {
  if (!canManage()) return toast("You don't have task access", "error");
  const input = $("taskInput");
  const text = input.value.trim();
  if (!text) return;
  let payload;
  if (audience === "room") payload = { text, audience: "room" };
  else if (audience === "me") payload = { text, audience: "members", assignees: [S.userId] };
  else {
    if (!picked.size) return toast("Pick at least one person", "error");
    payload = { text, audience: "members", assignees: [...picked] };
  }
  emit("task-add", payload);
  input.value = "";
}
export function wireTasks() {
  const list = $("taskList");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    const li = btn && btn.closest(".tk-item");
    if (!li) return;
    const task = st.items.find((t) => t.id === li.dataset.id);
    if (!task) return;
    if (btn.dataset.act === "toggle") {
      const mine = task.assignees.find((a) => a.userId === S.userId);
      if (mine) emit("task-toggle", { id: task.id, done: !mine.done });
    } else if (btn.dataset.act === "remove" && canManage()) {
      emit("task-remove", { id: task.id });
    }
  });
  $("taskAddBtn").onclick = addTask;
  $("taskInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(); });
  $("taskAudience").addEventListener("change", (e) => { audience = e.target.value; renderPicker(); });
  $("taskPicker").addEventListener("click", (e) => {
    const b = e.target.closest(".tk-pick");
    if (!b) return;
    picked.has(b.dataset.uid) ? picked.delete(b.dataset.uid) : picked.add(b.dataset.uid);
    b.classList.toggle("on");
  });
  $("taskClearBtn").onclick = () => canManage() && emit("task-clear-done");
  renderTasks();
}
/* ── network ── */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;
  sockWired = true;
  const socket = getSocket();
  socket.on("tasks-update", applyRemote);
  /* sent to everyone EXCEPT the person who ticked it */
  socket.on("task-notice", ({ username, text, finished, group }) => {
    const t = clip(String(text || ""), 60);
    toast(finished && group
      ? `${username} finished the last part of “${t}” — all done 🎉`
      : `${username} completed “${t}”`, "success");
  });
});
/* phase 25: after layout (5) + permissions (10), before the player (35) */
onRoomState(({ room }) => { if (room && room.tasks) applyRemote(room.tasks); }, 25);