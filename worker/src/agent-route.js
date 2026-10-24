// /agent: where the home print agent connects. It authenticates with a
// bearer token (AGENT_TOKEN secret) before the socket reaches the hub.

export async function handleAgent(request, env) {
  if (!(await validToken(request.headers.get("Authorization"), env.AGENT_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return hub(env).fetch(request);
}

export const hub = (env) => env.HUB.get(env.HUB.idFromName("home"));

async function validToken(header, expected) {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [header.slice(7), expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}
