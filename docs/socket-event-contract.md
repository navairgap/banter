# socket event contract

Validate every Socket.IO payload as untrusted input. Check payload types and required fields before accessing nested values. Reject non-string messages, empty text, and over-limit room names. Derive sender identity from server-side socket state rather than client-supplied usernames. Regression cases should include null, arrays, numbers, missing fields, whitespace-only text, over-limit input, and reconnects during active rooms. Rejected payloads must never be broadcast.

## Acknowledgement and delivery guarantees

Acknowledgements are part of the event contract: document whether each event acknowledges success, validation failure, rate limiting, or a room limit. Never send both a success acknowledgement and a failure-shaped payload for the same request. Events that intentionally drop invalid payloads should be documented as fire-and-forget. Integration tests should assert that a rejected event is not broadcast to another client, and that disconnect cleanup removes room membership and per-socket rate-limit state.

## Room lifecycle and reconnect behavior

A socket belongs to at most one room at a time. Switching rooms must remove the previous membership before adding the new one, and disconnect must clear the server-side user record, per-socket rate-limit counters, and any empty non-default room. A reconnect is a new socket identity: do not restore a previous username or room unless a future authenticated persistence feature explicitly defines that behavior. Integration tests should assert that disconnected users disappear from room lists and cannot receive later broadcasts.
