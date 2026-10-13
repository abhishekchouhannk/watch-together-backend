// public/js/room/games.js
// ─────────────────────────────────────────────────────────────
// Gaming rooms — the stage (seats + board), the "Game setup" panel
// (game managers only) and the "Players" side-panel tab.
//
// The server is authoritative. This file renders `game-state`
// snapshots and emits intents; it never decides that a move is legal.
//
// It keeps the little state it needs (perms, who's present, my id) from
// the room-wide events, and bootstraps itself with `game-sync`, so it
// works whether initGames() runs before or after the room is joined.
//
//   listens:  room-state · room-permissions · participants-update · game-state
//   emits:    game-sync · game-select · game-assign · game-start · game-reset
//             game-sit · game-stand · game-move · game-resign
//             perm-grant / perm-request (scope "queue" = player access)
// ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const G = {
  socket: null,
  me: null,               // my user id — arrives with the game-sync reply
  game: null,             // last server snapshot
  perms: {},
  present: [],            // [{ userId, username }] currently in the room
  eligible: new Set(),    // user ids that may be seated (sent to game managers only)
  fresh: new Set(),       // cells filled by the latest snapshot → animate once
  pendingRev: -1, pendingT: 0,     // a move is in flight for this rev
  armed: null, armedT: 0,          // two-step confirm ("resign" | "reset")
};

/* ── rendering helpers ─────────────────────────────────────── */
/* repaint a region only when its markup changed → hover, focus and
   running animations survive unrelated pushes (presence, perms…) */
const painted = new WeakMap();
function paint(el, html) {
  if (!el || painted.get(el) === html) return;
  const active = document.activeElement;
  const fk = active && el.contains(active) ? active.dataset.fk : null;
  el.innerHTML = html;
  painted.set(el, html);
  if (fk) {
    const again = el.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }
}
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
const youTag = (userId) => (userId === G.me ? '<span class="gm-you">you</span>' : "");
const avatar = (name) => `<span class="gm-av">${esc(String(name || "?").trim().charAt(0) || "?")}</span>`;

/* ── per-game client renderers ─────────────────────────────── */
const TTT_MARKS = [
  '<path pathLength="100" d="M26 26 74 74"/><path pathLength="100" d="M74 26 26 74"/>',          // X
  '<circle pathLength="100" cx="50" cy="50" r="26" transform="rotate(-90 50 50)"/>',             // O
];
const tttMark = (seat, cls = "") =>
  `<svg class="gm-mark${cls ? " " + cls : ""}" viewBox="0 0 100 100" aria-hidden="true">${TTT_MARKS[seat] || ""}</svg>`;

const UI = {
  tictactoe: {
    badge: (seat) => tttMark(seat.seat),
    /* which cells did this snapshot fill? (same round only) */
    fresh(prev, next) {
      const out = new Set();
      if (!prev || !next.state || prev.round !== next.round) return out;
      const before = (prev.state && prev.state.board) || [];
      next.state.board.forEach((val, i) => { if (val != null && before[i] == null) out.add(i); });
      return out;
    },
    board(v) {
      const { g } = v;
      const board = (g.state && g.state.board) || Array(9).fill(null);
      const line = g.result && Array.isArray(g.result.line) ? g.result.line : [];
      const cells = board.map((val, i) => {
        const filled = val === 0 || val === 1;
        const open = v.myTurn && !filled && G.pendingRev !== g.rev;
        const cls = ["gm-cell"];
        if (filled) cls.push(`gm-s${val}`);
        if (open) cls.push(`gm-s${v.mySeat}`, "is-open");
        if (G.fresh.has(i)) cls.push("is-new");
        if (line.includes(i)) cls.push("is-win");
        const inner = filled ? tttMark(val) : open ? tttMark(v.mySeat, "gm-ghost") : "";
        const label = `Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}: ${filled ? g.seats[val].label : "empty"}`;
        return `<button type="button" class="${cls.join(" ")}" data-act="move" data-cell="${i}" data-fk="c${i}"
                  aria-label="${esc(label)}"${open ? "" : " disabled"}>${inner}</button>`;
      }).join("");
      const state = g.status === "lobby" ? " is-idle" : v.finished ? " is-over" : "";
      return `<div class="gm-board${state}" role="group" aria-label="Tic-tac-toe board">${cells}</div>`;
    },
  },
};
const ui = (g) => UI[g.kind] || UI.tictactoe;

