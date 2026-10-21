# socket event contract

Validate every Socket.IO payload as untrusted input. Check payload types and required fields before accessing nested values. Reject non-string messages, empty text, and over-limit room names. Derive sender identity from server-side socket state rather than client-supplied usernames. Regression cases should include null, arrays, numbers, missing fields, whitespace-only text, over-limit input, and reconnects during active rooms. Rejected payloads must never be broadcast.
