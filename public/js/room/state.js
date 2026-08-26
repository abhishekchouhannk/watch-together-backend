/* public/js/state.js
 * ─────────────────────────────────────────────────────────────
 * THE SINGLE SHARED MUTABLE STATE OBJECT (`S`).
 *
 * Every module imports the SAME object reference. Therefore:
 *   ✅  S.room = Object.assign({}, S.room, room)   // mutates a PROPERTY — fine
 *   ❌  S = { ... }                                 // would rebind only this
 *                                                   // module's binding → never do it
 * (ESM bindings are read-only in importers anyway, so `S = x` in a consumer
 *  module is a hard TypeError, not a silent break. Inside this file it would
 *  be a silent break, so there is no setter exported.)
 *
 * Fields (all set/mutated in place by feature modules):
 *   room            authoritative room doc mirror (incl. participants)
 *   userId/username me, from /api/auth/me
 *   themeMode       'auto' | theme key
 *   detailsOpen     null = undecided, else bool (room-details card)
 *   perms           permission/mode flags from the server
 *   members         member list (host/mod views)
 *   requests        pending perm requests
 *   video           authoritative video mirror { currentTime, isPlaying, at }
 *   cfgCollapsed    { sectionId: bool } collapse memory for the config sheet
 *   banned          admin-only ban list (from room-permissions)
 *   cfgRowMenu      { id, confirm: null|'ban'|'remove' } open row menu
 *   roomDraft       in-progress room-details edits
 *   roomConflict    unacknowledged incoming room change
 *   profile         { userId, username, confirm, loading, error, data, pending }
 *   queue           { items, index }  ← still created by the Q module (Step: queue)
 *   currentItemId   queue item id of the currently loaded video
 * ───────────────────────────────────────────────────────────── */
"use strict";
export const S = {
  room: null, userId: null, username: "You", themeMode: "auto", detailsOpen: null,
  perms: { isAdmin:false, isMod:false, role:"member",
           syncMode:"host", queueMode:"host", autoplay:true,
           canSync:false, canQueue:false, canChangeVideo:false,
           canEditRoom:false, canManage:false, canGrantSync:false, canGrantQueue:false,
           requestState:"none", queueRequestState:"none" },
  members: [], requests: [],
  video: { currentTime: 0, isPlaying: false, at: 0 },   // authoritative mirror
};
/* ── properties the original file attached to S at top level, in order ── */
S.cfgCollapsed = {};          // { people: true, room: false, … }
S.banned       = [];          // admin-only, from room-permissions
S.cfgRowMenu   = null;        // { id, confirm: null | 'ban' | 'remove' }
S.roomDraft    = null;        // in-progress edits
S.roomConflict = null;        // unacknowledged incoming change
S.profile      = null;        // { userId, username, confirm, loading, error, data }
/* ── video-load / late-join sync bookkeeping (was module-scope `let`s in room.js) ── */
S.videoLoaded       = false;                                // a player has been mounted at least once
S.needsSync         = false;                                // room-state arrived with a video → sync on ready
S.initialVideoState = { currentTime: 0, isPlaying: false }; // DB snapshot used if no peer answers
S.syncFallbackTimer = null;                                 // timer id for the 2 s peer-sync fallback
S.currentItemId     = null;   