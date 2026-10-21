// tests/unit/permissions.core.test.js
// ─────────────────────────────────────────────────────────────
// CORE PERMISSION LOGIC — utils/roomConfigAndPermissions.js
//
// The app has exactly one permission hierarchy:
//
//   host (admin, one per room)  >  mod  >  member
//
// …and exactly two persisted per-member grants ("slots"), addressed on the
// wire by the scope strings "sync" and "queue". This suite covers the rules
// that everything else (playback, queue, timer, tasks, whiteboards) is built
// on: who holds a grant, how granting/revoking changes persisted room state,
// and what resolvePerms() reports to the client for each role.
//
// All documents live in a real in-memory MongoDB (mongodb-memory-server) and
// every assertion runs against a FRESH read from that DB, so schema defaults
// and persistence are part of what's being tested — not just in-process
// object mutation.
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
  asSocketUser,
} = require("./helpers/factories");
const {
  isAdmin,
  isMod,
  roleOf,
  canModerate,
  getMember,
  ensureMember,
  hasGrant,
  getGrantSlot,
  resolvePerms,
  serializeMembers,
} = require("../../utils/roomConfigAndPermissions");

beforeAll(() => db.connect());
afterEach(() => db.clearDatabase());
afterAll(() => db.disconnect());

/** host + mod + member all joined to one room of the given type */
async function roomWithCrew(roomType = "entertainment") {
  const host = await createUser();
  const mod = await createUser();
  const member = await createUser();
  let room = await createRoom(host, { roomType });
  await joinRoom(room.roomId, mod);
  await joinRoom(room.roomId, member);
  room = await setRole(room.roomId, mod, "mod");
  return { host, mod, member, room, roomId: room.roomId };
}

describe("core hierarchy: host > mod > member", () => {
  test("roles resolve correctly for host, mod and regular member", async () => {
    const { host, mod, member, roomId } = await roomWithCrew();
    const room = await reload(roomId);

    expect(roleOf(room, host._id)).toBe("admin");
    expect(roleOf(room, mod._id)).toBe("mod");
    expect(roleOf(room, member._id)).toBe("member");

    expect(isAdmin(room, host._id)).toBe(true);
    expect(isMod(room, host._id)).toBe(false); // the host is the host, not a mod
    expect(isAdmin(room, mod._id)).toBe(false);
    expect(isMod(room, mod._id)).toBe(true);
  });

  test("there is exactly one host: only room.admin passes isAdmin", async () => {
    const { host, mod, member, roomId } = await roomWithCrew();
    const room = await reload(roomId);

    const admins = [host, mod, member].filter((u) => isAdmin(room, u._id));
    expect(admins.map((u) => u.username)).toEqual([host.username]);
    expect(room.admin.userId.toString()).toBe(host._id.toString());
    // and the host's persisted member record carries the admin role
    expect(getMember(room, host._id).role).toBe("admin");
  });

  test("canModerate (the 'host + mods' guard) admits host and mod, rejects member", async () => {
    const { host, mod, member, roomId } = await roomWithCrew();
    const room = await reload(roomId);

    expect(canModerate(room, host._id)).toBe(true);
    expect(canModerate(room, mod._id)).toBe(true);
    expect(canModerate(room, member._id)).toBe(false);
  });

  test("a stranger who never joined has no role and no grants", async () => {
    const { roomId } = await roomWithCrew();
    const outsider = await createUser();
    const room = await reload(roomId);

    expect(getMember(room, outsider._id)).toBeUndefined();
    expect(roleOf(room, outsider._id)).toBe("member"); // default, but…
    expect(canModerate(room, outsider._id)).toBe(false);
    expect(hasGrant(room, outsider._id, "sync")).toBe(false);
    expect(hasGrant(room, outsider._id, "queue")).toBe(false);
  });
});

