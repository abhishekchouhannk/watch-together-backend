// tests/unit/moderation.socket.test.js
// ─────────────────────────────────────────────────────────────
// MODERATION OVER THE WIRE — socket/roomHandlers.js §6c
//
// Same recipe as permissions.socket.test.js: the real socket.io server runs
// the app's own auth middleware and room handlers against an in-memory
// MongoDB; mock users (username1, user1@user.com, verified) join rooms
// through "join-room" and the moderation events are fired exactly as the
// client fires them:
//
//   member-kick           boot from the session  (membership + grants survive)
//   member-remove         boot + wipe the permission record
//   member-ban / unban    boot + blocklist        (join-room refuses them)
//   voice-force-mute / voice-force-unmute         (persisted room-wide mute)
//
// The moderation hierarchy being pinned down:
//   · kick / remove / ban / unban are HOST-ONLY — even mods are refused
//   · voice mutes are host + mods, but never against self / host / a mod
//   · a regular member firing ANY of these is stopped by the guard and the
//     targeted user is left completely untouched
//
// Every test asserts the live payloads (room-kicked, the forced disconnect,
// participants-update, perm-notice, denial toasts) AND the persisted room
// document, because that is the state a rejoining client is served from.
// ─────────────────────────────────────────────────────────────
"use strict";

// Stub ONLY roomEvents.logLeave — its 15s presence-grace timer would outlive
// the suite (same reasoning as in permissions.socket.test.js).
jest.mock("../../utils/roomEvents", () => {
  const real = jest.requireActual("../../utils/roomEvents");
  return { ...real, logLeave: jest.fn() };
});

const User = require("../../models/User");
const db = require("./helpers/db");
const {
  createUser,
  createRoom,
  grantScope,
  setRole,
  reload,
} = require("./helpers/factories");
const {
  startServer,
  connectAs,
  waitFor,
  waitForPerms,
  waitForToast,
  joinRoomViaSocket,
  disconnectAll,
} = require("./helpers/socketHarness");
const {
  getMember,
  isBanned,
  isVoiceMuted,
} = require("../../utils/roomConfigAndPermissions");

let server;
let clients = [];

beforeAll(async () => {
  await db.connect();
  server = await startServer();
});
afterEach(async () => {
  await disconnectAll(clients);
  clients = [];
  await db.clearDatabase();
});
afterAll(async () => {
  await server.close();
  await db.disconnect();
});

const id = (userDoc) => userDoc._id.toString();

/** Connect `userDoc` and join `roomId` through the real socket events. */
async function enter(roomId, userDoc) {
  const socket = await connectAs(server.port, userDoc);
  clients.push(socket);
  const state = await joinRoomViaSocket(socket, roomId);
  return { socket, perms: state.perms };
}

/** A live room: host + one regular member, both connected and joined. */
async function liveRoom(roomType = "entertainment") {
  const host = await createUser();
  const member = await createUser();
  const { roomId } = await createRoom(host, { roomType });
  const h = await enter(roomId, host);
  const m = await enter(roomId, member);
  return { roomId, host, member, hostSock: h.socket, memberSock: m.socket };
}

/** Attempt a fresh join and resolve with whichever of room-state / room-error wins. */
async function tryRejoin(userDoc, roomId) {
  const socket = await connectAs(server.port, userDoc);
  clients.push(socket);
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no join response")), 5000);
    socket.once("room-state", (s) => { clearTimeout(timer); resolve({ ok: true, state: s }); });
    socket.once("room-error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e }); });
    socket.emit("join-room", { roomId });
  });
  return { socket, ...outcome };
}

/* ═══════════════════════════════════════════════════════════
   member-kick
   ═══════════════════════════════════════════════════════════ */
