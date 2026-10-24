import { exports } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";

const printer = () => exports.PrinterService;
const sockets = [];

// Connects as the home agent, which also drains anything queued by earlier
// tests. `onJob` answers each job the hub sends.
async function connectAgent({ onJob } = {}) {
  const res = await exports.default.fetch("https://printer.test/agent", {
    headers: { Upgrade: "websocket", Authorization: "Bearer test-token" },
  });
  const ws = res.webSocket;
  const jobs = [];
  ws.accept();
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.type === "job") {
      jobs.push(msg.text);
      if (onJob) ws.send(JSON.stringify({ type: "result", id: msg.id, ...onJob(msg.text) }));
    }
    if (msg.type === "status") ws.send(JSON.stringify({ type: "status", id: msg.id, ok: true, message: "idle" }));
  });
  sockets.push(ws);
  return { ws, jobs };
}

const tick = () => new Promise((r) => setTimeout(r, 50));

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await tick();
});

test("print queues while the agent is offline and says it will print later", async () => {
  expect(await printer().print("hello")).toEqual({
    ok: true,
    message: "The print agent is offline; this will print when it reconnects.",
  });
});

test("print returns the agent's message once it has printed", async () => {
  await connectAgent({ onJob: (text) => ({ ok: true, message: `printed ${text}` }) });
  expect(await printer().print("hello")).toEqual({ ok: true, message: "printed hello" });
});

test("print reports a printer failure as ok: false", async () => {
  await connectAgent({ onJob: () => ({ ok: false, message: "lp: printer not found" }) });
  expect(await printer().print("hello")).toEqual({ ok: false, message: "Print failed: lp: printer not found" });
});

test("print rejects lines over 48 columns without sending them", async () => {
  const { jobs } = await connectAgent({ onJob: () => ({ ok: true, message: "ok" }) });
  const result = await printer().print("x".repeat(49));
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/line 1: 49 chars/);
  expect(jobs).not.toContain("x".repeat(49));
});

test("print strips printer control codes before they reach the agent", async () => {
  const { jobs } = await connectAgent({ onJob: () => ({ ok: true, message: "ok" }) });
  await printer().print("safe\x1b@\x1dV\x00text");
  expect(jobs.at(-1)).toBe("safe@Vtext");
});

test("print rejects text over 10000 characters", async () => {
  expect(await printer().print("x\n".repeat(5_001))).toEqual({
    ok: false,
    message: "Nothing printed. Text is over 10000 characters.",
  });
});

test("print rejects empty and non-string input", async () => {
  for (const bad of ["", undefined, 42, { text: "hi" }]) {
    expect(await printer().print(bad)).toMatchObject({ ok: false, message: expect.stringMatching(/^Nothing printed\./) });
  }
});

test("status reports an offline agent as ok: false", async () => {
  const result = await printer().status();
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/offline/);
});

test("status relays the agent's report when it is online", async () => {
  await connectAgent();
  const result = await printer().status();
  expect(result.ok).toBe(true);
  expect(result.message).toMatch(/^idle\n/);
});
