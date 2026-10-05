/* public/js/room/identity-socket.js
 * Room-only adapter: feeds socket profile events into the shared identity
 * store, and re-syncs after a reconnect (we may have missed updates).
 */
"use strict";
import { S } from "./state.js";
import { getSocket } from "./socket-ref.js";
import { onConnect } from "./socket-core.js";
import { mergeIdentity, resyncIdentities } from "../shared/identity.js";
import { onMe } from "../shared/profile-settings.js";
let connects = 0;
onConnect(() => {
  if (connects++ === 0) {
    getSocket().on("user-profile-updated", (p) => { if (p && p.userId) mergeIdentity(p.userId, p); });
    return;
  }
  resyncIdentities();
});
onMe((u) => { S.me = u; });