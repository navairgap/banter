/* banter client v3 — AI chat harness.
 * Renders everything with DOM APIs + textContent; user and model output can
 * never inject markup. Assistant markdown is rendered by building nodes from
 * a whitelist (fences, code, bold, lists, links). */

const $ = (id) => document.getElementById(id);

const welcome = $("welcome");
const welcomeStatus = $("welcome-status");
const welcomeSettings = $("welcome-settings");
const welcomeHint = $("welcome-hint");
const chatShell = $("chat-shell");
const convListEl = $("conv-list");
const newChatBtn = $("new-chat-btn");
const chatTitle = $("chat-title");
const modelLabel = $("model-label");
const connDot = $("conn-dot");
const connLabel = $("conn-label");
const meStatus = $("me-status");
const messagesEl = $("messages");
const msgInput = $("msg-input");
const sendBtn = $("send-btn");
const stopBtn = $("stop-btn");
const charCount = $("char-count");
const chatForm = $("chat-form");
const typingBar = $("typing-bar");
const skillListEl = $("skill-list");
const sidebar = document.querySelector(".sidebar");
const settingsDialog = $("settings-dialog");
const settingsForm = $("settings-form");
const providerSelect = $("provider-select");
const providerHint = $("provider-hint");
const baseUrlInput = $("base-url");
const apiKeyInput = $("api-key");
const clearKeyInput = $("clear-key");
const modelInput = $("model-input");
const modelOptions = $("model-options");
const testResult = $("test-result");
const skillsDialog = $("skills-dialog");
const skillsCatalog = $("skills-catalog");
const skillUrlInput = $("skill-url");
const skillInstallResult = $("skill-install-result");
const toastsEl = $("toasts");

const NEAR_BOTTOM_PX = 96;

let socket = null;
let sessionId = null;
let config = null;            // masked config from the server
let skills = [];              // all skills from the server
let currentConvId = null;
let currentConvSkills = [];   // enabled skill names for the open conversation
let streamingConvId = null;
let streamBuffer = null;      // { node, text } while a reply streams

/* ---------- session + helpers ---------- */

