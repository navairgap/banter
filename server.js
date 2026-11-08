/**
 * banter server — a local-first AI chat harness.
 *
 * Express + Socket.IO, no database: conversations live in memory and reset
 * on restart. LLM traffic goes through lib/providers (OpenAI-compatible,
 * Anthropic, Gemini, or the offline mock). Skills are SKILL.md files from
 * lib/skills. API keys stay in $BANTER_HOME/config.json and never reach
 * the client.
 */

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const pkg = require("./package.json");
const {
  loadConfig,
  updateConfig,
  maskConfig,
  assertChatReady,
} = require("./lib/config");
const {
  listSkills,
  installSkillFromUrl,
  removeSkill,
  buildSystemPrompt,
} = require("./lib/skills");
const { PRESETS, streamChat, assertHttpUrl, assertFetchTarget } = require("./lib/providers");

const MAX_TEXT_LEN = 8000;
const MAX_MESSAGES_PER_CONV = 200;
const MAX_CONVERSATIONS = 50;
const HISTORY_WINDOW = 30; // messages sent to the model
const SESSION_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    try {
      const parsed = new URL(origin);
      if (parsed.host !== req.headers.host) return callback("origin not allowed", false);
      return callback(null, true);
    } catch {
      return callback("invalid origin", false);
    }
  },
});

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

const revalidate = { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") };
app.use("/styles", express.static(path.join(__dirname, "styles"), revalidate));
app.use("/js", express.static(path.join(__dirname, "js"), revalidate));
app.use("/docs", express.static(path.join(__dirname, "docs"), { maxAge: "1h" }));
app.use("/skills", express.static(path.join(__dirname, "skills"), revalidate));
app.get("/", (_req, res) =>
  res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "index.html"))
);
app.get("/healthz", (_req, res) =>
  res.set("Cache-Control", "no-store").json({
    ok: true,
    version: pkg.version,
    uptime: Math.round(process.uptime()),
    provider: loadConfig().activeProvider,
  })
);

/* ---------------- REST: settings + skills ---------------- */

app.get("/api/config", (_req, res) => {
  res.set("Cache-Control", "no-store").json({ ok: true, config: maskConfig(loadConfig()) });
});

