/* public/js/room/room-layout.js
 * Picks the room's visual layout from room.roomType.
 *
 *   "entertainment" (or missing) → theater video layout  (#videoContainer)
 *   "music"                      → music player layout   (#musicLayout)
 *   "study"                      → whiteboard + timer    (#studyLayout)
 *   "gaming"                     → game stage            (#gameLayout)
 *
 * Only DOM flags change. The YouTube iframe is never display:none'd in media
 * rooms; inactive layouts are hidden in CSS. Runs at room-state phase 5, before
 * queue (30), player (35) and games (40). Also re-validates the side-panel tab,
 * since tabs are shown/hidden per room type.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { onRoomState } from "./socket-core.js";
import { ensureVisibleTab } from "./side-tabs.js";

const TYPES = ["entertainment", "music", "study", "gaming"];
/* the layout container that is visible for each type */
const LAYOUT_ID = {
  entertainment: "videoContainer",
  music:         "musicLayout",
  study:         "studyLayout",
  gaming:        "gameLayout",
};
let reactionsMoved = false;
function relocateReactions() {
  if (reactionsMoved) return;
  const layout = $("musicLayout");
  const stage  = layout && layout.querySelector(".ml-stage");
  const rail   = $("reactRail");
  const fx     = $("fxLayer");
  if (stage && rail) stage.appendChild(rail);
  if (layout && fx)  layout.appendChild(fx);
  reactionsMoved = true;
}
export function applyRoomLayout(roomType) {
  const type = TYPES.includes(roomType) ? roomType : "entertainment";
  S.roomType = type;
  const page = $("roomPage");
  if (page) page.setAttribute("data-room-type", type);
  for (const [t, id] of Object.entries(LAYOUT_ID)) {
    const el = $(id);
    if (el) el.toggleAttribute("aria-hidden", type !== t);
  }
  if (type === "music") relocateReactions();
  // study / gaming: reactions stay in the hidden #videoContainer (no relocation).
  ensureVisibleTab();   // e.g. Queue is hidden in study + gaming rooms
}
onRoomState(({ room }) => {
  applyRoomLayout(room && room.roomType);
}, 5);