function getSessionId() {
  let id = localStorage.getItem("banter-session");
  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    id =
      "s-" +
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    localStorage.setItem("banter-session", id);
  }
  return id;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(text) {
  const node = el("div", "toast", text);
  toastsEl.appendChild(node);
  setTimeout(() => node.classList.add("gone"), 3200);
  setTimeout(() => node.remove(), 3800);
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToBottom(smooth) {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function updateCharCounter() {
  const remaining = msgInput.maxLength - msgInput.value.length;
  charCount.textContent = remaining < 200 ? String(remaining) : "";
}

function setConnected(on) {
  connDot.className = "conn-dot " + (on ? "online" : "offline");
  connDot.title = on ? "connected" : "disconnected";
  connLabel.textContent = on ? "connected" : "reconnecting…";
  meStatus.classList.toggle("online", on);
  msgInput.disabled = !on || streamingConvId !== null;
  sendBtn.disabled = msgInput.disabled;
}

function activeProviderConfig() {
  return config ? config.providers[config.activeProvider] : null;
}

function providerReady() {
  const entry = activeProviderConfig();
  if (!entry) return false;
  return config.activeProvider === "mock" || entry.apiKeySet;
}

/* ---------- markdown-lite (safe by construction) ---------- */

const LINK_RE = /https?:\/\/[^\s<>"']+/;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

function appendInline(parent, text) {
  // inline code first, then bold, then links — all text via textContent
  const parts = text.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      parent.appendChild(el("code", "inline-code", part.slice(1, -1)));
      continue;
    }
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    for (const bold of boldParts) {
      if (bold.startsWith("**") && bold.endsWith("**") && bold.length > 4) {
        parent.appendChild(el("strong", null, bold.slice(2, -2)));
        continue;
      }
      let rest = bold;
      while (rest) {
        const m = rest.match(LINK_RE);
        if (!m || m.index === undefined) {
          if (rest) parent.appendChild(document.createTextNode(rest));
          break;
        }
        if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
        const raw = m[0];
        const trailing = raw.match(TRAILING_PUNCT);
        const url = trailing ? raw.slice(0, raw.length - trailing[0].length) : raw;
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        a.textContent = url;
        parent.appendChild(a);
        if (trailing) parent.appendChild(document.createTextNode(trailing[0]));
        rest = rest.slice(m.index + raw.length);
      }
    }
  }
}

/** Render model markdown: fences, headings, lists, paragraphs, inline. */
function renderMarkdown(parent, text) {
  const segments = String(text).split(/```/);
  segments.forEach((segment, si) => {
    if (si % 2 === 1) {
      // fenced code block; drop an optional language tag on the first line
      const nl = segment.indexOf("\n");
      const code = nl === -1 ? "" : segment.slice(nl + 1).replace(/\n$/, "");
      parent.appendChild(el("pre", "code-block", code));
      return;
    }
    const blocks = segment.split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.trim().length > 0);
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const ul = el("ul", "md-list");
        for (const line of lines) {
          const li = el("li");
          appendInline(li, line.replace(/^\s*[-*]\s+/, ""));
          ul.appendChild(li);
        }
        parent.appendChild(ul);
        continue;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        const ol = el("ol", "md-list");
        for (const line of lines) {
          const li = el("li");
          appendInline(li, line.replace(/^\s*\d+[.)]\s+/, ""));
          ol.appendChild(li);
        }
        parent.appendChild(ol);
        continue;
      }
      const first = lines[0];
      const heading = first.match(/^(#{1,4})\s+(.*)$/);
      const p = el("p", "md-p");
      if (heading) {
        p.appendChild(el("strong", "md-heading", heading[2]));
        for (const line of lines.slice(1)) {
          p.appendChild(document.createTextNode(" "));
          appendInline(p, line);
        }
      } else {
        lines.forEach((line, i) => {
          if (i > 0) p.appendChild(document.createTextNode("\n"));
          appendInline(p, line);
        });
      }
      parent.appendChild(p);
    }
  });
}

/* ---------- rendering ---------- */

function addMessageNode(message) {
  const wasNearBottom = isNearBottom();
  const wrap = el("div", "msg " + (message.role === "user" ? "msg-user" : "msg-assistant"));
  if (message.role === "assistant") {
    const av = el("div", "avatar", "b");
    wrap.appendChild(av);
  }
  const body = el("div", "msg-body");
  if (message.role === "user") {
    const header = el("div", "msg-header");
    header.append(el("span", "name", "you"), el("span", "time", fmtTime(message.ts)));
    body.appendChild(header);
    const textEl = el("div", "msg-text user-text");
    textEl.textContent = message.content;
    body.appendChild(textEl);
  } else {
    const header = el("div", "msg-header");
    header.append(el("span", "name", "banter"), el("span", "time", fmtTime(message.ts)));
    body.appendChild(header);
    renderMarkdown(body, message.content || "");
  }
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  while (messagesEl.childElementCount > 400) messagesEl.firstElementChild.remove();
  if (wasNearBottom) scrollToBottom();
  return wrap;
}

function fmtTime(ts) {
  if (ts === undefined) return "";
  const d = new Date(ts);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d)
    : "";
}

function clearMessages() {
  messagesEl.replaceChildren();
}

function renderConversations(list) {
  convListEl.replaceChildren();
  for (const conv of list) {
    const li = el("li", conv.id === currentConvId ? "active" : "", conv.title || "New chat");
    li.addEventListener("click", () => openConversation(conv.id));
    convListEl.appendChild(li);
  }
}

function renderModelLabel() {
  const entry = activeProviderConfig();
  if (!entry) return modelLabel.textContent = "…";
  modelLabel.textContent = `${config.activeProvider} · ${entry.model || "no model"}`;
  modelLabel.title = `${entry.label || config.activeProvider} — click to change settings`;
}

function renderSkillPanel() {
  skillListEl.replaceChildren();
  for (const skill of skills) {
    const li = el("li");
    const label = el("label", "skill-toggle");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = currentConvSkills.includes(skill.name);
    checkbox.addEventListener("change", () => {
      const next = new Set(currentConvSkills);
      if (checkbox.checked) next.add(skill.name);
      else next.delete(skill.name);
      currentConvSkills = [...next];
      socket.emit("conv:skills", { id: currentConvId, skills: currentConvSkills }, (res) => {
        if (!res || !res.ok) toast((res && res.error) || "could not update skills");
      });
    });
    const nameSpan = el("span", "skill-name", skill.name);
    const desc = el("span", "skill-desc", skill.description);
    label.append(checkbox, nameSpan);
    li.append(label, desc);
    skillListEl.appendChild(li);
  }
}

function renderSettingsForm() {
  providerSelect.replaceChildren();
  for (const [name, entry] of Object.entries(config.providers)) {
    const opt = el("option", null, entry.label || name);
    opt.value = name;
    providerSelect.appendChild(opt);
  }
  fillSettingsForm();
}

function fillSettingsForm() {
  const entry = config.providers[config.activeProvider];
  providerSelect.value = config.activeProvider;
  baseUrlInput.value = entry.baseUrl;
  modelInput.value = entry.model;
  apiKeyInput.value = "";
  clearKeyInput.checked = false;
  modelOptions.replaceChildren();
  for (const model of entry.models || []) {
    const opt = el("option");
    opt.value = model;
    modelOptions.appendChild(opt);
  }
  const preset = config.providers[config.activeProvider];
  providerHint.textContent = preset.keyUrl ? `Get a key: ${preset.keyUrl}` : "";
  testResult.textContent = "";
}

function refreshUi() {
  renderModelLabel();
  renderSkillPanel();
}

/* ---------- conversations ---------- */

function openConversation(id) {
  socket.emit("conv:open", { id }, (res) => {
    if (!res || !res.ok) return toast((res && res.error) || "could not open chat");
    currentConvId = res.conversation.id;
    currentConvSkills = res.conversation.skills;
    chatTitle.textContent = res.conversation.title;
    clearMessages();
    for (const message of res.messages) addMessageNode(message);
    renderConversations(listCache);
    refreshUi();
    scrollToBottom();
    sidebar.classList.remove("open");
  });
}

let listCache = [];

function refreshList(keepView) {
  socket.emit("conv:list", (res) => {
    if (!res || !res.ok) return;
    listCache = res.conversations;
    renderConversations(listCache);
    if (!keepView && !currentConvId && listCache.length) {
      openConversation(listCache[0].id);
    }
    if (!listCache.length) newConversation({ silent: true });
  });
}

function newConversation({ silent } = {}) {
  socket.emit("conv:create", {}, (res) => {
    if (!res || !res.ok) return toast((res && res.error) || "could not create chat");
    currentConvId = res.conversation.id;
    currentConvSkills = res.conversation.skills;
    chatTitle.textContent = res.conversation.title;
    clearMessages();
    refreshList(true);
    refreshUi();
    msgInput.focus();
    if (!silent) msgInput.focus();
  });
}

function deleteConversation(id) {
  socket.emit("conv:delete", { id }, (res) => {
    if (!res || !res.ok) return toast((res && res.error) || "could not delete");
    if (id === currentConvId) {
      currentConvId = null;
      clearMessages();
      chatTitle.textContent = "New chat";
      refreshList();
    } else {
      refreshList(true);
    }
  });
}

/* ---------- streaming chat ---------- */

function beginStream() {
  streamingConvId = currentConvId;
  streamBuffer = { node: null, text: "" };
  const wrap = el("div", "msg msg-assistant");
  wrap.appendChild(el("div", "avatar", "b"));
  const body = el("div", "msg-body");
  const header = el("div", "msg-header");
  header.append(el("span", "name", "banter"), el("span", "time", fmtTime(Date.now())));
  const textEl = el("div", "msg-text");
  body.append(header, textEl);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  streamBuffer.node = textEl;
  scrollToBottom();
  typingBar.classList.remove("hidden");
  stopBtn.classList.remove("hidden");
  msgInput.disabled = true;
  sendBtn.disabled = true;
}

function endStream() {
  streamingConvId = null;
  typingBar.classList.add("hidden");
  stopBtn.classList.add("hidden");
  msgInput.disabled = !socket_connected();
  sendBtn.disabled = msgInput.disabled;
}

function socket_connected() {
  return socket && socket.connected;
}

/* ---------- socket wiring ---------- */

function connect() {
  sessionId = getSessionId();
  socket = io({ auth: { sessionId } });

  socket.on("connect", () => {
    setConnected(true);
    socket.emit("conv:list", (res) => {
      if (!res || !res.ok) return;
      listCache = res.conversations;
      if (listCache.length) {
        openConversation(listCache[0].id);
      } else {
        newConversation({ silent: true });
      }
    });
  });

  socket.on("disconnect", () => setConnected(false));

  socket.on("chat:delta", ({ conversationId, text }) => {
    if (conversationId !== streamingConvId || !streamBuffer) return;
    streamBuffer.text += text;
    streamBuffer.node.textContent = streamBuffer.text;
    scrollToBottom();
  });

  socket.on("chat:done", ({ conversationId, conversation }) => {
    if (conversationId !== streamingConvId) return;
    const text = streamBuffer ? streamBuffer.text : "";
    if (streamBuffer && streamBuffer.node) {
      const body = streamBuffer.node.parentElement;
      body.replaceChildren(el("div", "msg-header"));
      renderMarkdown(body, text);
    }
    streamBuffer = null;
    endStream();
    if (conversation) {
      listCache = listCache.map((c) => (c.id === conversation.id ? conversation : c));
      renderConversations(listCache);
      chatTitle.textContent = conversation.title;
    }
    scrollToBottom();
  });

  socket.on("chat:error", ({ error }) => {
    if (streamBuffer && streamBuffer.node) {
      const wrap = streamBuffer.node.closest(".msg");
      if (wrap && !streamBuffer.text) wrap.remove();
    }
    streamBuffer = null;
    endStream();
    toast(error || "generation failed");
  });
}

/* ---------- settings ---------- */

function openSettings() {
  renderSettingsForm();
  settingsDialog.showModal();
}

providerSelect.addEventListener("change", () => {
  config.activeProvider = providerSelect.value;
  fillSettingsForm();
});

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const patch = {
    provider: providerSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
  };
  if (apiKeyInput.value.length > 0) patch.apiKey = apiKeyInput.value;
  if (clearKeyInput.checked) patch.clearApiKey = true;
  fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) return toast(res.error || "could not save");
      config = res.config;
      refreshUi();
      updateWelcomeState();
      toast("settings saved");
      settingsDialog.close();
    })
    .catch(() => toast("could not save settings"));
});

$("settings-test").addEventListener("click", () => {
  testResult.textContent = "testing…";
  const patch = {
    provider: providerSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
  };
  if (apiKeyInput.value.length > 0) patch.apiKey = apiKeyInput.value;
  fetch("/api/config/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.ok) {
        const extra = res.models && res.models.length ? ` — models: ${res.models.slice(0, 8).join(", ")}` : "";
        testResult.textContent = `connected to ${res.provider}${extra}`;
        modelOptions.replaceChildren();
        for (const model of res.models || []) {
          const opt = el("option");
          opt.value = model;
          modelOptions.appendChild(opt);
        }
      } else {
        testResult.textContent = `failed: ${res.error}`;
      }
    })
    .catch(() => { testResult.textContent = "test failed"; });
});

$("settings-cancel").addEventListener("click", () => settingsDialog.close());
$("rail-settings").addEventListener("click", openSettings);
modelLabel.addEventListener("click", openSettings);
welcomeSettings.addEventListener("click", openSettings);

/* ---------- skill library ---------- */

function renderSkillsCatalog() {
  skillsCatalog.replaceChildren();
  for (const skill of skills) {
    const row = el("div", "skill-row");
    const info = el("div", "skill-row-info");
    const title = el("div", "skill-row-title", skill.name + (skill.builtin ? "" : " · installed"));
    const desc = el("div", "skill-row-desc", skill.description);
    info.append(title, desc);
    const actions = el("div", "skill-row-actions");
    if (!skill.builtin) {
      const removeBtn = el("button", "btn-ghost small", "remove");
      removeBtn.type = "button";
      removeBtn.addEventListener("click", () => {
        fetch(`/api/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" })
          .then((r) => r.json())
          .then((res) => {
            if (!res.ok) return toast(res.error || "could not remove");
            loadSkills().then(renderSkillsCatalog);
          });
      });
      actions.appendChild(removeBtn);
    }
    row.append(info, actions);
    skillsCatalog.appendChild(row);
  }
}

