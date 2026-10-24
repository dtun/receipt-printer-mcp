// Everything outside /mcp: the OAuth consent page, sign-in with an emailed
// code, and the agent socket. Only addresses listed in ALLOWED_EMAILS (comma
// separated) are ever sent a code; the page looks the same for any address so
// it doesn't reveal who is on the list.

import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { handleAgent } from "./agent-route.js";

const MAX_TRIES = 5; // wrong codes before starting over
const CODES_PER_HOUR = 5; // per address, so nobody can flood an inbox

export const authHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // `return await` so failures land in the catch below.
      if (url.pathname === "/agent") return await handleAgent(request, env);
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await sendCode(request, env);
      if (url.pathname === "/verify" && request.method === "POST") return await verify(request, env);
      if (url.pathname === "/") return new Response("Receipt printer MCP server. Connect at /mcp.\n");
      return new Response("Not found", { status: 404 });
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
        return page(400, "Can't connect", `${message} Start connecting again from Claude.`);
      }
      throw e;
    }
  },
};

// GET /authorize: say which app is asking, and ask for an email address.
async function showConsent(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const req = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(req);
  const consent = await oauth.beginConsent(req);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

// POST /authorize: on approval, email a code (if the address is allowed) and
// ask for it. The request and code live server-side behind `state`.
async function sendCode(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const email = String(form.get("email") ?? "").trim().toLowerCase();

  let codeHash = null;
  if (allowed(env).has(email) && (await underRateLimit(env, email))) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: "Receipt printer" },
      to: email,
      subject: `Your receipt printer code: ${code}`,
      text: `Your code to connect Claude to the receipt printer is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.`,
    });
    codeHash = await sha256(code);
  }
  return askForCode(oauth, approved.request, approved.headers, { email, codeHash, tries: 0 });
}

// POST /verify?state=…: check the code, then finish the grant.
async function verify(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream(request);
  const form = await request.formData();
  if (form.get("decision") === "cancel") {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  const ok = data.codeHash !== null && timingSafeEqual(await sha256(code), data.codeHash);
  if (!ok) {
    const tries = data.tries + 1;
    if (tries >= MAX_TRIES) return page(403, "Too many tries", "That code didn't match. Start connecting again from Claude to get a new one.");
    return askForCode(oauth, original, headers, { ...data, tries }, "That code didn't match. Try again.");
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: data.email,
    metadata: { label: data.email },
    scope: original.scope,
    props: { email: data.email },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

async function askForCode(oauth, authRequest, headers, data, error = "") {
  const { state, headers: out } = await oauth.beginUpstream(authRequest, { data, headers });
  out.set("Content-Type", "text/html; charset=utf-8");
  out.set("X-Frame-Options", "DENY");
  out.set("Content-Security-Policy", "frame-ancestors 'none'");
  return new Response(codePage(state, data.email, error), { status: error ? 400 : 200, headers: out });
}

const allowed = (env) =>
  new Set((env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

// Counts codes sent to an address in the current hour. KV isn't atomic, so
// this is a soft limit, which is plenty to stop an inbox being flooded.
async function underRateLimit(env, email) {
  const key = `email-code-rate:${await sha256(email)}:${Math.floor(Date.now() / 3_600_000)}`;
  const sent = Number((await env.OAUTH_KV.get(key)) ?? 0);
  if (sent >= CODES_PER_HOUR) return false;
  await env.OAUTH_KV.put(key, String(sent + 1), { expirationTtl: 3600 });
  return true;
}

async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}
button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem}
input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box}</style>`;

function consentPage(details, handle) {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<!doctype html>
<meta charset="utf-8">${STYLE}
<title>Connect ${name}</title>
<h1>Let ${name} use the receipt printer?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><label>Your email<br><input type="email" name="email" autocomplete="email" required></label></p>
  <p>We'll send a code to it.</p>
  <button name="decision" value="approve">Send code</button><button name="decision" value="deny" formnovalidate>Deny</button>
</form>`;
}

function codePage(state, email, error) {
  return `<!doctype html>
<meta charset="utf-8">${STYLE}
<title>Enter your code</title>
<h1>Enter your code</h1>
${error ? `<p><strong>${escape(error)}</strong></p>` : ""}
<p>If ${escape(email)} can use this printer, a 6-digit code is on its way. It works for 10 minutes.</p>
<form method="post" action="/verify?state=${encodeURIComponent(state)}">
  <p><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" required autofocus></p>
  <button name="decision" value="verify">Connect</button><button name="decision" value="cancel" formnovalidate>Cancel</button>
</form>`;
}

function page(status, title, message) {
  return new Response(`<!doctype html>\n<meta charset="utf-8">${STYLE}\n<title>${escape(title)}</title>\n<h1>${escape(title)}</h1>\n<p>${escape(message)}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
  });
}
