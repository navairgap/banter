<p align="center">
  <a href="https://github.com/navairgap/banter/actions/workflows/ci.yml"><img src="https://github.com/navairgap/banter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/deps-express%20%2B%20socket.io-orange.svg" alt="Express + Socket.IO">
</p>

banter is a local-first AI chat harness. It runs on your machine, talks to
any major model provider — or a local model — and ships with a library of
preinstalled skills that change how the model responds. Conversations live
in process memory, API keys live in a local file, and nothing is sent
anywhere except to the provider you configure.

```bash
git clone https://github.com/navairgap/banter.git
cd banter
npm install
npm start          # http://localhost:3000
```

Node.js 18 or newer. `npm run dev` watches for changes during development.

On first run, open Settings (the `b` button in the left rail), pick a
provider, and paste an API key. Or select **Mock (no network)** to try the
interface without any key.

## Providers

One configuration covers hosted and local models. Keys are stored in
`~/.banter/config.json` with owner-only permissions and are never returned
by the API — the client only learns whether a key is present.

| Provider | Type | Default base URL | Notes |
|----------|------|------------------|-------|
| OpenAI | hosted | `https://api.openai.com/v1` | |
| Anthropic | hosted | `https://api.anthropic.com` | |
| Google Gemini | hosted | `https://generativelanguage.googleapis.com` | |
| Groq | hosted | `https://api.groq.com/openai/v1` | |
| DeepSeek | hosted | `https://api.deepseek.com/v1` | |
| Mistral | hosted | `https://api.mistral.ai/v1` | |
| xAI Grok | hosted | `https://api.x.ai/v1` | |
| OpenRouter | hosted | `https://openrouter.ai/api/v1` | routes to most models |
| Ollama | local | `http://localhost:11434/v1` | no key needed |
| LM Studio | local | `http://localhost:1234/v1` | no key needed |
| Mock | offline | — | deterministic, for tests and demos |

Everything except Anthropic and Gemini uses the OpenAI-compatible
protocol, so any endpoint that speaks it — vLLM, llama.cpp server,
Together, or a self-hosted gateway — works through the same adapter.

Settings has a **Test & list models** button that validates the key
against the provider and fills the model dropdown from its `/models`
endpoint.

## Skills

Skills are small instruction packs injected into a conversation's system
prompt when you toggle them on. They use the `SKILL.md` format with
frontmatter (`name`, `description`) and a markdown instruction body — the
same format used by community skill repositories.

Eight ship preinstalled: `code-review`, `debugging`, `explain-simply`,
`writing-coach`, `summarize`, `regex-builder`, `sql-assistant`, and
`skill-creator`.

The skill library dialog installs from any URL to a raw `SKILL.md` file
(https, or http on localhost). Installed skills are stored in
`~/.banter/skills/` and can be removed; installing a skill that shares a
name with a built-in shadows it, and removing the copy restores the
built-in.

To write your own, enable the `skill-creator` skill and ask for a SKILL.md
— it emits files that follow this harness's rules.

## How it works

```
Browser (js/app.js) --socket.io--> server.js --fetch(stream)--> LLM provider
                                        |
                                 lib/providers   adapters + SSE parsing
                                 lib/skills      SKILL.md loader + injection
                                 lib/config      key storage (never leaves)
```

Streaming is token-by-token: the server relays provider deltas over the
socket, the client renders plain text while streaming and re-renders
markdown when the reply completes. A stop button aborts the provider
request server-side.

## Testing

```bash
npm test
```

The integration suite runs the harness in-process on a scratch port with
an isolated `BANTER_HOME` and drives real socket.io clients over TCP:
config key-masking, skill install/remove/shadow semantics, provider
request builders, mock-provider streaming, skill injection into the
system prompt, validation limits, and per-session conversation isolation.
CI runs it on Node 18 / 20 / 22 / 24 for every push and pull request.

## Configuration

| Variable     | Default              | Meaning |
|--------------|----------------------|---------|
| `PORT`       | `3000`               | Listen port |
| `HOST`       | all interfaces       | Bind address |
| `BANTER_HOME`| `~/.banter`          | Config and installed skills directory |
| `BANTER_ALLOW_PRIVATE_FETCH` | unset | `1` = allow model endpoints on your LAN (e.g. `http://192.168.x.x`). Loopback hosts (localhost, 127.0.0.1) are always allowed; all other fetch targets are DNS-checked and must resolve to public addresses. |

Server-side limits: messages 8000 chars, 200 messages per conversation,
50 conversations per session, 30-message context window sent to the
model. `GET /healthz` returns `{ ok, version, uptime, provider }`.

SIGTERM and SIGINT drain the server: abort in-flight generations, close
sockets, exit 0.

## Security model

- API keys never leave the server; the config API returns only
  `apiKeySet: true/false`.
- All user and model content is rendered with `textContent`; model
  markdown is rebuilt from a DOM whitelist, never `innerHTML`.
- Skill installs are https-only (http allowed on loopback), capped at
  256 KB, with a 10-second timeout.
- Same-origin checks on the socket handshake; CSP with `script-src 'self'`
  on every response.
- Conversations are in-memory and scoped to a random per-browser session
  id; a restart wipes them.

## Project layout

```
server.js          HTTP + Socket.IO harness: conversations, streaming, APIs
lib/providers.js   OpenAI-compatible / Anthropic / Gemini / mock adapters
lib/skills.js      SKILL.md loader, system-prompt builder, installer
lib/config.js      provider settings and key storage (~/.banter)
skills/            preinstalled skills (code-review, debugging, …)
index.html         app shell: rail, conversations, chat, skills panel
styles/main.css    dark theme, responsive layout
js/app.js          client: conversations, streaming, markdown-lite, dialogs
test/smoke.js      in-process integration suite
docs/              wire contract, validation cases
```

## Scope and non-goals

- No persistence by design: conversations reset on restart.
- No multi-user relay — this is a single-operator local tool; each browser
  session is isolated.
- No tool execution, shell access, or file editing yet. The harness talks
  to models; it does not act on your machine.
- No telemetry, no accounts, no database.

## License

MIT — see [LICENSE](LICENSE).
