// The remote MCP server: the same print_receipt / printer_status tools as the
// local Desktop server, backed by the PrinterHub instead of a local printer.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { PRINT_DESCRIPTION, STATUS_DESCRIPTION, WIDTH, checkWidth, stripControl } from "../../lib/receipt.js";
import pkg from "../../package.json" with { type: "json" };
import { hub } from "./agent-route.js";

const MAX_CHARS = 10_000;

const text = (t) => ({ content: [{ type: "text", text: t }] });
const error = (t) => ({ ...text(t), isError: true });

function createServer(env) {
  const server = new McpServer({ name: pkg.name, version: pkg.version });

  server.registerTool(
    "print_receipt",
    {
      title: "Print receipt",
      description: PRINT_DESCRIPTION,
      inputSchema: z.object({
        text: z.string().min(1).max(MAX_CHARS).describe(`Text to print, lines <= ${WIDTH} chars`),
      }),
    },
    async ({ text: raw }) => {
      const content = stripControl(raw);
      const tooWide = checkWidth(content);
      if (tooWide) return error(tooWide);
      const { state, message } = await hub(env).print(content);
      if (state === "failed") return error(`Print failed: ${message}`);
      if (state === "full") return error(`Nothing printed. ${message}`);
      return text(message);
    },
  );

  server.registerTool(
    "printer_status",
    {
      title: "Printer status",
      description: STATUS_DESCRIPTION,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { online, lastSeen, queued, report } = await hub(env).status();
      const queue = queued ? `${queued} receipt(s) waiting to print.` : "Nothing waiting to print.";
      if (!online) {
        const seen = lastSeen ? `last seen ${new Date(lastSeen).toISOString()}` : "never connected";
        return error(`The print agent is offline (${seen}). ${queue}`);
      }
      return report.ok ? text(`${report.message}\n${queue}`) : error(`${report.message}\n${queue}`);
    },
  );

  return server;
}

export const mcpHandler = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
