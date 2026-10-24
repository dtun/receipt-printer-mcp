// Remote side of the receipt printer: the home agent connects at /agent.

import { handleAgent } from "./agent-route.js";

export { PrinterHub } from "./hub.js";

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/agent") return handleAgent(request, env);
    return new Response("Not found", { status: 404 });
  },
};
