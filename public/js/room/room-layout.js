/* public/js/room/room-layout.js
 * ─────────────────────────────────────────────────────────────
 * Picks the room's visual layout from room.roomType.
 *
 *   "entertainment" (or missing) → theater video layout  (#videoContainer)
 *   "music"                      → music player layout   (#musicLayout)
 *
 * It only flips DOM flags — it never touches the player engine. The YouTube
 * iframe is NEVER display:none'd: in music mode #videoContainer stays fully
 * rendered (just visually hidden via CSS) so the IFrame API keeps working.
 * player.js reads S.roomType to decide which on-screen controls to drive.
 *
 * Runs at room-state phase 5 — before queue (30) and player (35), so the DOM
 * is already in the right shape by the time the first track loads.
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { S } from "./state.js";
import { $ } from "./dom.js";
import { onRoomState } from "./socket-core.js";
const TYPES = ["entertainment", "music"];
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
  const vc = $("videoContainer");
  if (vc) vc.toggleAttribute("aria-hidden", type === "music");
  const ml = $("musicLayout");
  if (ml) ml.toggleAttribute("aria-hidden", type !== "music");
  if (type === "music") relocateReactions();
}
/* roomType is immutable, so only the first room-state really matters —
   re-applying on later events is harmless (idempotent). */
onRoomState(({ room }) => {
  applyRoomLayout(room && room.roomType);
}, 5);