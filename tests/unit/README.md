# Backend unit tests — room permissions

```bash
npm test                 # run everything
npm run test:watch       # re-run on change
npx jest permissions.socket   # run a single suite
```

The first `npm test` downloads a `mongod` binary (mongodb-memory-server caches
it under `~/.cache/mongodb-binaries`); every run after that is fully offline.
If your environment can't reach `fastdl.mongodb.org`, point
`MONGOMS_SYSTEM_BINARY=/path/to/mongod` at any locally installed binary.

## What is covered

Everything runs against a **real in-memory MongoDB** — mock users
(`username1` / `user1@user.com` / verified) are inserted, join rooms, and all
assertions are made on fresh reads of the persisted room documents.

| Suite | What it proves |
| --- | --- |
| `permissions.core.test.js` | The hierarchy (one host > mods > members), `ensureMember` bootstrap, grant/revoke state rules, implicit + irrevocable host/mod grants, `"everyone"` slot modes, rejection of unknown scopes, and the exact `resolvePerms()` payload per role. |
| `permissions.scopes.test.js` | What each scope string *means* per room type (see table below), per-room isolation of grants, and the room-type wording (`labels`). |
| `permissions.socket.test.js` | The real wire protocol: a genuine socket.io server + `authenticateSocket` + `roomHandlers`, exercising `join-room`, `perm-grant`, `perm-revoke`, `perm-request`/`perm-respond`, `perm-set-role` and `perm-set-queue-mode` — asserting both the live broadcasts users receive *and* what got persisted. |
| `moderation.socket.test.js` | Moderation over the same harness: `member-kick` (eviction + forced disconnect + rejoin cooldown, grants survive), `member-remove` (membership wiped), `member-ban`/`member-unban` (blocklist persisted, `join-room` refuses banned users), `voice-force-mute`/`voice-force-unmute` (host + mods, never self/host/another mod) — plus proof that members and even mods firing kick/remove/ban are stopped by the guards with the target left untouched. |

## The scope model (the thing these tests pin down)

There are exactly **two** grantable scopes on the wire — `"sync"` and
`"queue"` — and what they unlock depends on the room type
(`utils/roomConfigAndPermissions.js`):

| scope | entertainment / music | study |
| --- | --- | --- |
| `"sync"` | playback control (`canControlMedia`) | pomodoro timer (`canControlTimer`) |
| `"queue"` | queue management (`canManageQueue`) | **tasks + whiteboards** (`canManageTasks`, `canManageBoards`) |

So "granting whiteboard/tasks access" in a study room *is* granting the
`"queue"` scope; literal `"whiteboard"` / `"tasks"` scope strings are not part
of the protocol and the tests assert they are rejected. The host and mods hold
both scopes implicitly (and irrevocably); regular members get them via
`perm-grant`, an approved `perm-request`, or a room-wide `"everyone"` mode.

## Conventions

- Each suite boots its own `mongod` (`helpers/db.js`) and wipes all
  collections between tests — no shared state, no ordering dependencies.
- `helpers/factories.js` persists users/rooms/joins/grants through the same
  mutations the app itself performs (`ensureMember`, the `perm-*` handler
  field writes), so schema defaults are part of what's tested.
- `helpers/socketHarness.js` starts the production socket stack unmodified;
  clients authenticate with real `accessToken` cookies. Only
  `roomEvents.logLeave` is stubbed in the socket suite (its 15s
  presence-grace timer would outlive the test process).
