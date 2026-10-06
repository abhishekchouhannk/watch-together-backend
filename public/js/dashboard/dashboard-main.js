/* public/js/dashboard/dashboard-main.js
 * ─────────────────────────────────────────────────────────────
 * DASHBOARD ENTRY — discovery + "my rooms", create / edit / delete, and
 * the same profile chip + modal the rooms use (shared/).
 *
 *   identity   host names + avatars on cards are live (data-name-uid /
 *              data-av-uid). Saving your profile here repaints instantly;
 *              other tabs push changes over BroadcastChannel; coming back
 *              to this tab re-syncs over REST. No sockets on this page.
 *   modules    room-form.js (create + edit modal), room-actions.js
 *              (⋯ / right-click menu + delete dialog), ui.js (helpers)
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { initRoomTypes, renderTypeChips, badgeHTML, typeMeta } from "../room-types.js";
import { initProfileUI, onMe, refreshProfile } from "../shared/profile-settings.js";
import { avatarHTML, nameOf, ensureIdentities, resyncIdentities } from "../shared/identity.js";
import { $, esc, toast, timeAgo, api } from "./ui.js";
import { createRoomForm, ROOM_CAP } from "./room-form.js";
import { wireRoomActions } from "./room-actions.js";

const RESYNC_MS = 20000;
const MORE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

const S = {
  myRooms: [], pubRooms: [],
  view: "public", type: "all", query: "",
  loading: true, userId: null, username: null, theme: null,
};
const dom = {
  search: $("searchInput"), grid: $("roomsGrid"), title: $("sectionTitle"),
  count: $("roomCount"), welcome: $("welcomeTitle"), filters: $("filters"),
};
let form = null, actions = null, navigating = false, lastSync = Date.now(), fetchSeq = 0;

boot();

async function boot() {
  initSky();
  renderTypeChips(dom.filters, { active: "", onPick: (id) => { S.type = id || "all"; render(); } });
  initRoomTypes();
  form = createRoomForm({
    onCreated: () => fetchRooms({ silent: true }),
    onSaved: applySavedRoom,
  });
  actions = wireRoomActions({
    grid: dom.grid,
    getRoom: findRoom,
    onEdit: (room, ret) => form.openEdit(room, ret),
    onDeleted: removeRoom,
  });
  wireEvents();
  drainNotice();
  onMe(paintMe);
  render();                                                  // skeleton right away
  await Promise.all([
    initProfileUI({
      chipHost: $("meChipHost"),
      root: $("dashboard"),
      onUnauthenticated: () => { location.href = "/"; },
    }),
    fetchRooms(),
  ]);
}

/* ---------- me ---------- */
function paintMe(u) {
  const first = S.userId !== u.id;
  S.userId = u.id;
  S.username = u.username;
  dom.welcome.innerHTML = 'Welcome back, <span data-name-uid="' + esc(u.id) + '">' + esc(u.username) + "</span>! 👋";
  if (first && !S.loading) render();                         // owner badges / ⋯ need my id
}

/* ---------- notices handed over from other pages (e.g. a deleted room) ---------- */
function drainNotice() {
  try {
    const raw = sessionStorage.getItem("wp:notice");
    if (!raw) return;
    sessionStorage.removeItem("wp:notice");
    const n = JSON.parse(raw);
    if (n && n.text) toast(n.text, n.type || "error");
  } catch (_) {}
}

/* ---------- sky ---------- */
function initSky() {
  if (window.SkyBackground && $("sky-root")) {
    S.theme = window.SkyBackground.start({
      root: "#sky-root",
      themeTarget: document.documentElement,
      intro: false,
      onThemeApplied(theme) { S.theme = theme; },
    });
    return;
  }
  S.theme = resolveTime();
  document.documentElement.setAttribute("data-theme", S.theme);
}
function resolveTime() {
  try { if (typeof getTimeOfDay === "function") return getTimeOfDay(); } catch (_) {}
  const h = new Date().getHours();
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

/* ---------- events ---------- */
function wireEvents() {
  let t = 0;
  dom.search.addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { S.query = e.target.value; render(); }, 220);
  });
  document.querySelectorAll(".toggle-btn").forEach((btn) => btn.addEventListener("click", () => {
    if (S.view === btn.dataset.view) return;
    S.view = btn.dataset.view;
    S.type = "all"; S.query = ""; dom.search.value = "";
    document.querySelectorAll(".toggle-btn").forEach((b) => {
      const on = b.dataset.view === S.view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    renderTypeChips(dom.filters, { active: "" });
    render();
  }));
  $("createBtn").addEventListener("click", () => form.openCreate($("createBtn")));
  $("logoutBtn").addEventListener("click", handleLogout);
  dom.grid.addEventListener("click", (e) => {
    if (e.target.closest(".card-more")) return;             // room-actions.js owns it
    const card = e.target.closest(".room-card");
    if (card && !card.classList.contains("is-removing")) go(card.dataset.rid);
  });
  /* no sockets here: re-sync when the user comes back to this tab */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - lastSync < RESYNC_MS) return;
    lastSync = Date.now();
    refreshProfile();
    resyncIdentities();
    fetchRooms({ silent: true });
  });
}

