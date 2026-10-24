// Remote side of the receipt printer. Claude connects at /mcp (OAuth with an
// emailed code, allowlisted addresses only); the home agent connects at /agent.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authHandler } from "./auth.js";
import { mcpHandler } from "./mcp.js";

export { PrinterHub } from "./hub.js";

// The token audience must be this server's canonical URL. Use PUBLIC_URL when
// set (a custom domain), else whatever host the request arrived on.
const providers = new Map();

function provider(base) {
  if (!providers.has(base)) {
    providers.set(
      base,
      new OAuthProvider({
        apiRoute: "/mcp",
        apiHandler: mcpHandler,
        defaultHandler: authHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
      }),
    );
  }
  return providers.get(base);
}

export default {
  fetch(request, env, ctx) {
    const base = env.PUBLIC_URL?.replace(/\/$/, "") ?? new URL(request.url).origin;
    return provider(base).fetch(request, env, ctx);
  },
};
