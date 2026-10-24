// The remote MCP server: the same print_receipt / printer_status tools as the
// local Desktop server, backed by the PrinterHub instead of a local printer.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { PRINT_DESCRIPTION, STATUS_DESCRIPTION, WIDTH } from "../../lib/receipt.js";
import pkg from "../../package.json" with { type: "json" };
import { MAX_CHARS, printText, printerStatus } from "./printing.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const error = (t) => ({ ...text(t), isError: true });
const toResult = ({ ok, message }) => (ok ? text(message) : error(message));

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
    async ({ text: raw }) => toResult(await printText(env, raw)),
  );

  server.registerTool(
    "printer_status",
    {
      title: "Printer status",
      description: STATUS_DESCRIPTION,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => toResult(await printerStatus(env)),
  );

  return server;
}

export const mcpHandler = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
