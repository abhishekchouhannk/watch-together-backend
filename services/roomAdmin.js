// services/roomAdmin.js
// Owner-only room management used by REST (dashboard). Point your in-room
// 'room-update' socket handler at validateRoomPatch() too, so both paths
// enforce exactly the same rules.
"use strict";
const mongoose   = require("mongoose");
const Room       = require("../models/Room");
const Message    = require("../models/Message");
const Report     = require("../models/Report");
const RoomEvent  = require("../models/RoomEvent");
const Whiteboard = require("../models/Whiteboard");
const User       = require("../models/User");
const { runRoomDeleted } = require("./roomRuntime");
const ROOM_CAP = Room.ROOM_CAP || 10;
const RULES = { nameMin: 3, nameMax: 60, descMax: 200, tagMax: 24, tagsMax: 8 };
const EDITABLE = ["roomName", "description", "tags", "isPublic", "maxParticipants"];
const FIELD_LABEL = {
  roomName: "name", description: "description", tags: "tags",
  isPublic: "visibility", maxParticipants: "max participants",
};
/* Every model holding room-scoped documents (keyed by `roomId`). Adding a new
   room-scoped collection later? Add it HERE — deletion, the delete preview
   and scripts/sweep-orphans.js all read this map. */
const ROOM_SCOPED = {
  messages:    Message,
  reports:     Report,
  events:      RoomEvent,
  whiteboards: Whiteboard,
};
const CASCADE = [
  ...Object.entries(ROOM_SCOPED).map(([key, Model]) => ({
    key, run: (roomId, o) => Model.deleteMany({ roomId }, o),
  })),
  { key: "memberships",
    run: (roomId, o) => User.updateMany({ joinedRooms: roomId }, { $pull: { joinedRooms: roomId } }, o) },
];
/* ── helpers ── */
const isOwner = (room, userId) => !!room && !!room.admin && String(room.admin.userId) === String(userId);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normTag = (t) => String(t).replace(/^#+/, "").replace(/\s+/g, " ").trim();
const editableOf = (r) => ({
  roomName: r.roomName || "",
  description: r.description || "",
  tags: Array.isArray(r.tags) ? r.tags.slice() : [],
  isPublic: r.isPublic !== false,
  maxParticipants: r.maxParticipants,
});
/** What the dashboard card + edit modal need — nothing more. */
function toCard(r) {
  return {
    roomId: r.roomId,
    roomName: r.roomName,
    description: r.description || "",
    roomType: r.roomType,
    isPublic: r.isPublic !== false,
    maxParticipants: r.maxParticipants,
    tags: r.tags || [],
    thumbnail: r.thumbnail || null,
    status: r.status || "active",
    admin: r.admin ? { userId: String(r.admin.userId), username: r.admin.username } : null,
    participants: (r.participants || []).map((p) => ({ userId: String(p.userId), username: p.username })),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
/** Validates ONLY the keys present in `body`. Same rules as the in-room form. */
function validateRoomPatch(body, room) {
  const errors = {}, patch = {};
  if ("roomName" in body) {
    const v = typeof body.roomName === "string" ? body.roomName.replace(/\s+/g, " ").trim() : "";
    if (v.length < RULES.nameMin || v.length > RULES.nameMax) {
      errors.roomName = `Room name must be ${RULES.nameMin}–${RULES.nameMax} characters`;
    } else patch.roomName = v;
  }
  if ("description" in body) {
    const raw = body.description == null ? "" : body.description;
    if (typeof raw !== "string") errors.description = "Description must be text";
    else {
      const v = raw.trim();
      if (v.length > RULES.descMax) errors.description = `Description can be at most ${RULES.descMax} characters`;
      else patch.description = v;
    }
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags)) errors.tags = "Tags must be a list";
    else {
      const out = [], seen = new Set();
      for (const t of body.tags) {
        if (typeof t !== "string") continue;
        const v = normTag(t);
        if (!v) continue;
        if (v.length > RULES.tagMax) { errors.tags = `Tags can be at most ${RULES.tagMax} characters`; break; }
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
      }
      if (!errors.tags && out.length > RULES.tagsMax) errors.tags = `At most ${RULES.tagsMax} tags`;
      if (!errors.tags) patch.tags = out;
    }
  }
  if ("isPublic" in body) {
    if (typeof body.isPublic !== "boolean") errors.isPublic = "Visibility must be public or private";
    else patch.isPublic = body.isPublic;
  }
  if ("maxParticipants" in body) {
    const n = Number(body.maxParticipants);
    const here = (room.participants || []).length;
    const floor = Math.max(2, here);
    if (!Number.isInteger(n)) errors.maxParticipants = "Max participants must be a whole number";
    else if (n < floor) {
      errors.maxParticipants = here > 2
        ? `${here} people are in the room right now — the limit can't go below that`
        : "Rooms need space for at least 2 people";
    }
    else if (n > ROOM_CAP) errors.maxParticipants = `Rooms can't hold more than ${ROOM_CAP} people`;
    else patch.maxParticipants = n;
  }
  return { patch, errors };
}
/* ── read ── */
async function getRoomSettings({ roomId, userId }) {
  const room = await Room.findOne({ roomId }).lean();
  if (!room) return { status: 404, error: "Room not found" };
  if (!isOwner(room, userId)) return { status: 403, error: "Only the room's host can manage it here" };
  return { status: 200, room: toCard(room) };
}
/* ── edit ── */
async function updateRoomDetails({ roomId, userId, body }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "Expected a JSON object" };
  if ("roomType" in body) return { status: 400, error: "Room type can't be changed after creation" };
  const unknown = Object.keys(body).filter((k) => !EDITABLE.includes(k) && k !== "base");
  if (unknown.length) return { status: 400, error: "These fields can't be edited: " + unknown.join(", ") };
  const room = await Room.findOne({ roomId }).lean();
  if (!room) return { status: 404, error: "Room not found" };
  if (!isOwner(room, userId)) return { status: 403, error: "Only the room's host can edit it here" };
  const { patch, errors } = validateRoomPatch(body, room);
  if (Object.keys(errors).length) return { status: 422, error: Object.values(errors)[0], errors };
  const cur = editableOf(room);
  for (const k of Object.keys(patch)) if (same(patch[k], cur[k])) delete patch[k];
  /* field-level optimistic concurrency. `updatedAt` is useless here — playback
     sync bumps it every few seconds — so we compare only the fields being
     changed against what the editor saw when they opened the form. */
  const base = body.base && typeof body.base === "object" ? body.base : null;
  if (base) {
    const conflicts = Object.keys(patch).filter((k) => k in base && !same(cur[k], base[k]));
    if (conflicts.length) {
      return {
        status: 409,
        error: "Someone else changed this room while you were editing",
        conflicts, room: toCard(room),
      };
    }
  }
  const saved = Object.keys(patch);
  if (!saved.length) return { status: 200, room: toCard(room), saved };
  const updated = await Room.findOneAndUpdate(
    { roomId, "admin.userId": room.admin.userId },
    { $set: patch },
    { new: true, runValidators: true }
  ).lean();
  if (!updated) return { status: 404, error: "Room not found" };
  return { status: 200, room: toCard(updated), saved };
}
/** Tell people inside the room + write the audit receipt. */
function notifyRoomUpdated(io, room, saved, actor) {
  if (!saved || !saved.length) return;
  if (io) {
    const channel = String(room.roomId);
    io.to(channel).emit("room-updated", {
      room: { roomId: room.roomId, ...editableOf(room) },
      changed: saved,
      by: actor.username,
      source: "dashboard",
    });
    io.to(channel).emit("perm-notice", {
      text: `${actor.username} updated the room details`,
      byId: actor.userId,
    });
  }
  RoomEvent.create({
    roomId: room.roomId, kind: "room", action: "room.update",
    text: "{actor} updated the room details from the dashboard",
    detail: saved.map((k) => FIELD_LABEL[k]).join(", "),
    actorId: actor.userId, actorName: actor.username,
  }).catch((err) => console.warn("[room edit] audit log failed:", err.message));
}
/* ── delete ── */
async function deletePreview({ roomId, userId }) {
  const room = await Room.findOne({ roomId })
    .select("roomId roomName admin participants members bannedUsers queue tasks").lean();
  if (!room) return { status: 404, error: "Room not found" };
  if (!isOwner(room, userId)) return { status: 403, error: "Only the room's host can delete it" };
  const entries = await Promise.all(
    Object.entries(ROOM_SCOPED).map(async ([k, Model]) => [k, await Model.countDocuments({ roomId })]));
  return {
    status: 200,
    preview: {
      roomName: room.roomName,
      ...Object.fromEntries(entries),
      queue:   (room.queue || []).length,
      tasks:   (room.tasks || []).length,
      members: (room.members || []).length,
      banned:  (room.bannedUsers || []).length,
      online:  (room.participants || []).length,
    },
  };
}
const NO_TXN = (e) => !!e && (e.code === 20 || e.codeName === "IllegalOperation" ||
  /replica set|Transaction numbers/i.test(String(e.message)));
