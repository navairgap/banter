/**
 * Integration smoke test: boots the server on a scratch port, connects two
 * socket.io clients, and exercises the core event flow end to end.
 *
 * Run with: npm test
 */

const { fork } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

const PORT = 3459;
const URL = `http://localhost:${PORT}`;

function client() {
  return io(URL, { transports: ["websocket"], forceNew: true });
}

function once(sock, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting for "${event}"`)),
      timeoutMs
    );
    sock.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

async function main() {
  const server = fork(path.join(__dirname, "..", "server.js"), [], {
    env: { ...process.env, PORT: String(PORT) },
    silent: true,
  });
  server.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  server.stderr.on("data", (d) => process.stdout.write("[server:err] " + d));

  let a, b;
  try {
    await new Promise((r) => setTimeout(r, 700)); // let it bind

    const health = await fetch(`${URL}/healthz`);
    if (!health.ok || JSON.stringify(await health.json()) !== JSON.stringify({ ok: true })) {
      throw new Error("health endpoint did not return its expected status");
    }

    a = client();
    b = client();
    await once(a, "connect");
    await once(b, "connect");

    // Invalid payloads must be rejected without creating a room membership.
    const invalidJoin = await new Promise((r) => a.emit("join", [], r));
    if (invalidJoin.ok !== false) throw new Error("array join payload was not rejected");

    const invalidName = await new Promise((r) =>
      a.emit("join", { name: { nested: true }, room: "lobby" }, r)
    );
    if (invalidName.ok !== false) throw new Error("object nickname was not rejected");
    const invalidRoom = await new Promise((r) =>
      a.emit("join", { name: "alice", room: ["lobby"] }, r)
    );
    if (invalidRoom.ok !== false) throw new Error("array room name was not rejected");

    // join
    const joinedA = await new Promise((r) =>
      a.emit("join", { name: "alice", room: "lobby" }, r)
    );
    if (!joinedA.ok || joinedA.name !== "alice") throw new Error("join A failed");
    // user list reaches both — attach the listener between the joins:
    // A's own join already broadcast a list, B's join is the one we catch
    const usersA = once(a, "users");
    const joinedB = await new Promise((r) =>
      b.emit("join", { name: "alice", room: "lobby" }, r) // duplicate name on purpose
    );
    if (joinedB.name !== "alice (2)") {
      throw new Error(`duplicate-name suffix broken: got "${joinedB.name}"`);
    }
    const list = await usersA;
    if (!list.includes("alice") || !list.includes("alice (2)")) {
      throw new Error("user list incomplete: " + JSON.stringify(list));
    }

    // b sees a's message
    const gotMsg = once(b, "message");
    a.emit("message", "hello from alice");
    const msg = await gotMsg;
    if (msg.user !== "alice" || msg.text !== "hello from alice") {
      throw new Error("message payload wrong: " + JSON.stringify(msg));
    }

    const unicodeMessage = once(b, "message");
    a.emit("message", "नमस्ते 👋 café");
    const unicodeMsg = await unicodeMessage;
    if (unicodeMsg.text !== "नमस्ते 👋 café") {
      throw new Error("Unicode message was not preserved");
    }

    const maxLengthMessage = once(b, "message");
    a.emit("message", "m".repeat(500));
    const maxLengthMsg = await maxLengthMessage;
    if (maxLengthMsg.text.length !== 500) {
      throw new Error("maximum-length valid message was changed or rejected");
    }

    // Non-string message payloads must not be relayed.
    const malformedNotArrive = once(b, "message", 500).then(
      () => { throw new Error("object message payload was relayed"); },
      () => "ignored-as-expected"
    );
    a.emit("message", { text: "spoofed" });
    await malformedNotArrive;

    // oversized message is rejected (silently dropped)
    const shouldNotArrive = once(b, "message", 500).then(
      () => {
        throw new Error("500+ char message was relayed");
      },
      () => "ignored-as-expected"
    );
    a.emit("message", "x".repeat(600));
    await shouldNotArrive;

    const whitespaceNotArrive = once(b, "message", 500).then(
      () => { throw new Error("whitespace-only message was relayed"); },
      () => "ignored-as-expected"
    );
    a.emit("message", "   \n\t ");
    await whitespaceNotArrive;

    // typing indicator
    const gotTyping = once(b, "typing");
    a.emit("typing", true);
    const typing = await gotTyping;
    if (typing.user !== "alice" || typing.isTyping !== true) {
      throw new Error("typing payload wrong: " + JSON.stringify(typing));
    }

    const malformedTypingNotArrive = once(b, "typing", 500).then(
      () => { throw new Error("non-boolean typing payload was relayed"); },
      () => "ignored-as-expected"
    );
    a.emit("typing", { isTyping: true });
    await malformedTypingNotArrive;

    // room creation
    const newRoom = await new Promise((r) => a.emit("new room", "-- Test !!! Room --", r));
    if (newRoom.room !== "test-room") {
      throw new Error("room slug normalization wrong: " + newRoom.room);
    }

    const slugJoin = await new Promise((r) =>
      a.emit("join", { name: "alice", room: "QA !!! Room" }, r)
    );
    if (!slugJoin.ok || slugJoin.room !== "qa-room") {
      throw new Error("join room slug normalization wrong: " + JSON.stringify(slugJoin));
    }

    const invalidRoomType = await new Promise((r) =>
      a.emit("new room", { room: "not-a-string" }, r)
    );
    if (invalidRoomType.ok !== false) {
      throw new Error("non-string room creation payload was accepted");
    }

    const invalidRoomName = await new Promise((r) => a.emit("new room", "!!!", r));
    if (invalidRoomName.ok !== false) {
      throw new Error("room name with no valid slug was accepted");
    }

    // room-switch rename: c joins tech as "alice", then a switches to tech
    // and must be renamed by the server (ack carries the new name)
    const c = client();
    await once(c, "connect");
    const cJoin = await new Promise((r) => c.emit("join", { name: "alice", room: "tech" }, r));
    if (cJoin.name !== "alice") throw new Error("setup join failed: " + cJoin.name);
    const switched = await new Promise((r) =>
      a.emit("join", { name: "alice", room: "tech" }, r)
    );
    if (switched.name !== "alice (2)") {
      throw new Error(`switch rename broken: got "${switched.name}"`);
    }
    c.close();
    // move a back to lobby so the disconnect check below still holds
    const back = await new Promise((r) => a.emit("join", { name: "alice", room: "lobby" }, r));
    if (back.name !== "alice") throw new Error("rejoin failed: " + back.name);

    // disconnect cleanup: b leaves the user list
    const afterLeave = once(a, "users");
    b.disconnect();
    const remaining = await afterLeave;
    if (remaining.includes("alice (2)")) {
      throw new Error("departed user still listed");
    }

    console.log("smoke test: all checks passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("smoke test FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    a?.close();
    b?.close();
    server.kill();
  }
}

main();