describe("member-kick: host boots a user from the session", () => {
  test("host kicks a member → room-kicked + forced disconnect; grants survive the kick", async () => {
    const { roomId, host, member, hostSock, memberSock } = await liveRoom();
    await grantScope(roomId, member, "sync"); // kick must NOT cost them this

    const kicked = waitFor(memberSock, "room-kicked");
    const forcedOut = waitFor(memberSock, "disconnect", () => true, {
      timeout: 4000, label: "forced disconnect of the kicked member",
    });
    const hostAck = waitForToast(hostSock, `${member.username} was kicked`);
    const roomNotice = waitFor(hostSock, "perm-notice", (n) => n.text.includes("was kicked from the room"));
    const presence = waitFor(hostSock, "participants-update",
      (p) => p.participants.every((x) => x.userId !== id(member)));

    hostSock.emit("member-kick", { userId: id(member) });

    const evict = await kicked;
    expect(evict.reason).toBe("kick");
    expect(evict.roomId).toBe(roomId);
    expect(evict.message).toContain(host.username);           // who did it
    expect(evict.message).toContain("You can rejoin");        // kick ≠ ban
    await hostAck;
    await roomNotice;
    expect((await presence).count).toBe(1);                   // only the host left

    // the server force-closes the target's socket shortly after the boot
    expect(await forcedOut).toBe("io server disconnect");
    expect(memberSock.connected).toBe(false);

    // presence is pruned, but the permission record (and its grant) survives
    const room = await reload(roomId);
    expect(room.participants.some((p) => p.userId.toString() === id(member))).toBe(false);
    expect(getMember(room, member._id)).toMatchObject({ role: "member", canSync: true });
    expect(isBanned(room, member._id)).toBe(false);
  });

  test("a kicked member is held out by the rejoin cooldown (but is not banned)", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom();

    const kicked = waitFor(memberSock, "room-kicked");
    hostSock.emit("member-kick", { userId: id(member) });
    await kicked;

    const rejoin = await tryRejoin(member, roomId);
    expect(rejoin.ok).toBe(false);
    expect(rejoin.error.code).toBe("kicked");               // cooldown, not a ban
    expect(rejoin.error.message).toMatch(/You were just removed .* try again in \d+s/);
    expect(isBanned(await reload(roomId), member._id)).toBe(false);
  });

  test("the host cannot kick themselves — and stays untouched", async () => {
    const { roomId, host, hostSock } = await liveRoom();

    const refused = waitForToast(hostSock, "You can't do that to yourself");
    hostSock.emit("member-kick", { userId: id(host) });
    await refused;

    expect(hostSock.connected).toBe(true);
    const room = await reload(roomId);
    expect(room.participants.some((p) => p.userId.toString() === id(host))).toBe(true);
    expect(getMember(room, host._id).role).toBe("admin");
  });
});

/* ═══════════════════════════════════════════════════════════
   member-remove
   ═══════════════════════════════════════════════════════════ */
describe("member-remove: host deletes the whole membership", () => {
  test("remove boots the user AND wipes their permission record (unlike kick)", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom();
    await grantScope(roomId, member, "queue"); // remove SHOULD cost them this

    const removed = waitFor(memberSock, "room-kicked", (e) => e.reason === "removed");
    const hostAck = waitForToast(hostSock, `${member.username} was removed`);
    hostSock.emit("member-remove", { userId: id(member) });
    await removed;
    await hostAck;

    const room = await reload(roomId);
    expect(room.participants.some((p) => p.userId.toString() === id(member))).toBe(false);
    expect(getMember(room, member._id)).toBeUndefined();   // role + grants + request state: gone
    expect(isBanned(room, member._id)).toBe(false);        // removal is not a ban…

    const userDoc = await User.findById(member._id);
    expect(userDoc.joinedRooms).not.toContain(roomId);     // …but the room is gone from their list

    // …so rejoining is only held up by the short kick cooldown, not a blocklist
    const rejoin = await tryRejoin(member, roomId);
    expect(rejoin.ok).toBe(false);
    expect(rejoin.error.code).toBe("kicked");
  });

  test("removing someone who was never a member is refused cleanly", async () => {
    const { hostSock } = await liveRoom();
    const stranger = await createUser();

    const refused = waitForToast(hostSock, "They're not a member of this room");
    hostSock.emit("member-remove", { userId: id(stranger) });
    await refused;
  });
});

/* ═══════════════════════════════════════════════════════════
   member-ban / member-unban
   ═══════════════════════════════════════════════════════════ */
