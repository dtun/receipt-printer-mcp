#!/usr/bin/env node
// MCP server for the Rongta RP820 thermal receipt printer.
// Printing goes through the print-receipt skill's print.sh so the printer
// settings (raw mode, feed + cut) live in one place.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const run = promisify(execFile);

const PRINTER = "Rongta_RP820";
const WIDTH = 48; // 80mm paper, Font A
const PRINT_SCRIPT =
  process.env.PRINT_SCRIPT ??
  join(homedir(), ".claude/skills/print-receipt/print.sh");

// GUI apps launch servers with a minimal PATH; make sure lp/lpstat resolve.
const env = { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}` };

const text = (t) => ({ content: [{ type: "text", text: t }] });
const error = (t) => ({ ...text(t), isError: true });

const server = new McpServer({ name: "receipt-printer", version: "1.0.0" });

server.registerTool(
  "print_receipt",
  {
    title: "Print receipt",
    description:
      `Print plain text on the ${PRINTER} thermal receipt printer (80mm paper). ` +
      `Every line must be at most ${WIDTH} characters; longer lines are rejected so ` +
      `ASCII art never wraps. Use ${"=".repeat(WIDTH)} as a full-width divider. ` +
      `The printer feeds and cuts automatically after the text.`,
    inputSchema: {
      text: z.string().min(1).describe(`Text to print, lines <= ${WIDTH} chars`),
    },
  },
  async ({ text: content }) => {
    const tooLong = content
      .split("\n")
      .map((line, i) => ({ n: i + 1, len: [...line].length }))
      .filter(({ len }) => len > WIDTH);
    if (tooLong.length) {
      const list = tooLong.map(({ n, len }) => `line ${n}: ${len} chars`).join(", ");
      return error(`Nothing printed. Lines over ${WIDTH} chars: ${list}. Reformat and retry.`);
    }

    try {
      const child = execFile("/bin/bash", [PRINT_SCRIPT], { env });
      child.stdin.end(content);
      const { stdout } = await new Promise((resolve, reject) => {
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve({ stdout: out }) : reject(new Error(err || `exit ${code}`)),
        );
      });
      return text(stdout.trim());
    } catch (e) {
      return error(`Print failed: ${e.message}`);
    }
  },
);

server.registerTool(
  "printer_status",
  {
    title: "Printer status",
    description: `Show whether the ${PRINTER} is idle/enabled and list any pending jobs.`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const status = await run("lpstat", ["-p", PRINTER], { env });
      const jobs = await run("lpstat", ["-o", PRINTER], { env }).catch(() => ({ stdout: "" }));
      return text(`${status.stdout.trim()}\n${jobs.stdout.trim() || "No pending jobs."}`);
    } catch (e) {
      return error(`Could not reach ${PRINTER}: ${e.stderr || e.message}`);
    }
  },
);

await server.connect(new StdioServerTransport());
