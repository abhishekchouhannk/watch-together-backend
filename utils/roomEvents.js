// utils/roomEvents.js
const mongoose = require("mongoose");
const RoomEvent = require("../models/RoomEvent");
const PRESENCE_GRACE_MS = 15 * 1000;   // a leave + rejoin inside this window logs nothing
const pendingLeaves = new Map();       // "roomId:userId" → timeout
const HEX24 = /^[a-f\d]{24}$/i;
const oid  = (v) => (v && HEX24.test(String(v)) ? String(v) : null);
const clip = (s, n) => (s == null || s === "" ? null : String(s).slice(0, n));
/* accepts the socket `user` ({ id, username }), a member ({ userId, username }) or { id, name } */
const who  = (p) => (p ? { id: p.id || p.userId || p._id || null, name: p.username || p.name || null }
                       : { id: null, name: null });
function serializeEvent(e) {
  return {
    id:         String(e._id),
    kind:       e.kind,
    action:     e.action,
    text:       e.text,
    detail:     e.detail || null,
    actorId:    e.actorId ? String(e.actorId) : null,
    actorName:  e.actorName || null,
    targetId:   e.targetId ? String(e.targetId) : null,
    targetName: e.targetName || null,
    meta:       e.meta || null,
    at:         e.createdAt,
  };
}
/**
 * Persist a receipt and broadcast it live. Never throws — a logging failure must
 * never break the action being logged, so callers don't need to await it.
 *   ev   = { kind, action, text, detail?, actor?, target?, meta? }
 *   opts = { _id?, at? }   (backdating, used by the presence grace timer)
 */
async function logRoomEvent(io, roomId, ev = {}, opts = {}) {
  if (!roomId || !ev.action || !ev.text) return null;
  const a = who(ev.actor), t = who(ev.target);
  try {
    const doc = {
      roomId,
      kind:       RoomEvent.KINDS.includes(ev.kind) ? ev.kind : "other",
      action:     clip(ev.action, 64),
      text:       clip(ev.text, 300),
      detail:     clip(ev.detail, 200),
      actorId:    oid(a.id),
      actorName:  clip(a.name, 64),
      targetId:   oid(t.id),
      targetName: clip(t.name, 64),
      meta:       ev.meta,
    };
    if (opts._id) doc._id = opts._id;
    if (opts.at)  doc.createdAt = opts.at;
    const saved = await RoomEvent.create(doc);
    const out = serializeEvent(saved);
    if (io) io.to(roomId).emit("sys-event", out);
    return out;
  } catch (err) {
    console.error("[roomEvents] log failed:", err.message);
    return null;
  }
}
/* plain-text rendering for the legacy ephemeral 'chat-system' line */
function renderPlain(ev) {
  const a = who(ev.actor), t = who(ev.target);
  return String(ev.text || "").replace(/\{(actor|target|detail)\}/g, (_, k) =>
    k === "actor" ? (a.name || "Someone") : k === "target" ? (t.name || "someone") : (ev.detail || ""));
}
/** Drop-in replacement for io.to(roomId).emit("chat-system", { text, byId }):
 *  same ephemeral notice for everyone + a stored receipt. `extra` is merged
 *  into the chat-system payload if your client reads more fields (e.g. cls). */
function announce(io, roomId, ev, extra = {}) {
  const a = who(ev.actor);
  io.to(roomId).emit("chat-system", { text: renderPlain(ev), byId: a.id ? String(a.id) : null, ...extra });
  return logRoomEvent(io, roomId, ev);
}
/* ── presence: coalesce refreshes / reconnects so the transcript stays readable ── */
function logJoin(io, roomId, user) {
  const key = roomId + ":" + who(user).id;
  const pending = pendingLeaves.get(key);
  if (pending) {                                   // came back within the grace window → no "left"/"joined" pair
    clearTimeout(pending);
    pendingLeaves.delete(key);
    return Promise.resolve(null);
  }
  return logRoomEvent(io, roomId, { kind: "presence", action: "user.join", actor: user, text: "{actor} joined" });
}
function logLeave(io, roomId, user) {
  const key = roomId + ":" + who(user).id;
  clearTimeout(pendingLeaves.get(key));
  /* allocate the id NOW so the receipt sorts at the real leave time, not 15s later */
  const _id = new mongoose.Types.ObjectId();
  const at  = new Date();
  pendingLeaves.set(key, setTimeout(() => {
    pendingLeaves.delete(key);
    logRoomEvent(io, roomId,
      { kind: "presence", action: "user.leave", actor: user, text: "{actor} left" },
      { _id, at });
  }, PRESENCE_GRACE_MS));
}
module.exports = { logRoomEvent, announce, logJoin, logLeave, serializeEvent, renderPlain };