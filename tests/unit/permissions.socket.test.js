// tests/unit/permissions.socket.test.js
// ─────────────────────────────────────────────────────────────
// THE REAL GRANT / REVOKE FLOW — socket/roomHandlers.js §6b
//
// The previous suites pin down the pure rules; this one proves the actual
// wire protocol enforces them. A real socket.io server runs the app's own
// authentication middleware and room handlers against the in-memory
// MongoDB; mock users (username1, user1@user.com, verified) connect with
// genuine accessToken cookies, join rooms through "join-room", and then the
// perm-* events are exercised exactly as the client fires them:
//
//   perm-grant / perm-revoke        moderator hands a scope to a member
//   perm-request / perm-respond     member asks, moderator approves/denies
//   perm-set-role                   host (only!) promotes / demotes mods
//   perm-set-queue-mode             room-wide "everyone" switch for a slot
//
// Every test asserts BOTH sides: the live payload pushed to the affected
// user (room-permissions / perm-toast / perm-notice) and the state that
// was persisted to the room document in the database.
// ─────────────────────────────────────────────────────────────
"use strict";

// handleLeave() logs departures with a 15s "presence grace" timer
// (utils/roomEvents.js). That timer is irrelevant to permissions but would
// keep the Jest process alive after the suite — so only logLeave is stubbed;
// every other roomEvents export stays real.
jest.mock("../../utils/roomEvents", () => {
  const real = jest.requireActual("../../utils/roomEvents");
  return { ...real, logLeave: jest.fn() };
});