/* ---------- API ---------- */
async function fetchRooms({ silent = false } = {}) {
  const seq = ++fetchSeq;
  if (!silent) { S.loading = true; render(); }
  const get = (p) => api(p).catch((e) => { if (e.auth) throw e; return { rooms: null }; });
  try {
    const [mine, pub] = await Promise.all([get("/api/rooms/my-rooms"), get("/api/rooms/public")]);
    if (seq !== fetchSeq) return;
    if (!mine.rooms && !pub.rooms && !silent) toast("Failed to load rooms", "error");
    if (mine.rooms) S.myRooms = mine.rooms;
    if (pub.rooms) S.pubRooms = pub.rooms;
  } catch (e) {
    if (e.auth) return;
  } finally {
    if (seq === fetchSeq) { S.loading = false; render(); }
  }
}
async function handleLogout() {
  try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (_) {}
  location.href = "/";
}

/* ---------- state helpers ---------- */
const ridOf = (r) => String(r.roomId || r._id || "");
function findRoom(rid) {
  return S.myRooms.find((r) => ridOf(r) === rid) || S.pubRooms.find((r) => ridOf(r) === rid) || null;
}
function isOwned(r) {
  if (!r.admin) return false;
  if (S.userId) return String(r.admin.userId) === String(S.userId);
  return !!S.username && r.admin.username === S.username;
}
function applySavedRoom(room) {
  if (!room) return;
  const rid = ridOf(room);
  const patch = (list) => list.map((r) => (ridOf(r) === rid ? { ...r, ...room } : r));
  S.myRooms = patch(S.myRooms);
  S.pubRooms = patch(S.pubRooms).filter((r) => ridOf(r) !== rid || room.isPublic !== false);
  render();
  fetchRooms({ silent: true });                              // reconcile (e.g. a room that just went public)
}
function removeRoom(rid) {
  const drop = () => {
    S.myRooms = S.myRooms.filter((r) => ridOf(r) !== rid);
    S.pubRooms = S.pubRooms.filter((r) => ridOf(r) !== rid);
    render();
  };
  const card = dom.grid.querySelector('.room-card[data-rid="' + CSS.escape(rid) + '"]');
  if (!card) { drop(); return; }
  card.classList.add("is-removing");
  setTimeout(drop, 260);
}

/* ---------- filtering ---------- */
function filtered() {
  let list = S.view === "public" ? S.pubRooms : S.myRooms;
  if (S.type !== "all") list = list.filter((r) => r.roomType === S.type);
  const q = S.query.trim().toLowerCase();
  if (q) {
    list = list.filter((r) =>
      (r.roomName && r.roomName.toLowerCase().includes(q)) ||
      (r.description && r.description.toLowerCase().includes(q)) ||
      (r.tags && r.tags.some((t) => t.toLowerCase().includes(q))));
  }
  return list;
}

/* ---------- rendering ---------- */
function render() {
  if (actions) actions.closeMenu();
  dom.title.textContent = S.view === "public" ? "Discover Rooms" : "My Rooms";
  if (S.loading) { dom.grid.innerHTML = skeletons(8); dom.count.textContent = ""; return; }
  const rooms = filtered();
  dom.count.textContent = "(" + rooms.length + " room" + (rooms.length !== 1 ? "s" : "") + ")";
  if (!rooms.length) { dom.grid.innerHTML = emptyHTML(); return; }
  dom.grid.innerHTML = rooms.map(cardHTML).join("");
  ensureIdentities(rooms.map((r) => r.admin && r.admin.userId));
}

