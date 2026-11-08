/**
 * LLM provider adapters for banter.
 *
 * One adapter covers every OpenAI-compatible endpoint (OpenAI, xAI, Groq,
 * DeepSeek, Mistral, Together, OpenRouter, Ollama, LM Studio, vLLM), plus
 * dedicated adapters for Anthropic and Google Gemini. A built-in mock
 * provider streams deterministic replies so the harness works with no keys
 * and the test suite can run offline.
 *
 * All adapters speak the same interface:
 *   streamChat({ provider, baseUrl, apiKey, model, system, messages,
 *                signal, onDelta }) -> resolves with the full text
 */

const PRESETS = {
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini", "gpt-4.1"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    label: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  groq: {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyUrl: "https://console.groq.com/keys",
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  mistral: {
    label: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest"],
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  xai: {
    label: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-3", "grok-3-mini"],
    keyUrl: "https://console.x.ai",
  },
  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-haiku",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    keyUrl: "https://openrouter.ai/keys",
  },
  ollama: {
    label: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.2", "qwen2.5-coder", "mistral", "phi4"],
    keyUrl: "https://ollama.com/download",
  },
  lmstudio: {
    label: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    models: ["local-model"],
    keyUrl: "https://lmstudio.ai",
  },
  mock: {
    label: "Mock (no network)",
    kind: "mock",
    baseUrl: "",
    models: ["mock-1"],
    keyUrl: "",
  },
};

/** Build an OpenAI-compatible chat/completions request. */
function buildOpenAIRequest({ baseUrl, apiKey, model, system, messages }) {
  const messagesOut = [];
  if (system) messagesOut.push({ role: "system", content: system });
  for (const m of messages) messagesOut.push({ role: m.role, content: m.content });
  return {
    url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: { model, messages: messagesOut, stream: true },
  };
}

/** Build an Anthropic messages request. */
function buildAnthropicRequest({ baseUrl, apiKey, model, system, messages }) {
  return {
    url: `${baseUrl.replace(/\/$/, "")}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    },
  };
}

/** Build a Gemini streamGenerateContent request. */
function buildGeminiRequest({ baseUrl, apiKey, model, system, messages }) {
  return {
    url:
      `${baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    headers: { "content-type": "application/json" },
    body: {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    },
  };
}

/** Iterate server-sent events from a fetch Response body. */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return parsed.error?.message || parsed.message || text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Validate a provider/skill base URL: http(s) only, no embedded
 * credentials. Loopback and private hosts stay allowed — local model
 * servers (Ollama, LM Studio) are a core feature of this harness.
 */
function assertHttpUrl(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not embed credentials`);
  }
  return parsed;
}

const dns = require("dns").promises;
const ALLOW_PRIVATE_FETCH = process.env.BANTER_ALLOW_PRIVATE_FETCH === "1";

function isPrivateIp(address, family) {
  if (family === 4 || !address.includes(":")) {
    const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const v = address.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (/^f[de]/.test(v)) return true; // fe80::/10 link-local, fc00::/7 unique-local
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIp(mapped[1], 4);
  return false;
}

function isLiteralLoopbackHost(host) {
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Full fetch-target check: scheme/credential validation plus DNS
 * resolution to reject targets that resolve to private, loopback, or
 * link-local addresses. Literal loopback hosts are exempt when
 * allowLoopback is set (local model servers, local skill registries).
 * Set BANTER_ALLOW_PRIVATE_FETCH=1 to permit private network targets
 * (e.g. a model server on your LAN).
 */
async function assertFetchTarget(raw, { label, allowLoopback = false }) {
  const parsed = assertHttpUrl(raw, label);
  const host = parsed.hostname.toLowerCase();
  if (allowLoopback && isLiteralLoopbackHost(host)) return parsed;
  const records = await dns.lookup(host, { all: true }).catch(() => null);
  if (!records || records.length === 0) {
    throw new Error(`${label} host could not be resolved`);
  }
  if (!ALLOW_PRIVATE_FETCH) {
    for (const { address, family } of records) {
      if (isPrivateIp(address, family)) {
        throw new Error(
          `${label} resolves to a private address (${address}) — ` +
          `set BANTER_ALLOW_PRIVATE_FETCH=1 to allow`
        );
      }
    }
  }
  return parsed;
}

/** Stream a chat completion from any provider. Resolves with full text. */
async function streamChat(options) {
  const { provider, signal, onDelta } = options;
  const preset = PRESETS[provider];
  if (!preset) throw new Error(`unknown provider: ${provider}`);

  if (preset.kind === "mock") return streamMock(options);

  let request;
  if (preset.kind === "openai") request = buildOpenAIRequest(options);
  else if (preset.kind === "anthropic") request = buildAnthropicRequest(options);
  else if (preset.kind === "gemini") request = buildGeminiRequest(options);
  else throw new Error(`unsupported provider kind: ${preset.kind}`);

  await assertFetchTarget(request.url, { label: "provider base URL", allowLoopback: true });
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`${preset.label} API error: ${await readErrorBody(response)}`);
  }

  let full = "";
  for await (const data of sseEvents(response)) {
    if (data === "[DONE]") break;
    let delta;
    try {
      const parsed = JSON.parse(data);
      if (preset.kind === "openai") {
        delta = parsed.choices?.[0]?.delta?.content ?? "";
      } else if (preset.kind === "anthropic") {
        delta = parsed.delta?.type === "text_delta" ? parsed.delta.text : "";
      } else {
        delta = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
      }
    } catch {
      delta = "";
    }
    if (delta) {
      full += delta;
      if (onDelta) onDelta(delta);
    }
  }
  return full;
}

/** Deterministic offline provider: echoes input and names active skills. */
async function streamMock({ system, messages, signal, onDelta }) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const skillMatch = system ? system.match(/Active skills: ([^\n]+)/) : null;
  const lines = [
    `[mock] You said: ${(lastUser && lastUser.content) || "(nothing)"}`,
  ];
  if (skillMatch) lines.push(`[mock] active skills: ${skillMatch[1]}`);
  lines.push(`[mock] configure a real provider in Settings to talk to a model.`);
  const text = lines.join("\n");
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (signal && signal.aborted) return full_so_far(words, i);
    onDelta((i === 0 ? "" : " ") + words[i]);
    await new Promise((r) => setTimeout(r, 8));
  }
  return text;
}

function full_so_far(words, upto) {
  return words.slice(0, upto).join(" ");
}

module.exports = {
  PRESETS,
  buildOpenAIRequest,
  buildAnthropicRequest,
  buildGeminiRequest,
  assertHttpUrl,
  assertFetchTarget,
  isPrivateIp,
  streamChat,
};
