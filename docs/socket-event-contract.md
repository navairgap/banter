# socket event contract (v2)

Validate every Socket.IO payload as untrusted input. Check payload types
and required fields before accessing nested values. Derive sender identity
from server-side socket state rather than client-supplied usernames.
Rejected payloads must never be broadcast.

## Wire format v2

- Timestamps are epoch milliseconds in a `ts` field. The client formats
  them with its own locale and timezone; the server never renders time.
- The `rooms` event carries `{ name, count }[]` sorted by name — member
  counts are part of the roster broadcast, computed in one pass.
- The `users` event carries `string[]` — server-unique nicknames within
  the room, sorted case-insensitively.

## Acknowledgement and delivery guarantees

| Event      | Acknowledges                                    |
|------------|--------------------------------------------------|
| `join`     | validation failure, rate limit, room limit, success (`{ ok, name, room }` with the server-resolved nickname) |
| `message`  | validation failure, rate limit, success          |
| `typing`   | success only; invalid payloads are dropped silently (fire-and-forget) |
| `new room` | "join first", validation failure, rate limit, room limit, success |

Never send both a success acknowledgement and a failure-shaped payload
for the same request. A dropped (unacknowledged) event is a contract
violation except for `typing` with an invalid payload.

Validation happens **before** the rate limiter on every event: garbage
must not consume a client's quota. The rate limiter still runs before any
broadcast or state mutation.

## Room lifecycle and reconnect behavior

A socket belongs to at most one room at a time. Switching rooms must
remove the previous membership before adding the new one, and disconnect
must clear the server-side user record, per-socket rate-limit counters,
and any empty non-default room (respecting other creators' pending
reservations).

Re-joining the room a socket already occupies — same room, same resolved
nickname — is a silent no-op: success ack, no `system` broadcast, no
roster churn. This is what makes client reconnects invisible.

A reconnect is a new socket identity: no username or room is restored
server-side; the *client* re-emits `join` with its current desired state,
which is also how a mid-session room switch survives a reconnect.
Integration tests should assert that disconnected users disappear from
room lists and cannot receive later broadcasts.

## Room reservations

`new room` reserves an empty non-default room for its creator. Multiple
creators may share one reservation; a reservation only disappears when
its last creator disconnects without joining, or when anyone joins the
room. Default rooms (lobby, tech, random) are never reserved and never
deleted.

## Shutdown

SIGTERM/SIGINT stop accepting connections, disconnect every socket with a
proper socket.io disconnect packet (clients reconnect cleanly if the
process comes back), close the listener, drop idle keep-alive HTTP
sockets, and exit 0. A force timer bounds the drain. Integration tests
assert the client-visible disconnect and the exit request.
