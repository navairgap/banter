<p align="center">
  <img src="docs/ascii-hero.gif" alt="banter — real-time public chat rooms, in ASCII" width="720">
</p>

<p align="center">
  <a href="https://github.com/navairgap/banter/actions/workflows/ci.yml"><img src="https://github.com/navairgap/banter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node 18+">
</p>

banter is a self-hosted, real-time public chat. Pick a nickname, join a
room, talk. State lives in process memory and resets on restart — there
are no accounts, no database, and no message history, so there is nothing
to leak and nothing to migrate. The server is a single ~400-line file you
can read in one sitting.

```bash
git clone https://github.com/navairgap/banter.git
cd banter
npm install
npm start          # http://localhost:3000
```

Node.js 18 or newer. For auto-reloading during development use `npm run dev`.

## Features

- Multiple public rooms; create more from the client. The sidebar shows a
  live member count per room.
- Live roster per room with join and leave notices, typing indicators, and
  presence in the member panel.
- Discord-style interface: server rail, channel sidebar, member list, and
  flat messages grouped by author. Multiline input (Enter sends,
  Shift+Enter adds a line).
- Automatic http(s) link detection. All user content is rendered with
  `textContent`; it cannot inject markup.
- Delivery feedback: every send is acknowledged, and rejections (rate
  limit, over-length) surface in the client instead of vanishing.
- Reconnect handling: dropped clients re-join the room they were in, and
  re-joining the current room produces no roster noise.
- Unread counter in the tab title plus a "new messages" divider; message
  DOM nodes are capped so long sessions stay bounded.

Duplicate nicknames are resolved server-side (`alex`, `alex (2)`, …) and
the client re-syncs its name on every join.

<p align="center">
  <img src="docs/chat-demo.gif" alt="banter chat — channels, grouped messages, member list" width="720">
</p>

## Configuration

| Variable      | Default   | Meaning |
|---------------|-----------|---------|
| `PORT`        | `3000`    | Listen port |
| `HOST`        | all interfaces | Bind address |
| `TRUST_PROXY` | unset     | `1` = take the client IP from `X-Forwarded-For`. Enable only behind a proxy you control; the header is client-spoofable otherwise. |
| `BENCH`       | unset     | `1` = lift the per-IP connection cap for local benchmarking. Never expose such a process. |

## Wire protocol

| Event      | Direction | Payload                  | Notes |
|------------|-----------|--------------------------|-------|
| `join`     | C → S     | `{ name, room }`         | ack `{ ok, name, room }`; `name` is server-resolved |
| `message`  | C → S     | `text`                   | ack `{ ok }` / `{ ok: false, error }` |
| `typing`   | C → S     | `boolean`                | fire-and-forget for invalid payloads |
| `new room` | C → S     | `room`                   | ack `{ ok, room }` |
| `message`  | S → C     | `{ user, text, ts }`     | `ts` is epoch milliseconds |
| `system`   | S → C     | `{ text, ts }`           | join/leave notices |
| `users`    | S → C     | `string[]`               | room roster |
| `rooms`    | S → C     | `{ name, count }[]`      | all rooms with member counts |
| `typing`   | S → C     | `{ user, isTyping }`     | |

The full contract — acknowledgement semantics, rate limits, room
reservations, reconnect behavior, and shutdown — is specified in
[docs/socket-event-contract.md](docs/socket-event-contract.md).

Server-side limits: nicknames 20 chars, messages 500 chars (rejected, not
truncated), room names 24 chars, 100 rooms, 8 messages / 10 s / socket,
20 connections per IP, 1000 connections total. Invalid payloads never
broadcast and never consume rate-limit quota.

## Testing

```bash
npm test
```

The integration suite runs the real server in-process on a scratch port
and drives socket.io clients over TCP: joins and renames, guest naming,
roster counts, message acks and timestamps, Unicode and newlines, length
limits, rate-limit quota semantics, room creation and reservations,
silent same-room re-joins, disconnect cleanup, security headers, and the
SIGTERM drain. CI runs it on Node 18 / 20 / 22 / 24 for every push and
pull request.

## Benchmarking

```bash
npm run bench                        # 100 bots, 10 s
npm run bench -- --clients 200 --duration 30
```

Reports message round-trip percentiles (p50 / p95 / p99). Local runs with
100 loopback clients sit at single-digit to low-double-digit milliseconds.

## Deployment

`npm start` is the whole deployment story — no build step, no external
services. `GET /healthz` returns `{ ok, version, uptime, users, rooms }`
for platform health checks. A `Procfile` is included for
Heroku-family hosts.

Behind nginx, proxy to the port and pass the websocket upgrade headers
(`Upgrade`, `Connection`); without them clients fall back to
long-polling. Set `TRUST_PROXY=1` only when the proxy is yours.

SIGTERM and SIGINT drain the server: stop accepting, close sockets with
proper disconnect packets, exit 0.

One process comfortably holds a few thousand concurrent sockets. Beyond
that, shard by room across instances — clients in the same room must
share an instance.

## Project layout

```
server.js          HTTP + Socket.IO server, in-memory state, /healthz
index.html         app shell: join screen, rail, channels, members panel
styles/main.css    dark theme, responsive layout
js/app.js          client: rendering, socket wiring, typing, unread state
test/smoke.js      in-process integration suite
scripts/bench.js   load benchmark
docs/              wire contract, validation cases, README artwork
```

## Scope and non-goals

- No persistence by design. A restart empties rooms; this is the feature.
- No private messages, no roles, no history replay.
- No end-to-end encryption — the model assumes you operate the server you
  trust. For that guarantee, use Matrix.
- Anonymous nicknames are not authentication. Do not run sensitive
  conversations on a public deployment.

## License

MIT — see [LICENSE](LICENSE).