const db = require("./helpers/db");
const {
  createUser,
  createRoom,
  grantScope,
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
const { getMember } = require("../../utils/roomConfigAndPermissions");

let server;
let clients = []; // every client opened by the current test — closed in afterEach

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

/** Connect `userDoc` and join `roomId` through the real socket events. */
async function enter(roomId, userDoc) {
  const socket = await connectAs(server.port, userDoc);
  clients.push(socket);
  const { perms } = await joinRoomViaSocket(socket, roomId);
  return { socket, perms };
}

/** A live room: host + one regular member, both connected and joined. */
async function liveRoom(roomType = "entertainment") {
  const host = await createUser();
  const member = await createUser();
  const { roomId } = await createRoom(host, { roomType });
  const h = await enter(roomId, host);
  const m = await enter(roomId, member);
  return {
    roomId, host, member,
    hostSock: h.socket, hostPerms: h.perms,
    memberSock: m.socket, memberPerms: m.perms,
  };
}

const id = (userDoc) => userDoc._id.toString();

describe("join-room: everyone starts with the right permissions", () => {
  test("the host joins as admin, a member joins with no grants", async () => {
    const { hostPerms, memberPerms, roomId, member } = await liveRoom();

    expect(hostPerms).toMatchObject({ isAdmin: true, role: "admin", canSync: true, canQueue: true, canSetRoles: true, canBan: true });
    expect(memberPerms).toMatchObject({ isAdmin: false, isMod: false, role: "member", canSync: false, canQueue: false, canManage: false });

    // joining persisted the member's permission record with safe defaults
    const m = getMember(await reload(roomId), member._id);
    expect(m).toMatchObject({ role: "member", canSync: false, canQueue: false, syncRequest: "none", queueRequest: "none" });
  });
});

describe("perm-grant / perm-revoke", () => {
  test("host grants 'sync' → member gains playback control, live and in the DB", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");

    const memberUpdate = waitForPerms(memberSock, (p) => p.canSync === true);
    const memberToast = waitForToast(memberSock, "You can now use playback control");
    const roomNotice = waitFor(hostSock, "perm-notice", (n) => n.text.includes("can now use playback control"));

    hostSock.emit("perm-grant", { userId: id(member), scope: "sync" });

    const { perms } = await memberUpdate;
    expect(perms.canSync).toBe(true);
    expect(perms.canControlMedia).toBe(true); // the feature this scope means in a media room
    expect(perms.canQueue).toBe(false);       // only the requested scope was granted
    expect(perms.canManage).toBe(false);      // a grant is not a promotion
    await memberToast;
    expect((await roomNotice).text).toContain(member.username);

    const m = getMember(await reload(roomId), member._id);
    expect(m.canSync).toBe(true);
    expect(m.canQueue).toBe(false);
  });

  test("host revokes 'sync' → member loses control and further requests are blocked", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");
    await grantScope(roomId, member, "sync"); // starting point: member holds the grant

    const memberUpdate = waitForPerms(memberSock, (p) => p.canSync === false && p.requestState === "denied");
    const memberToast = waitForToast(memberSock, "Your playback control was removed");

    hostSock.emit("perm-revoke", { userId: id(member), scope: "sync" });

    const { perms } = await memberUpdate;
    expect(perms.canControlMedia).toBe(false);
    await memberToast;

    const m = getMember(await reload(roomId), member._id);
    expect(m.canSync).toBe(false);
    expect(m.syncRequest).toBe("denied"); // "ask again" is off until a mod re-grants
  });

  test("a regular member may NOT grant — the guard denies and nothing is persisted", async () => {
    const { roomId, memberSock } = await liveRoom("entertainment");
    const other = await createUser();
    await enter(roomId, other);

    const denied = waitForToast(memberSock, "Only the host and moderators can do that");
    memberSock.emit("perm-grant", { userId: id(other), scope: "sync" });
    await denied;

    const m = getMember(await reload(roomId), other._id);
    expect(m.canSync).toBe(false); // the attempt never reached the room document
  });

  test("granting to the host or a mod is a no-op — they already hold everything", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");

    // promote the member to mod first
    const promoted = waitForPerms(memberSock, (p) => p.isMod === true);
    hostSock.emit("perm-set-role", { userId: id(member), role: "mod" });
    await promoted;

    // now try to "grant" the mod both scopes
    hostSock.emit("perm-grant", { userId: id(member), scope: "sync" });
    hostSock.emit("perm-grant", { userId: id(member), scope: "queue" });

    // sentinel: a real grant to a fresh member — once it lands, the
    // earlier no-op emits are guaranteed to have been processed too
    const extra = await createUser();
    const e = await enter(roomId, extra);
    const sentinel = waitForPerms(e.socket, (p) => p.canQueue === true);
    hostSock.emit("perm-grant", { userId: id(extra), scope: "queue" });
    await sentinel;

    const room = await reload(roomId);
    const modRecord = getMember(room, member._id);
    expect(modRecord.canSync).toBe(false);  // no flag written —
    expect(modRecord.canQueue).toBe(false); // the grant is implicit in the role
  });

  test("unknown scope strings are ignored outright", async () => {
    const { roomId, member, hostSock } = await liveRoom("entertainment");

    hostSock.emit("perm-grant", { userId: id(member), scope: "whiteboard" }); // not a wire scope
    hostSock.emit("perm-grant", { userId: id(member), scope: "tasks" });     // not a wire scope

    // sentinel grant with a VALID scope to flush the queue
    const e = await enter(roomId, await createUser());
    const flushed = waitForPerms(e.socket, () => true);
    hostSock.emit("perm-grant", { userId: id(member), scope: "sync" });
    await flushed;

    const m = getMember(await reload(roomId), member._id);
    expect(m.canSync).toBe(true);   // the valid scope landed…
    expect(m.canQueue).toBe(false); // …the bogus ones changed nothing
  });
});

