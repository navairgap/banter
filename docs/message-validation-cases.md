# message validation cases

Message validation cases: reject missing and non-string message bodies,
whitespace-only text, and values beyond the configured length limit.
Verify rejected messages are not broadcast AND that each rejection is
acknowledged with `{ ok: false, error }` so the client can surface it —
silent drops are reserved for unauthenticated or unjoined sockets.
Rejected messages must not consume rate-limit quota; the documented rate
limit (8 per 10 seconds) applies to valid messages only. Confirm accepted
messages preserve ordinary Unicode, emoji, and embedded newlines. Ensure
server-derived sender identity cannot be overridden by client fields.
Keep tests isolated from public rooms and avoid logging complete message
contents.

Client-side rendering cases: user text is always inserted with
`textContent` (never markup); http(s) URLs are linkified by constructing
`<a>` nodes with `textContent` and `rel="noopener noreferrer nofollow"` —
no other URL scheme is linkified, and link text is never interpreted as
HTML. Newlines are preserved via `white-space: pre-wrap`.