/* ── derived view ──────────────────────────────────────────── */
function view() {
  const g = G.game;
  const mySeat = g.seats.findIndex((s) => s.player && s.player.userId === G.me);   // -1 = spectator
  const filled = g.seats.filter((s) => s.player).length;
  const playing = g.status === "playing";
  return {
    g, mySeat, filled, playing,
    full: filled === g.seats.length,
    finished: g.status === "finished",
    myTurn: playing && mySeat >= 0 && g.turn === mySeat,
    presentIds: new Set(G.present.map((p) => String(p.userId))),
    canManage: !!G.perms.canManageGame,
    canPlay: !!G.perms.canPlayGames,
  };
}
function status(v) {
  const { g } = v;
  const seated = v.mySeat >= 0;
  const nameOf = (seat) => {
    const s = g.seats[seat];
    if (!s) return "Someone";
    return seated && seat === v.mySeat ? "You" : (s.player && s.player.username) || s.label;
  };
  if (v.playing) {
    return v.myTurn
      ? { tone: "me",   text: `Your turn — you're ${g.seats[v.mySeat].label}` }
      : { tone: "wait", text: `${nameOf(g.turn)}'s turn (${g.seats[g.turn].label})` };
  }
  if (v.finished) {
    const r = g.result || {};
    if (r.outcome === "draw") return { tone: "over", text: "It's a draw" };
    const won = seated && r.winner === v.mySeat;
    if (r.outcome === "forfeit") {
      if (seated && r.by === v.mySeat) return { tone: "over", text: "You resigned this round" };
      return { tone: won ? "win" : "over", text: `${nameOf(r.by)} resigned — ${won ? "you win" : nameOf(r.winner) + " wins"}` };
    }
    return { tone: won ? "win" : "over", text: won ? "You won this round!" : `${nameOf(r.winner)} won this round` };
  }
  if (!v.full) return { tone: "idle", text: `Waiting for players · ${v.filled}/${g.seats.length} seated` };
  return { tone: "idle", text: v.canManage ? "Players are ready — start the game" : "Waiting for the game to start" };
}

/* ── stage ─────────────────────────────────────────────────── */
function titleHtml({ g }) {
  return `<span class="gm-title-ic">${esc(g.icon)}</span><span>${esc(g.label)}</span>` +
         (g.round ? `<span class="gm-round">Round ${g.round}</span>` : "");
}
function sitButton(v, seat, key) {
  if (!v.canPlay || v.playing) return "";
  return `<button type="button" class="gm-btn gm-btn-sm" data-act="sit" data-seat="${seat}" data-fk="${key}${seat}">` +
         `${v.mySeat >= 0 ? "Move here" : "Sit here"}</button>`;
}
function seatsHtml(v) {
  const { g } = v;
  const cards = g.seats.map((s) => {
    const badge = `<span class="gm-seat-mark">${ui(g).badge(s)}</span>`;
    const p = s.player;
    if (!p) {
      return `<div class="gm-seat gm-s${s.seat} is-empty">${badge}
        <div class="gm-seat-body"><span class="gm-seat-name">Empty seat</span>
        <span class="gm-seat-sub">Plays ${esc(s.label)}</span></div>${sitButton(v, s.seat, "sit")}</div>`;
    }
    const cls = ["gm-seat", `gm-s${s.seat}`];
    if (v.playing && g.turn === s.seat) cls.push("is-turn");
    if (v.finished && g.result && g.result.winner === s.seat) cls.push("is-winner");
    const sub = plural(p.wins, "win") + (v.presentIds.has(p.userId) ? "" : ' · <span class="gm-away">away</span>');
    return `<div class="${cls.join(" ")}">${badge}
      <div class="gm-seat-body"><span class="gm-seat-name">${esc(p.username)}${youTag(p.userId)}</span>
      <span class="gm-seat-sub">${sub}</span></div></div>`;
  });
  const vs = `<span class="gm-vs"><b>VS</b>${g.draws ? `<small>${plural(g.draws, "draw")}</small>` : ""}</span>`;
  return cards.join(vs);
}
function askButton() {
  const st = G.perms.queueRequestState;
  if (st === "pending") return `<button type="button" class="gm-btn gm-btn-sm" disabled>Request sent</button>`;
  if (st === "denied")  return `<span class="gm-note">Request declined</span>`;
  return `<button type="button" class="gm-btn gm-btn-sm" data-act="ask" data-fk="ask">Ask to play</button>`;
}
function actionsHtml(v) {
  if (v.mySeat >= 0 && v.playing) {
    const armed = G.armed === "resign";
    return `<button type="button" class="gm-btn${armed ? " is-armed" : ""}" data-act="resign" data-fk="resign">` +
           `${armed ? "Tap again to resign" : "Resign"}</button>`;
  }
  if (v.mySeat >= 0) {
    return `<span class="gm-note">You're playing ${esc(v.g.seats[v.mySeat].label)}</span>` +
           `<button type="button" class="gm-btn gm-btn-sm" data-act="stand" data-fk="stand">Leave seat</button>`;
  }
  if (!v.canPlay) return `<span class="gm-note">You're spectating</span>${askButton()}`;
  if (!v.playing && !v.full) return `<span class="gm-note">Take an empty seat to play</span>`;
  return `<span class="gm-note">You're watching</span>`;
}

