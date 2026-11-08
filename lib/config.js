/**
 * Harness configuration: providers, API keys, and the active model.
 * Stored at $BANTER_HOME/config.json (default ~/.banter/config.json) with
 * owner-only permissions. Keys never leave the machine and are never sent
 * back to clients — the API only ever reports whether a key is present.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { PRESETS } = require("./providers");

const BANTER_HOME =
  process.env.BANTER_HOME || path.join(os.homedir(), ".banter");
const CONFIG_PATH = path.join(BANTER_HOME, "config.json");

const DEFAULT_ACTIVE = "openai";

function ensureHome() {
  fs.mkdirSync(BANTER_HOME, { recursive: true, mode: 0o700 });
}

function defaultProviderEntry(name) {
  const preset = PRESETS[name] || {};
  return {
    baseUrl: preset.baseUrl || "",
    apiKey: "",
    model: (preset.models && preset.models[0]) || "",
  };
}

function defaultConfig() {
  const providers = {};
  for (const name of Object.keys(PRESETS)) providers[name] = defaultProviderEntry(name);
  return { activeProvider: DEFAULT_ACTIVE, providers };
}

/** Load config from disk, filling in any missing provider slots. */
function loadConfig() {
  ensureHome();
  const config = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (raw && typeof raw === "object") {
      if (typeof raw.activeProvider === "string" && PRESETS[raw.activeProvider]) {
        config.activeProvider = raw.activeProvider;
      }
      if (raw.providers && typeof raw.providers === "object") {
        for (const [name, entry] of Object.entries(raw.providers)) {
          if (!config.providers[name] || typeof entry !== "object") continue;
          if (typeof entry.baseUrl === "string" && entry.baseUrl.trim()) {
            config.providers[name].baseUrl = entry.baseUrl.trim();
          }
          if (typeof entry.apiKey === "string") {
            config.providers[name].apiKey = entry.apiKey;
          }
          if (typeof entry.model === "string" && entry.model.trim()) {
            config.providers[name].model = entry.model.trim();
          }
        }
      }
    }
  } catch {
    // missing or unreadable config — start from defaults
  }
  return config;
}

/** Persist config atomically with owner-only permissions. */
function saveConfig(config) {
  ensureHome();
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

/** Apply a partial settings update. Empty apiKey keeps the stored key. */
function updateConfig(patch) {
  const config = loadConfig();
  if (patch.provider && PRESETS[patch.provider]) {
    config.activeProvider = patch.provider;
  }
  const target = config.activeProvider;
  const entry = config.providers[target];
  if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) {
    entry.baseUrl = patch.baseUrl.trim();
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    entry.model = patch.model.trim();
  }
  if (typeof patch.apiKey === "string" && patch.apiKey.length > 0) {
    entry.apiKey = patch.apiKey.trim();
  }
  if (patch.clearApiKey === true) {
    entry.apiKey = "";
  }
  saveConfig(config);
  return config;
}

/** Client-safe view: never includes the API key itself. */
function maskConfig(config) {
  const providers = {};
  for (const [name, entry] of Object.entries(config.providers)) {
    const preset = PRESETS[name];
    providers[name] = {
      baseUrl: entry.baseUrl,
      model: entry.model,
      apiKeySet: Boolean(entry.apiKey),
      label: preset.label,
      kind: preset.kind,
      models: preset.models,
      keyUrl: preset.keyUrl,
    };
  }
  return { activeProvider: config.activeProvider, providers };
}

/** Validate that the active provider is usable for chat. */
function assertChatReady(config) {
  const entry = config.providers[config.activeProvider];
  if (!entry) throw new Error("no provider configured");
  if (config.activeProvider !== "mock" && !entry.apiKey) {
    throw new Error(
      `no API key set for ${config.activeProvider} — add one in Settings`
    );
  }
  if (!entry.model) throw new Error("no model set — pick one in Settings");
  return { provider: config.activeProvider, ...entry };
}

module.exports = {
  BANTER_HOME,
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  updateConfig,
  maskConfig,
  assertChatReady,
  defaultProviderEntry,
};
