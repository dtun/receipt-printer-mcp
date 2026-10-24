import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, createHandler } from "../agent/agent.js";

function handler({ print = async (t) => `printed ${t}`, status = async () => "idle" } = {}) {
  const sent = [];
  const handle = createHandler({ print, status, send: (m) => sent.push(m) });
  return { handle, sent };
}

const job = (id, text) => JSON.stringify({ type: "job", id, text });

test("prints jobs and reports the result", async () => {
  const { handle, sent } = handler();
  await handle(job("1", "hello"));
  assert.deepEqual(sent, [{ type: "result", id: "1", ok: true, message: "printed hello" }]);
});

test("prints jobs one at a time, in order", async () => {
  const order = [];
  const { handle } = handler({
    print: async (t) => {
      order.push(`start ${t}`);
      await new Promise((r) => setTimeout(r, t === "a" ? 30 : 0));
      order.push(`end ${t}`);
      return "ok";
    },
  });
  handle(job("1", "a"));
  await handle(job("2", "b"));
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

test("rejects over-wide lines without printing", async () => {
  let printed = false;
  const { handle, sent } = handler({ print: async () => (printed = true) });
  await handle(job("1", "x".repeat(49)));
  assert.equal(printed, false);
  assert.equal(sent[0].ok, false);
  assert.match(sent[0].message, /line 1: 49 chars/);
});

test("strips control codes before printing", async () => {
  let got;
  const { handle } = handler({ print: async (t) => (got = t) });
  await handle(job("1", "a\x1dV\x00b"));
  assert.equal(got, "aVb");
});

test("reports print failures", async () => {
  const { handle, sent } = handler({ print: async () => { throw new Error("lp: printer not found"); } });
  await handle(job("1", "hello"));
  assert.deepEqual(sent, [{ type: "result", id: "1", ok: false, message: "lp: printer not found" }]);
});

test("answers status requests", async () => {
  const { handle, sent } = handler();
  handle(JSON.stringify({ type: "status", id: "s" }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [{ type: "status", id: "s", ok: true, message: "idle" }]);
});

test("ignores malformed messages", async () => {
  const { handle, sent } = handler();
  await handle("not json");
  assert.deepEqual(sent, []);
});

// A stand-in for WebSocket that tests drive by hand.
class FakeSocket extends EventTarget {
  static all = [];
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
  drop(code = 1006) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" })); }
}

test("authenticates, passes messages through, and reconnects after a drop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  FakeSocket.all = [];
  const got = [];
  const conn = connect({ url: "wss://x/agent", token: "tok", onMessage: (m) => got.push(m), log: () => {}, WebSocketImpl: FakeSocket });

  const first = FakeSocket.all[0];
  assert.equal(first.opts.headers.Authorization, "Bearer tok");
  first.open();
  first.receive("pong");
  first.receive('{"type":"job"}');
  assert.deepEqual(got, ['{"type":"job"}']);

  first.drop();
  t.mock.timers.tick(1000);
  assert.equal(FakeSocket.all.length, 2);
  conn.stop();
});

test("gives up on a connection that stops answering pings", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  FakeSocket.all = [];
  const conn = connect({ url: "wss://x/agent", token: "tok", onMessage: () => {}, log: () => {}, WebSocketImpl: FakeSocket, pingMs: 100 });
  FakeSocket.all[0].open();
  t.mock.timers.tick(100);
  assert.deepEqual(FakeSocket.all[0].sent, ["ping"]);
  t.mock.timers.tick(200); // no pong for over two intervals
  t.mock.timers.tick(1000); // backoff
  assert.equal(FakeSocket.all.length, 2);
  conn.stop();
});
