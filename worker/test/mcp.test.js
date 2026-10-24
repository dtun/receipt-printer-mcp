import { env, exports } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";

const BASE = "https://printer.test";
const REDIRECT = "https://claude.example/callback";

afterEach(() => vi.restoreAllMocks());

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

// Pretends to be Google for the token exchange and userinfo calls.
function fakeGoogle(email) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Promise.resolve(Response.json({ access_token: "g" }));
    if (url.startsWith("https://openidconnect.googleapis.com/")) {
      return Promise.resolve(Response.json({ email, email_verified: true }));
    }
    return real(input, init);
  });
}

async function s256(v) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Runs the whole connector sign-in as `email`. Returns the final response.
async function signIn(email) {
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

  const approve = await go("/authorize", { method: "POST", body: new URLSearchParams({ handle, decision: "approve" }) });
  expect(approve.status).toBe(302);
  const google = new URL(approve.headers.get("Location"));
  expect(google.origin).toBe("https://accounts.google.com");
  expect(google.searchParams.get("code_challenge_method")).toBe("S256");

  fakeGoogle(email);
  const back = await go(`/callback?code=c&state=${google.searchParams.get("state")}`);
  return { back, client_id, verifier, go };
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

test("an allowlisted Google account completes sign-in", async () => {
  const { back } = await signIn("me@example.com");
  expect(back.status).toBe(302);
  const to = new URL(back.headers.get("Location"));
  expect(to.origin + to.pathname).toBe(REDIRECT);
  expect(to.searchParams.get("code")).toBeTruthy();
  expect(to.searchParams.get("state")).toBe("client-state");
});

test("allowlist matching ignores case", async () => {
  const { back } = await signIn("partner@example.com");
  expect(back.status).toBe(302);
});

test("other Google accounts are refused", async () => {
  const { back } = await signIn("stranger@example.com");
  expect(back.status).toBe(403);
  expect(await back.text()).toContain("isn&#39;t allowed");
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
