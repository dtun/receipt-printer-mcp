#!/usr/bin/env node
// MCP server for the Rongta RP820 thermal receipt printer, for Claude Desktop
// on the machine the printer is attached to.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { print, status } from "./lib/printer.js";
import { PRINT_DESCRIPTION, STATUS_DESCRIPTION, WIDTH, checkWidth } from "./lib/receipt.js";
import pkg from "./package.json" with { type: "json" };

const text = (t) => ({ content: [{ type: "text", text: t }] });
const error = (t) => ({ ...text(t), isError: true });

const server = new McpServer({ name: pkg.name, version: pkg.version });

server.registerTool(
  "print_receipt",
  {
    title: "Print receipt",
    description: PRINT_DESCRIPTION,
    inputSchema: {
      text: z.string().min(1).describe(`Text to print, lines <= ${WIDTH} chars`),
    },
  },
  async ({ text: content }) => {
    const tooWide = checkWidth(content);
    if (tooWide) return error(tooWide);
    try {
      return text(await print(content));
    } catch (e) {
      return error(`Print failed: ${e.message}`);
    }
  },
);

server.registerTool(
  "printer_status",
  {
    title: "Printer status",
    description: STATUS_DESCRIPTION,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return text(await status());
    } catch (e) {
      return error(e.message);
    }
  },
);

await server.connect(new StdioServerTransport());