describe("perm-set-role: promoting and demoting mods (host only)", () => {
  test("host promotes a member to mod — mod powers arrive live and persist", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");

    const promoted = waitForPerms(memberSock, (p) => p.isMod === true);
    const toast = waitForToast(memberSock, "You're now a moderator");
    hostSock.emit("perm-set-role", { userId: id(member), role: "mod" });

    const { perms } = await promoted;
    expect(perms).toMatchObject({
      role: "mod",
      canSync: true,  canQueue: true,   // implicit grants
      canManage: true, canGrantSync: true, canGrantQueue: true,
      canSetRoles: false, canBan: false, // still not the host
    });
    await toast;
    expect(getMember(await reload(roomId), member._id).role).toBe("mod");
  });

  test("a mod may grant scopes to members — same power as the host", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");
    const target = await createUser();
    const t = await enter(roomId, target);

    // host makes `member` a mod…
    const promoted = waitForPerms(memberSock, (p) => p.isMod === true);
    hostSock.emit("perm-set-role", { userId: id(member), role: "mod" });
    await promoted;

    // …then the MOD (not the host) grants queue control to `target`
    const granted = waitForPerms(t.socket, (p) => p.canQueue === true);
    memberSock.emit("perm-grant", { userId: id(target), scope: "queue" });

    const { perms } = await granted;
    expect(perms.canManageQueue).toBe(true);
    expect(getMember(await reload(roomId), target._id).canQueue).toBe(true);
  });

  test("a mod may NOT change roles — that is host-only", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");
    const target = await createUser();
    await enter(roomId, target);

    const promoted = waitForPerms(memberSock, (p) => p.isMod === true);
    hostSock.emit("perm-set-role", { userId: id(member), role: "mod" });
    await promoted;

    const denied = waitForToast(memberSock, "Only the host can do that");
    memberSock.emit("perm-set-role", { userId: id(target), role: "mod" });
    await denied;

    expect(getMember(await reload(roomId), target._id).role).toBe("member");
  });

  test("the host can never be demoted through perm-set-role", async () => {
    const { roomId, host, member, hostSock, memberSock } = await liveRoom("entertainment");

    hostSock.emit("perm-set-role", { userId: id(host), role: "member" }); // silently ignored

    // sentinel so we know the ignored event was processed
    const promoted = waitForPerms(memberSock, (p) => p.isMod === true);
    hostSock.emit("perm-set-role", { userId: id(member), role: "mod" });
    await promoted;

    const room = await reload(roomId);
    expect(room.admin.userId.toString()).toBe(id(host)); // still the one and only host
    expect(getMember(room, host._id).role).toBe("admin");
  });

  test("demoting a mod takes the implicit grants away again", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");

    const promoted = waitForPerms(memberSock, (p) => p.isMod === true);
    hostSock.emit("perm-set-role", { userId: id(member), role: "mod" });
    await promoted;

    const demoted = waitForPerms(memberSock, (p) => p.isMod === false && p.role === "member");
    const toast = waitForToast(memberSock, "You're no longer a moderator");
    hostSock.emit("perm-set-role", { userId: id(member), role: "member" });

    const { perms } = await demoted;
    expect(perms.canSync).toBe(false);  // implicit grants gone
    expect(perms.canQueue).toBe(false);
    expect(perms.canManage).toBe(false);
    await toast;
    expect(getMember(await reload(roomId), member._id).role).toBe("member");
  });
});

