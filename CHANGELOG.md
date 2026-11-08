# Changelog

## 2.0.0 — 2026-11-09

Wire protocol v2. Not backwards compatible with 1.x clients.

### Server

- Timestamps are epoch milliseconds (`ts`) instead of server-formatted strings;
  clients render times in their own timezone.
- The `rooms` event carries `{ name, count }[]` so clients can show member
  counts.
- `message` and `new room` acknowledge with `{ ok }` / `{ ok: false, error }`;
  invalid payloads no longer consume rate-limit quota (validation runs before
  the limiter).
- Re-joining the current room with the same nickname is a silent no-op, which
  makes client reconnects invisible to the room.
- Content-Security-Policy and Permissions-Policy headers on all responses;
  ETag-revalidated static assets.
- SIGTERM/SIGINT drain: stop accepting, disconnect sockets, exit 0.
- `/healthz` reports `{ ok, version, uptime, users, rooms }`.
- New environment variables: `HOST`, `TRUST_PROXY`, `BENCH` (see README).

### Client

- Discord-style layout: server rail, channel sidebar, member list, user panel.
- Flat grouped messages instead of bubbles; http(s) URLs are linkified.
- Multiline input (Enter sends, Shift+Enter adds a line) with pre-wrap
  rendering.
- Send failures surface as toasts via the new acks; typing indicator is
  throttled and auto-clears.
- "New messages" pill and unread title counter; DOM is capped at 350 message
  nodes for long sessions.
- Reconnects re-join the current room instead of the originally joined one.

### Project

- `test/smoke.js` runs the server in-process and covers acks, rate-limit
  quota semantics, guest naming, room reservations, and the shutdown drain.
- `npm run bench` loads the server with bot clients and reports round-trip
  percentiles.
- CI matrix: Node 18 / 20 / 22 / 24.