app.post("/api/config", (req, res) => {
  const patch = req.body || {};
  if (patch.provider && !PRESETS[patch.provider]) {
    return res.status(400).json({ ok: false, error: "unknown provider" });
  }
  for (const field of ["baseUrl", "model", "apiKey"]) {
    if (patch[field] !== undefined && typeof patch[field] !== "string") {
      return res.status(400).json({ ok: false, error: `${field} must be a string` });
    }
  }
  if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) {
    try {
      assertHttpUrl(patch.baseUrl.trim(), "base URL");
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
  const config = updateConfig(patch);
  res.json({ ok: true, config: maskConfig(config) });
});

app.post("/api/config/test", async (req, res) => {
  const patch = req.body || {};
  let effective = loadConfig();
  if (patch.provider || patch.baseUrl || patch.model || patch.apiKey) {
    effective = updateConfig(patch); // persist what the user asked to test
  }
  const entry = effective.providers[effective.activeProvider];
  const preset = PRESETS[effective.activeProvider];
  if (effective.activeProvider === "mock") {
    return res.json({ ok: true, provider: "mock", models: ["mock-1"] });
  }
  if (!entry.apiKey) {
    return res.json({
      ok: false,
      provider: effective.activeProvider,
      error: "no API key set",
    });
  }
  try {
    await assertFetchTarget(entry.baseUrl, {
      label: "base URL",
      allowLoopback: true, // local model servers are a core feature
    });
  } catch (err) {
    return res.json({
      ok: false,
      provider: effective.activeProvider,
      error: err.message,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let url;
    const headers = {};
    if (preset.kind === "openai") {
      url = `${entry.baseUrl.replace(/\/$/, "")}/models`;
      headers.authorization = `Bearer ${entry.apiKey}`;
    } else if (preset.kind === "anthropic") {
      url = `${entry.baseUrl.replace(/\/$/, "")}/v1/models`;
      headers["x-api-key"] = entry.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      url = `${entry.baseUrl.replace(/\/$/, "")}/v1beta/models`;
      url += `?key=${encodeURIComponent(entry.apiKey)}`;
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return res.json({
        ok: false,
        provider: effective.activeProvider,
        error: `HTTP ${response.status}`,
      });
    }
    const body = await response.json();
    const models = (body.data || body.models || [])
      .map((m) => m.id || m.name)
      .filter(Boolean)
      .slice(0, 50)
      .map((id) => String(id).replace(/^models\//, ""));
    res.json({ ok: true, provider: effective.activeProvider, models });
  } catch (err) {
    res.json({
      ok: false,
      provider: effective.activeProvider,
      error: err.name === "AbortError" ? "timed out" : err.message,
    });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/api/skills", (_req, res) => {
  res.json({ ok: true, skills: listSkills() });
});

app.post("/api/skills/install", async (req, res) => {
  const url = req.body && req.body.url;
  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ ok: false, error: "url is required" });
  }
  try {
    const skill = await installSkillFromUrl(url.trim());
    res.json({ ok: true, skill });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/skills/:name", (req, res) => {
  try {
    removeSkill(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ---------------- conversations (in memory) ---------------- */

/** sessionId -> Map<convId, conversation> */
const sessions = new Map();
/** convId -> AbortController for in-flight generations */
const generating = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, new Map());
  return sessions.get(sessionId);
}

function conversationView(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    skills: [...conv.skills],
  };
}

function listConversations(sessionId) {
  return [...getSession(sessionId).values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(conversationView);
}

function createConversation(sessionId, title) {
  const convs = getSession(sessionId);
  if (convs.size >= MAX_CONVERSATIONS) return null;
  const conv = {
    id: crypto.randomUUID(),
    title: (title || "New chat").slice(0, 80),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    skills: new Set(),
    messages: [],
  };
  convs.set(conv.id, conv);
  return conv;
}

function getConversation(sessionId, convId) {
  const conv = getSession(sessionId).get(convId);
  return conv || null;
}

function buildMessagesForModel(conv) {
  const trimmed = conv.messages.slice(-HISTORY_WINDOW);
  return trimmed
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

/* ---------------- socket: chat harness events ---------------- */

function ack(ackFn, payload) {
  if (typeof ackFn === "function") ackFn(payload);
}

io.on("connection", (socket) => {
  const sessionId =
    typeof socket.handshake.auth?.sessionId === "string" &&
    SESSION_RE.test(socket.handshake.auth.sessionId)
      ? socket.handshake.auth.sessionId
      : socket.id;

  socket.on("conv:list", (payload, ackFn) => {
    // emitted both with and without a payload — accept either arity
    if (typeof payload === "function") ackFn = payload;
    ack(ackFn, { ok: true, conversations: listConversations(sessionId) });
  });

  socket.on("conv:create", (payload, ackFn) => {
    const title =
      payload && typeof payload.title === "string" ? payload.title : undefined;
    const conv = createConversation(sessionId, title);
    if (!conv) return ack(ackFn, { ok: false, error: "conversation limit reached" });
    ack(ackFn, { ok: true, conversation: conversationView(conv) });
  });

  socket.on("conv:open", (payload, ackFn) => {
    const conv =
      payload && typeof payload.id === "string"
        ? getConversation(sessionId, payload.id)
        : null;
    if (!conv) return ack(ackFn, { ok: false, error: "conversation not found" });
    ack(ackFn, {
      ok: true,
      conversation: conversationView(conv),
      messages: conv.messages,
    });
  });

  socket.on("conv:delete", (payload, ackFn) => {
    const conv =
      payload && typeof payload.id === "string"
        ? getConversation(sessionId, payload.id)
        : null;
    if (!conv) return ack(ackFn, { ok: false, error: "conversation not found" });
    const controller = generating.get(conv.id);
    if (controller) controller.abort();
    getSession(sessionId).delete(conv.id);
    ack(ackFn, { ok: true });
  });

  socket.on("conv:skills", (payload, ackFn) => {
    const conv =
      payload && typeof payload.id === "string"
        ? getConversation(sessionId, payload.id)
        : null;
    if (!conv) return ack(ackFn, { ok: false, error: "conversation not found" });
    if (!Array.isArray(payload.skills)) {
      return ack(ackFn, { ok: false, error: "skills must be an array" });
    }
    const known = new Set(listSkills().map((s) => s.name));
    conv.skills = new Set(payload.skills.filter((s) => known.has(s)));
    conv.updatedAt = Date.now();
    ack(ackFn, { ok: true, skills: [...conv.skills] });
  });

  socket.on("chat:send", async (payload, ackFn) => {
    if (!payload || typeof payload !== "object" ||
        typeof payload.conversationId !== "string" ||
        typeof payload.text !== "string") {
      return ack(ackFn, { ok: false, error: "invalid chat payload" });
    }
    const text = payload.text.trim();
    if (!text) return ack(ackFn, { ok: false, error: "message is empty" });
    if (text.length > MAX_TEXT_LEN) {
      return ack(ackFn, { ok: false, error: `message over ${MAX_TEXT_LEN} characters` });
    }
    const conv = getConversation(sessionId, payload.conversationId);
    if (!conv) return ack(ackFn, { ok: false, error: "conversation not found" });
    if (generating.has(conv.id)) {
      return ack(ackFn, { ok: false, error: "already generating — stop first" });
    }

    let chatConfig;
    try {
      chatConfig = assertChatReady(loadConfig());
    } catch (err) {
      return ack(ackFn, { ok: false, error: err.message });
    }

    const userMessage = { role: "user", content: text, ts: Date.now() };
    conv.messages.push(userMessage);
    if (conv.messages.length > MAX_MESSAGES_PER_CONV) {
      conv.messages.splice(0, conv.messages.length - MAX_MESSAGES_PER_CONV);
    }
    if (conv.title === "New chat" || conv.messages.length === 1) {
      conv.title = text.slice(0, 60);
    }
    conv.updatedAt = Date.now();

    const assistantMessage = { role: "assistant", content: "", ts: Date.now() };
    const controller = new AbortController();
    generating.set(conv.id, controller);

    ack(ackFn, {
      ok: true,
      userMessage,
      conversation: conversationView(conv),
    });

    try {
      await streamChat({
        provider: chatConfig.provider,
        baseUrl: chatConfig.baseUrl,
        apiKey: chatConfig.apiKey,
        model: chatConfig.model,
        system: buildSystemPrompt([...conv.skills]),
        messages: buildMessagesForModel(conv),
        signal: controller.signal,
        onDelta: (delta) => {
          assistantMessage.content += delta;
          socket.emit("chat:delta", { conversationId: conv.id, text: delta });
        },
      });
      if (assistantMessage.content) conv.messages.push(assistantMessage);
      conv.updatedAt = Date.now();
      socket.emit("chat:done", {
        conversationId: conv.id,
        conversation: conversationView(conv),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        if (assistantMessage.content) conv.messages.push(assistantMessage);
        socket.emit("chat:done", {
          conversationId: conv.id,
          aborted: true,
          conversation: conversationView(conv),
        });
      } else {
        socket.emit("chat:error", {
          conversationId: conv.id,
          error: err.message || "generation failed",
        });
      }
    } finally {
      generating.delete(conv.id);
    }
  });

  socket.on("chat:stop", (payload) => {
    const conv =
      payload && typeof payload.conversationId === "string"
        ? getConversation(sessionId, payload.conversationId)
        : null;
    if (conv && generating.has(conv.id)) generating.get(conv.id).abort();
  });
});

/* ---------------- lifecycle ---------------- */

/** Listen; resolves once the server accepts connections. */
function start({
  port = Number(process.env.PORT) || 3000,
  host = process.env.HOST || "0.0.0.0",
} = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

let draining = false;
function shutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`${signal} received — draining connections`);
  for (const controller of generating.values()) controller.abort();
  server.close(() => process.exit(0));
  io.disconnectSockets();
  setTimeout(() => {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  }, 100).unref();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  start({ port })
    .then(() =>
      console.log(`banter v${pkg.version} listening on http://localhost:${port}`)
    )
    .catch((err) => {
      console.error(`banter could not start: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { app, io, server, start, shutdown };
