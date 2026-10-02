// middleware/perUserLimit.js — in-memory sliding window per user. Fine for one
// Node process; swap for express-rate-limit + a Redis store when you scale out.
"use strict";
function perUserLimit({ windowMs, max, message = "Too many requests" }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > windowMs) hits.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();
  return (req, res, next) => {
    const key = String((req.user && req.user.id) || req.ip);
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set("Retry-After", String(Math.ceil((windowMs - (now - arr[0])) / 1000)));
      return res.status(429).json({ error: message });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
module.exports = { perUserLimit };