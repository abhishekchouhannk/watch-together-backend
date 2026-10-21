// tests/unit/helpers/factories.js
// Builders for the mock data every permission test needs: verified users,
// rooms of each type, and "join" / "role" / "grant" helpers that persist
// state EXACTLY the way the app does (same code paths where possible —
// ensureMember() is the app's own membership bootstrap, and the grant/role
// mutations mirror the perm-* socket handlers field for field).
"use strict";
const User = require("../../../models/User");
const Room = require("../../../models/Room");
const {
  ensureMember,
  getMember,
  GRANT_SLOTS,
} = require("../../../utils/roomConfigAndPermissions");

let userSeq = 0;
let roomSeq = 0;

/** The socket layer identifies people as { id, username } — adapt a User doc. */
const asSocketUser = (userDoc) => ({
  id: userDoc._id.toString(),
  username: userDoc.username,
});

/** username1 / user1@user.com / isVerified:true — exactly the mock shape we want. */
async function createUser() {
  const n = ++userSeq;
  return User.create({
    username: `username${n}`,
    email: `user${n}@user.com`,
    password: `hashed-password-${n}`, // model stores a hash; any string works for tests
    isVerified: true,
  });
}

async function createUsers(count) {
  const users = [];
  for (let i = 0; i < count; i++) users.push(await createUser());
  return users;
}

/**
 * Create a room of the given type with `host` as its (single) admin,
 * and have the host join it — mirroring POST /rooms + the first join.
 */
async function createRoom(host, { roomType = "entertainment", ...overrides } = {}) {
  const n = ++roomSeq;
  await Room.create({
    roomId: `test-room-${n}`,
    roomName: `Test ${roomType} room ${n}`,
    description: `A ${roomType} room used by the permission tests`,
    roomType,
    admin: { userId: host._id, username: host.username },
    ...overrides,
  });
  return joinRoom(`test-room-${n}`, host);
}

/**
 * Persist a user joining a room the same way socket "join-room" does:
 * push presence into `participants`, then ensureMember() creates (or
 * refreshes) the persistent per-user permission record in `members`.
 */
async function joinRoom(roomId, userDoc) {
  const room = await Room.findOne({ roomId });
  const u = asSocketUser(userDoc);
  const alreadyIn = room.participants.some((p) => p.userId && p.userId.toString() === u.id);
  if (!alreadyIn) {
    room.participants.push({ userId: userDoc._id, username: u.username, joinedAt: new Date() });
  }
  ensureMember(room, u);
  await room.save();
  await User.updateOne({ _id: userDoc._id }, { $addToSet: { joinedRooms: roomId } });
  return room;
}

/** Promote / demote a member — same mutation as the "perm-set-role" handler. */
async function setRole(roomId, userDoc, role) {
  const room = await Room.findOne({ roomId });
  const m = getMember(room, userDoc._id);
  if (!m) throw new Error(`${userDoc.username} never joined ${roomId}`);
  m.role = role;
  if (role === "mod") {
    for (const slot of Object.values(GRANT_SLOTS)) m[slot.req] = "none";
  }
  m.updatedAt = new Date();
  await room.save();
  return room;
}

/** Flip a member's persisted grant flag — same mutation as "perm-grant". */
async function grantScope(roomId, userDoc, scope) {
  const slot = GRANT_SLOTS[scope];
  if (!slot) throw new Error(`unknown scope "${scope}"`);
  const room = await Room.findOne({ roomId });
  const m = getMember(room, userDoc._id);
  m[slot.flag] = true;
  m[slot.req] = "none";
  m.updatedAt = new Date();
  await room.save();
  return room;
}

/** Clear a member's persisted grant flag — same mutation as "perm-revoke". */
async function revokeScope(roomId, userDoc, scope) {
  const slot = GRANT_SLOTS[scope];
  if (!slot) throw new Error(`unknown scope "${scope}"`);
  const room = await Room.findOne({ roomId });
  const m = getMember(room, userDoc._id);
  m[slot.flag] = false;
  m[slot.req] = "denied";
  m.updatedAt = new Date();
  await room.save();
  return room;
}

/** Room-wide slot mode ("host" | "everyone") — same as "perm-set-mode". */
async function setSlotMode(roomId, scope, mode) {
  const slot = GRANT_SLOTS[scope];
  if (!slot) throw new Error(`unknown scope "${scope}"`);
  const room = await Room.findOne({ roomId });
  room.settings[slot.mode] = mode;
  await room.save();
  return room;
}

/** Fresh read from the in-memory DB — what any other server instance would see. */
const reload = (roomId) => Room.findOne({ roomId });

module.exports = {
  asSocketUser,
  createUser,
  createUsers,
  createRoom,
  joinRoom,
  setRole,
  grantScope,
  revokeScope,
  setSlotMode,
  reload,
};