function cardHTML(r) {
  const rid = ridOf(r);
  const owned = isOwned(r);
  const tags = (r.tags || []).slice(0, 4);
  const status = r.status || "active";
  const label = S.view === "my" ? "Open" : "Join";
  const hostId = r.admin && r.admin.userId ? String(r.admin.userId) : "";
  const hostName = hostId ? nameOf(hostId, r.admin.username) : (r.admin && r.admin.username) || "";
  const when = timeAgo(r.createdAt);
  const host = hostName
    ? '<span class="card-host">' +
        (hostId ? avatarHTML({ uid: hostId, name: hostName, cls: "card-host-av" }) : "") +
        '<span class="card-host-name">by <span' + (hostId ? ' data-name-uid="' + esc(hostId) + '"' : "") + ">" +
          esc(hostName) + "</span></span>" +
      "</span>"
    : "";
  return '<div class="room-card" data-rid="' + esc(rid) + '"' + (owned ? ' data-owned="1"' : "") + ">" +
    (r.thumbnail
      ? '<div class="card-thumb"><img src="' + esc(r.thumbnail) + '" alt="" loading="lazy" onerror="this.parentElement.remove()"></div>'
      : "") +
    '<div class="card-top">' +
      '<div class="card-badges">' + badgeHTML(r.roomType) + (owned ? '<span class="owner-badge">👑 Owner</span>' : "") + "</div>" +
      '<div class="card-top-right">' +
        '<span class="member-count">' +
          '<span class="status-dot status-' + esc(status) + '" title="' + esc(status) + '"></span>' +
          "👥 " + (r.participants || []).length + "/" + (r.maxParticipants || ROOM_CAP) +
        "</span>" +
        (owned
          ? '<button type="button" class="card-more" aria-haspopup="menu" aria-expanded="false" ' +
              'title="Room actions" aria-label="Actions for ' + esc(r.roomName) + '">' + MORE_SVG + "</button>"
          : "") +
      "</div>" +
    "</div>" +
    '<h3 class="card-title">' + esc(r.roomName) + "</h3>" +
    (r.description ? '<p class="card-desc">' + esc(r.description) + "</p>" : "") +
    (tags.length ? '<div class="card-tags">' + tags.map((t) => '<span class="tag">#' + esc(t) + "</span>").join("") + "</div>" : "") +
    '<div class="card-footer">' +
      '<span class="card-meta">' + host +
        (host && when ? '<span class="card-dot">·</span>' : "") +
        (when ? "<span>" + esc(when) + "</span>" : "") +
      "</span>" +
      '<button type="button" class="join-btn">' + label + " →</button>" +
    "</div>" +
  "</div>";
}

function skeletons(n) {
  let h = "";
  while (n--) {
    h += '<div class="skel-card">' +
      '<div class="sk sk-badge"></div><div class="sk sk-title"></div>' +
      '<div class="sk sk-text"></div><div class="sk sk-text-s"></div>' +
      '<div class="sk-tags"><div class="sk sk-tag"></div><div class="sk sk-tag"></div></div>' +
      '<div class="sk-foot"><div class="sk sk-meta"></div><div class="sk sk-btn"></div></div>' +
    "</div>";
  }
  return h;
}
function emptyHTML() {
  let icon, msg;
  if (S.view === "my")          { icon = "🏠"; msg = "You haven't created or joined any rooms yet."; }
  else if (S.type !== "all")    { icon = "🔍"; msg = "No " + typeMeta(S.type).label + " rooms found."; }
  else if (S.query.trim())      { icon = "🔍"; msg = "No rooms match your search."; }
  else                          { icon = "📺"; msg = "No rooms available right now."; }
  return '<div class="empty-state"><div class="empty-icon">' + icon + "</div>" +
    '<p class="empty-title">' + esc(msg) + "</p>" +
    '<p class="empty-desc">Try a different search or filter, or create a room!</p></div>';
}

/* ---------- navigation ---------- */
async function go(rid) {
  if (!rid || navigating) return;
  navigating = true;
  try {
    const res = await fetch("/api/rooms/" + encodeURIComponent(rid), { credentials: "include" });
    if (res.status === 401) { location.href = "/"; return; }
    if (res.status === 403) {
      const d = await res.json().catch(() => ({}));
      toast(d.message || d.error || "You can't join this room", "error");
      fetchRooms({ silent: true });
      return;
    }
    if (res.status === 404) { toast("That room no longer exists", "error"); fetchRooms({ silent: true }); return; }
    if (!res.ok) throw new Error("lookup failed");
    const room = (await res.json()).room || {};
    const here = (room.participants || []).length;
    const cap = room.maxParticipants || ROOM_CAP;
    const inside = (room.participants || []).some((p) => String(p.userId) === String(S.userId));
    if (room.status === "ended") { toast("That room has ended", "error"); fetchRooms({ silent: true }); return; }
    if (!inside && here >= cap) { toast("That room is full (" + here + "/" + cap + ")", "error"); fetchRooms({ silent: true }); return; }
    location.href = "/room/" + rid;
  } catch (_) {
    toast("Could not open that room", "error");
  } finally {
    navigating = false;
  }
}