describe("ensureMember: the persistent per-user permission record", () => {
  test("joining creates a member record with no grants and no pending requests", async () => {
    const host = await createUser();
    const member = await createUser();
    const { roomId } = await createRoom(host);
    await joinRoom(roomId, member);

    const m = getMember(await reload(roomId), member._id);
    expect(m).toMatchObject({
      username: member.username,
      role: "member",
      canSync: false,
      syncRequest: "none",
      canQueue: false,
      queueRequest: "none",
    });
  });

  test("re-joining is idempotent — one record per user, grants survive leave/rejoin", async () => {
    const host = await createUser();
    const member = await createUser();
    const { roomId } = await createRoom(host);
    await joinRoom(roomId, member);
    await grantScope(roomId, member, "sync");

    await joinRoom(roomId, member); // simulate leave + rejoin
    const room = await reload(roomId);

    const records = room.members.filter((m) => m.userId.toString() === member._id.toString());
    expect(records).toHaveLength(1);
    expect(records[0].canSync).toBe(true); // the grant persisted across the rejoin
  });

  test("only the actual host can hold the admin role — ensureMember repairs drift", async () => {
    const host = await createUser();
    const impostor = await createUser();
    const { roomId } = await createRoom(host);
    await joinRoom(roomId, impostor);

    // simulate corrupted/stale data: a non-host member claims role "admin"
    let room = await reload(roomId);
    getMember(room, impostor._id).role = "admin";
    await room.save();

    // the app re-runs ensureMember on every join — the role must be repaired
    room = await reload(roomId);
    ensureMember(room, asSocketUser(impostor));
    await room.save();

    room = await reload(roomId);
    expect(getMember(room, impostor._id).role).toBe("member");
    expect(isAdmin(room, impostor._id)).toBe(false);
    expect(roleOf(room, host._id)).toBe("admin"); // still exactly one host
  });
});

describe("granting and revoking the two permission slots", () => {
  test("a regular member starts with no grants in either slot", async () => {
    const { member, roomId } = await roomWithCrew();
    const room = await reload(roomId);

    expect(hasGrant(room, member._id, "sync")).toBe(false);
    expect(hasGrant(room, member._id, "queue")).toBe(false);
  });

  test("granting 'sync' updates the member's persisted record and only that slot", async () => {
    const { member, roomId } = await roomWithCrew();
    await grantScope(roomId, member, "sync");
    const room = await reload(roomId);

    expect(getMember(room, member._id).canSync).toBe(true);
    expect(hasGrant(room, member._id, "sync")).toBe(true);
    expect(hasGrant(room, member._id, "queue")).toBe(false); // per-scope, not blanket
  });

  test("grants are per-user — other members are untouched", async () => {
    const { member, roomId } = await roomWithCrew();
    const bystander = await createUser();
    await joinRoom(roomId, bystander);

    await grantScope(roomId, member, "queue");
    const room = await reload(roomId);

    expect(hasGrant(room, member._id, "queue")).toBe(true);
    expect(hasGrant(room, bystander._id, "queue")).toBe(false);
  });

  test("revoking removes the grant and marks the request state 'denied'", async () => {
    const { member, roomId } = await roomWithCrew();
    await grantScope(roomId, member, "sync");
    await revokeScope(roomId, member, "sync");
    const room = await reload(roomId);

    const m = getMember(room, member._id);
    expect(m.canSync).toBe(false);
    expect(m.syncRequest).toBe("denied"); // future perm-requests are blocked until a mod re-grants
    expect(hasGrant(room, member._id, "sync")).toBe(false);
  });

  test("host and mods hold every grant implicitly — no flag needed", async () => {
    const { host, mod, roomId } = await roomWithCrew();
    const room = await reload(roomId);

    for (const scope of ["sync", "queue"]) {
      expect(hasGrant(room, host._id, scope)).toBe(true);
      expect(hasGrant(room, mod._id, scope)).toBe(true);
    }
    // …even though their persisted flags were never set
    expect(getMember(room, mod._id).canSync).toBe(false);
    expect(getMember(room, mod._id).canQueue).toBe(false);
  });

  test("host/mod grants are not revocable — flipping their flags changes nothing", async () => {
    const { host, mod, roomId } = await roomWithCrew();
    await revokeScope(roomId, host, "sync");
    await revokeScope(roomId, mod, "sync");
    const room = await reload(roomId);

    expect(hasGrant(room, host._id, "sync")).toBe(true);
    expect(hasGrant(room, mod._id, "sync")).toBe(true);
  });

  test("promoting to mod grants everything; demoting takes the implicit grants back", async () => {
    const { member, roomId } = await roomWithCrew();
    let room = await setRole(roomId, member, "mod");
    expect(hasGrant(room, member._id, "sync")).toBe(true);
    expect(hasGrant(room, member._id, "queue")).toBe(true);

    room = await setRole(roomId, member, "member");
    expect(hasGrant(room, member._id, "sync")).toBe(false); // no explicit flag was ever set
    expect(hasGrant(room, member._id, "queue")).toBe(false);
  });

  test("slot mode 'everyone' opens the slot for all members; 'host' closes it again", async () => {
    const { member, roomId } = await roomWithCrew();
    await setSlotMode(roomId, "sync", "everyone");
    let room = await reload(roomId);
    expect(hasGrant(room, member._id, "sync")).toBe(true);
    expect(hasGrant(room, member._id, "queue")).toBe(false); // the other slot stays closed

    await setSlotMode(roomId, "sync", "host");
    room = await reload(roomId);
    expect(hasGrant(room, member._id, "sync")).toBe(false);
  });

  test("an explicit personal grant survives the room flipping back to host-only mode", async () => {
    const { member, roomId } = await roomWithCrew();
    await grantScope(roomId, member, "queue");
    await setSlotMode(roomId, "queue", "everyone");
    await setSlotMode(roomId, "queue", "host");
    const room = await reload(roomId);

    expect(hasGrant(room, member._id, "queue")).toBe(true);
  });

  test("only 'sync' and 'queue' are valid wire scopes — anything else is rejected", async () => {
    const { host, member, roomId } = await roomWithCrew();
    const room = await reload(roomId);

    expect(getGrantSlot("sync")).not.toBeNull();
    expect(getGrantSlot("queue")).not.toBeNull();
    for (const bogus of ["whiteboard", "tasks", "admin", "", null, undefined, 42, {}]) {
      expect(getGrantSlot(bogus)).toBeNull();
      expect(hasGrant(room, member._id, bogus)).toBe(false);
      expect(hasGrant(room, host._id, bogus)).toBe(false); // not even for the host
    }
  });
});

