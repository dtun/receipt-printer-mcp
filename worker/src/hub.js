// PrinterHub: one Durable Object instance that the home print agent keeps a
// WebSocket open to. MCP tool calls hand it jobs; it forwards them to the
// agent, or queues them until the agent reconnects.
//
// Delivery is at-most-once: a job leaves the queue as it is sent, so a
// dropped connection can lose a receipt but never prints one twice.

import { DurableObject } from "cloudflare:workers";

const PRINT_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_QUEUED = 20;

export class PrinterHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiting = new Map(); // job/request id -> resolve, while a tool call waits
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    // The agent pings to keep NAT and proxies happy; answer without waking up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // The Worker has already checked the agent token before forwarding here.
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    // Only one agent at a time: a new connection replaces the old one.
    for (const old of this.ctx.getWebSockets()) old.close(1012, "Replaced by a new agent connection");

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    await this.ctx.storage.put("lastSeen", Date.now());
    this.flush(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    await this.ctx.storage.put("lastSeen", Date.now());
    if ((msg.type === "result" || msg.type === "status") && typeof msg.id === "string") {
      this.waiting.get(msg.id)?.({ ok: msg.ok === true, message: String(msg.message ?? "") });
    }
  }

  // The runtime answers the close handshake itself (web_socket_auto_reply_to_close).
  async webSocketClose() {
    await this.ctx.storage.put("lastSeen", Date.now());
  }

  async webSocketError() {
    await this.ctx.storage.put("lastSeen", Date.now());
  }

  // Queues a job and, if the agent is connected, waits briefly for the result.
  // Returns { state: "printed" | "failed" | "sent" | "queued" | "full", message }.
  async print(text) {
    const [{ n }] = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").toArray();
    if (n >= MAX_QUEUED) {
      return { state: "full", message: `${n} receipts are already waiting for the printer to come back.` };
    }
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO jobs (id, text, created_at) VALUES (?, ?, ?)", id, text, Date.now());

    const agent = this.agent();
    if (!agent) return { state: "queued", message: "The print agent is offline; this will print when it reconnects." };

    const reply = this.reply(id, PRINT_TIMEOUT_MS);
    this.flush(agent);
    const result = await reply;
    if (!result) return { state: "sent", message: "Sent to the printer, but it didn't confirm in time." };
    return { state: result.ok ? "printed" : "failed", message: result.message };
  }

  // Asks the agent for printer status. Returns { online, lastSeen, queued, report? }.
  async status() {
    const lastSeen = (await this.ctx.storage.get("lastSeen")) ?? null;
    const [{ n: queued }] = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").toArray();
    const agent = this.agent();
    if (!agent) return { online: false, lastSeen, queued };

    const id = crypto.randomUUID();
    const reply = this.reply(id, STATUS_TIMEOUT_MS);
    agent.send(JSON.stringify({ type: "status", id }));
    const result = await reply;
    return { online: true, lastSeen, queued, report: result ?? { ok: false, message: "The agent didn't answer in time." } };
  }

  agent() {
    return this.ctx.getWebSockets()[0] ?? null;
  }

  // Sends every queued job to the agent, oldest first, removing each as it goes.
  flush(ws) {
    const jobs = this.ctx.storage.sql.exec("SELECT id, text FROM jobs ORDER BY created_at").toArray();
    for (const { id, text } of jobs) {
      try {
        ws.send(JSON.stringify({ type: "job", id, text }));
      } catch {
        return; // socket went away; the rest stay queued
      }
      this.ctx.storage.sql.exec("DELETE FROM jobs WHERE id = ?", id);
    }
  }

  // Resolves with the agent's reply for id, or null after ms.
  reply(id, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms);
      const done = (value) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(value);
      };
      this.waiting.set(id, done);
    });
  }
}
