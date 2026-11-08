/**
 * Integration smoke test: runs the real server in-process on a scratch port,
 * connects real socket.io clients, and exercises the core event flow end to
 * end — joins, renames, messaging + acks, rate limits, room lifecycle, and
 * the SIGTERM drain.
 *
 * Run with: npm test
 */

const { io } = require("socket.io-client");

const { server, io: ios, start } = require("../server.js");

const PORT = 3459;
const URL = `http://localhost:${PORT}`;

function client() {
  return io(URL, { transports: ["websocket"], forceNew: true });
}

function once(sock, event, timeoutMs = 3000) {
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

/** Assert an event does NOT arrive — the server dropped it as expected. */
function nothingArrives(sock, event, timeoutMs, failMessage) {
  return once(sock, event, timeoutMs).then(
    () => { throw new Error(failMessage); },
    (err) => {
      if (!err.message.startsWith("timeout waiting for")) throw err;
    }
  );
}

/** Emit an event and capture its acknowledgement. */
function emitAck(sock, event, payload) {
  return new Promise((resolve) => {
    sock.emit(event, payload, function (res) { resolve(res); });
  });
}

async function main() {
  await start({ port: PORT });

  let a, b;
  try {
    // ---- health + hardening headers ----
    const health = await fetch(`${URL}/healthz`);
    const body = await health.json();
    if (!health.ok || body.ok !== true) {
      throw new Error("health endpoint did not return ok");
    }
    if (typeof body.version !== "string" || !body.version) {
      throw new Error("health endpoint is missing a version string");
    }
    if (body.users !== 0 || typeof body.rooms !== "number" ||
        typeof body.uptime !== "number") {
      throw new Error("health endpoint stats missing or wrong type: " + JSON.stringify(body));
    }
    for (const [header, expected] of Object.entries({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "no-store",
    })) {
      if (health.headers.get(header) !== expected) {
        throw new Error(`health response header ${header} was not ${expected}`);
      }
    }
    if (health.headers.has("x-powered-by")) {
      throw new Error("Express framework header should not be exposed");
    }

    const home = await fetch(`${URL}/`);
    if (!home.ok || home.headers.get("content-security-policy") === null) {
      throw new Error("app shell must set a Content-Security-Policy");
    }

    const crossOrigin = io(URL, {
      transports: ["websocket"],
      forceNew: true,
      extraHeaders: { Origin: "https://attacker.example" },
    });
    await once(crossOrigin, "connect_error");
    crossOrigin.close();

    a = client();
    b = client();
    await once(a, "connect");
    await once(b, "connect");

    // A connected socket must join before it can allocate a persistent room.
    const orphanRoom = await emitAck(a, "new room", "orphan-room");
    if (orphanRoom.ok !== false || orphanRoom.error !== "join a room first") {
      throw new Error("unjoined socket was allowed to create a room");
    }

    // Invalid payloads must be rejected without creating a room membership.
    const invalidJoin = await emitAck(a, "join", []);
    if (invalidJoin.ok !== false) throw new Error("array join payload was not rejected");

    const invalidName = await emitAck(a, "join", { name: { nested: true }, room: "lobby" });
    if (invalidName.ok !== false) throw new Error("object nickname was not rejected");
    const invalidRoom = await emitAck(a, "join", { name: "alice", room: ["lobby"] });
    if (invalidRoom.ok !== false) throw new Error("array room name was not rejected");

    // ---- join + roster counts ----
    const roomsAfterA = once(a, "rooms");
    const joinedA = await emitAck(a, "join", { name: "alice", room: "lobby" });
    if (!joinedA.ok || joinedA.name !== "alice") throw new Error("join A failed");
    const roomsV2 = await roomsAfterA; // A's own join also announces room counts
    if (!roomsV2.some((r) => r.name === "lobby" && r.count === 1)) {
      throw new Error("rooms event must carry { name, count } entries: " + JSON.stringify(roomsV2));
    }

    // user list reaches both — attach the listener between the joins:
    // A's own join already broadcast a list, B's join is the one we catch
    const usersA = once(a, "users");
    const roomsAfterB = once(a, "rooms");
    const joinedB = await emitAck(b, "join", { name: "alice", room: "lobby" }); // duplicate name on purpose
    if (joinedB.name !== "alice (2)") {
      throw new Error(`duplicate-name suffix broken: got "${joinedB.name}"`);
    }
    const list = await usersA;
    if (!list.includes("alice") || !list.includes("alice (2)")) {
      throw new Error("user list incomplete: " + JSON.stringify(list));
    }
    const roomsBoth = await roomsAfterB;
    if (!roomsBoth.some((r) => r.name === "lobby" && r.count === 2)) {
      throw new Error("lobby member count should be 2 after the second join");
    }

    // Empty nickname falls back to a server-assigned guest name.
    const guest = client();
    await once(guest, "connect");
    const guestJoin = await emitAck(guest, "join", { room: "guestroom" });
    if (!/^guest-\d+$/.test(guestJoin.name)) {
      throw new Error("empty nickname should become a guest name, got: " + guestJoin.name);
    }
    guest.close();

    const casedClient = client();
    await once(casedClient, "connect");
    const casedJoin = await emitAck(casedClient, "join", { name: "ALICE", room: "lobby" });
    if (casedJoin.name !== "ALICE (3)") {
      throw new Error("case-insensitive duplicate-name handling failed: " + casedJoin.name);
    }
    casedClient.close();

    // ---- messaging: acks, timestamps, unicode, limits ----
    const gotMsg = once(b, "message");
    const msgAck = await emitAck(a, "message", "hello from alice");
    if (!msgAck.ok) throw new Error("valid message was not acknowledged: " + JSON.stringify(msgAck));
    const msg = await gotMsg;
    if (msg.user !== "alice" || msg.text !== "hello from alice") {
      throw new Error("message payload wrong: " + JSON.stringify(msg));
    }
    if (typeof msg.ts !== "number" || Math.abs(Date.now() - msg.ts) > 5000) {
      throw new Error("message ts must be fresh epoch milliseconds");
    }

    const unicodeMessage = once(b, "message");
    await emitAck(a, "message", "नमस्ते 👋 café");
    const unicodeMsg = await unicodeMessage;
    if (unicodeMsg.text !== "नमस्ते 👋 café") {
      throw new Error("Unicode message was not preserved");
    }

    const maxLengthMessage = once(b, "message");
    await emitAck(a, "message", "m".repeat(500));
    const maxLengthMsg = await maxLengthMessage;
    if (maxLengthMsg.text.length !== 500) {
      throw new Error("maximum-length valid message was changed or rejected");
    }

    // Newlines must survive the relay so the client can render them.
    const multilineMessage = once(b, "message");
    await emitAck(a, "message", "first line\nsecond line");
    const multilineMsg = await multilineMessage;
    if (multilineMsg.text !== "first line\nsecond line") {
      throw new Error("newlines were not preserved: " + JSON.stringify(multilineMsg.text));
    }

    // Invalid payloads must be rejected WITH an ack — and must not burn
    // message rate-limit quota (validation happens before the limiter).
    for (const [payload, why] of [
      [{ text: "spoofed" }, "object message payload"],
      [null, "null message payload"],
      [42, "numeric message payload"],
      ["", "empty message payload"],
      ["   \n\t ", "whitespace-only message payload"],
      ["x".repeat(600), "over-limit message payload"],
    ]) {
      const rejected = await emitAck(a, "message", payload);
      if (rejected.ok !== false || !rejected.error) {
        throw new Error(why + " was not rejected with an ack");
      }
    }
    await nothingArrives(b, "message", 400, "rejected message payload was broadcast");

    // Rate limit: the per-window budget is 8; the 9th gets an error ack.
    for (let i = 0; i < 4; i++) {
      const okAck = await emitAck(a, "message", `burst ${i}`);
      if (!okAck.ok) throw new Error(`burst message ${i} was unexpectedly rejected`);
      await once(b, "message"); // drain the broadcast
    }
    const limited = await emitAck(a, "message", "one too many");
    if (limited.ok !== false || !limited.error.includes("slow")) {
      throw new Error("rate limit did not reject the 9th message: " + JSON.stringify(limited));
    }
    await nothingArrives(b, "message", 400, "rate-limited message was broadcast");

    // ---- typing ----
    const gotTyping = once(b, "typing");
    const typingAck = await emitAck(a, "typing", true);
    if (!typingAck.ok) throw new Error("valid typing event was not acknowledged");
    const typing = await gotTyping;
    if (typing.user !== "alice" || typing.isTyping !== true) {
      throw new Error("typing payload wrong: " + JSON.stringify(typing));
    }

    await nothingArrives(b, "typing", 500, "non-boolean typing payload was relayed");
    a.emit("typing", { isTyping: true });

    // ---- room creation + slugs ----
    const newRoom = await emitAck(a, "new room", "-- Test !!! Room --");
    if (newRoom.room !== "test-room") {
      throw new Error("room slug normalization wrong: " + newRoom.room);
    }

    const slugJoin = await emitAck(a, "join", { name: "alice", room: "QA !!! Room" });
    if (!slugJoin.ok || slugJoin.room !== "qa-room") {
      throw new Error("join room slug normalization wrong: " + JSON.stringify(slugJoin));
    }

    const invalidRoomType = await emitAck(a, "new room", { room: "not-a-string" });
    if (invalidRoomType.ok !== false) {
      throw new Error("non-string room creation payload was accepted");
    }

    const invalidRoomName = await emitAck(a, "new room", "!!!");
    if (invalidRoomName.ok !== false) {
      throw new Error("room name with no valid slug was accepted");
    }

    // Unjoined room reservations are removed when their creator disconnects.
    const roomCreator = client();
    await once(roomCreator, "connect");
    const creatorJoin = await emitAck(roomCreator, "join", { name: "room-owner", room: "lobby" });
    if (!creatorJoin.ok) throw new Error("room creator could not join lobby");
    const roomAppears = once(b, "rooms");
    const reservation = await emitAck(roomCreator, "new room", "abandoned-room");
    if (!reservation.ok) throw new Error("room reservation failed");
    const roomsWithReservation = await roomAppears;
    if (!roomsWithReservation.some((r) => r.name === "abandoned-room")) {
      throw new Error("new room was not announced");
    }
    const roomDisappears = once(b, "rooms");
    roomCreator.disconnect();
    const roomsAfterDisconnect = await roomDisappears;
    if (roomsAfterDisconnect.some((r) => r.name === "abandoned-room")) {
      throw new Error("unjoined room reservation survived creator disconnect");
    }

    // Multiple clients may reserve the same empty room before anyone joins it.
    const roomObserver = client();
    await once(roomObserver, "connect");
    const observerJoin = await emitAck(roomObserver, "join", { name: "room-observer", room: "random" });
    if (!observerJoin.ok) throw new Error("room observer could not join random");
    const firstSharedCreator = client();
    await once(firstSharedCreator, "connect");
    const firstSharedJoin = await emitAck(firstSharedCreator, "join", { name: "room-owner-one", room: "lobby" });
    if (!firstSharedJoin.ok) throw new Error("first shared-room creator could not join lobby");
    const secondCreator = client();
    await once(secondCreator, "connect");
    const secondJoin = await emitAck(secondCreator, "join", { name: "room-owner-two", room: "lobby" });
    if (!secondJoin.ok) throw new Error("second room creator could not join lobby");
    const firstReservation = await emitAck(firstSharedCreator, "new room", "shared-pending-room");
    const secondReservation = await emitAck(secondCreator, "new room", "shared-pending-room");
    if (!firstReservation.ok || !secondReservation.ok) {
      throw new Error("shared room reservation failed");
    }
    firstSharedCreator.disconnect();
    const roomsRefresh = once(roomObserver, "rooms");
    // Switching rooms (not a same-room rejoin — that is now a silent no-op)
    // forces the server to announce the room list.
    roomObserver.emit("join", { name: "room-observer", room: "tech" });
    const roomsAfterFirstCreator = await roomsRefresh;
    if (!roomsAfterFirstCreator.some((r) => r.name === "shared-pending-room")) {
      throw new Error("one creator disconnect removed another creator's reservation");
    }
    const sharedRoomDisappears = once(roomObserver, "rooms");
    secondCreator.disconnect();
    const roomsAfterLastCreator = await sharedRoomDisappears;
    if (roomsAfterLastCreator.some((r) => r.name === "shared-pending-room")) {
      throw new Error("shared empty room survived the last creator disconnect");
    }
    roomObserver.disconnect();

    // room-switch rename: c joins tech as "alice", then a switches to tech
    // and must be renamed by the server (ack carries the new name)
    const c = client();
    await once(c, "connect");
    const cJoin = await emitAck(c, "join", { name: "alice", room: "tech" });
    if (cJoin.name !== "alice") throw new Error("setup join failed: " + cJoin.name);
    const switched = await emitAck(a, "join", { name: "alice", room: "tech" });
    if (switched.name !== "alice (2)") {
      throw new Error(`switch rename broken: got "${switched.name}"`);
    }
    c.close();
    // move a back to lobby so the disconnect check below still holds
    const back = await emitAck(a, "join", { name: "alice", room: "lobby" });
    if (back.name !== "alice") throw new Error("rejoin failed: " + back.name);

    // Duplicate suffixes must not push nicknames beyond the documented limit.
    const longBase = "abcdefghijklmnopqrst";
    const longA = await emitAck(a, "join", { name: longBase, room: "limit-name" });
    const longB = await emitAck(b, "join", { name: longBase, room: "limit-name" });
    if (longA.name !== longBase || longB.name.length > 20 ||
        longB.name.toLowerCase() === longA.name.toLowerCase() ||
        !longB.name.endsWith(" (2)")) {
      throw new Error("duplicate long nicknames must remain unique and at most 20 characters");
    }

    // Re-joining the room you are already in must be a silent no-op:
    // no "left"/"joined" system noise, no roster churn.
    const rejoin = await emitAck(a, "join", { name: longA.name, room: "limit-name" });
    if (!rejoin.ok || rejoin.name !== longA.name) {
      throw new Error("same-room rejoin should succeed unchanged: " + JSON.stringify(rejoin));
    }
    await nothingArrives(b, "system", 500, "same-room rejoin produced system noise");

    // disconnect cleanup: b leaves the user list
    const afterLeave = once(a, "users");
    b.disconnect();
    const remaining = await afterLeave;
    if (remaining.includes(longB.name)) {
      throw new Error("departed user still listed");
    }

    // ---- graceful shutdown: SIGTERM drains clients and exits 0 ----
    const clientDisconnected = once(a, "disconnect", 5000);
    const exitCalls = [];
    const realExit = process.exit;
    process.exit = (code) => exitCalls.push(code);
    try {
      process.emit("SIGTERM"); // invoke the registered signal handler
      await clientDisconnected;
      await new Promise((r) => setTimeout(r, 400)); // allow the close callback
    } finally {
      process.exit = realExit;
    }
    if (exitCalls[0] !== 0) {
      throw new Error("SIGTERM shutdown should request exit code 0, got: " + exitCalls[0]);
    }

    console.log("smoke test: all checks passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("smoke test FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    a?.close();
    b?.close();
    ios.disconnectSockets();
    try { server.close(); } catch { /* already closed by the drain test */ }
  }
}

main().then(() => process.exit(process.exitCode || 0));
