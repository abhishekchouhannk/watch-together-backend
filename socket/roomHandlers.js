// socket/roomHandlers.js
const crypto = require("crypto");

// models
const Room = require("../models/Room");
const Message = require("../models/Message");
const User = require("../models/User");
const {
  ROOM_CAP, MODE_VALUES, validId, sameId, isAdmin, isMod, getMember, ensureMember,
  isBanned, canSync, canChangeVideo, canModerate, canEditRoom, canGrantSync, canSetRoles,
  canBan, serializeMembers, sanitizeRoomPatch, sameValue, resolvePerms, canQueue, canGrantQueue, SCOPES, isScope,
} = require("../utils/roomConfigAndPermissions");

const recentKicks = new Map();                       // "roomId:userId" → expiry ms
const KICK_COOLDOWN = 10000;

const MAX_QUEUE   = 100;
const YT_RE       = /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;
const advanceLock = new Map();              // roomId → ts; de-dupes concurrent "video-ended" reports
const newItemId = () => crypto.randomBytes(8).toString("hex");
function validUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && u.length <= 2048; }
  catch (_) { return false; }
}
async function fetchJSON(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch (_) { return null; }
  finally { clearTimeout(t); }
}
function iso8601ToSec(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
/* Metadata is resolved HERE, never trusted from the client. */
async function resolveMeta(url) {
  const m = url.match(YT_RE);
  if (m) {
    const id = m[1];
    const o = await fetchJSON("https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    let duration = 0;
    if (process.env.YT_API_KEY) {                       // optional: gives us runtimes
      const d = await fetchJSON("https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=" +
        id + "&key=" + process.env.YT_API_KEY);
      duration = iso8601ToSec(d?.items?.[0]?.contentDetails?.duration);
    }
    return {
      type: "youtube", videoId: id,
      title:  (o?.title || "YouTube video").slice(0, 300),
      author: (o?.author_name || "YouTube").slice(0, 120),
      thumb:  o?.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      duration,
    };
  }
  let title = "Video";
  try { title = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "Video"; } catch (_) {}
  return { type: "direct", videoId: null, title: title.slice(0, 300), author: "Direct link", thumb: "", duration: 0 };
}
const serializeQueue = (room) => ({
  items: (room.queue || []).map((i) => ({
    id: i.itemId, url: i.url, type: i.type, videoId: i.videoId,
    title: i.title, author: i.author, thumb: i.thumb, duration: i.duration || 0,
    addedBy: i.addedBy ? i.addedBy.toString() : null, addedByName: i.addedByName || "",
  })),
  index:    typeof room.queueIndex === "number" ? room.queueIndex : -1,
  autoplay: room.settings?.autoplay !== false,
});
/* make queue[idx] the room's current video */
function applyCurrent(room, idx, play) {
  const it = room.queue[idx];
  room.queueIndex = idx;
  it.playedAt = new Date();
  room.video = {
    url: it.url, itemId: it.itemId, title: it.title, thumb: it.thumb,
    duration: it.duration || 0, currentTime: 0, isPlaying: !!play, updatedAt: new Date(),
  };
  return it;
}
function emitLoad(io, roomId, it, by, play) {
  io.to(roomId).emit("video-load", {
    url: it.url, itemId: it.itemId, title: it.title, thumb: it.thumb,
    by: by || null, play: !!play, startAt: 0,
  });
}
const findItem = (room, id) => (room.queue || []).findIndex((i) => i.itemId === id);
const sysMsg = (io, roomId, text) => io.to(roomId).emit("chat-system", { text });

function serializeRoom(room) {
  const v = room.video || {};
  let currentTime = v.currentTime || 0;
  if (v.isPlaying && v.updatedAt) {
    currentTime += (Date.now() - new Date(v.updatedAt).getTime()) / 1000;
  }
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    description: room.description,
    mode: room.mode,
    status: room.status,
    isPublic: room.isPublic,
    maxParticipants: room.maxParticipants,
    tags: room.tags,
    settings: {
      syncMode: room.settings?.syncMode || "host",
      queueMode: room.settings?.queueMode || "host",
      autoplay:  room.settings?.autoplay !== false,
      whoCanChangeVideo: room.settings?.whoCanChangeVideo || "host",
    },
    admin: room.admin ? { userId: room.admin.userId, username: room.admin.username } : null,
    video: { url: v.url || null, itemId: v.itemId || null, title: v.title || null,
             thumb: v.thumb || null, currentTime, isPlaying: !!v.isPlaying },
    queue: serializeQueue(room),
    participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
  };
}
/* ── permission plumbing ───────────────────────────────── */
function permPayload(room, uid) {
  const perms = resolvePerms(room, uid);
  const reqs = [];
  if (perms.canGrantSync || perms.canGrantQueue) {
    (room.members || []).forEach((m) => {
      if (perms.canGrantSync  && m.syncRequest  === "pending")
        reqs.push({ userId: m.userId.toString(), username: m.username, scope: "sync" });
      if (perms.canGrantQueue && m.queueRequest === "pending")
        reqs.push({ userId: m.userId.toString(), username: m.username, scope: "queue" });
    });
  }
  return {
    perms,
    members: serializeMembers(room, perms.canManage),
    requests: reqs,
    banned: perms.canBan ? (room.bannedUsers || []).map((b) => ({
      userId: b.userId.toString(), username: b.username,
      reason: b.reason || "", by: b.bannedByName || "", bannedAt: b.bannedAt,
    })) : [],
  };
}
/* push fresh perms to every socket in the room + refresh their cache */
async function broadcastPermissions(io, roomId, room) {
  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const uid = s.data.user && s.data.user.id;
    if (!uid) continue;
    const payload = permPayload(room, uid);
    s.data.perm = payload.perms;                  // cache → no DB read per video event
    s.emit("room-permissions", payload);
  }
}
async function socketsOfUser(io, roomId, userId) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.user && sameId(s.data.user.id, userId));
}

