/**
 * Integration test: runs the harness server in-process on a scratch port and
 * exercises the AI chat flow end to end — config masking, skills, mock
 * provider streaming, skill injection, provider adapters, and failures.
 *
 * Run with: npm test
 */

const { io } = require("socket.io-client");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Isolated harness home BEFORE server modules load (config + user skills).
const BANTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "banter-test-"));
process.env.BANTER_HOME = BANTER_HOME;

const {
  server,
  io: ios,
  start,
} = require("../server.js");
const {
  buildOpenAIRequest,
  buildAnthropicRequest,
  buildGeminiRequest,
  isPrivateIp,
} = require("../lib/providers.js");

const PORT = 3463;
const URL = `http://127.0.0.1:${PORT}`;

function client(sessionId) {
  return io(URL, { transports: ["websocket"], forceNew: true, auth: { sessionId } });
}

function once(sock, event, timeoutMs = 4000) {
  const at = (new Error().stack.split("\n")[2] || "").trim();
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting for "${event}" (registered at ${at})`)),
      timeoutMs
    );
    sock.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

function emitAck(sock, event, payload) {
  return new Promise((resolve) => {
    sock.emit(event, payload, function (res) { resolve(res); });
  });
}

function nothingArrives(sock, event, timeoutMs, failMessage) {
  return once(sock, event, timeoutMs).then(
    () => { throw new Error(failMessage); },
    (err) => {
      if (!err.message.startsWith("timeout waiting for")) throw err;
    }
  );
}

const post = (route, body) =>
  fetch(`${URL}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function main() {
  await start({ port: PORT });

  const a = client("session-aaaaaaaaaaaaaaaa");
  const b = client("session-bbbbbbbbbbbbbbbb");
  await once(a, "connect");
  await once(b, "connect");

  try {
    // ---- health + headers ----
    const health = await fetch(`${URL}/healthz`);
    const healthBody = await health.json();
    if (!health.ok || healthBody.ok !== true || healthBody.provider !== "openai") {
      throw new Error("health endpoint wrong: " + JSON.stringify(healthBody));
    }
    if (health.headers.get("x-frame-options") !== "DENY" ||
        health.headers.get("content-security-policy") === null) {
      throw new Error("hardening headers missing");
    }

    // ---- config masking: keys never leave the server ----
    await post("/api/config", { provider: "openai", apiKey: "sk-super-secret", model: "gpt-4o" });
    const cfgRes = await fetch(`${URL}/api/config`);
    const cfgText = await cfgRes.text();
    if (cfgText.includes("sk-super-secret")) {
      throw new Error("API key leaked through /api/config");
    }
    const cfg = JSON.parse(cfgText);
    if (!cfg.config.providers.openai.apiKeySet || cfg.config.providers.openai.apiKey) {
      throw new Error("config mask wrong: " + cfgText);
    }

    const badProvider = await post("/api/config", { provider: "not-a-provider" });
    if (badProvider.status !== 400) throw new Error("unknown provider was accepted");

    // ---- skills: built-ins + install + remove ----
    const skillsRes = await fetch(`${URL}/api/skills`);
    const skillsBody = await skillsRes.json();
    const names = skillsBody.skills.map((s) => s.name);
    for (const expected of ["code-review", "debugging", "skill-creator", "summarize"]) {
      if (!names.includes(expected)) throw new Error("missing built-in skill: " + expected);
    }
    const review = skillsBody.skills.find((s) => s.name === "code-review");
    if (!review.builtin || review.body.length < 100 || !review.description) {
      throw new Error("built-in skill metadata incomplete");
    }

    const installRes = await post("/api/skills/install", {
      url: `${URL}/skills/code-review/SKILL.md`, // own origin, loopback http
    });
    const installBody = await installRes.json();
    if (!installBody.ok || installBody.skill.name !== "code-review") {
      throw new Error("skill install failed: " + JSON.stringify(installBody));
    }
    // The installed copy shadows the built-in (user wins)…
    const afterInstall = await (await fetch(`${URL}/api/skills`)).json();
    const shadow = afterInstall.skills.find((s) => s.name === "code-review");
    if (!shadow || shadow.builtin !== false) {
      throw new Error("installed skill does not shadow the built-in");
    }
    const badUrl = await post("/api/skills/install", { url: "ftp://example.com/x.md" });
    if (badUrl.status !== 400) throw new Error("non-https external URL was accepted");
    // …and removing it restores the built-in.
    const removeRes = await fetch(`${URL}/api/skills/code-review`, { method: "DELETE" });
    if (!(await removeRes.json()).ok) throw new Error("skill removal failed");
    const afterRemove = await (await fetch(`${URL}/api/skills`)).json();
    const restored = afterRemove.skills.find((s) => s.name === "code-review");
    if (!restored || restored.builtin !== true) {
      throw new Error("built-in skill did not reappear after removal");
    }
    const removeMissing = await fetch(`${URL}/api/skills/code-review`, { method: "DELETE" });
    if ((await removeMissing.json()).ok !== false) {
      throw new Error("removing a non-installed skill succeeded");
    }

    // ---- provider adapters (pure request builders) ----
    const oai = buildOpenAIRequest({
      baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m",
      system: "sys", messages: [{ role: "user", content: "hi" }],
    });
    if (oai.url !== "https://api.openai.com/v1/chat/completions" ||
        oai.headers.authorization !== "Bearer k" ||
        oai.body.messages[0].role !== "system" || oai.body.messages[1].role !== "user") {
      throw new Error("OpenAI request builder wrong: " + JSON.stringify(oai));
    }
    const ant = buildAnthropicRequest({
      baseUrl: "https://api.anthropic.com", apiKey: "k", model: "m",
      system: "sys", messages: [{ role: "assistant", content: "yo" }],
    });
    if (ant.url !== "https://api.anthropic.com/v1/messages" ||
        !ant.body.system || ant.body.messages[0].role !== "assistant" ||
        !ant.headers["x-api-key"]) {
      throw new Error("Anthropic request builder wrong");
    }
    const gem = buildGeminiRequest({
      baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k  ", model: "m",
      system: "sys", messages: [{ role: "user", content: "hi" }],
    });
    if (!gem.url.includes("models/m:streamGenerateContent?alt=sse&key=k") ||
        gem.body.contents[0].role !== "user") {
      throw new Error("Gemini request builder wrong: " + gem.url);
    }

    // private-IP classification used by the fetch guard
    for (const [ip, family, expected] of [
      ["10.1.2.3", 4, true], ["127.0.0.1", 4, true], ["192.168.5.5", 4, true],
      ["172.16.0.9", 4, true], ["169.254.9.9", 4, true], ["::1", 6, true],
      ["fd00::1", 6, true], ["::ffff:10.0.0.1", 6, true],
      ["8.8.8.8", 4, false], ["1.1.1.1", 4, false], ["2606:4700::1", 6, false],
    ]) {
      if (isPrivateIp(ip, family) !== expected) {
        throw new Error(`isPrivateIp(${ip}) should be ${expected}`);
      }
    }

    // ---- chat: no key configured -> clean, non-networking error ----
    await post("/api/config", { provider: "openai", clearApiKey: true });
    const preConv = await emitAck(a, "conv:create", {});
    if (!preConv.ok) throw new Error("pre-key conversation creation failed");
    const noKey = await emitAck(a, "chat:send", {
      conversationId: preConv.conversation.id, text: "x",
    });
    if (noKey.ok !== false || !/no API key/.test(noKey.error)) {
      throw new Error("missing key was not reported: " + JSON.stringify(noKey));
    }

    // private-network fetch targets are rejected by the DNS guard
    await post("/api/config", {
      provider: "openai", apiKey: "sk-test", baseUrl: "http://10.0.0.5:9999/v1",
    });
    const privateTarget = await post("/api/config/test", {});
    const privateBody = await privateTarget.json();
    if (privateBody.ok !== false || !/private/.test(privateBody.error || "")) {
      throw new Error("private fetch target was not rejected: " + JSON.stringify(privateBody));
    }

    // ---- chat flow with the mock provider ----
    await post("/api/config", { provider: "mock" });
    const created = await emitAck(a, "conv:create", {});
    if (!created.ok) throw new Error("conversation creation failed");
    const convId = created.conversation.id;

    const deltas = [];
    const onDelta = (m) => { if (m.conversationId === convId) deltas.push(m.text); };
    a.on("chat:delta", onDelta);
    const donePromise = once(a, "chat:done", 8000);

    const sendAck = await emitAck(a, "chat:send", {
      conversationId: convId,
      text: "hello harness, stream me a reply",
    });
    if (!sendAck.ok) throw new Error("chat:send rejected: " + JSON.stringify(sendAck));
    if (sendAck.userMessage.content !== "hello harness, stream me a reply") {
      throw new Error("user message echo wrong");
    }
    const done = await donePromise;
    a.off("chat:delta", onDelta);
    if (done.conversationId !== convId) throw new Error("done event for wrong conversation");
    const full = deltas.join("");
    if (!full.includes("[mock] You said: hello harness, stream me a reply")) {
      throw new Error("mock reply incomplete: " + full);
    }
    if (!done.conversation.title.startsWith("hello harness")) {
      throw new Error("conversation title not set from first message");
    }

    // history must persist server-side
    const opened = await emitAck(a, "conv:open", { id: convId });
    if (opened.messages.length !== 2) {
      throw new Error("expected 2 stored messages, got " + opened.messages.length);
    }
    if (opened.messages[1].role !== "assistant") throw new Error("assistant reply not stored");

    // ---- skill injection reaches the provider ----
    const skillSetAck = await emitAck(a, "conv:skills", { id: convId, skills: ["code-review", "summarize"] });
    if (!skillSetAck.ok || skillSetAck.skills.length !== 2) {
      throw new Error("conv:skills failed: " + JSON.stringify(skillSetAck));
    }
    const skillDeltas = [];
    const onSkillDelta = (m) => { if (m.conversationId === convId) skillDeltas.push(m.text); };
    a.on("chat:delta", onSkillDelta);
    const skillDone = once(a, "chat:done", 8000);
    await emitAck(a, "chat:send", { conversationId: convId, text: "with skills on" });
    await skillDone;
    a.off("chat:delta", onSkillDelta);
    const skillText = skillDeltas.join("");
    if (!skillText.includes("active skills: code-review, summarize")) {
      throw new Error("skills were not injected into the system prompt: " + skillText);
    }

    // unknown skill names are dropped, known ones kept
    const skillsAck = await emitAck(a, "conv:skills", { id: convId, skills: ["summarize", "made-up-skill"] });
    if (!skillsAck.ok || skillsAck.skills.join(",") !== "summarize") {
      throw new Error("unknown skill filtering wrong: " + JSON.stringify(skillsAck));
    }

    // ---- validation ----
    const tooLong = await emitAck(a, "chat:send", {
      conversationId: convId, text: "x".repeat(8001),
    });
    if (tooLong.ok !== false) throw new Error("over-length message accepted");
    const empty = await emitAck(a, "chat:send", { conversationId: convId, text: "   " });
    if (empty.ok !== false) throw new Error("empty message accepted");
    const badPayload = await emitAck(a, "chat:send", { conversationId: convId });
    if (badPayload.ok !== false) throw new Error("missing text accepted");
    const unknownConv = await emitAck(a, "chat:send", { conversationId: "nope", text: "hi" });
    if (unknownConv.ok !== false) throw new Error("unknown conversation accepted");
    const badSkills = await emitAck(a, "conv:skills", { id: convId, skills: "not-an-array" });
    if (badSkills.ok !== false) throw new Error("non-array skills accepted");

    // ---- session isolation ----
    const bList = await emitAck(b, "conv:list", null);
    if (!bList.ok || bList.conversations.length !== 0) {
      throw new Error("session b can see session a conversations: " + JSON.stringify(bList));
    }
    const bOpen = await emitAck(b, "conv:open", { id: convId });
    if (bOpen.ok !== false) throw new Error("session b opened session a conversation");

    // ---- delete ----
    const second = await emitAck(a, "conv:create", { title: "scratch" });
    const delAck = await emitAck(a, "conv:delete", { id: second.conversation.id });
    if (!delAck.ok) throw new Error("delete failed");
    const reopened = await emitAck(a, "conv:open", { id: second.conversation.id });
    if (reopened.ok !== false) throw new Error("deleted conversation still openable");

    console.log("smoke test: all checks passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("smoke test FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    a.close();
    b.close();
    ios.disconnectSockets();
    try { server.close(); } catch { /* already closed */ }
    fs.rmSync(BANTER_HOME, { recursive: true, force: true });
  }
}

main().then(() => process.exit(process.exitCode || 0));
