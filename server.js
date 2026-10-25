/**
 * web-chat-app server — Express + Socket.IO.
 * Serves the static client and relays events between users in rooms.
 * No database: users and rooms live in memory and reset on restart.
 */

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
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

// serve only client assets — never server.js, package.json, tests, etc.
app.use("/styles", express.static(path.join(__dirname, "styles")));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use("/docs", express.static(path.join(__dirname, "docs")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
const connectionsByIp = new Map();
const eventCounts = new Map();

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
const rooms = new Set(["lobby", "tech", "random"]);
let guestSeq = 1;

const now = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const clean = (s, max) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

function roomUsers(room) {
  const list = [];
  for (const u of users.values()) if (u.room === room) list.push(u.name);
  return list.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function uniqueName(base, room) {
  const taken = new Set(
    [...users.values()]
      .filter((u) => u.room === room)
      .map((u) => u.name.toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`.toLowerCase())) i += 1;
  return `${base} (${i})`;
}

function leaveCurrentRoom(socket) {
  const u = users.get(socket.id);
  if (!u) return;
  users.delete(socket.id);  // actually remove, or "departed" users linger
  socket.leave(u.room);
  socket.to(u.room).emit("system", { text: `${u.name} left`, time: now() });
  io.to(u.room).emit("users", roomUsers(u.room));
  if (!["lobby", "tech", "random"].includes(u.room) && roomUsers(u.room).length === 0) {
    rooms.delete(u.room);
    io.emit("rooms", [...rooms].sort());
  }
}

io.on("connection", (socket) => {
  const ip = socket.handshake.address || "unknown";
  const ipConnections = connectionsByIp.get(ip) || 0;
  if (io.engine.clientsCount >= MAX_CONNECTIONS || ipConnections >= MAX_CONNECTIONS_PER_IP) {
    socket.disconnect(true);
    return;
  }
  connectionsByIp.set(ip, ipConnections + 1);

  // join a room (also used for switching rooms)
  socket.on("join", (payload = {}, ack) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      if (typeof ack === "function") ack({ ok: false, error: "invalid join payload" });
      return;
    }
    const { name, room } = payload;
    if ((name != null && typeof name !== "string") ||
        (room != null && typeof room !== "string")) {
      if (typeof ack === "function") ack({ ok: false, error: "name and room must be strings" });
      return;
    }
    if (!allowEvent(socket.id, "join", 10, 60_000)) {
      if (typeof ack === "function") ack({ ok: false, error: "too many join attempts" });
      return;
    }
    let n = clean(name, MAX_NAME_LEN) || `guest-${guestSeq++}`;
    let r = clean(room, MAX_ROOM_LEN).toLowerCase() || "lobby";
    if (!rooms.has(r) && rooms.size >= MAX_ROOMS) {
      if (typeof ack === "function") ack({ ok: false, error: "room limit reached" });
      return;
    }
    leaveCurrentRoom(socket);
    n = uniqueName(n, r);
    users.set(socket.id, { name: n, room: r });
    socket.join(r);
    rooms.add(r);
    socket.to(r).emit("system", { text: `${n} joined`, time: now() });
    io.to(r).emit("users", roomUsers(r));
    io.emit("rooms", [...rooms].sort());
    if (typeof ack === "function") ack({ ok: true, name: n, room: r });
  });

  socket.on("message", (text) => {
    const u = users.get(socket.id);
    if (!u || !allowEvent(socket.id, "message", MAX_MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS)) return;
    if (typeof text !== "string") return;
    const t = text.trim();
    if (!t || t.length > MAX_MSG_LEN) return;  // reject empty or over-limit
    // text is relayed raw; the client renders it with textContent (XSS-safe)
    io.to(u.room).emit("message", { user: u.name, text: t, time: now() });
  });

  socket.on("typing", (isTyping) => {
    const u = users.get(socket.id);
    if (!u || !allowEvent(socket.id, "typing", MAX_TYPING_EVENTS_PER_WINDOW)) return;
    if (typeof isTyping !== "boolean") return;
    socket.to(u.room).emit("typing", { user: u.name, isTyping });
  });

  // create a room and return its name so the client can join it
  socket.on("new room", (room, ack) => {
    if (!allowEvent(socket.id, "new-room", 5, 60_000)) {
      if (typeof ack === "function") ack({ ok: false, error: "too many room creation attempts" });
      return;
    }
    if (typeof room !== "string") {
      if (typeof ack === "function") ack({ ok: false, error: "invalid room name" });
      return;
    }
    const r = clean(room, MAX_ROOM_LEN).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!r) {
      if (typeof ack === "function") ack({ ok: false, error: "invalid room name" });
      return;
    }
    if (!rooms.has(r)) {
      if (rooms.size >= MAX_ROOMS) {
        if (typeof ack === "function") ack({ ok: false, error: "room limit reached" });
        return;
      }
      rooms.add(r);
      io.emit("rooms", [...rooms].sort());
    }
    if (typeof ack === "function") ack({ ok: true, room: r });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    const remaining = Math.max(0, (connectionsByIp.get(ip) || 1) - 1);
    if (remaining === 0) connectionsByIp.delete(ip);
    else connectionsByIp.set(ip, remaining);
    for (const key of eventCounts.keys()) {
      if (key.startsWith(socket.id + ":")) eventCounts.delete(key);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`banter listening on http://localhost:${PORT}`)
);
