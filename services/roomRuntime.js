// services/roomRuntime.js
// Anything that keeps per-room state IN MEMORY (sync leader timers, live
// whiteboard buffers, caches, rate-limit maps…) registers a disposer here.
// Room deletion runs them all, so nothing outlives the room.
//
//   const { onRoomDeleted } = require("../services/roomRuntime");
//   onRoomDeleted((roomId) => { liveBoards.delete(roomId); clearInterval(timers.get(roomId)); });
"use strict";
const hooks = new Set();
function onRoomDeleted(fn) {
  hooks.add(fn);
  return () => hooks.delete(fn);
}
async function runRoomDeleted(roomId) {
  for (const fn of hooks) {
    try { await fn(roomId); }
    catch (err) { console.error("[roomRuntime] disposer failed for", roomId, err); }
  }
}
module.exports = { onRoomDeleted, runRoomDeleted };