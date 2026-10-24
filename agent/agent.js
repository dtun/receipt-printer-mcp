// The home print agent: keeps a WebSocket open to the Worker's PrinterHub and
// prints the jobs it sends. Outbound only, so it works behind any router.

import { checkWidth, stripControl } from "../lib/receipt.js";

// Handles one message from the hub. Jobs print one at a time, in order.
// Returns a promise that settles when everything received so far is done.
export function createHandler({ print, status, send }) {
  let queue = Promise.resolve();

  async function runJob({ id, text }) {
    const content = stripControl(String(text ?? ""));
    const tooWide = checkWidth(content);
    if (tooWide) return send({ type: "result", id, ok: false, message: tooWide });
    try {
      send({ type: "result", id, ok: true, message: await print(content) });
    } catch (e) {
      send({ type: "result", id, ok: false, message: e.message });
    }
  }

  return (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return queue;
    }
    if (msg.type === "job") {
      queue = queue.then(() => runJob(msg));
    } else if (msg.type === "status") {
      status().then(
        (message) => send({ type: "status", id: msg.id, ok: true, message }),
        (e) => send({ type: "status", id: msg.id, ok: false, message: e.message }),
      );
    }
    return queue;
  };
}

// Connects to the hub and stays connected: pings every pingMs, treats two
// missed pongs as a dead connection, and reconnects with backoff (1s to 60s).
export function connect({ url, token, onMessage, log = console.log, WebSocketImpl = WebSocket, pingMs = 30_000 }) {
  let ws, ping, retry;
  let delay = 1000;
  let stopped = false;

  const reconnect = (why) => {
    clearInterval(ping);
    if (stopped) return;
    log(`Disconnected (${why}); retrying in ${delay / 1000}s.`);
    retry = setTimeout(open, delay);
    delay = Math.min(delay * 2, 60_000);
  };

  function open() {
    const socket = (ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}` } }));
    let lastHeard = Date.now();
    // Events from a socket we've already given up on are ignored.
    const current = (fn) => (event) => socket === ws && fn(event);

    socket.addEventListener("open", current(() => {
      delay = 1000;
      lastHeard = Date.now();
      log(`Connected to ${url}.`);
      ping = setInterval(() => {
        if (Date.now() - lastHeard > pingMs * 2) {
          ws = null;
          socket.close();
          return reconnect("no reply to pings");
        }
        socket.send("ping");
      }, pingMs);
    }));
    socket.addEventListener("message", current(({ data }) => {
      lastHeard = Date.now();
      if (data !== "pong") onMessage(String(data));
    }));
    socket.addEventListener("close", current(({ code, reason }) => {
      ws = null;
      reconnect(`${code}${reason ? ` ${reason}` : ""}`);
    }));
    socket.addEventListener("error", () => {}); // a close event always follows
  }

  open();
  return {
    send(msg) {
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    },
    stop() {
      stopped = true;
      clearInterval(ping);
      clearTimeout(retry);
      ws?.close();
    },
  };
}