async function loadSkills() {
  const res = await fetch("/api/skills").then((r) => r.json());
  if (res.ok) skills = res.skills;
  renderSkillPanel();
  return skills;
}

$("rail-skills").addEventListener("click", () => {
  renderSkillsCatalog();
  skillsDialog.showModal();
});

$("skills-close").addEventListener("click", () => skillsDialog.close());

skillsDialog.addEventListener("close", () => loadSkills());

$("skills-dialog-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = skillUrlInput.value.trim();
  if (!url) return;
  skillInstallResult.textContent = "installing…";
  fetch("/api/skills/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) {
        skillInstallResult.textContent = `failed: ${res.error}`;
        return;
      }
      skillInstallResult.textContent = `installed: ${res.skill.name}`;
      skillUrlInput.value = "";
      loadSkills().then(renderSkillsCatalog);
    })
    .catch(() => { skillInstallResult.textContent = "install failed"; });
});

/* ---------- events ---------- */

newChatBtn.addEventListener("click", () => newConversation());
$("rail-new").addEventListener("click", () => newConversation());

$("sidebar-toggle").addEventListener("click", () => sidebar.classList.toggle("open"));

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text || !socket_connected() || streamingConvId) return;
  msgInput.value = "";
  autoSizeInput();
  updateCharCounter();
  addMessageNode({ role: "user", content: text, ts: Date.now() });
  beginStream();
  socket.emit(
    "chat:send",
    { conversationId: currentConvId, text },
    (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || "could not send");
        if (streamBuffer && streamBuffer.node) {
          const wrap = streamBuffer.node.closest(".msg");
          if (wrap && !streamBuffer.text) wrap.remove();
        }
        streamBuffer = null;
        endStream();
      } else if (res.conversation) {
        listCache = listCache.map((c) => (c.id === res.conversation.id ? res.conversation : c));
        renderConversations(listCache);
        chatTitle.textContent = res.conversation.title;
      }
    }
  );
});

stopBtn.addEventListener("click", () => {
  if (streamingConvId) socket.emit("chat:stop", { conversationId: streamingConvId });
});

function autoSizeInput() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + "px";
}

msgInput.addEventListener("input", () => {
  autoSizeInput();
  updateCharCounter();
});

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebar.classList.contains("open") &&
      !settingsDialog.open && !skillsDialog.open) {
    sidebar.classList.remove("open");
  }
});

function updateWelcomeState() {
  const ready = providerReady();
  welcomeStatus.textContent = ready
    ? `Provider: ${config.activeProvider} (${activeProviderConfig().model || "no model"})`
    : "No provider configured — add an API key or pick the offline mock.";
  welcomeSettings.textContent = ready ? "Provider settings" : "Set up a provider";
}

/* ---------- boot ---------- */

async function boot() {
  const cfgRes = await fetch("/api/config").then((r) => r.json());
  if (cfgRes.ok) config = cfgRes.config;
  await loadSkills();
  renderSettingsForm();
  updateWelcomeState();
  connect();
  welcome.classList.add("hidden");
  chatShell.classList.remove("hidden");
  setConnected(false);
}

boot();
