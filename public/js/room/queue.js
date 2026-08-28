/* public/js/queue.js
 * ─────────────────────────────────────────────────────────────
 * QUEUE — playlist + auto-advance + up-next card + side-panel tabs.
 *
 * Local-first UI over a server-authoritative list: every mutation is an emit
 * ('queue-add' / 'queue-remove' / 'queue-move' / 'queue-clear' / 'queue-play'
 * / 'queue-autoplay'); the server answers with 'queue-update' carrying the
 * authoritative list → applyRemote() reconciles and re-renders.
 *
 *  Q                  the queue facade (same surface as the old closure):
 *    wire()           tabs, add box, clear, autoplay toggle, row actions,
 *                     drag-and-drop reorder, prev/next transport, up-next
 *                     card buttons, N/P shortcuts. Called from wireEvents().
 *    add(url)         emit queue-add (permission-gated with a toast)
 *    render()         list + badge + empty state + bar/lock visibility + nav
 *    refreshNav()     prev/next enabled state (both control bars)
 *    applyRemote(p)   reconcile {items, index, autoplay} from the server
 *    onEnded()        video ended → hide card, emit 'video-ended' {itemId}
 *    tick(t, d)       called 4×/s by the player's UI ticker → up-next card
 *    resetUpNext()    hide the card and forget a user cancel
 *    next()/prev()/hasNext()/hasPrev()/canManage()
 *    switchTab(which) 'chat' | 'queue' — also pings Unread.onChatShown()
 *
 *  Shared state: creates S.queue = { items, index } ONCE and keeps a private
 *    alias `st` to it; applyRemote mutates st.items / st.index IN PLACE, so the
 *    alias never goes stale. Never assign S.queue from anywhere else.
 *    Reads S.perms.canQueue, S.currentItemId, S.videoLoaded.
 *  Closure-private: dragId, autoplay (server value from queue-update — NOT
 *    S.perms.autoplay, by design), unVisible, unCancelled.
 *
 *  Player coupling: the player calls us via playerHooks (it cannot import us,
 *    we import P from it). The four slots are filled at the bottom of this file.
 *
 *  Network: 'queue-update' / 'queue-ended' attached on first onConnect;
 *    room-state phase 30 seeds the list (before the player's phase 35 load).
 * ───────────────────────────────────────────────────────────── */
"use strict";
import { UPNEXT_AT } from "./config.js";
import { S } from "./state.js";
import { $, dom } from "./dom.js";
import { toast, esc, fmtTime, fmtBadge } from "./utils.js";
import { emit as sockEmit, getSocket } from "./socket-ref.js";
import { onConnect, onRoomState } from "./socket-core.js";
import { P, playerHooks } from "./player.js";
import { Unread, addSystemMsg } from "./chat.js";
/* ═══════════════════════════════════════════
   QUEUE  —  playlist + auto-advance + up-next
   ═══════════════════════════════════════════ */