describe("resolvePerms: the payload each role sees", () => {
  test("host gets the full moderation set, including host-only powers", async () => {
    const { host, roomId } = await roomWithCrew();
    const perms = resolvePerms(await reload(roomId), host._id);

    expect(perms).toMatchObject({
      isAdmin: true,
      isMod: false,
      role: "admin",
      canSync: true,
      canQueue: true,
      canManage: true,
      canEditRoom: true,
      canGrantSync: true,
      canGrantQueue: true,
      canSetRoles: true, // host only
      canBan: true,      // host only
    });
  });

  test("mod can moderate and grant, but cannot set roles or ban", async () => {
    const { mod, roomId } = await roomWithCrew();
    const perms = resolvePerms(await reload(roomId), mod._id);

    expect(perms).toMatchObject({
      isAdmin: false,
      isMod: true,
      role: "mod",
      canSync: true,
      canQueue: true,
      canManage: true,
      canGrantSync: true,
      canGrantQueue: true,
      canSetRoles: false, // host only
      canBan: false,      // host only
    });
  });

  test("regular member starts with nothing but the defaults", async () => {
    const { member, roomId } = await roomWithCrew();
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms).toMatchObject({
      isAdmin: false,
      isMod: false,
      role: "member",
      canSync: false,
      canQueue: false,
      canManage: false,
      canEditRoom: false,
      canGrantSync: false,
      canGrantQueue: false,
      canSetRoles: false,
      canBan: false,
      requestState: "none",
      queueRequestState: "none",
    });
  });

  test("a grant flips exactly the matching capability in the payload", async () => {
    const { member, roomId } = await roomWithCrew();
    await grantScope(roomId, member, "sync");
    const perms = resolvePerms(await reload(roomId), member._id);

    expect(perms.canSync).toBe(true);
    expect(perms.canQueue).toBe(false);
    expect(perms.canManage).toBe(false); // a grant is not a promotion
    expect(perms.role).toBe("member");
  });

  test("privileged members-list shows grants; the public one hides them", async () => {
    const { member, roomId } = await roomWithCrew();
    await grantScope(roomId, member, "sync");
    const room = await reload(roomId);

    const privileged = serializeMembers(room, true)
      .find((m) => m.userId === member._id.toString());
    expect(privileged.canSync).toBe(true);
    expect(privileged.canQueue).toBe(false);

    const publicView = serializeMembers(room, false)
      .find((m) => m.userId === member._id.toString());
    expect(publicView.canSync).toBeUndefined(); // grant details are mod-only
    expect(publicView).toEqual({
      userId: member._id.toString(),
      username: member.username,
      role: "member",
    });
  });
});
