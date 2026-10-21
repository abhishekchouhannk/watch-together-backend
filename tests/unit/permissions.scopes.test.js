// tests/unit/permissions.scopes.test.js
// ─────────────────────────────────────────────────────────────
// SCOPE STRINGS → FEATURES, PER ROOM TYPE
//
// The two wire scopes are room-type agnostic, but what they UNLOCK depends
// on the room family (see utils/roomConfigAndPermissions.js §3):
//
//   scope     entertainment / music (media)    study
//   "sync"    canControlMedia (play/pause)     canControlTimer (pomodoro)
//   "queue"   canManageQueue  (video queue)    canManageTasks + canManageBoards
//                                              (tasks & whiteboards)
//
// So "granting whiteboard / tasks access" in a study room IS granting the
// "queue" scope — this suite pins that mapping down for all three room
// types, and proves a grant never leaks across room families.
// ─────────────────────────────────────────────────────────────
"use strict";
const db = require("./helpers/db");
const {
  createUser,
  createRoom,
  joinRoom,
  setRole,
  grantScope,
  revokeScope,
  setSlotMode,
  reload,
} = require("./helpers/factories");
const {
  hasGrant,
  canControlMedia,
  canManageQueue,
  canControlTimer,
  canManageStudy,
  resolvePerms,
  scopeText,
} = require("../../utils/roomConfigAndPermissions");

beforeAll(() => db.connect());
afterEach(() => db.clearDatabase());
afterAll(() => db.disconnect());

async function roomWithMember(roomType) {
  const host = await createUser();
  const member = await createUser();
  const { roomId } = await createRoom(host, { roomType });
  await joinRoom(roomId, member);
  return { host, member, roomId };
}

/* ═══════════════════════════════════════════════════════════
   Media rooms — entertainment & music behave identically
   ═══════════════════════════════════════════════════════════ */
describe.each(["entertainment", "music"])("%s room (media family)", (roomType) => {
  test("a plain member controls nothing", async () => {
    const { member, roomId } = await roomWithMember(roomType);
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canControlMedia).toBe(false);
    expect(perms.canManageQueue).toBe(false);
    // study / gaming features simply don't exist here
    expect(perms.canControlTimer).toBe(false);
    expect(perms.canManageTasks).toBe(false);
    expect(perms.canManageBoards).toBe(false);
  });

  test("granting 'sync' unlocks playback control — and nothing else", async () => {
    const { member, roomId } = await roomWithMember(roomType);
    await grantScope(roomId, member, "sync");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canSync).toBe(true);
    expect(perms.canControlMedia).toBe(true);  // play / pause / seek
    expect(perms.canManageQueue).toBe(false);  // the other slot stays closed
    expect(perms.canControlTimer).toBe(false); // media rooms have no pomodoro
    expect(perms.canManageTasks).toBe(false);
  });

  test("granting 'queue' unlocks queue management — and nothing else", async () => {
    const { member, roomId } = await roomWithMember(roomType);
    await grantScope(roomId, member, "queue");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canQueue).toBe(true);
    expect(perms.canManageQueue).toBe(true);   // add / remove / reorder
    expect(perms.canControlMedia).toBe(false);
    expect(perms.canManageTasks).toBe(false);  // "queue" ≠ task access outside study rooms
    expect(perms.canManageBoards).toBe(false);
  });

  test("revoking 'sync' takes playback control back", async () => {
    const { member, roomId } = await roomWithMember(roomType);
    await grantScope(roomId, member, "sync");
    await revokeScope(roomId, member, "sync");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canControlMedia).toBe(false);
    expect(perms.requestState).toBe("denied");
  });

  test("host and mods control playback and queue implicitly", async () => {
    const { host, member, roomId } = await roomWithMember(roomType);
    await setRole(roomId, member, "mod");
    const room = await reload(roomId);

    for (const uid of [host._id, member._id]) {
      expect(canControlMedia(room, uid)).toBe(true);
      expect(canManageQueue(room, uid)).toBe(true);
    }
  });

  test(`the slots are worded for ${roomType}: "playback control" / "queue control"`, async () => {
    const { roomId } = await roomWithMember(roomType);
    const room = await reload(roomId);

    expect(scopeText(room, "sync").label).toBe("playback control");
    expect(scopeText(room, "queue").label).toBe("queue control");
    // resolvePerms ships the same wording to the client
    const { labels } = resolvePerms(room, room.admin.userId);
    expect(labels.sync.short).toBe("Playback");
    expect(labels.queue.short).toBe("Queue");
  });
});

/* ═══════════════════════════════════════════════════════════
   Study rooms — same slots, very different meaning
   ═══════════════════════════════════════════════════════════ */
