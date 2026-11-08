# socket event contract (v3)

Validate every Socket.IO payload as untrusted input. Check payload types
and required fields before accessing nested values. Rejected payloads must
never broadcast, never mutate state, and never consume rate-limit quota
(validation runs before the limiter).

Sessions are identified by `socket.handshake.auth.sessionId` (8–64 chars,
`[a-zA-Z0-9_-]`). Conversations are namespaced per session; one session can
never read or open another session's conversations.

## Events

| Event          | Direction | Payload                         | Ack |
|----------------|-----------|----------------------------------|-----|
| `conv:list`    | C → S     | none or `null`                   | `{ ok, conversations }` — handler accepts both arities |
| `conv:create`  | C → S     | `{ title? }`                     | `{ ok, conversation }` |
| `conv:open`    | C → S     | `{ id }`                         | `{ ok, conversation, messages }` / `{ ok: false }` |
| `conv:delete`  | C → S     | `{ id }`                         | `{ ok }`; aborts an in-flight generation |
| `conv:skills`  | C → S     | `{ id, skills: string[] }`       | `{ ok, skills }`; unknown skill names are dropped |
| `chat:send`    | C → S     | `{ conversationId, text }`       | `{ ok, userMessage, conversation }` or `{ ok: false, error }` |
| `chat:stop`    | C → S     | `{ conversationId }`             | none — aborts the generation |
| `chat:delta`   | S → C     | `{ conversationId, text }`       | streamed token |
| `chat:done`    | S → C     | `{ conversationId, conversation, aborted? }` | generation finished |
| `chat:error`   | S → C     | `{ conversationId, error }`      | generation failed; nothing broadcast |

## Guarantees

- One generation per conversation at a time; a second `chat:send` while
  generating is rejected with `already generating`.
- `chat:send` validates payload shape, text length (8000 chars), and
  provider readiness (API key + model) before mutating the conversation.
  The user message is stored before streaming starts; the assistant message
  is stored only if it has content (aborted partial replies count).
- An acked `chat:send` is followed by exactly one of `chat:done` or
  `chat:error` on the same socket.
- REST settings endpoints never return API keys — only `apiKeySet`.
- Installed skills must parse as SKILL.md with a valid name; unknown names
  in `conv:skills` are silently dropped.
