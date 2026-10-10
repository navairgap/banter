<p align="center">
  <img src="docs/ascii-hero.gif" alt="banter — real-time public chat rooms, in ASCII" width="780">
</p>

<p align="center">
  <img src="docs/chat-demo.gif" alt="banter chat demo — rooms, bubbles, typing indicator" width="760">
</p>

<p align="center">
  <img src="https://github.com/navairgap/banter/actions/workflows/ci.yml/badge.svg" alt="CI">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/deps-express%20%2B%20socket.io-orange.svg" alt="Express + Socket.IO">
  <img src="https://img.shields.io/badge/accounts-none-purple.svg" alt="No accounts">
  <img src="https://img.shields.io/badge/database-none-black.svg" alt="No database">
</p>

Pick a nickname, join a room, talk. **banter** is a real-time public chat
app — no accounts, no database, no build step. Users and rooms live in
server memory, so a restart wipes everything and nothing about you is
ever stored.

## Quick start

```bash
git clone https://github.com/navairgap/banter.git
cd banter
npm install
npm start
```

Open **http://localhost:3000** in as many tabs as you like — each tab is
another person in the room.

Requires Node.js 18+.

## Features

- 💬 **Multiple public rooms** — lobby, tech, random… or create your own
  with one click
- 👀 **Live online list** per room, with join/leave notices
- ✍️ **Typing indicators** — animated, with names
- 🎨 **Duplicate nicknames handled** — two "alex" become `alex` and `alex (2)`, and the client re-syncs its name on every room switch
- 📱 **Responsive** — sidebar collapses into a slide-in overlay on mobile
- 🔔 **Unread counter** in the tab title when the window is hidden
- 🔌 **Connection-aware** — status dot, input locks when disconnected
- 🛡️ **XSS-proof by construction** — the client renders everything with
  `textContent`; user input can never inject markup

## How it works

```
Browser (js/app.js) --socket.io--> server.js --broadcast--> room members
```

| Event     | Direction | Payload                  | Purpose              |
|-----------|-----------|--------------------------|----------------------|
| `join`    | client →  | `{ name, room }`         | join / switch room   |
| `message` | client →  | `text`                   | send a message       |
| `typing`  | client →  | `bool`                   | typing indicator     |
| `new room`| client →  | `room`                   | create a room        |
| `message` | → client  | `{ user, text, time }`   | incoming message     |
| `system`  | → client  | `{ text, time }`         | join/leave notices   |
| `users`   | → client  | `string[]`               | room's online list   |
| `rooms`   | → client  | `string[]`               | all rooms            |
| `typing`  | → client  | `{ user, isTyping }`     | who's typing         |

The `join` acknowledgement returns `{ ok, name, room }` — `name` is the
server-resolved nickname (renamed on collision), and the client applies it
on both the initial join and every room switch.

Limits: nicknames 20 chars, messages 500 chars (over-limit is rejected,
not truncated), rooms 24 chars. Everything is trimmed and validated
server-side.

## Testing

```bash
npm test
```

Runs in CI on every push and pull request (Node 18 / 20 / 22) — see
`.github/workflows/ci.yml`.

Boots the server on a scratch port, connects two real socket clients, and
verifies joining, duplicate names (including collision on a mid-session
room switch), user lists, messaging, length limits, typing events, room
creation, and disconnect cleanup.

## Deploying

Listens on `process.env.PORT` (default 3000), no build step, no external
services. `GET /healthz` returns `{ "ok": true }` — point your platform's
health check at it. Only client assets are served; server files are not
exposed.

- **Render / Railway / Fly.io** — start command `npm start`
- **VPS** — `npm install && pm2 start server.js --name banter`
- **Heroku-family** — `web: npm start` in a Procfile

## Project layout

```
server.js        Express + Socket.IO backend, in-memory state, /healthz
index.html       join screen + chat screen markup
styles/main.css  dark theme, animations, responsive layout
js/app.js        client: rendering, socket events, typing, unread badge
test/smoke.js    two-client integration test
docs/            ASCII hero animation for this README
```

## Honest limits

- In-memory only — restarting the server empties rooms and user lists
- No message history — everything is relayed live, nothing is stored
- Demo-grade moderation — no rate limiting or auth; add them before
  exposing it to strangers

## License

MIT, see [LICENSE](LICENSE).

---
maintained · verified 2026-09-30
---
maintained · verified 2026-10-01
---
maintained · verified 2026-10-02

## Architecture

- `server.js` holds all in-memory state: rooms, users, typing indicators. Nothing touches disk.
- `test/smoke.js` forks the server on a test port and drives two socket.io clients through join/message/rename/disconnect flows in CI.
- Messages are relayed, never stored — reload and history is gone, by design.

## Scaling limits

Everything lives in process memory: expect comfortable performance to a few thousand concurrent sockets per instance. Beyond that, shard by room across instances — clients in the same room must share an instance. No persistence means restart = empty rooms, which is the point.


## Operating notes

- single instance per room shard; scale by sharding rooms across processes
- no persistence is a feature: restarts clear state cleanly
- put it behind your reverse proxy of choice for TLS


## Comparison

vs matrix/synapse: banter has no federation, no accounts, no database — and is ~200 lines you can read. vs a discord bot: it's a protocol, not a platform. pick it when zero-state matters more than features.


## Troubleshooting

rooms empty after restart? by design — no persistence. client connected but messages not arriving? check the room name matches exactly; typos make new rooms, silently.

## Versioning

no semver — `main` is always runnable and the protocol is stable. tags mark protocol changes; if the wire format ever changes, it gets a tag and a migration note here.

## Versioning

no semver — `main` is always runnable and the protocol is stable. tags mark protocol changes; if the wire format ever changes, it gets a tag and a migration note here.
