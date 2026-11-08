/**
 * banter server — Express + Socket.IO.
 * Serves the static client and relays events between users in rooms.
 * No database: users and rooms live in memory and reset on restart.
 *
 * Wire protocol v2: timestamps are epoch milliseconds (`ts`), the `rooms`
 * event carries `{ name, count }` entries, and `message` acknowledges
 * delivery so clients can surface rejections (rate limit, length, …).
 */

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const pkg = require("./package.json");

// Bench mode relaxes only the per-IP connection cap so a single machine can
// open many loopback sockets. Never set BENCH=1 on a public deployment.
const BENCH_MODE = process.env.BENCH === "1";
// Only enable behind a proxy you control: X-Forwarded-For is client-spoofable
// otherwise. Needed so per-IP limits don't collapse onto the proxy's IP.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const app = express();
if (TRUST_PROXY) app.set("trust proxy", true);
const server = http.createServer(app);
const io = new Server(server, {
  // Reject oversized Socket.IO payloads before they reach event handlers.
  maxHttpBufferSize: 16 * 1024,
  // Browser clients must be same-origin. Non-browser clients without Origin
  // remain supported, so this is CSRF hardening rather than authentication.
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

// Reduce framework disclosure and apply a small, consistent set of browser
// hardening headers to both the app shell and static client assets.
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // The client ships no inline scripts/styles; avatars set colors through the
  // CSSOM (allowed), and the favicon is a data: URL.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

// serve only client assets — never server.js, package.json, tests, etc.
// The client has no hashed filenames, so scripts/styles revalidate via
// ETag on every load (cheap 304s) instead of risking a stale hour-old app.
const revalidate = { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") };
app.use("/styles", express.static(path.join(__dirname, "styles"), revalidate));
app.use("/js", express.static(path.join(__dirname, "js"), revalidate));
app.use("/docs", express.static(path.join(__dirname, "docs"), { maxAge: "1h" }));
app.get("/", (_req, res) =>
  res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "index.html"))
);
app.get("/healthz", (_req, res) =>
  res.set("Cache-Control", "no-store").json({
    ok: true,
    version: pkg.version,
    uptime: Math.round(process.uptime()),
    users: users.size,
    rooms: rooms.size,
  })
);

const MAX_NAME_LEN = 20;
const MAX_MSG_LEN = 500;
const MAX_ROOM_LEN = 24;
const MAX_ROOMS = 100;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 8;
const EVENT_WINDOW_MS = 10_000;
const MAX_TYPING_EVENTS_PER_WINDOW = 20;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_CONNECTIONS = 1000;
const DEFAULT_ROOMS = ["lobby", "tech", "random"];
const SHUTDOWN_TIMEOUT_MS = 3_000;
const connectionsByIp = new Map();
const eventCounts = new Map();
const pendingRoomsByCreator = new Map();

function allowEvent(socketId, event, limit, windowMs = EVENT_WINDOW_MS) {
  const nowMs = Date.now();
  const key = socketId + ':' + event;
  const entry = eventCounts.get(key);
  if (!entry || nowMs - entry.startedAt >= windowMs) {
    eventCounts.set(key, { startedAt: nowMs, count: 1 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/** @type {Map<string, {name: string, room: string}>} socket.id -> user */
const users = new Map();
const rooms = new Set(DEFAULT_ROOMS);
let guestSeq = 1;

const clean = (s, max) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

const roomSlug = (value) => clean(value, MAX_ROOM_LEN).toLowerCase()
  .replace(/\s+/g, "-")
  .replace(/[^a-z0-9-]/g, "")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");

function roomUsers(room) {
  const list = [];
  for (const u of users.values()) if (u.room === room) list.push(u.name);
  return list.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Room roster in one pass — O(users), not O(rooms × users). */
function roomCounts() {
  const counts = new Map();
  for (const u of users.values()) counts.set(u.room, (counts.get(u.room) || 0) + 1);
  return [...rooms].sort().map((name) => ({ name, count: counts.get(name) || 0 }));
}

function uniqueName(base, room) {
  const taken = new Set(
    [...users.values()]
      .filter((u) => u.room === room)
      .map((u) => u.name.toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (true) {
    const suffix = ` (${i})`;
    const candidate = `${base.slice(0, MAX_NAME_LEN - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    i += 1;
  }
}

function leaveCurrentRoom(socket) {
  const u = users.get(socket.id);
  if (!u) return;
  users.delete(socket.id);  // actually remove, or "departed" users linger
  socket.leave(u.room);
  socket.to(u.room).emit("system", { text: `${u.name} left`, ts: Date.now() });
  io.to(u.room).emit("users", roomUsers(u.room));
  if (!DEFAULT_ROOMS.includes(u.room) && roomUsers(u.room).length === 0) {
    rooms.delete(u.room);
    io.emit("rooms", roomCounts());
  }
}

/** Best-effort client IP; honors X-Forwarded-For only when TRUST_PROXY=1. */
function clientIp(handshake) {
  if (TRUST_PROXY) {
    const xff = handshake.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  }
  return handshake.address || "unknown";
}

function ack(ackFn, payload) {
  if (typeof ackFn === "function") ackFn(payload);
}

io.on("connection", (socket) => {
  const ip = clientIp(socket.handshake);
  const perIpCap = BENCH_MODE ? MAX_CONNECTIONS : MAX_CONNECTIONS_PER_IP;
  const ipConnections = connectionsByIp.get(ip) || 0;
  if (io.engine.clientsCount > MAX_CONNECTIONS || ipConnections >= perIpCap) {
    socket.disconnect(true);
    return;
  }
  connectionsByIp.set(ip, ipConnections + 1);

  // join a room (also used for switching rooms and, with the same name,
  // as an idempotent re-join after reconnecting)
  socket.on("join", (payload = {}, ackFn) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ack(ackFn, { ok: false, error: "invalid join payload" });
    }
    const { name, room } = payload;
    if ((name != null && typeof name !== "string") ||
        (room != null && typeof room !== "string")) {
      return ack(ackFn, { ok: false, error: "name and room must be strings" });
    }
    // Validation comes before the rate limiter so garbage cannot burn quota.
    if (!allowEvent(socket.id, "join", 10, 60_000)) {
      return ack(ackFn, { ok: false, error: "too many join attempts" });
    }
    const r = roomSlug(room) || "lobby";
    if (!rooms.has(r) && rooms.size >= MAX_ROOMS) {
      return ack(ackFn, { ok: false, error: "room limit reached" });
    }
    const current = users.get(socket.id);
    // Re-joining the room you are already in is a no-op: no left/joined
    // noise, no roster churn. Happens after every client reconnect.
    if (current && current.room === r && clean(name, MAX_NAME_LEN) === current.name) {
      return ack(ackFn, { ok: true, name: current.name, room: r });
    }
    let n = clean(name, MAX_NAME_LEN) || `guest-${guestSeq++}`;
    leaveCurrentRoom(socket);
    // Once a user joins a room it is no longer an unclaimed reservation.
    for (const [creator, pending] of pendingRoomsByCreator) {
      pending.delete(r);
      if (pending.size === 0) pendingRoomsByCreator.delete(creator);
    }
    n = uniqueName(n, r);
    users.set(socket.id, { name: n, room: r });
    socket.join(r);
    rooms.add(r);
    socket.to(r).emit("system", { text: `${n} joined`, ts: Date.now() });
    io.to(r).emit("users", roomUsers(r));
    io.emit("rooms", roomCounts());
    ack(ackFn, { ok: true, name: n, room: r });
  });

  socket.on("message", (text, ackFn) => {
    const u = users.get(socket.id);
    if (!u) return ack(ackFn, { ok: false, error: "join a room first" });
    if (typeof text !== "string") {
      return ack(ackFn, { ok: false, error: "invalid message" });
    }
    const t = text.trim();
    if (!t) return ack(ackFn, { ok: false, error: "message is empty" });
    if (t.length > MAX_MSG_LEN) {
      return ack(ackFn, { ok: false, error: `message over ${MAX_MSG_LEN} characters` });
    }
    if (!allowEvent(socket.id, "message", MAX_MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS)) {
      return ack(ackFn, { ok: false, error: "slow down — too many messages" });
    }
    // text is relayed raw; the client renders it with textContent (XSS-safe)
    io.to(u.room).emit("message", { user: u.name, text: t, ts: Date.now() });
    ack(ackFn, { ok: true });
  });

  socket.on("typing", (isTyping, ackFn) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (typeof isTyping !== "boolean") return;
    if (!allowEvent(socket.id, "typing", MAX_TYPING_EVENTS_PER_WINDOW)) return;
    socket.to(u.room).emit("typing", { user: u.name, isTyping });
    ack(ackFn, { ok: true });
  });

  // create a room and return its name so the client can join it
  socket.on("new room", (room, ackFn) => {
    if (!users.has(socket.id)) {
      return ack(ackFn, { ok: false, error: "join a room first" });
    }
    if (typeof room !== "string") {
      return ack(ackFn, { ok: false, error: "invalid room name" });
    }
    if (!allowEvent(socket.id, "new-room", 5, 60_000)) {
      return ack(ackFn, { ok: false, error: "too many room creation attempts" });
    }
    const r = roomSlug(room);
    if (!r) return ack(ackFn, { ok: false, error: "invalid room name" });
    if (!rooms.has(r)) {
      if (rooms.size >= MAX_ROOMS) {
        return ack(ackFn, { ok: false, error: "room limit reached" });
      }
      rooms.add(r);
      io.emit("rooms", roomCounts());
    }
    if (!DEFAULT_ROOMS.includes(r) && roomUsers(r).length === 0) {
      const pending = pendingRoomsByCreator.get(socket.id) || new Set();
      pending.add(r);
      pendingRoomsByCreator.set(socket.id, pending);
    }
    ack(ackFn, { ok: true, room: r });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    const pending = pendingRoomsByCreator.get(socket.id);
    let removedEmptyRoom = false;
    if (pending) {
      pendingRoomsByCreator.delete(socket.id);
      for (const room of pending) {
        const stillReserved = [...pendingRoomsByCreator.values()]
          .some((otherPending) => otherPending.has(room));
        if (!stillReserved && roomUsers(room).length === 0 && rooms.delete(room)) {
          removedEmptyRoom = true;
        }
      }
    }
    if (removedEmptyRoom) io.emit("rooms", roomCounts());
    const remaining = Math.max(0, (connectionsByIp.get(ip) || 1) - 1);
    if (remaining === 0) connectionsByIp.delete(ip);
    else connectionsByIp.set(ip, remaining);
    for (const key of eventCounts.keys()) {
      if (key.startsWith(socket.id + ":")) eventCounts.delete(key);
    }
  });
});

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

// Graceful drain: stop accepting, close every socket with a proper disconnect
// packet so clients reconnect cleanly, then exit 0. A force timer guards
// against keep-alive connections holding the process open.
let draining = false;
function shutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`${signal} received — draining connections`);
  io.disconnectSockets();
  server.close(() => process.exit(0));
  // Idle keep-alive HTTP sockets (health checkers, fetch agents) would
  // otherwise delay the close callback until the force timer; drop them
  // once the disconnect frames had a moment to flush.
  setTimeout(() => {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  }, 100).unref();
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
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