describe("study room", () => {
  test("a plain member can't touch the timer, tasks or whiteboards", async () => {
    const { member, roomId } = await roomWithMember("study");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canControlTimer).toBe(false);
    expect(perms.canManageTasks).toBe(false);
    expect(perms.canManageBoards).toBe(false);
    // and the media features of other room types never exist here
    expect(perms.canControlMedia).toBe(false);
    expect(perms.canManageQueue).toBe(false);
  });

  test("granting 'sync' unlocks the pomodoro timer — not media playback", async () => {
    const { member, roomId } = await roomWithMember("study");
    await grantScope(roomId, member, "sync");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canSync).toBe(true);
    expect(perms.canControlTimer).toBe(true);  // start / pause / reset / skip
    expect(perms.canControlMedia).toBe(false); // study rooms have no video player
    expect(perms.canManageTasks).toBe(false);  // timer control ≠ task access
    expect(perms.canManageBoards).toBe(false);
  });

  test("granting 'queue' unlocks BOTH tasks and whiteboards (one study content grant)", async () => {
    const { member, roomId } = await roomWithMember("study");
    await grantScope(roomId, member, "queue");
    const room = await reload(roomId);
    const perms = resolvePerms(room, member._id);

    expect(perms.canQueue).toBe(true);
    expect(perms.canManageTasks).toBe(true);   // create / assign / delete tasks
    expect(perms.canManageBoards).toBe(true);  // create / edit / delete whiteboards
    expect(canManageStudy(room, member._id)).toBe(true); // the guard the handlers use
    expect(perms.canManageQueue).toBe(false);  // no video queue in a study room
    expect(perms.canControlTimer).toBe(false); // the other slot stays closed
  });

  test("revoking 'queue' removes task AND whiteboard access together", async () => {
    const { member, roomId } = await roomWithMember("study");
    await grantScope(roomId, member, "queue");
    await revokeScope(roomId, member, "queue");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canManageTasks).toBe(false);
    expect(perms.canManageBoards).toBe(false);
    expect(perms.queueRequestState).toBe("denied");
  });

  test("host and mods implicitly hold timer, task and whiteboard access", async () => {
    const { host, member, roomId } = await roomWithMember("study");
    await setRole(roomId, member, "mod");
    const room = await reload(roomId);

    for (const uid of [host._id, member._id]) {
      expect(canControlTimer(room, uid)).toBe(true);
      expect(canManageStudy(room, uid)).toBe(true);
      const perms = resolvePerms(room, uid);
      expect(perms.canManageTasks).toBe(true);
      expect(perms.canManageBoards).toBe(true);
    }
  });

  test("'everyone' mode on the content slot opens tasks & boards to all members", async () => {
    const { member, roomId } = await roomWithMember("study");
    await setSlotMode(roomId, "queue", "everyone");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canManageTasks).toBe(true);
    expect(perms.canManageBoards).toBe(true);
    expect(perms.canControlTimer).toBe(false); // timer mode is separate
  });

  test("the slots are worded for studying: 'timer control' / 'task & board management'", async () => {
    const { roomId } = await roomWithMember("study");
    const room = await reload(roomId);

    expect(scopeText(room, "sync").label).toBe("timer control");
    expect(scopeText(room, "queue").label).toBe("task & board management");
    const { labels } = resolvePerms(room, room.admin.userId);
    expect(labels.sync.short).toBe("Timer");
    expect(labels.queue.short).toBe("Tasks & boards");
  });
});

/* ═══════════════════════════════════════════════════════════
   Grants never leak across room families
   ═══════════════════════════════════════════════════════════ */
describe("room-type isolation", () => {
  test("the same user's grant in one room does not follow them into another room", async () => {
    const host = await createUser();
    const member = await createUser();
    const media = await createRoom(host, { roomType: "entertainment" });
    const study = await createRoom(host, { roomType: "study" });
    await joinRoom(media.roomId, member);
    await joinRoom(study.roomId, member);

    await grantScope(media.roomId, member, "queue"); // queue control in the media room only

    const mediaPerms = resolvePerms(await reload(media.roomId), member._id);
    const studyPerms = resolvePerms(await reload(study.roomId), member._id);

    expect(mediaPerms.canManageQueue).toBe(true);
    expect(studyPerms.canManageTasks).toBe(false);  // per-room state: nothing leaked
    expect(studyPerms.canManageBoards).toBe(false);
    expect(studyPerms.canQueue).toBe(false);
  });

  test("feature guards are the product of family AND grant — a grant alone is not enough", async () => {
    const { member, roomId } = await roomWithMember("entertainment");
    await grantScope(roomId, member, "queue");
    const room = await reload(roomId);

    // the user holds the raw slot…
    expect(hasGrant(room, member._id, "queue")).toBe(true);
    // …which in a media room means the queue, never the study features
    expect(canManageQueue(room, member._id)).toBe(true);
    expect(canManageStudy(room, member._id)).toBe(false);
  });
});
