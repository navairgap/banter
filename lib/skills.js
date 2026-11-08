/**
 * Skill system for banter.
 *
 * A skill is a folder containing a SKILL.md with YAML-ish frontmatter
 * (name, description) and a markdown instruction body — the same format
 * used by popular community skill repositories. Skills are injected into
 * the system prompt of any conversation that enables them.
 *
 * Built-in skills ship in <repo>/skills and are read-only. User-installed
 * skills live in $BANTER_HOME/skills (default ~/.banter/skills) and may be
 * added from a URL to a raw SKILL.md file or removed.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { assertFetchTarget } = require("./providers");

const BANTER_HOME = process.env.BANTER_HOME || path.join(os.homedir(), ".banter");
const USER_SKILLS_DIR = path.join(BANTER_HOME, "skills");
const BUILTIN_SKILLS_DIR = path.join(__dirname, "..", "skills");
const MAX_SKILL_BYTES = 256 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseSkillMd(raw, fallbackName) {
  if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("skill file exceeds 256 KB");
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.+)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
    body = match[2];
  }
  const name = String(meta.name || fallbackName || "").toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("skill has no valid name");
  const description = String(meta.description || "").slice(0, 300);
  const bodyText = body.trim();
  if (bodyText.length < 8) throw new Error("skill body is empty");
  return { name, description, body: bodyText };
}

function readSkillDir(dir, builtin) {
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  const root = path.resolve(dir) + path.sep;
  for (const entry of entries) {
    // only plain skill folders — no dotfiles, no separators, no escapes
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || /[/\\]/.test(entry.name)) continue;
    const skillDir = path.resolve(dir, entry.name);
    if (!skillDir.startsWith(root)) continue;
    const file = path.join(skillDir, "SKILL.md");
    try {
      const parsed = parseSkillMd(fs.readFileSync(file, "utf8"), entry.name);
      skills.push({ ...parsed, builtin: Boolean(builtin), dir: entry.name });
    } catch {
      // unreadable or malformed skill — skip it rather than break the list
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** All skills: built-ins first, then user-installed (user wins on name). */
function listSkills() {
  const merged = new Map();
  for (const skill of readSkillDir(BUILTIN_SKILLS_DIR, true)) merged.set(skill.name, skill);
  for (const skill of readSkillDir(USER_SKILLS_DIR, false)) merged.set(skill.name, skill);
  return [...merged.values()];
}

function getSkill(name) {
  return listSkills().find((s) => s.name === name) || null;
}

/** Build the system prompt for a conversation with the given skills on. */
function buildSystemPrompt(enabledNames) {
  const base =
    "You are banter, a concise and capable AI assistant running inside a " +
    "local chat harness. Prefer clear, direct answers. Use markdown-style " +
    "code fences for code. When you are unsure, say so.";
  const active = (Array.isArray(enabledNames) ? enabledNames : [])
    .map((n) => getSkill(n))
    .filter(Boolean);
  const parts = [base];
  if (active.length) {
    parts.push(`Active skills: ${active.map((s) => s.name).join(", ")}`);
  }
  for (const skill of active) {
    parts.push(`## Skill: ${skill.name}\n${skill.body}`);
  }
  return parts.join("\n\n");
}

/** Install a skill from a URL pointing at a raw SKILL.md file. */
async function installSkillFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid URL");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("only https: URLs (or http on localhost) can be installed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  // remote installs must resolve to public addresses — no intranet fetches
  await assertFetchTarget(parsed.href, { label: "skill URL", allowLoopback: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(parsed.href, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      `could not fetch skill: ${err.name === "AbortError" ? "timed out" : err.message}`
    );
  }
  clearTimeout(timer);
  if (!response.ok) throw new Error(`skill URL returned HTTP ${response.status}`);
  const raw = await response.text();
  const skill = parseSkillMd(raw);
  if (!NAME_RE.test(skill.name)) throw new Error("skill has no valid name");
  // Provable containment: the target must be a direct child of the
  // resolved skills root, so it cannot escape regardless of input.
  const root = path.resolve(USER_SKILLS_DIR);
  const dir = path.resolve(root, skill.name);
  if (path.dirname(dir) !== root || path.basename(dir) !== skill.name) {
    throw new Error("resolved skill path escaped the skills directory");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "SKILL.md"), raw, { mode: 0o600 });
  return { ...skill, builtin: false };
}

/** Remove a user-installed skill copy. Built-ins stay; only the shadow goes. */
function removeSkill(name) {
  if (!NAME_RE.test(name)) throw new Error("invalid skill name");
  const root = path.resolve(USER_SKILLS_DIR);
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== root || path.basename(dir) !== name) {
    throw new Error("invalid skill name");
  }
  if (!fs.existsSync(dir)) throw new Error("not an installed skill");
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = {
  BANTER_HOME,
  USER_SKILLS_DIR,
  listSkills,
  getSkill,
  buildSystemPrompt,
  installSkillFromUrl,
  removeSkill,
  parseSkillMd,
};
