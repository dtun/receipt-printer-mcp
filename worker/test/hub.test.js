import { env, exports } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";

const hub = () => env.HUB.get(env.HUB.idFromName("home"));
const sockets = [];

// Connects as the home agent. `onJob` answers each job the hub sends.
async function connectAgent({ token = "test-token", onJob } = {}) {
  const res = await exports.default.fetch("https://printer.test/agent", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  const ws = res.webSocket;
  if (!ws) return { res };
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
  return { res, ws, jobs };
}

const tick = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close();
});

test("rejects agents without the right token", async () => {
  const { res } = await connectAgent({ token: "wrong" });
  expect(res.status).toBe(401);
});

test("queues jobs while the agent is offline and delivers them on connect", async () => {
  expect(await hub().print("first")).toMatchObject({ state: "queued" });
  expect(await hub().print("second")).toMatchObject({ state: "queued" });
  expect(await hub().status()).toMatchObject({ online: false, queued: 2 });

  const { jobs } = await connectAgent();
  await tick();
  expect(jobs).toEqual(["first", "second"]);
  expect(await hub().status()).toMatchObject({ queued: 0 });
});

test("reports the agent's result for a live print", async () => {
  await connectAgent({ onJob: (text) => ({ ok: true, message: `printed ${text}` }) });
  expect(await hub().print("hello")).toEqual({ state: "printed", message: "printed hello" });
});

test("passes printer failures back", async () => {
  await connectAgent({ onJob: () => ({ ok: false, message: "lp: printer not found" }) });
  expect(await hub().print("hello")).toEqual({ state: "failed", message: "lp: printer not found" });
});

test("relays printer status from the agent", async () => {
  await connectAgent();
  expect(await hub().status()).toMatchObject({ online: true, report: { ok: true, message: "idle" } });
});

test("a new agent connection replaces the old one", async () => {
  const first = await connectAgent();
  const closed = new Promise((r) => first.ws.addEventListener("close", r));
  await connectAgent({ onJob: () => ({ ok: true, message: "from second" }) });
  await closed;
  expect(await hub().print("hello")).toMatchObject({ message: "from second" });
});

test("caps the offline queue", async () => {
  for (let i = 0; i < 20; i++) await hub().print(`job ${i}`);
  expect(await hub().print("one too many")).toMatchObject({ state: "full" });
});