/* ── setup panel (game managers) ───────────────────────────── */
function roster(v) {
  const seatOf = new Map(v.g.seats.filter((s) => s.player).map((s) => [s.player.userId, s.seat]));
  const list = G.present.map((p) => {
    const id = String(p.userId);
    return { userId: id, username: p.username || "", away: false,
             seat: seatOf.has(id) ? seatOf.get(id) : -1, eligible: G.eligible.has(id) };
  });
  for (const s of v.g.seats) {                        // seated but not in the room right now
    if (s.player && !v.presentIds.has(s.player.userId)) {
      list.push({ userId: s.player.userId, username: s.player.username || "", away: true, seat: s.seat, eligible: true });
    }
  }
  return list.sort((a, b) => (b.seat >= 0) - (a.seat >= 0) || a.username.localeCompare(b.username));
}
function personRow(v, p) {
  const picks = v.g.seats.map((s) => {
    const on = p.seat === s.seat;
    const disabled = v.playing || (!on && (!p.eligible || p.away));
    return `<button type="button" class="gm-pick gm-s${s.seat}${on ? " is-on" : ""}" data-act="assign"
              data-seat="${s.seat}" data-user="${esc(p.userId)}" data-on="${on ? 1 : 0}"
              data-fk="a-${esc(p.userId)}-${s.seat}" aria-pressed="${on}"
              title="${on ? `Remove from ${esc(s.label)}` : `Seat as ${esc(s.label)}`}"${disabled ? " disabled" : ""}>${esc(s.label)}</button>`;
  }).join("");
  const note = p.away ? "away" : !p.eligible ? "no player access" : "";
  const grant = !p.eligible && !p.away && G.perms.canGrantQueue
    ? `<button type="button" class="gm-btn gm-btn-sm" data-act="grant" data-user="${esc(p.userId)}" data-fk="g-${esc(p.userId)}">Allow</button>`
    : "";
  return `<li class="gm-person${p.seat >= 0 ? " is-seated" : ""}">${avatar(p.username)}
    <span class="gm-person-body"><span class="gm-person-name">${esc(p.username)}${youTag(p.userId)}</span>
    ${note ? `<span class="gm-person-note">${note}</span>` : ""}</span>
    <span class="gm-person-ctl">${grant}${grant ? "" : picks}</span></li>`;
}
function manageHtml(v) {
  const { g } = v;
  const games = g.catalog.map((c) => `
    <button type="button" class="gm-game${c.id === g.kind ? " is-on" : ""}" data-act="select" data-kind="${esc(c.id)}"
      data-fk="k-${esc(c.id)}" aria-pressed="${c.id === g.kind}"${v.playing ? " disabled" : ""}>
      <span class="gm-game-ic">${esc(c.icon)}</span><span class="gm-game-t">${esc(c.label)}</span>
      <span class="gm-game-s">${plural(c.seats.length, "player")}</span></button>`).join("");
  const labels = g.seats.map((s) => s.label).join(" or ");
  const hint = v.playing ? "End the game to change the players or the game."
    : v.full ? "Tap a highlighted seat to free it. Changing players starts a fresh scoreboard."
    : `Choose ${g.seats.length} players — tap ${labels} next to a name.`;
  const canReset = v.playing || v.finished || g.round > 0 || g.draws > 0;
  const resetLabel = G.armed === "reset" ? "Tap again to end" : v.playing ? "End game" : "Reset match";
  const start = v.playing ? "" :
    `<button type="button" class="gm-btn gm-btn-primary" data-act="start" data-fk="start"${v.full ? "" : " disabled"}>` +
    `${v.finished ? "Next round" : "Start game"}</button>`;
  return `
    <div class="gm-h">Game setup<small>Visible to people with ${esc(G.perms.labels?.sync?.label || "game management")}</small></div>
    <div class="gm-sec"><div class="gm-label">Game</div><div class="gm-games">${games}</div></div>
    <div class="gm-sec">
      <div class="gm-label"><span>Players</span><span>${v.filled}/${g.seats.length}</span></div>
      <ul class="gm-people">${roster(v).map((p) => personRow(v, p)).join("")}</ul>
      <p class="gm-hint">${esc(hint)}</p>
    </div>
    <div class="gm-manage-btns">${start}
      <button type="button" class="gm-btn${G.armed === "reset" ? " is-armed" : ""}" data-act="reset" data-fk="reset"${canReset ? "" : " disabled"}>${resetLabel}</button>
    </div>`;
}