export const Q = (() => {
  /* items[i] = { id, url, type:'youtube'|'direct', videoId, title, author,
                  thumb, duration, addedBy } ; index = currently playing */
  const st = (S.queue = { items: [], index: -1 });
  let dragId = null, autoplay = true;
  let unVisible = false, unCancelled = false;
  /* Host + moderators. Server should ideally expose a dedicated `canQueue`
     permission; until then reuse the two flags already shipped. */
  const canManage = () => !!S.perms.canQueue;
  function playId(id) {
    if (!canManage()) return toast("You don't have queue control", "error");
    emit("queue-play", { id });
  }
  /* ── queries ────────────────────────────────────────── */
  const hasNext = () => st.index >= -1 && st.index + 1 < st.items.length;
  const hasPrev = () => st.index > 0;
  const peekNext = () => (hasNext() ? st.items[st.index + 1] : null);
  const find = (id) => st.items.findIndex((i) => i.id === id);
  /* ── mutations ──────────────────────────────────────── */
  function add(url) {
    if (!url) return toast("Enter a URL", "error");
    if (!canManage()) return toast("You don't have queue control", "error");
    emit("queue-add", { url });                      // server resolves metadata + echoes queue-update
  }
  const remove = (id)     => canManage() && emit("queue-remove", { id });
  const move   = (id, to) => canManage() && emit("queue-move", { id, to });
  const clear  = ()       => canManage() && emit("queue-clear", {});
  /* ── playback ───────────────────────────────────────── */
  const playIndex = (i) => st.items[i] && playId(st.items[i].id);
  const next = () => hasNext() && playIndex(st.index + 1);
  const prev = () => hasPrev() && playIndex(st.index - 1);
  /* video finished → tell the server; IT decides what plays next (single authority) */
  function onEnded() {
    hideUpNext();
    sockEmit("video-ended", { itemId: S.currentItemId });
  }
  /* ── UP NEXT card ───────────────────────────────────── */
  function tick(t, d) {
    const nxt = peekNext();
    const rem = d > 0 && isFinite(d) ? d - t : Infinity;
    if (!nxt || !autoplay) return hideUpNext();
    if (rem > UPNEXT_AT + 0.5) { unCancelled = false; return hideUpNext(); }   // user seeked back
    if (unCancelled || P.paused() || rem <= 0.25) return hideUpNext();
    showUpNext(nxt, rem);
  }
  function showUpNext(item, rem) {
    const card = $("upNext");
    if (!unVisible) {
      $("unTitle").textContent = item.title;
      $("unSub").textContent   = item.author || "";
      const img = $("unThumb");
      img.style.display = item.thumb ? "" : "none";
      if (item.thumb) img.src = item.thumb;
      card.hidden = false; unVisible = true;
    }
    $("unCount").textContent = Math.max(0, Math.ceil(rem)) + "s";
    $("unRing").style.setProperty("--p", Math.min(100, (1 - rem / UPNEXT_AT) * 100).toFixed(0) + "%");
  }
  function hideUpNext() { if (unVisible) { $("upNext").hidden = true; unVisible = false; } }
  function resetUpNext() { hideUpNext(); unCancelled = false; }
  /* ── render ─────────────────────────────────────────── */
  const ICON = {
    play:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    up:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="18 15 12 9 6 15"/></svg>',
    down:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>',
    remove: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };
  function render() {
    const manage = canManage();
    const list = $("queueList");
    /* badge + empty state */
    const upcoming = Math.max(0, st.items.length - (st.index + 1));
    const badge = $("queueCount");
    badge.textContent   = fmtBadge(upcoming);                  // ← 11+ → "10+"
    badge.dataset.zero  = upcoming ? "0" : "1";
    badge.title = upcoming === 1 ? "1 video up next"
                                 : upcoming + " videos up next";
    $("queueEmpty").hidden = st.items.length > 0;
    $("queueClearBtn").disabled = !manage || st.items.length === 0;
    $("queueBar").hidden = !manage;
    $("queueLock").hidden = manage;
    $("qAutoplay").disabled = !manage;
    if (st.items.length === 0 && manage && !S.videoLoaded) {
      $("queueEmpty").querySelector(".q-empty-s").textContent =
        "Paste a URL below — the first video starts right away";
    }
    list.innerHTML = st.items.map((it, i) => {
      const playing = i === st.index;
      const cls = ["q-item", manage ? "can-manage" : "",
                   playing ? "playing" : (i < st.index ? "played" : "")].join(" ");
      const thumb = it.thumb
        ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy">'
        : "🎞️";
      const now = playing ? '<span class="q-now"><span class="q-eq"><i></i><i></i><i></i></span></span>' : "";
      const dur = it.duration ? '<span class="q-dur">' + fmtTime(it.duration) + "</span>" : "";
      const sub = [it.author, it.addedByName].filter(Boolean).map(esc).join(" · ");
      return (
        '<li class="' + cls + '" data-id="' + it.id + '"' + (manage ? ' draggable="true"' : "") + ">" +
          '<span class="q-grip" aria-hidden="true">⠿</span>' +
          '<div class="q-thumb">' + thumb + dur + now + "</div>" +
          '<div class="q-meta">' +
            '<div class="q-title" title="' + esc(it.title) + '">' + esc(it.title) + "</div>" +
            '<div class="q-sub">' + sub + "</div>" +
          "</div>" +
          '<div class="q-actions">' +
            '<button class="q-act" data-act="play"   title="Play now">'  + ICON.play   + "</button>" +
            '<button class="q-act" data-act="up"     title="Move up"'    + (i === 0 ? " disabled" : "") + ">" + ICON.up + "</button>" +
            '<button class="q-act" data-act="down"   title="Move down"'  + (i === st.items.length - 1 ? " disabled" : "") + ">" + ICON.down + "</button>" +
            '<button class="q-act" data-act="remove" title="Remove">'    + ICON.remove + "</button>" +
          "</div>" +
        "</li>"
      );
    }).join("");
    refreshNav();
  }
  /* prev/next enabled state in the control bar */
  function refreshNav() {
    const manage = canManage();
    const noPrev = !manage || !hasPrev(), noNext = !manage || !hasNext();
    $("prevBtn").disabled  = noPrev;  $("nextBtn").disabled  = noNext;
    $("cPrevBtn").disabled = noPrev;  $("cNextBtn").disabled = noNext;
  }
  /* ── remote reconcile (socket `queue-update`) ── */
  function applyRemote(p) {
    if (!p || !Array.isArray(p.items)) return;
    st.items = p.items;
    st.index = typeof p.index === "number" ? p.index : -1;
    if (typeof p.autoplay === "boolean") {
      autoplay = p.autoplay;
      const cb = $("qAutoplay");
      if (cb) cb.checked = autoplay;
    }
    resetUpNext(); render();
  }
  function emit(ev, data) { sockEmit(ev, data); }
  /* ── wiring ─────────────────────────────────────────── */
  function wire() {
    /* tabs */
    [dom.tabChat, dom.tabQueue].forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.tab))
    );
    /* add */
    $("queueAddBtn").onclick = () => {
      const v = $("queueInput").value.trim();
      if (v) { add(v); $("queueInput").value = ""; }
    };
    $("queueInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("queueAddBtn").click();
    });
    $("queueClearBtn").onclick = clear;
    $("qAutoplay").onchange = (e) => {
      if (!canManage()) { e.target.checked = autoplay; return toast("You don't have queue control", "error"); }
      emit("queue-autoplay", { on: e.target.checked });
    };
    /* row actions (delegated) */
    $("queueList").addEventListener("click", (e) => {
      const btn = e.target.closest(".q-act"); if (!btn) return;
      const id = e.target.closest(".q-item").dataset.id;
      const i  = find(id); if (i < 0) return;
      const act = btn.dataset.act;
      if (act === "play")   playIndex(i);
      if (act === "remove") remove(id);
      if (act === "up")     move(id, i - 1);
      if (act === "down")   move(id, i + 1);
    });
    /* drag & drop reorder */
    const list = $("queueList");
    list.addEventListener("dragstart", (e) => {
      const li = e.target.closest(".q-item"); if (!li || !canManage()) return;
      dragId = li.dataset.id; li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragend", () => {
      dragId = null;
      list.querySelectorAll(".q-item").forEach((n) => n.classList.remove("dragging", "drag-over"));
    });
    list.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      const li = e.target.closest(".q-item"); if (!li) return;
      list.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
      li.classList.add("drag-over");
    });
    list.addEventListener("drop", (e) => {
      if (!dragId) return;
      e.preventDefault();
      const li = e.target.closest(".q-item"); if (!li) return;
      move(dragId, find(li.dataset.id));
    });
    /* transport */
    $("prevBtn").onclick = prev;
    $("nextBtn").onclick = next;
    /* center transport (previous/next video buttons) */
    $("cPrevBtn").onclick = prev;
    $("cNextBtn").onclick = next;
    /* up-next card */
    const cancel = () => { unCancelled = true; hideUpNext(); };
    $("unCancel").onclick    = cancel;
    $("unCancelBtn").onclick = cancel;
    $("unNowBtn").onclick = () => { hideUpNext(); next(); };
    /* N / P shortcuts */
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "n" || e.key === "N") next();
      if (e.key === "p" || e.key === "P") prev();
    });
    render();
  }
  function switchTab(which) {
    const chat = which === "chat";
    dom.tabChat.classList.toggle("active", chat);
    dom.tabQueue.classList.toggle("active", !chat);
    dom.tabChat.setAttribute("aria-selected", String(chat));
    dom.tabQueue.setAttribute("aria-selected", String(!chat));
    dom.paneChat.classList.toggle("active", chat);
    dom.paneQueue.classList.toggle("active", !chat);
    if (chat) Unread.onChatShown();
  }
  return { wire, add, render, refreshNav, applyRemote,
           onEnded, tick, resetUpNext, next, prev, hasNext, hasPrev, canManage, switchTab };
})();
/* ══════════════════════════════════════
   PLAYER → QUEUE callbacks (moved here from room.js; player.js can't import us)
   ══════════════════════════════════════ */
playerHooks.queueResetUpNext = () => Q.resetUpNext();
playerHooks.queueRender      = () => Q.render();
playerHooks.queueOnEnded     = () => Q.onEnded();
playerHooks.queueTick        = (t, d) => Q.tick(t, d);
/* ══════════════════════════════════════
   NETWORK
   ══════════════════════════════════════ */
let sockWired = false;
onConnect(() => {
  if (sockWired) return;        // attach once, even across reconnects
  sockWired = true;
  const socket = getSocket();
  socket.on("queue-update", (p) => Q.applyRemote(p));
  socket.on("queue-ended", () => {
    Q.resetUpNext();
    addSystemMsg("Queue finished 🎉");
    toast("Queue finished 🎉", "success");
  });
});
/* phase 30: after chat history (20), before the player's initial load (35) —
   same order as the original room-state body */
onRoomState(({ room }) => {
  if (room.queue) Q.applyRemote(room.queue);
}, 30);