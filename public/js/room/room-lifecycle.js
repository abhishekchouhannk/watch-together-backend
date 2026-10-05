/* public/js/room/room-lifecycle.js
 * The host deleted this room (from the dashboard or anywhere else):
 * leave with a notice the dashboard shows on arrival (drainNotice).
 * Voice disconnects through voice.js's beforeunload handler.
 */
"use strict";
import { getSocket } from "./socket-ref.js";
import { onConnect } from "./socket-core.js";
const DASHBOARD_URL = "/dashboard";   // ⚠ same target your #backBtn navigates to
let wired = false;
onConnect(() => {
  if (wired) return;
  wired = true;
  getSocket().on("room-deleted", ({ byName } = {}) => {
    try {
      sessionStorage.setItem("wp:notice", JSON.stringify({
        type: "error",
        text: (byName ? byName + " deleted this room" : "This room was deleted") + " — it no longer exists.",
      }));
    } catch (_) {}
    location.replace(DASHBOARD_URL);
  });
});