/* ── side panel: Players tab ───────────────────────────────── */
function paneHtml(v) {
  const { g } = v;
  const rows = g.seats.map((s) => {
    const badge = `<span class="gp-mark">${ui(g).badge(s)}</span>`;
    const p = s.player;
    if (!p) {
      return `<li class="gp-row gm-s${s.seat} is-empty">${badge}
        <span class="gp-row-body"><span class="gp-name">Empty seat</span><span class="gp-sub">Plays ${esc(s.label)}</span></span>
        ${sitButton(v, s.seat, "psit")}</li>`;
    }
    const turn = v.playing && g.turn === s.seat;
    const sub = [`Plays ${esc(s.label)}`, turn ? "to move" : "",
                 v.presentIds.has(p.userId) ? "" : '<span class="gm-away">away</span>'].filter(Boolean).join(" · ");
    return `<li class="gp-row gm-s${s.seat}${turn ? " is-turn" : ""}">${badge}
      <span class="gp-row-body"><span class="gp-name">${esc(p.username)}${youTag(p.userId)}</span><span class="gp-sub">${sub}</span></span>
      <span class="gp-wins" title="Rounds won">${p.wins}</span></li>`;
  }).join("");
  const seatedIds = new Set(g.seats.filter((s) => s.player).map((s) => s.player.userId));
  const watching = G.present.filter((p) => !seatedIds.has(String(p.userId)));
  const chips = watching.length
    ? `<ul class="gp-list gp-watch">${watching.map((p) =>
        `<li class="gp-chip">${avatar(p.username)}${esc(p.username)}${youTag(String(p.userId))}</li>`).join("")}</ul>`
    : `<p class="gp-none">Nobody is watching right now</p>`;
  const foot = v.mySeat >= 0
    ? `<span>You're playing ${esc(g.seats[v.mySeat].label)}</span>` +
      (v.playing ? "" : `<button type="button" class="gm-btn gm-btn-sm" data-act="stand" data-fk="pstand">Leave seat</button>`)
    : v.canPlay ? `<span>You can take an empty seat between games</span>`
    : `<span>You're spectating</span>${askButton()}`;
  return `
    <div class="gp-now"><span class="gp-now-ic">${esc(g.icon)}</span>
      <div><div class="gp-now-t">${esc(g.label)}</div><div class="gp-now-s">${esc(status(v).text)}</div></div></div>
    <div class="gp-label"><span>At the board</span>${g.draws ? `<span>${plural(g.draws, "draw")}</span>` : ""}</div>
    <ul class="gp-list">${rows}</ul>
    <div class="gp-label"><span>Watching</span><span>${watching.length}</span></div>
    ${chips}
    <div class="gp-foot">${foot}</div>`;
}

