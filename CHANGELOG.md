# Changelog

## 3.0.0 — 2026-11-09

The project pivots from a public chat room to a local AI chat harness.
Not compatible with 2.x clients.

### Added

- Multi-provider LLM layer with streaming: OpenAI-compatible endpoints
  (OpenAI, Groq, DeepSeek, Mistral, xAI, OpenRouter, Ollama, LM Studio),
  Anthropic, Google Gemini, and an offline mock provider.
- Provider settings UI with API-key storage in `~/.banter/config.json`
  (owner-only file, keys never returned by the API) and a
  "Test & list models" check.
- Skill system using the SKILL.md format: eight preinstalled skills,
  per-conversation toggles that inject into the system prompt, installs
  from a raw SKILL.md URL, and user-skill removal with built-in shadowing.
- Conversations: create, open, auto-title from the first message, delete,
  isolated per browser session.
- Token-by-token streaming with a server-side stop (AbortController).
- Safe markdown rendering for model replies (fences, lists, bold, inline
  code, links).

### Removed

- Public rooms, nicknames, and user-to-user relay; the harness is a
  single-operator tool with per-session isolation.
- The rooms-based benchmark script.

### Changed

- `chat:send` replaces `message`; all chat events acknowledge or stream.
- `BANTER_HOME` (default `~/.banter`) holds config and installed skills.
- Health endpoint reports the active provider instead of room stats.

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

### Security

- Server-side fetches (chat, model test, skill installs) validate the
  target: http(s) only, no embedded credentials, and DNS resolution must
  be public — private/intranet addresses are rejected unless the host is
  literal loopback or `BANTER_ALLOW_PRIVATE_FETCH=1` is set.
- Skill paths are proven to be direct children of the skills directory
  before any write or delete.

### Project

- `test/smoke.js` runs the server in-process and covers acks, rate-limit
  quota semantics, guest naming, room reservations, and the shutdown drain.
- `npm run bench` loads the server with bot clients and reports round-trip
  percentiles.
- CI matrix: Node 18 / 20 / 22 / 24.
