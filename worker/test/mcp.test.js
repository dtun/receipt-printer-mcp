import { env, exports } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";

const BASE = "https://printer.test";
const REDIRECT = "https://claude.example/callback";

afterEach(async () => {
  vi.restoreAllMocks();
  // Storage is shared across tests; reset the per-address code limit.
  const { keys } = await env.OAUTH_KV.list({ prefix: "email-code-rate:" });
  await Promise.all(keys.map(({ name }) => env.OAUTH_KV.delete(name)));
});

// A tiny browser: carries cookies between requests, never follows redirects.
function browser() {
  const jar = new Map();
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await exports.default.fetch(new URL(path, BASE), { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      jar.set(k, v);
    }
    return res;
  };
}

// Captures emailed codes instead of sending them.
function inbox() {
  const sent = [];
  vi.spyOn(env.EMAIL, "send").mockImplementation(async (msg) => {
    sent.push(msg);
    return { messageId: "test" };
  });
  return { sent, code: () => sent.at(-1)?.subject.match(/(\d{6})$/)[1] };
}

async function s256(v) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Starts connecting a client and submits `email` on the consent page.
// Returns the code page, the browser, and what's needed to finish.
async function start(email) {
  const go = browser();
  const reg = await go("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = await reg.json();
  const verifier = "v".repeat(64);
  const authorize = new URL("/authorize", BASE);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    state: "client-state",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });

  const consent = await go(authorize);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("Test client");
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];

  const codePage = await go("/authorize", {
    method: "POST",
    body: new URLSearchParams({ handle, decision: "approve", email }),
  });
  return { go, client_id, verifier, codePage, html: await codePage.text() };
}

// Submits a code on a code page's form.
function submitCode(go, html, code, decision = "verify") {
  const action = html.match(/action="([^"]+)"/)[1].replace(/&amp;/g, "&");
  return go(action, { method: "POST", body: new URLSearchParams({ code, decision }) });
}

// Runs the whole connector sign-in as `email`. Returns the final response.
async function signIn(email) {
  const mail = inbox();
  const s = await start(email);
  const back = await submitCode(s.go, s.html, mail.code() ?? "000000");
  return { ...s, back, mail };
}

async function accessToken() {
  const { back, client_id, verifier, go } = await signIn("me@example.com");
  const code = new URL(back.headers.get("Location")).searchParams.get("code");
  const res = await go("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  return (await res.json()).access_token;
}

// Calls a tool over MCP's HTTP transport and returns the JSON-RPC result.
async function callTool(token, name, args = {}) {
  const res = await exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  const data = body.startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data: ")).slice(6);
  return JSON.parse(data).result;
}

test("/mcp requires a token", async () => {
  const res = await exports.default.fetch(`${BASE}/mcp`, { method: "POST" });
  expect(res.status).toBe(401);
  expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
});

test("an allowlisted address gets a code and completes sign-in", async () => {
  const { back, mail } = await signIn("me@example.com");
  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0].to).toBe("me@example.com");
  expect(back.status).toBe(302);
  const to = new URL(back.headers.get("Location"));
  expect(to.origin + to.pathname).toBe(REDIRECT);
  expect(to.searchParams.get("code")).toBeTruthy();
  expect(to.searchParams.get("state")).toBe("client-state");
});

test("allowlist matching ignores case and spaces", async () => {
  const { back, mail } = await signIn("  PARTNER@example.com ");
  expect(mail.sent[0].to).toBe("partner@example.com");
  expect(back.status).toBe(302);
});

test("other addresses get no email, and the page doesn't say so", async () => {
  const mail = inbox();
  const allowed = await start("me@example.com");
  const stranger = await start("stranger@example.com");
  expect(mail.sent).toHaveLength(1);
  expect(stranger.codePage.status).toBe(allowed.codePage.status);
  const strip = (h) => h.replace(/state=[^"]+/, "").replace(/[\w.]+@example\.com/, "");
  expect(strip(stranger.html)).toBe(strip(allowed.html));
  const back = await submitCode(stranger.go, stranger.html, "123456");
  expect(back.status).toBe(400);
});

test("a wrong code can be retried", async () => {
  const mail = inbox();
  const { go, html } = await start("me@example.com");
  const wrong = await submitCode(go, html, mail.code() === "111111" ? "222222" : "111111");
  expect(wrong.status).toBe(400);
  const retry = await wrong.text();
  expect(retry).toContain("didn&#39;t match");
  const back = await submitCode(go, retry, mail.code());
  expect(back.status).toBe(302);
  expect(new URL(back.headers.get("Location")).searchParams.get("code")).toBeTruthy();
});

test("five wrong codes end the attempt", async () => {
  const mail = inbox();
  let { go, html } = await start("me@example.com");
  const bad = mail.code() === "111111" ? "222222" : "111111";
  let res;
  for (let i = 0; i < 5; i++) {
    res = await submitCode(go, html, bad);
    html = await res.text();
  }
  expect(res.status).toBe(403);
  expect(html).toContain("Too many tries");
});

test("a code page can't be reused once it's been submitted", async () => {
  const mail = inbox();
  const { go, html } = await start("me@example.com");
  await submitCode(go, html, mail.code());
  const again = await submitCode(go, html, mail.code());
  expect(again.status).toBe(400);
});

test("cancel sends the client access_denied", async () => {
  inbox();
  const { go, html } = await start("me@example.com");
  const back = await submitCode(go, html, "", "cancel");
  expect(back.status).toBe(302);
  expect(new URL(back.headers.get("Location")).searchParams.get("error")).toBe("access_denied");
});

test("codes to one address are limited per hour", async () => {
  const mail = inbox();
  for (let i = 0; i < 6; i++) await start("partner@example.com");
  expect(mail.sent.length).toBeLessThanOrEqual(5);
});

test("print_receipt queues while the agent is offline", async () => {
  const token = await accessToken();
  const result = await callTool(token, "print_receipt", { text: "hello" });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toMatch(/offline/);
});

test("print_receipt rejects lines over 48 columns", async () => {
  const token = await accessToken();
  const result = await callTool(token, "print_receipt", { text: "x".repeat(49) });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/line 1: 49 chars/);
});

test("print_receipt strips printer control codes before sending", async () => {
  const token = await accessToken();
  await callTool(token, "print_receipt", { text: "safe\x1b@\x1dV\x00text" });
  const res = await exports.default.fetch(`${BASE}/agent`, {
    headers: { Upgrade: "websocket", Authorization: "Bearer test-token" },
  });
  const ws = res.webSocket;
  const jobs = [];
  ws.addEventListener("message", ({ data }) => jobs.push(JSON.parse(data).text));
  ws.accept();
  await new Promise((r) => setTimeout(r, 50));
  expect(jobs.at(-1)).toBe("safe@Vtext");
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
});

test("printer_status reports an offline agent as an error", async () => {
  const token = await accessToken();
  const result = await callTool(token, "printer_status");
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/offline/);
});
