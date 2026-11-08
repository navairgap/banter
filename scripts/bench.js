/**
 * Load benchmark: opens N bot clients against the real server (in-process),
 * has each send one message per second, and reports message round-trip
 * percentiles.
 *
 * Run with: npm run bench [-- --clients 100 --duration 10]
 *
 * The server runs with BENCH=1, which relaxes only the per-IP connection
 * cap so a single machine can open many loopback sockets. Never expose a
 * BENCH=1 process to the public internet.
 */

const { io } = require("socket.io-client");

// Must be set before server.js is required — it reads the flag at load time.
process.env.BENCH = "1";
const { server, start } = require("../server.js");

function parseArgs(argv) {
  const args = { clients: 100, duration: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--clients") args.clients = Number(argv[++i]);
    if (argv[i] === "--duration") args.duration = Number(argv[++i]);
  }
  if (!Number.isFinite(args.clients) || args.clients < 2) args.clients = 2;
  if (args.clients > 500) args.clients = 500;
  if (!Number.isFinite(args.duration) || args.duration < 2) args.duration = 2;
  if (args.duration > 120) args.duration = 120;
  return args;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function connect(port, name) {
  return new Promise((resolve, reject) => {
    const sock = io(`http://localhost:${port}`, {
      transports: ["websocket"],
      forceNew: true,
    });
    const guard = setTimeout(() => reject(new Error("bot connect timeout")), 10_000);
    sock.on("connect", () => {
      clearTimeout(guard);
      sock.emit("join", { name, room: "bench" }, (res) => {
        if (res && res.ok) resolve(sock);
        else reject(new Error("bot join failed: " + JSON.stringify(res)));
      });
    });
    sock.on("connect_error", (err) => {
      clearTimeout(guard);
      reject(err);
    });
  });
}

async function main() {
  const { clients: n, duration: seconds } = parseArgs(process.argv.slice(2));

  await start({ port: 0 }); // port 0 → the OS picks a free one
  const port = server.address().port;

  const latencies = [];
  let sent = 0;
  let echoes = 0;
  const timers = [];
  const bots = [];

  console.log(`banter bench — ${n} clients, ${seconds}s, room "bench"`);
  const connectedAt = Date.now();
  for (let i = 0; i < n; i++) {
    const name = `bot-${i}`;
    const sock = await connect(port, name);
    // Each bot measures the echo of its own message (names are unique in
    // the room). A lost echo self-heals: the next send overwrites the stamp.
    sock.on("message", (m) => {
      if (m && m.user === name && sock.sentAt) {
        latencies.push(Date.now() - sock.sentAt);
        sock.sentAt = null;
        echoes += 1;
      }
    });
    bots.push(sock);
  }
  console.log(`connected: ${bots.length}/${n} in ${Date.now() - connectedAt}ms`);

  // Stagger the senders evenly. The cadence stays below the server's
  // message rate limit (8 per 10s → interval > 1.25s) so no bot is throttled.
  const SEND_INTERVAL_MS = 1500;
  const offset = Math.min(75, SEND_INTERVAL_MS / n);
  bots.forEach((sock, i) => {
    const name = `bot-${i}`;
    const send = () => {
      sock.sentAt = Date.now();
      sock.emit("message", `ping ${name}`, () => {});
      sent += 1;
    };
    timers.push(setTimeout(send, i * offset));
    timers.push(setInterval(send, SEND_INTERVAL_MS));
  });

  await new Promise((r) => setTimeout(r, seconds * 1000));
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  bots.forEach((sock) => sock.close());

  latencies.sort((x, y) => x - y);
  const elapsed = Date.now() - connectedAt;
  console.log(`messages sent: ${sent} (${((sent / elapsed) * 1000).toFixed(1)}/s)`);
  console.log(`echoes received: ${echoes}`);
  if (latencies.length) {
    console.log(
      `round-trip latency ms: p50 ${percentile(latencies, 50)}` +
      ` p95 ${percentile(latencies, 95)}` +
      ` p99 ${percentile(latencies, 99)}` +
      ` max ${latencies[latencies.length - 1]}`
    );
  }

  // release the port so the process can exit cleanly
  bots.forEach((sock) => { sock.sentAt = null; });
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  server.close(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("bench failed:", err.message);
  process.exit(1);
});