/* ── render ────────────────────────────────────────────────── */
function render() {
  const layout = $("gameLayout");
  if (!layout || !G.game) return;
  const v = view();
  const st = status(v);

  layout.dataset.manage = v.canManage ? "1" : "0";
  paint($("gmTitle"), titleHtml(v));
  const statusEl = $("gmStatus");
  if (statusEl) { setText(statusEl, st.text); statusEl.dataset.tone = st.tone; }
  paint($("gmSeats"), seatsHtml(v));
  paint($("gmBoard"), ui(v.g).board(v));
  paint($("gmActions"), actionsHtml(v));

  const manage = $("gmManage");
  if (manage) { manage.hidden = !v.canManage; paint(manage, v.canManage ? manageHtml(v) : ""); }

  paint($("gpBody"), paneHtml(v));
  setText($("gpState"), v.playing ? `Round ${v.g.round}` : v.finished ? "Round over" : "Lobby");
  const badge = $("playerCount");
  if (badge) { setText(badge, String(v.filled)); badge.dataset.zero = v.filled ? "0" : "1"; }
}
function applyGame(next) {
  if (!next) return;
  G.fresh = ui(next).fresh(G.game, next);
  G.game = next;
  G.pendingRev = -1; clearTimeout(G.pendingT);
  G.armed = null;    clearTimeout(G.armedT);
  render();
}

/* ── intents ───────────────────────────────────────────────── */
/* destructive buttons need a second click within 3s */
function confirmed(key) {
  clearTimeout(G.armedT);
  if (G.armed === key) { G.armed = null; return true; }
  G.armed = key;
  G.armedT = setTimeout(() => { G.armed = null; render(); }, 3000);
  render();
  return false;
}
function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled || !G.game || !G.socket) return;
  const d = btn.dataset;
  const emit = (event, payload) => G.socket.emit(event, payload);
  switch (d.act) {
    case "move":
      if (G.pendingRev === G.game.rev) return;                 // one move per snapshot
      G.pendingRev = G.game.rev;
      clearTimeout(G.pendingT);
      G.pendingT = setTimeout(() => { G.pendingRev = -1; render(); }, 1500);   // server said no → unlock
      emit("game-move", { cell: Number(d.cell), rev: G.game.rev });
      return render();
    case "sit":    return emit("game-sit", { seat: Number(d.seat) });
    case "stand":  return emit("game-stand");
    case "resign": return confirmed("resign") && emit("game-resign");
    case "start":  return emit("game-start");
    case "reset":  return (G.game.status !== "playing" || confirmed("reset")) && emit("game-reset");
    case "select": return emit("game-select", { kind: d.kind });
    case "assign": return emit("game-assign", { seat: Number(d.seat), userId: d.on === "1" ? null : d.user });
    case "grant":  return emit("perm-grant",   { userId: d.user, scope: "queue" });   // player access
    case "ask":    return emit("perm-request", { scope: "queue" });
  }
}

/* ── wiring ────────────────────────────────────────────────── */
export function initGames(socket) {
  if (!socket || G.socket) return;
  G.socket = socket;

  $("gameLayout")?.addEventListener("click", onClick);
  $("panePlayers")?.addEventListener("click", onClick);

  socket.on("room-state", ({ room, perms } = {}) => {          // first join and every re-join
    if (!room || room.roomType !== "gaming") return;
    if (perms) G.perms = perms;
    G.present = room.participants || [];
    if (!G.me) socket.emit("game-sync");                        // learn who "you" is
    applyGame(room.game);
  });
  socket.on("room-permissions", ({ perms, gameEligible } = {}) => {
    if (perms) G.perms = perms;
    if (Array.isArray(gameEligible)) G.eligible = new Set(gameEligible);
    render();
  });
  socket.on("participants-update", ({ participants } = {}) => {
    if (Array.isArray(participants)) G.present = participants;
    render();
  });
  socket.on("game-state", (p = {}) => {
    if (p.you) G.me = String(p.you);
    if (p.perms) G.perms = p.perms;
    if (Array.isArray(p.participants)) G.present = p.participants;
    if (Array.isArray(p.gameEligible)) G.eligible = new Set(p.gameEligible);
    if (p.game && G.game && p.game.rev < G.game.rev) return render();   // older than what we show
    if (p.game) applyGame(p.game); else render();
  });

  socket.emit("game-sync");     // no-op unless we're already inside a gaming room
}