describe("member-ban: host blocklists a user", () => {
  test("ban evicts the user, persists the blocklist entry and bars them from rejoining", async () => {
    const { roomId, host, member, hostSock, memberSock } = await liveRoom();

    const banned = waitFor(memberSock, "room-kicked", (e) => e.reason === "banned");
    const hostAck = waitForToast(hostSock, `${member.username} was banned`);
    const roomNotice = waitFor(hostSock, "perm-notice", (n) => n.text.includes("was banned from the room"));
    // the host's refreshed payload lists the ban (host-only `banned` array)
    const hostPayload = waitFor(hostSock, "room-permissions",
      (p) => (p.banned || []).some((b) => b.userId === id(member)));

    hostSock.emit("member-ban", { userId: id(member), reason: "spamming the chat" });

    expect((await banned).message).toContain(`banned from “`);
    await hostAck;
    await roomNotice;
    const entry = (await hostPayload).banned.find((b) => b.userId === id(member));
    expect(entry).toMatchObject({ username: member.username, reason: "spamming the chat", by: host.username });

    // persisted: blocklisted, membership wiped, presence pruned, room unlisted for them
    const room = await reload(roomId);
    expect(isBanned(room, member._id)).toBe(true);
    expect(room.bannedUsers[0]).toMatchObject({
      username: member.username,
      bannedByName: host.username,
      reason: "spamming the chat",
    });
    expect(getMember(room, member._id)).toBeUndefined();
    expect(room.participants.some((p) => p.userId.toString() === id(member))).toBe(false);
    expect((await User.findById(member._id)).joinedRooms).not.toContain(roomId);

    // and join-room refuses them outright — a ban outranks the kick cooldown
    const rejoin = await tryRejoin(member, roomId);
    expect(rejoin.ok).toBe(false);
    expect(rejoin.error).toMatchObject({
      code: "banned",
      fatal: true,
      message: "You've been banned from this room",
    });
  });

  test("banning the same user twice is refused", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom();

    const banned = waitFor(memberSock, "room-kicked", (e) => e.reason === "banned");
    hostSock.emit("member-ban", { userId: id(member) });
    await banned;

    const refused = waitForToast(hostSock, `${member.username} is already banned`);
    hostSock.emit("member-ban", { userId: id(member) });
    await refused;

    expect((await reload(roomId)).bannedUsers).toHaveLength(1);
  });

  test("member-unban clears the blocklist AND the kick cooldown — they can walk right back in", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom();

    const banned = waitFor(memberSock, "room-kicked", (e) => e.reason === "banned");
    hostSock.emit("member-ban", { userId: id(member) });
    await banned;

    const unbanAck = waitForToast(hostSock, `${member.username} can join again`);
    hostSock.emit("member-unban", { userId: id(member) });
    await unbanAck;
    expect(isBanned(await reload(roomId), member._id)).toBe(false);

    const rejoin = await tryRejoin(member, roomId);
    expect(rejoin.ok).toBe(true);                          // no ban, no cooldown
    expect(rejoin.state.perms.role).toBe("member");        // fresh default membership
    const room = await reload(roomId);
    expect(room.participants.some((p) => p.userId.toString() === id(member))).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════
   voice-force-mute / voice-force-unmute
   ═══════════════════════════════════════════════════════════ */
describe("voice mutes: host + mods silence a member room-wide", () => {
  test("host force-mutes a member → persisted, broadcast, and the target is told", async () => {
    const { roomId, host, member, hostSock, memberSock } = await liveRoom();

    const targetToast = waitForToast(memberSock, `${host.username} muted your microphone`);
    const muteList = waitFor(memberSock, "voice-muted-users", (p) => p.muted.length === 1);
    const hostAck = waitForToast(hostSock, `${member.username} muted in voice`);
    const roomNotice = waitFor(hostSock, "perm-notice", (n) => n.text.includes("was muted in voice"));

    hostSock.emit("voice-force-mute", { userId: id(member) });

    expect((await muteList).muted[0]).toMatchObject({
      userId: id(member),
      username: member.username,
      by: host.username,
    });
    await targetToast;
    await hostAck;
    await roomNotice;

    const room = await reload(roomId);
    expect(isVoiceMuted(room, member._id)).toBe(true);
    expect(room.voiceMutedUsers[0]).toMatchObject({ username: member.username, mutedByName: host.username });
  });

  test("a mod can mute and unmute (moderator power, not host-only)", async () => {
    const { roomId, member, memberSock } = await liveRoom();
    const target = await createUser();
    const t = await enter(roomId, target);
    await setRole(roomId, member, "mod"); // member is now a mod

    const muted = waitFor(t.socket, "voice-muted-users", (p) => p.muted.length === 1);
    memberSock.emit("voice-force-mute", { userId: id(target) });
    await muted;
    expect(isVoiceMuted(await reload(roomId), target._id)).toBe(true);

    const liftedToast = waitForToast(t.socket, "lifted your voice mute");
    const cleared = waitFor(t.socket, "voice-muted-users", (p) => p.muted.length === 0);
    memberSock.emit("voice-force-unmute", { userId: id(target) });
    await cleared;
    await liftedToast;
    expect(isVoiceMuted(await reload(roomId), target._id)).toBe(false);
  });

  test("mutes never touch the host, a fellow mod, or yourself", async () => {
    const { roomId, host, member, memberSock } = await liveRoom();
    const otherMod = await createUser();
    await enter(roomId, otherMod);
    await setRole(roomId, member, "mod");
    await setRole(roomId, otherMod, "mod");

    const refusals = [
      [{ userId: id(host) }, "The host can't be removed"],
      [{ userId: id(otherMod) }, "You can't voice-mute another moderator"],
      [{ userId: id(member) }, "You can't do that to yourself"],
    ];
    for (const [payload, message] of refusals) {
      const refused = waitForToast(memberSock, message);
      memberSock.emit("voice-force-mute", payload);
      await refused;
    }

    expect((await reload(roomId)).voiceMutedUsers).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════
   Unauthorized attempts — the guards hold, the target is untouched
   ═══════════════════════════════════════════════════════════ */
describe("a regular member cannot moderate anyone", () => {
  test("kick / remove / ban from a member are all denied — the victim never even notices", async () => {
    const { roomId, hostSock, memberSock } = await liveRoom();
    const victim = await createUser();
    const v = await enter(roomId, victim);

    // record anything hostile that might reach the victim
    const hostileEvents = [];
    v.socket.on("room-kicked", (e) => hostileEvents.push(e));

    for (const event of ["member-kick", "member-remove", "member-ban"]) {
      const denied = waitForToast(memberSock, "Only the host can do that",
        { label: `denial of ${event}` });
      memberSock.emit(event, { userId: id(victim) });
      await denied;                                   // the guard answered → handler never ran
    }
    const deniedMute = waitForToast(memberSock, "Only the host and moderators can do that");
    memberSock.emit("voice-force-mute", { userId: id(victim) });
    await deniedMute;

    // nothing happened to the victim: no eviction, no disconnect…
    expect(hostileEvents).toHaveLength(0);
    expect(v.socket.connected).toBe(true);

    // …no persisted damage…
    const room = await reload(roomId);
    expect(room.participants.some((p) => p.userId.toString() === id(victim))).toBe(true);
    expect(getMember(room, victim._id)).toMatchObject({ role: "member" });
    expect(isBanned(room, victim._id)).toBe(false);
    expect(room.bannedUsers).toHaveLength(0);
    expect(room.voiceMutedUsers).toHaveLength(0);
    expect((await User.findById(victim._id)).joinedRooms).toContain(roomId);

    // …and the victim's socket still works: they receive the next room broadcast
    const stillLive = waitForPerms(v.socket, (p) => p.canQueue === true);
    hostSock.emit("perm-set-queue-mode", { mode: "everyone" });
    await stillLive;
  });

  test("even a MOD cannot kick, remove or ban — those stay host-only", async () => {
    const { roomId, member, memberSock } = await liveRoom();
    const victim = await createUser();
    const v = await enter(roomId, victim);
    await setRole(roomId, member, "mod"); // real moderator, real guard check

    for (const event of ["member-kick", "member-remove", "member-ban"]) {
      const denied = waitForToast(memberSock, "Only the host can do that",
        { label: `denial of ${event} for a mod` });
      memberSock.emit(event, { userId: id(victim) });
      await denied;
    }

    expect(v.socket.connected).toBe(true);
    const room = await reload(roomId);
    expect(room.participants.some((p) => p.userId.toString() === id(victim))).toBe(true);
    expect(getMember(room, victim._id)).toBeDefined();
    expect(room.bannedUsers).toHaveLength(0);
  });

  test("an outsider who joined another room can't reach into this one at all", async () => {
    // guarded() scopes every action to the room the SOCKET is in — a host of
    // room A firing member-kick only ever hits room A, so a victim in room B
    // is untouchable even by someone who is a host somewhere else.
    const roomA = await liveRoom();                 // attacker is host here
    const roomB = await liveRoom();                 // victim lives here

    const deniedInOwnRoom = waitForToast(roomA.hostSock, `isn't in the room right now`);
    roomA.hostSock.emit("member-kick", { userId: id(roomB.member) });
    await deniedInOwnRoom;                          // resolved against room A, found nobody

    expect(roomB.memberSock.connected).toBe(true);
    const b = await reload(roomB.roomId);
    expect(b.participants.some((p) => p.userId.toString() === id(roomB.member))).toBe(true);
  });
});
