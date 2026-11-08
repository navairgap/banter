# message validation cases

Message validation cases: reject missing and non-string message bodies,
whitespace-only text, and values beyond the configured length limit
(8000 chars). Verify rejected messages are not broadcast and not stored,
and that each rejection is acknowledged with `{ ok: false, error }`.

Provider readiness is validated before a conversation is mutated: with no
API key configured, `chat:send` fails with a "no API key" error and makes
no network request.

Skill injection cases: `conv:skills` accepts only known skill names
(unknown entries are dropped), stores them on the conversation, and the
next generation's system prompt contains `Active skills: …` followed by
each enabled skill's body. Installed skills shadow built-ins with the
same name; removing the copy restores the built-in.

Client-side rendering cases: user text and model output are always
inserted with `textContent` (never markup); model markdown is rebuilt
from a DOM whitelist — fenced code, lists, bold, inline code, and
http(s) links only, with `rel="noopener noreferrer nofollow"`. No other
URL scheme is linkified and link text is never interpreted as HTML.

Config cases: API keys are write-only — every settings response reports
`apiKeySet` instead of the key; an empty key field keeps the stored key;
the explicit clear flag removes it. Config is persisted with
owner-only file permissions.