async function moderatorSockets(io, roomId, room) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.filter((s) => s.data.user && canModerate(room, s.data.user.id));
}

async function toUser(io, roomId, userId, event, payload) {
  (await socketsOfUser(io, roomId, userId)).forEach((s) => s.emit(event, payload));
}
/* authoritative video state, used to snap a rule-breaker back into place */
function liveVideoState(room) {
  const v = room.video || {};
  let t = v.currentTime || 0;
  if (v.isPlaying && v.updatedAt) t += (Date.now() - new Date(v.updatedAt).getTime()) / 1000;
  return { currentTime: t, isPlaying: !!v.isPlaying };
}
async function handleLeave(io, socket) {
  const roomId = socket.data.roomId;
  const user = socket.data.user;
  if (!roomId || !user) return;
  const socketsInRoom = await io.in(roomId).fetchSockets();
  const stillConnectedElsewhere = socketsInRoom.some(
    (s) => s.id !== socket.id && s.data.user && s.data.user.id === user.id,
  );
  socket.leave(roomId);
  socket.data.roomId = null;
  if (stillConnectedElsewhere) return;
  const room = await Room.findOne({ roomId });
  if (!room) return;
  // NOTE: we prune `participants` (presence) but NEVER `members` (permissions persist)
  room.participants = room.participants.filter((p) => !(p.userId && p.userId.toString() === user.id));
  if (room.participants.length === 0 && room.status === "active") room.status = "idle";
  if (room.participants.length === 0) advanceLock.delete(roomId);
  await room.save();
  io.to(roomId).emit("participants-update", {
    participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
    count: room.participants.length,
  });
  io.to(roomId).emit("user-left", { username: user.username });
}
/* a kick must survive the client's auto-reconnect for a few seconds,
   otherwise a reconnecting socket walks straight back in */
