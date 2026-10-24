// The print and status policy, in one place so every way into the Worker (the
// MCP tools, and the PrinterService that other Workers call) behaves the same.
// Both functions resolve to { ok, message } and never throw for expected
// outcomes, so callers can relay the message to a person as is.

import { WIDTH, checkWidth, stripControl } from "../../lib/receipt.js";
import { hub } from "./agent-route.js";

export const MAX_CHARS = 10_000;

// How each PrinterHub print state reads to a caller. Queued and sent count as
// ok: the receipt is on its way, even if nobody has confirmed it yet.
const OUTCOMES = {
  printed: { ok: true, prefix: "" },
  sent: { ok: true, prefix: "" },
  queued: { ok: true, prefix: "" },
  failed: { ok: false, prefix: "Print failed: " },
  full: { ok: false, prefix: "Nothing printed. " },
};

export async function printText(env, raw) {
  // RPC callers have no zod schema in front of them, so check here too.
  if (typeof raw !== "string" || !raw) return { ok: false, message: "Nothing printed. Text must be a non-empty string." };
  if (raw.length > MAX_CHARS) return { ok: false, message: `Nothing printed. Text is over ${MAX_CHARS} characters.` };

  const content = stripControl(raw);
  const tooWide = checkWidth(content);
  if (tooWide) return { ok: false, message: tooWide };

  const { state, message } = await hub(env).print(content);
  const { ok, prefix } = OUTCOMES[state];
  return { ok, message: prefix + message };
}

export async function printerStatus(env) {
  const { online, lastSeen, queued, report } = await hub(env).status();
  const queue = queued ? `${queued} receipt(s) waiting to print.` : "Nothing waiting to print.";
  if (!online) {
    const seen = lastSeen ? `last seen ${new Date(lastSeen).toISOString()}` : "never connected";
    return { ok: false, message: `The print agent is offline (${seen}). ${queue}` };
  }
  return { ok: report.ok, message: `${report.message}\n${queue}` };
}
