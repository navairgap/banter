# Contributing

## Setup

```bash
npm install
npm run dev     # auto-reloading server on :3000
npm test        # integration suite (in-process server, no mocks)
```

## Ground rules

- **Run the tests.** `npm test` must pass before you push. The suite covers
  the wire contract in `docs/socket-event-contract.md`; if you change the
  contract, change the contract doc and the tests in the same commit.
- **Keep the wire protocol documented.** Any change to event payloads gets a
  section in `docs/socket-event-contract.md` and an entry in `CHANGELOG.md`.
- **Validate all client input server-side.** Identity comes from socket
  state, never from payload fields. Rejected payloads must not broadcast and
  must not consume rate-limit quota.
- **Render with `textContent`.** User input is never interpolated as markup.
  Linkification builds `<a>` nodes from an http(s)-only regex.
- **No new runtime dependencies** unless the problem genuinely needs one;
  the current set is express + socket.io.

## Commit style

Imperative mood, scoped conventional prefixes (`feat:`, `fix:`, `docs:`,
`chore:`, `test:`), no emoji. One logical change per commit.

## Reporting issues

Include the server log, the browser console output, and the `npm test`
result.