const kickKey = (roomId, uid) => roomId + ":" + uid;
function markKicked(roomId, uid) {
  recentKicks.set(kickKey(roomId, uid), Date.now() + KICK_COOLDOWN);
}
function kickCooldownLeft(roomId, uid) {
  const until = recentKicks.get(kickKey(roomId, uid));
  if (!until) return 0;
  if (Date.now() > until) { recentKicks.delete(kickKey(roomId, uid)); return 0; }
  return until - Date.now();
}
/* boot every socket this user has in the room, prune presence (caller saves) */
async function evictUser(io, roomId, room, userId, reason, message) {
  const sockets = await io.in(roomId).fetchSockets();
  const mine = sockets.filter((s) => s.data.user && sameId(s.data.user.id, userId));
  for (const s of mine) {
    s.emit("room-kicked", { reason, message, roomId });   // client stashes a toast + redirects
    s.leave(roomId);                                      // no further room traffic reaches them
    s.data.roomId = null;
    s.data.perm = null;
    setTimeout(() => { try { s.disconnect(true); } catch (_) {} }, 1000); // in case their JS is dead
  }
  const before = room.participants.length;
  room.participants = room.participants.filter((p) => !sameId(p.userId, userId));
  if (room.participants.length === 0 && room.status === "active") room.status = "idle";
  return { wasPresent: before !== room.participants.length, sockets: mine.length };
}
const presencePayload = (room) => ({
  participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
  count: room.participants.length,
});
module.exports = function registerRoomHandlers(io, socket) {
  const user = socket.data.user;
  socket.on("join-room", async ({ roomId }) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return socket.emit("room-error", { message: "Room not found" });

      if (isBanned(room, user.id)) {
        return socket.emit("room-error", {
          message: "You've been banned from this room",
          code: "banned", fatal: true,
        });
      }
      const cool = kickCooldownLeft(roomId, user.id);
      if (cool > 0) {
        return socket.emit("room-error", {
          message: `You were just removed from this room — try again in ${Math.ceil(cool / 1000)}s`,
          code: "kicked", fatal: true,
        });
      }
      socket.join(roomId);
      socket.data.roomId = roomId;
      const alreadyIn = room.participants.some((p) => p.userId && p.userId.toString() === user.id);
      let isNewParticipant = false;
      if (!alreadyIn) {
        if (room.participants.length >= room.maxParticipants) {
          socket.emit("room-error", { message: "Room is full" });
          socket.leave(roomId);
          socket.data.roomId = null;
          return;
        }
        room.participants.push({ userId: user.id, username: user.username, joinedAt: new Date() });
        if (room.status === "idle") room.status = "active";
        isNewParticipant = true;
      }
      ensureMember(room, user);                         // ← persistent permission record
      /* legacy room that has a video but no queue → seed the queue with it */
      if ((!room.queue || !room.queue.length) && room.video && room.video.url) {
        const meta = await resolveMeta(room.video.url);
        room.queue = [{
          itemId: newItemId(), url: room.video.url, ...meta,
          addedBy: room.admin.userId, addedByName: room.admin.username, addedAt: new Date(),
          playedAt: new Date(),
        }];
        room.queueIndex = 0;
        room.video.itemId = room.queue[0].itemId;
        room.video.title  = room.queue[0].title;
        room.video.thumb  = room.queue[0].thumb;
      }
      if (room.isModified()) await room.save();
      if (isNewParticipant) {
        await User.updateOne({ _id: user.id }, { $addToSet: { joinedRooms: roomId } });
      }
      socket.data.perm = resolvePerms(room, user.id);
      socket.emit("room-state", { room: serializeRoom(room), perms: socket.data.perm });
      io.to(roomId).emit("participants-update", {
        participants: room.participants.map((p) => ({ userId: p.userId, username: p.username })),
        count: room.participants.length,
      });
      await broadcastPermissions(io, roomId, room);     // roster/badges for everyone (incl. admin)
      if (isNewParticipant) socket.to(roomId).emit("user-joined", { username: user.username });
    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("room-error", { message: "Failed to join room" });
    }
  });
  socket.on("chat-message", async ({ text }) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const clean = (text || "").trim().slice(0, 500);
      if (!clean) return;
      const msg = await Message.create({ roomId, senderId: user.id, senderName: user.username, message: clean });
      io.to(roomId).emit("chat-message", {
        id: msg._id.toString(), senderId: user.id, username: user.username,
        text: clean, timestamp: msg.timestamp,
      });
    } catch (err) { console.error("chat-message error:", err); }
  });
  /* ═══════════════ VIDEO SYNC (permission-gated) ═══════════════ */
  async function denySync(action) {
    const roomId = socket.data.roomId;
    const room = await Room.findOne({ roomId }).lean();
    socket.emit("perm-denied", {
      action,
      message: action === "queue"
        ? "You don't have queue control in this room"
        : "You don't have playback control in this room",
      video: room ? liveVideoState(room) : null,
    });
  }
  const maySync = () => !!(socket.data.perm && socket.data.perm.canSync);
  const mayLoad = () => !!(socket.data.perm && socket.data.perm.canChangeVideo);
  socket.on("video-play", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!maySync()) return denySync("play");
    await Room.updateOne({ roomId }, { $set: {
      "video.isPlaying": true, "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-play", { currentTime, by: user.username });
  });
  socket.on("video-pause", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!maySync()) return denySync("pause");
    await Room.updateOne({ roomId }, { $set: {
      "video.isPlaying": false, "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-pause", { currentTime, by: user.username });
  });
  socket.on("video-seek", async ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (!maySync()) return denySync("seek");
    await Room.updateOne({ roomId }, { $set: {
      "video.currentTime": currentTime, "video.updatedAt": new Date(),
    }});
    socket.to(roomId).emit("video-seek", { currentTime, by: user.username });
  });
  /* drift correction — only controllers may drive the clock
     (these three were MISSING before: the client emits them, nobody relayed them) */
  socket.on("video-time-sync", ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !maySync()) return;
    socket.to(roomId).emit("video-time-sync", { currentTime });
  });
  socket.on("video-sync-request", () => {                        // late joiner asks peers
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("video-sync-request", { requesterId: socket.id });
  });
  socket.on("video-sync-response", ({ requesterId, currentTime, isPlaying }) => {
    if (!socket.data.roomId || !requesterId) return;
    io.to(requesterId).emit("video-sync-state", { currentTime, isPlaying });
  });
  /* ═══════════════ PERMISSIONS ═══════════════ */
  /* generic gate: `check(room, uid)` decides, `msg` is the rejection toast */
  function guarded(check, msg, fn) {
    return async (...args) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = await Room.findOne({ roomId });
      if (!room) return;
      if (!check(room, user.id)) {
        return socket.emit("perm-toast", { message: msg, type: "error" });
      }
      try {
        await fn(room, roomId, ...args);
      } catch (err) {
        console.error("privileged action failed:", err);
        socket.emit("perm-toast", { message: "Something went wrong — try again", type: "error" });
      }
    };
  }
  
  const adminAction = (fn) => guarded(isAdmin, "Only the host can do that", fn);
  const modAction   = (fn) => guarded(canModerate, "Only the host and moderators can do that", fn);
  
  socket.on("perm-set-mode", modAction(async (room, roomId, { mode } = {}) => {
    if (!["host", "everyone"].includes(mode)) return;
    if (room.settings.syncMode === mode) return;
    room.settings.syncMode = mode;
    await room.save();
    await broadcastPermissions(io, roomId, room);
    io.to(roomId).emit("perm-notice", {
      text: mode === "everyone"
        ? "Everyone can now control playback"
        : "Playback control is now host-only",
    });
  }));
  /* accepts { userId, scope:'sync'|'queue' } — scope defaults to 'sync' (old clients) */
  socket.on("perm-grant", modAction(async (room, roomId, { userId, scope = "sync" } = {}) => {
    if (!isScope(scope)) return;
    const S = SCOPES[scope];
    if (!S.grantedBy(room, user.id)) return;
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === "mod") return;    // implicit already
    if (m[S.grant]) return;
    m[S.grant] = true; m[S.req] = "none"; m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", { message: `You can now use ${S.label} 🎉`, type: "success" });
    io.to(roomId).emit("perm-notice", { text: `${m.username} can now use ${S.label}` });
  }));

  socket.on("perm-revoke", modAction(async (room, roomId, { userId, scope = "sync" } = {}) => {
    if (!isScope(scope)) return;
    const S = SCOPES[scope];
    if (!S.grantedBy(room, user.id)) return;
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === "mod") return;
    m[S.grant] = false; m[S.req] = "denied"; m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", { message: `Your ${S.label} was removed`, type: "error" });
  }));
  /* role changes: HOST ONLY */
  socket.on("perm-set-role", adminAction(async (room, roomId, { userId, role } = {}) => {
    if (!["mod", "member"].includes(role)) return;
    const m = getMember(room, userId);
    if (!m || isAdmin(room, userId) || m.role === role) return;
    m.role = role;
    if (role === "mod") { m.syncRequest = "none"; m.canSync = true; } // implicit anyway; keeps it true on demote-back
    m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);                    // ← this is what flips their UI live
    await toUser(io, roomId, userId, "perm-toast", {
      message: role === "mod"
        ? "You're now a moderator — you can edit the room and grant playback control"
        : "You're no longer a moderator",
      type: role === "mod" ? "success" : "error",
    });
    io.to(roomId).emit("perm-notice", {
      text: role === "mod" ? `${m.username} is now a moderator` : `${m.username} is no longer a moderator`,
    });
  }));
  /* ═══════════════ ROOM DETAILS ═══════════════ */
  socket.on("room-update", modAction(async (room, roomId, payload = {}) => {
    if (!canEditRoom(room, user.id)) return;   // belt & braces
    const { patch, errors } = sanitizeRoomPatch(room, payload);
    if (errors.length) return socket.emit("perm-toast", { message: errors[0], type: "error" });
    const changed = Object.keys(patch).filter((k) => !sameValue(room[k], patch[k]));
    if (!changed.length) return socket.emit("perm-toast", { message: "Nothing to save", type: "info" });
    changed.forEach((k) => { room[k] = patch[k]; });
    await room.save();   // schema validators (enum/maxlength) run here; guarded() catches throws
    const updatedRoom = serializeRoom(room);
    socket.emit("room-saved", { room: updatedRoom, changed });                               // the editor
    socket.to(roomId).emit("room-updated", { room: updatedRoom, by: user.username, changed }); // everyone else
    socket.emit("perm-toast", { message: "Room details saved ✅", type: "success" });
    socket.to(roomId).emit("perm-notice", { text: `${user.username} updated the room details` });
  }));
  /* participant asks the host/mod for playback control */
  socket.on("perm-request", async ({ scope = "sync" } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isScope(scope)) return;
    const S = SCOPES[scope];
    const now = Date.now();
    socket.data.lastPermReq = socket.data.lastPermReq || {};
    if (now - (socket.data.lastPermReq[scope] || 0) < 15000) return;
    socket.data.lastPermReq[scope] = now;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    if (S.can(room, user.id))
      return socket.emit("perm-toast", { message: `You already have ${S.label}`, type: "success" });
    const m = ensureMember(room, user);
    if (m[S.req] === "denied")
      return socket.emit("perm-toast", {
        message: "Your request was declined — a host or mod has to grant it from room settings", type: "error" });
    const targets = await moderatorSockets(io, roomId, room);
    if (!targets.length)
      return socket.emit("perm-toast", { message: "No host or moderator is in the room right now", type: "error" });
    if (m[S.req] !== "pending") { m[S.req] = "pending"; m.updatedAt = new Date(); await room.save(); }
    targets.forEach((s) => s.emit("perm-request", { userId: user.id, username: user.username, scope }));
    socket.emit("perm-toast", { message: "Request sent ✌️", type: "success" });
    await broadcastPermissions(io, roomId, room);
  });
  socket.on("perm-respond", modAction(async (room, roomId, { userId, approve, scope = "sync" } = {}) => {
    if (!isScope(scope)) return;
    const S = SCOPES[scope];
    if (!S.grantedBy(room, user.id)) return;
    const m = getMember(room, userId);
    if (!m || m[S.req] !== "pending") return;
    m[S.grant] = !!approve;
    m[S.req]   = approve ? "none" : "denied";
    m.updatedAt = new Date();
    await room.save();
    await broadcastPermissions(io, roomId, room);
    await toUser(io, roomId, userId, "perm-toast", {
      message: approve ? `${user.username} gave you ${S.label} 🎉` : "Your request was declined",
      type: approve ? "success" : "error",
    });
    if (approve) io.to(roomId).emit("perm-notice", { text: `${m.username} can now use ${S.label}` });
  }));
  socket.on("perm-set-queue-mode", modAction(async (room, roomId, { mode } = {}) => {
    if (!["host", "everyone"].includes(mode) || room.settings.queueMode === mode) return;
    room.settings.queueMode = mode;
    await room.save();
    await broadcastPermissions(io, roomId, room);
    io.to(roomId).emit("perm-notice", {
      text: mode === "everyone" ? "Everyone can now manage the queue" : "Queue control is now host-only",
    });
  }));
  /* ═══════════════ MEMBER MODERATION (host only) ═══════════════ */
  /* resolve a display name even if the member record is already gone */
  function nameOf(room, userId) {
    const m = getMember(room, userId);
    if (m && m.username) return m.username;
    const p = room.participants.find((x) => sameId(x.userId, userId));
    if (p && p.username) return p.username;
    const b = (room.bannedUsers || []).find((x) => sameId(x.userId, userId));
    return (b && b.username) || "That user";
  }
  /* shared target validation for all three destructive actions */
  function badTarget(room, userId) {
    if (!validId(userId)) return "Unknown user";
    if (sameId(userId, user.id)) return "You can't do that to yourself";
    if (isAdmin(room, userId))   return "The host can't be removed";
    return null;
  }
  /* KICK — boot from this session; membership + permissions survive, they may rejoin */
  socket.on("member-kick", adminAction(async (room, roomId, { userId } = {}) => {
    const bad = badTarget(room, userId);
    if (bad) return socket.emit("perm-toast", { message: bad, type: "error" });
    const name = nameOf(room, userId);
    const { wasPresent } = await evictUser(
      io, roomId, room, userId, "kick",
      `${user.username} removed you from “${room.roomName}”. You can rejoin in a moment.`
    );
    if (!wasPresent) return socket.emit("perm-toast", { message: `${name} isn't in the room right now`, type: "error" });
    markKicked(roomId, userId);
    await room.save();
    io.to(roomId).emit("participants-update", presencePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was kicked from the room` });
    socket.emit("perm-toast", { message: `${name} was kicked`, type: "success" });
    await broadcastPermissions(io, roomId, room);
  }));
  /* REMOVE — delete the member record (role, grants, request state) + boot; rejoining is allowed */
  socket.on("member-remove", adminAction(async (room, roomId, { userId } = {}) => {
    const bad = badTarget(room, userId);
    if (bad) return socket.emit("perm-toast", { message: bad, type: "error" });
    if (!getMember(room, userId)) return socket.emit("perm-toast", { message: "They're not a member of this room", type: "error" });
    const name = nameOf(room, userId);
    await evictUser(io, roomId, room, userId, "removed",
      `${user.username} removed you from “${room.roomName}”.`);
    room.members = room.members.filter((m) => !sameId(m.userId, userId));
    markKicked(roomId, userId);
    await room.save();
    await User.updateOne({ _id: userId }, { $pull: { joinedRooms: roomId } });
    io.to(roomId).emit("participants-update", presencePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was removed from the room` });
    socket.emit("perm-toast", { message: `${name} was removed`, type: "success" });
    await broadcastPermissions(io, roomId, room);
  }));
  /* BAN — remove + blocklist; rejoining is impossible until unbanned */
  socket.on("member-ban", adminAction(async (room, roomId, { userId, reason } = {}) => {
    const bad = badTarget(room, userId);
    if (bad) return socket.emit("perm-toast", { message: bad, type: "error" });
    const name = nameOf(room, userId);
    if (isBanned(room, userId)) return socket.emit("perm-toast", { message: `${name} is already banned`, type: "error" });
    await evictUser(io, roomId, room, userId, "banned",
      `You were banned from “${room.roomName}” by ${user.username}.`);
    room.members = room.members.filter((m) => !sameId(m.userId, userId));
    room.bannedUsers.push({
      userId, username: name,
      bannedBy: user.id, bannedByName: user.username,
      reason: String(reason || "").trim().slice(0, 140),
      bannedAt: new Date(),
    });
    await room.save();
    await User.updateOne({ _id: userId }, { $pull: { joinedRooms: roomId } });
    io.to(roomId).emit("participants-update", presencePayload(room));
    io.to(roomId).emit("perm-notice", { text: `${name} was banned from the room` });
    socket.emit("perm-toast", { message: `${name} was banned`, type: "success" });
    await broadcastPermissions(io, roomId, room);
  }));
  /* UNBAN */
  socket.on("member-unban", adminAction(async (room, roomId, { userId } = {}) => {
    if (!validId(userId)) return;
    const b = (room.bannedUsers || []).find((x) => sameId(x.userId, userId));
    if (!b) return;
    const name = b.username || "They";
    room.bannedUsers = room.bannedUsers.filter((x) => !sameId(x.userId, userId));
    recentKicks.delete(kickKey(roomId, userId));
    await room.save();
    await broadcastPermissions(io, roomId, room);
    socket.emit("perm-toast", { message: `${name} can join again`, type: "success" });
  }));

  /* ═══════════════ QUEUE ═══════════════ */
  const queueAction = (fn) => guarded(canQueue, "You don't have queue control in this room", fn);
  function rateLimited(key, max, windowMs) {
    const now = Date.now();
    const rl = socket.data[key] || (socket.data[key] = { n: 0, reset: now + windowMs });
    if (now > rl.reset) { rl.n = 0; rl.reset = now + windowMs; }
    return ++rl.n > max;
  }
  socket.on("queue-add", queueAction(async (room, roomId, { url } = {}) => {
    url = String(url || "").trim();
    if (!validUrl(url))
      return socket.emit("perm-toast", { message: "That doesn't look like a valid URL", type: "error" });
    if ((room.queue || []).length >= MAX_QUEUE)
      return socket.emit("perm-toast", { message: `Queue is full (${MAX_QUEUE} videos max)`, type: "error" });
    if (rateLimited("qRL", 10, 10000))
      return socket.emit("perm-toast", { message: "Slow down a little ✋", type: "error" });
    const meta = await resolveMeta(url);
    const item = Object.assign({
      itemId: newItemId(), url,
      addedBy: user.id, addedByName: user.username, addedAt: new Date(),
    }, meta);
    room.queue.push(item);
    /* first video in an empty room → make it current (paused; someone presses play) */
    const startNow = room.queueIndex < 0 && !(room.video && room.video.url);
    if (startNow) applyCurrent(room, room.queue.length - 1, false);
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
    sysMsg(io, roomId, `${user.username} added “${item.title}” to the queue`);
    if (startNow) emitLoad(io, roomId, room.queue[room.queueIndex], user.username, false);
  }));
  socket.on("queue-remove", queueAction(async (room, roomId, { id } = {}) => {
    const i = findItem(room, id);
    if (i < 0) return;
    const [gone] = room.queue.splice(i, 1);
    if (i < room.queueIndex) room.queueIndex--;
    else if (i === room.queueIndex) room.queueIndex = -1;   // keep playing, just detach
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
    sysMsg(io, roomId, `${user.username} removed “${gone.title}” from the queue`);
  }));
  socket.on("queue-move", queueAction(async (room, roomId, { id, to } = {}) => {
    const from = findItem(room, id);
    to = parseInt(to, 10);
    if (from < 0 || !Number.isInteger(to) || to < 0 || to >= room.queue.length || from === to) return;
    const curId = room.queueIndex >= 0 ? room.queue[room.queueIndex].itemId : null;
    const [it] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, it);
    if (curId) room.queueIndex = findItem(room, curId);      // index follows the playing item
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
  }));
  socket.on("queue-clear", queueAction(async (room, roomId) => {
    const cur = room.queueIndex >= 0 ? room.queue[room.queueIndex] : null;
    room.queue = cur ? [cur] : [];
    room.queueIndex = cur ? 0 : -1;
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
    sysMsg(io, roomId, `${user.username} cleared the queue`);
  }));
  /* play a specific item (also powers the prev/next buttons) */
  socket.on("queue-play", queueAction(async (room, roomId, { id } = {}) => {
    const i = findItem(room, id);
    if (i < 0) return;
    const it = applyCurrent(room, i, true);
    advanceLock.set(roomId, Date.now());                     // suppress a stale "ended" from the old video
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
    emitLoad(io, roomId, it, user.username, true);
    sysMsg(io, roomId, `${user.username} started “${it.title}”`);
  }));
  socket.on("queue-autoplay", queueAction(async (room, roomId, { on } = {}) => {
    const v = !!on;
    if (room.settings.autoplay === v) return;
    room.settings.autoplay = v;
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
    io.to(roomId).emit("perm-notice", { text: `${user.username} turned autoplay ${v ? "on" : "off"}` });
  }));
  /* a controller learned the real runtime — cache it so everyone sees it */
  socket.on("queue-duration", async ({ id, duration } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !maySync()) return;
    const d = Number(duration);
    if (!isFinite(d) || d <= 0 || d > 86400) return;
    const room = await Room.findOne({ roomId });
    const i = room ? findItem(room, id) : -1;
    if (i < 0 || room.queue[i].duration) return;
    room.queue[i].duration = d;
    if (room.video && room.video.itemId === id) room.video.duration = d;
    await room.save();
    io.to(roomId).emit("queue-update", serializeQueue(room));
  });
  /* ── SERVER-AUTHORITATIVE AUTO-ADVANCE ──
     Any client may report the end; the lock means exactly one advance happens. */
  socket.on("video-ended", async ({ itemId } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (Date.now() - (advanceLock.get(roomId) || 0) < 3000) return;
    const room = await Room.findOne({ roomId });
    if (!room) return;
    const cur = room.queueIndex >= 0 ? room.queue[room.queueIndex] : null;
    if (!cur || (itemId && itemId !== cur.itemId)) return;              // stale / wrong video
    advanceLock.set(roomId, Date.now());
    const nextIdx = room.queueIndex + 1;
    if (room.settings.autoplay !== false && nextIdx < room.queue.length) {
      const it = applyCurrent(room, nextIdx, true);
      await room.save();
      io.to(roomId).emit("queue-update", serializeQueue(room));
      emitLoad(io, roomId, it, null, true);
      sysMsg(io, roomId, `▶ Now playing “${it.title}”`);
    } else {
      room.video.isPlaying = false;
      room.video.updatedAt = new Date();
      await room.save();
      io.to(roomId).emit("video-pause", { currentTime: room.video.currentTime, by: null });
      io.to(roomId).emit("queue-ended", {});
    }
  });

  /* ═══════════════ REACTIONS (unchanged) ═══════════════ */
  const ALLOWED_REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👏", "💀"];
  const REACT_LIMIT = 8, REACT_WINDOW = 4000;
  socket.on("video-reaction", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    const now = Date.now();
    const rl = socket.data.reactRL || (socket.data.reactRL = { n: 0, reset: now + REACT_WINDOW });
    if (now > rl.reset) { rl.n = 0; rl.reset = now + REACT_WINDOW; }
    if (++rl.n > REACT_LIMIT) return;
    socket.to(roomId).emit("video-reaction", { emoji, userId: user.id, username: user.username, at: now });
  });
  socket.on("leave-room", () => handleLeave(io, socket));
  socket.on("disconnecting", () => handleLeave(io, socket));
};