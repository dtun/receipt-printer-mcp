// Everything outside /mcp: the OAuth consent page, sign-in with Google, and
// the agent socket. Only Google accounts listed in ALLOWED_EMAILS (comma
// separated) can finish authorizing a connector.

import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { handleAgent } from "./agent-route.js";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export const authHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/agent") return handleAgent(request, env);
      if (url.pathname === "/authorize" && request.method === "GET") return showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return decide(request, env);
      if (url.pathname === "/callback") return callback(request, env);
      if (url.pathname === "/") return new Response("Receipt printer MCP server. Connect at /mcp.\n");
      return new Response("Not found", { status: 404 });
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
        return page(400, "Can't connect", message);
      }
      throw e;
    }
  },
};

// GET /authorize: ask before sending anyone to Google, so another app can't
// ride an existing Google session to get a token (confused deputy).
async function showConsent(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const req = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(req);
  const consent = await oauth.beginConsent(req);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

// POST /authorize: on approval, start Google sign-in with PKCE.
async function decide(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const google = new URL(GOOGLE_AUTHORIZE);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL("/callback", request.url).href,
    response_type: "code",
    scope: "openid email",
    prompt: "select_account",
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
  });
  headers.set("Location", google.href);
  return new Response(null, { status: 302, headers });
}

// GET /callback: back from Google. Check the account, then finish the grant.
async function callback(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream(request);
  const params = new URL(request.url).searchParams;
  if (params.get("error")) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    body: new URLSearchParams({
      code: params.get("code") ?? "",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL("/callback", request.url).href,
      grant_type: "authorization_code",
      code_verifier: data.verifier,
    }),
  });
  if (!tokenRes.ok) return page(502, "Google sign-in failed", "Google didn't accept the sign-in. Try again.");
  const { access_token } = await tokenRes.json();

  const userRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!userRes.ok) return page(502, "Google sign-in failed", "Couldn't read your Google account. Try again.");
  const { email, email_verified } = await userRes.json();

  if (!email_verified || !allowed(env).has(email.toLowerCase())) {
    return page(403, "Not allowed", `${email} isn't allowed to use this printer.`);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: email.toLowerCase(),
    metadata: { label: email },
    scope: original.scope,
    props: { email: email.toLowerCase() },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

const allowed = (env) =>
  new Set((env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

async function s256(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}
button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem}</style>`;

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
<p>You'll sign in with Google next.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`;
}

function page(status, title, message) {
  return new Response(`<!doctype html>\n<meta charset="utf-8">${STYLE}\n<title>${escape(title)}</title>\n<h1>${escape(title)}</h1>\n<p>${escape(message)}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
  });
}