describe("perm-request / perm-respond: members ask, moderators decide", () => {
  test("request → approve: the member ends up holding the scope", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("entertainment");

    const seenByHost = waitFor(hostSock, "perm-request", (r) => r.scope === "queue");
    const ack = waitForToast(memberSock, "Request sent");
    memberSock.emit("perm-request", { scope: "queue" });

    const request = await seenByHost;
    expect(request).toMatchObject({ userId: id(member), username: member.username, scope: "queue" });
    await ack;
    expect(getMember(await reload(roomId), member._id).queueRequest).toBe("pending");

    const granted = waitForPerms(memberSock, (p) => p.canQueue === true);
    const congrats = waitForToast(memberSock, "gave you queue control");
    hostSock.emit("perm-respond", { userId: id(member), approve: true, scope: "queue" });

    const { perms } = await granted;
    expect(perms.canManageQueue).toBe(true);
    await congrats;

    const m = getMember(await reload(roomId), member._id);
    expect(m.canQueue).toBe(true);
    expect(m.queueRequest).toBe("none"); // nothing left pending
  });

  test("request → deny: scope stays off and re-asking is refused", async () => {
    const { roomId, member, host, hostSock, memberSock } = await liveRoom("entertainment");

    const seenByHost = waitFor(hostSock, "perm-request", (r) => r.scope === "sync");
    memberSock.emit("perm-request", { scope: "sync" });
    await seenByHost;

    const declined = waitForToast(memberSock, "Your request was declined");
    hostSock.emit("perm-respond", { userId: id(member), approve: false, scope: "sync" });
    await declined;

    const m = getMember(await reload(roomId), member._id);
    expect(m.canSync).toBe(false);
    expect(m.syncRequest).toBe("denied");

    // a fresh connection (no per-socket cooldown) tries again → hard refusal
    const again = await connectAs(server.port, member);
    clients.push(again);
    await joinRoomViaSocket(again, roomId);
    const refused = waitForToast(again, "Your request was declined — a host or mod has to grant it");
    again.emit("perm-request", { scope: "sync" });
    await refused;
    expect(getMember(await reload(roomId), member._id).syncRequest).toBe("denied");
  });
});

describe("study rooms over the wire: 'queue' = tasks & whiteboards", () => {
  test("host grants the study content scope → tasks AND boards unlock for the member", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("study");

    const unlocked = waitForPerms(memberSock, (p) => p.canManageTasks === true);
    const toast = waitForToast(memberSock, "You can now use task & board management");
    hostSock.emit("perm-grant", { userId: id(member), scope: "queue" });

    const { perms } = await unlocked;
    expect(perms.canManageTasks).toBe(true);   // task creation / assignment
    expect(perms.canManageBoards).toBe(true);  // whiteboard management
    expect(perms.canManageQueue).toBe(false);  // study rooms have no video queue
    expect(perms.canControlTimer).toBe(false); // the timer slot was not granted
    await toast;                               // study-room wording, not "queue control"

    expect(getMember(await reload(roomId), member._id).canQueue).toBe(true);
  });

  test("host grants the timer scope → pomodoro control only", async () => {
    const { roomId, member, hostSock, memberSock } = await liveRoom("study");

    const unlocked = waitForPerms(memberSock, (p) => p.canControlTimer === true);
    const toast = waitForToast(memberSock, "You can now use timer control");
    hostSock.emit("perm-grant", { userId: id(member), scope: "sync" });

    const { perms } = await unlocked;
    expect(perms.canControlTimer).toBe(true);
    expect(perms.canManageTasks).toBe(false);
    expect(perms.canManageBoards).toBe(false);
    await toast;
    expect(getMember(await reload(roomId), member._id).canSync).toBe(true);
  });
});

describe("perm-set-queue-mode: opening a slot to the whole room", () => {
  test("'everyone' mode gives every member the scope without individual flags", async () => {
    const { roomId, hostSock, memberSock } = await liveRoom("entertainment");

    const opened = waitForPerms(memberSock, (p) => p.canQueue === true);
    const notice = waitFor(memberSock, "perm-notice", (n) => n.text.includes("Everyone can now manage the queue"));
    hostSock.emit("perm-set-queue-mode", { mode: "everyone" });

    const { perms } = await opened;
    expect(perms.canManageQueue).toBe(true);
    expect(perms.canManage).toBe(false); // open slot ≠ moderator
    await notice;

    const room = await reload(roomId);
    expect(room.settings.queueMode).toBe("everyone");
    // no per-member flag was written — access comes from the room mode
    expect(room.members.every((m) => m.canQueue === false)).toBe(true);
  });

  test("only moderators may flip the mode", async () => {
    const { roomId, memberSock } = await liveRoom("entertainment");

    const denied = waitForToast(memberSock, "Only the host and moderators can do that");
    memberSock.emit("perm-set-queue-mode", { mode: "everyone" });
    await denied;

    expect((await reload(roomId)).settings.queueMode).toBe("host");
  });
});
