// PrinterService: the entrypoint other Workers in this account bind to as a
// Service Binding ({ "service": "receipt-printer", "entrypoint": "PrinterService" })
// and call over RPC. It is internal only: service bindings are the sole way in,
// and nothing outside the account can reach it, which is why it has no auth.
// The /mcp and /agent routes keep their own checks.

import { WorkerEntrypoint } from "cloudflare:workers";
import { printText, printerStatus } from "./printing.js";

export class PrinterService extends WorkerEntrypoint {
  print(text) {
    return printText(this.env, text);
  }

  status() {
    return printerStatus(this.env);
  }
}