/** Runs `work(session)` in a transaction when the deployment supports it
 *  (Atlas / replica sets), otherwise `work(null)` — best effort + sweeper. */
async function withOptionalTransaction(work) {
  let session = null;
  try { session = await mongoose.startSession(); } catch (_) { return work(null); }
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } catch (err) {
    if (NO_TXN(err)) return work(null);
    throw err;
  } finally {
    session.endSession();
  }
}
async function deleteRoomCascade({ roomId, userId }) {
  const room = await Room.findOne({ roomId }).select("roomId roomName admin").lean();
  if (!room) return { status: 404, error: "Room not found" };
  if (!isOwner(room, userId)) return { status: 403, error: "Only the room's host can delete it" };
  const result = await withOptionalTransaction(async (session) => {
    const o = session ? { session } : {};
    // the room document goes FIRST: nobody can join / write into it from here on
    const gone = await Room.findOneAndDelete({ roomId, "admin.userId": room.admin.userId }, o);
    if (!gone) return null;
    const counts = {}, failures = [];
    for (const step of CASCADE) {
      try {
        const r = await step.run(roomId, o);
        counts[step.key] = (r && (r.deletedCount ?? r.modifiedCount)) || 0;
      } catch (err) {
        if (session) throw err;                       // inside a transaction → abort everything
        failures.push(step.key);
        console.error("[room delete] cascade step failed:", step.key, roomId, err);
      }
    }
    return { counts, failures };
  });
  if (!result) return { status: 404, error: "Room not found" };
  return { status: 200, roomId, roomName: room.roomName, deleted: result.counts, incomplete: result.failures };
}
/* ── live teardown (after the data is gone) ── */
let lk;
function voiceClient() {
  if (lk !== undefined) return lk;
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  lk = null;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return lk;
  try {
    const { RoomServiceClient } = require("livekit-server-sdk");
    lk = new RoomServiceClient(LIVEKIT_URL.replace(/^ws/, "http"), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  } catch (err) {
    console.warn("[room delete] livekit-server-sdk unavailable:", err.message);
  }
  return lk;
}
const voiceRoomName = (roomId) => String(roomId);   // ⚠ ADAPT to how your token endpoint names LiveKit rooms
async function teardownLiveRoom(io, roomId, actor) {
  const channel = String(roomId);                  // ⚠ same channel your sockets join()
  if (io) {
    io.to(channel).emit("room-deleted", { roomId: channel, byName: actor && actor.username });
    try { io.in(channel).socketsLeave(channel); } catch (_) {}
  }
  await runRoomDeleted(channel);
  const client = voiceClient();
  if (client) {
    try { await client.deleteRoom(voiceRoomName(channel)); }
    catch (err) { if (!/not.?found/i.test(String(err && err.message))) console.warn("[room delete] voice close failed:", err.message); }
  }
}
module.exports = {
  ROOM_CAP, RULES, ROOM_SCOPED, toCard, validateRoomPatch,
  getRoomSettings, updateRoomDetails, notifyRoomUpdated,
  deletePreview, deleteRoomCascade, teardownLiveRoom,
};