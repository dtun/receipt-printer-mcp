#!/usr/bin/env node
// Runs the home print agent. Configure with environment variables:
//   RECEIPT_SERVER_URL  the Worker, e.g. https://receipt-printer.example.workers.dev
//   AGENT_TOKEN         the Worker's AGENT_TOKEN secret
//   PRINT_SCRIPT        optional; see README (defaults to the print-receipt skill)

import { print, status } from "../lib/printer.js";
import { connect, createHandler } from "./agent.js";

const { RECEIPT_SERVER_URL, AGENT_TOKEN } = process.env;
if (!RECEIPT_SERVER_URL || !AGENT_TOKEN) {
  console.error("Set RECEIPT_SERVER_URL and AGENT_TOKEN.");
  process.exit(1);
}

const url = new URL("/agent", RECEIPT_SERVER_URL);
url.protocol = url.protocol === "http:" ? "ws:" : "wss:";

let handle;
const conn = connect({ url: url.href, token: AGENT_TOKEN, onMessage: (raw) => handle(raw) });
handle = createHandler({ print, status, send: conn.send });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    conn.stop();
    process.exit(0);
  });
}
