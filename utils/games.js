// utils/games.js
// ─────────────────────────────────────────────────────────────
// Game rules. Pure functions — no sockets, no DB, no room knowledge.
// The room handlers own seats, rounds and scores; an engine only
// answers "is this move legal, and what happens next?"
//
// Engine contract
//   id, label, icon
//   seats: [{ label }]            one entry per seat (index = seat number)
//   create()                    → fresh, JSON-safe state for a new round
//   publicState(state)          → sanitised copy that clients may see
//   play(state, seat, move)     → { error }            illegal move
//                               | { state, turn }      game goes on; `turn` = next seat
//                               | { state, result }    round over
//       result = { outcome: "win", winner: seat, … } | { outcome: "draw" }
//
// Adding a game = one engine here + one line in GAMES
// (+ a renderer in public/js/room/games.js).
// ─────────────────────────────────────────────────────────────
"use strict";

const GAME_STATUS = Object.freeze(["lobby", "playing", "finished"]);

/* ── Tic-Tac-Toe ── cells hold the seat index (0 = X, 1 = O) or null */
const TTT_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
/* always returns a fresh, well-formed 9-cell array — stored state is never trusted blindly */
function tttBoard(state) {
  const src = state && Array.isArray(state.board) ? state.board : [];
  return Array.from({ length: 9 }, (_, i) => (src[i] === 0 || src[i] === 1 ? src[i] : null));
}
const tictactoe = {
  id: "tictactoe",
  label: "Tic-Tac-Toe",
  icon: "⭕",
  seats: [{ label: "X" }, { label: "O" }],
  create: () => ({ board: Array(9).fill(null) }),
  publicState: (state) => ({ board: tttBoard(state) }),
  play(state, seat, move) {
    const cell = move && move.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { error: "That isn't a square on the board" };
    const board = tttBoard(state);
    if (board[cell] !== null) return { error: "That square is already taken" };
    board[cell] = seat;
    const line = TTT_LINES.find((l) => l.every((i) => board[i] === seat));
    if (line) return { state: { board }, result: { outcome: "win", winner: seat, line } };
    if (board.every((v) => v !== null)) return { state: { board }, result: { outcome: "draw" } };
    return { state: { board }, turn: 1 - seat };
  },
};

/* ── registry ── */
const GAMES = { tictactoe };
const GAME_IDS = Object.keys(GAMES);
const DEFAULT_GAME = "tictactoe";

const isGameId = (id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(GAMES, id);
const getGame  = (id) => (isGameId(id) ? GAMES[id] : GAMES[DEFAULT_GAME]);
const publicGames = () => GAME_IDS.map((id) => ({
  id, label: GAMES[id].label, icon: GAMES[id].icon, seats: GAMES[id].seats.map((s) => s.label),
}));

module.exports = { GAME_STATUS, GAME_IDS, DEFAULT_GAME, isGameId, getGame, publicGames };