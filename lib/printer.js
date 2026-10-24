// Local access to the printer. Printing goes through the print-receipt
// skill's print.sh so the printer settings (raw mode, feed + cut) live in one
// place; on another machine, point PRINT_SCRIPT at a script for that setup.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PRINTER } from "./receipt.js";

const run = promisify(execFile);

const PRINT_SCRIPT =
  process.env.PRINT_SCRIPT ??
  join(homedir(), ".claude/skills/print-receipt/print.sh");

// GUI apps and services launch with a minimal PATH; make sure lp/lpstat resolve.
const env = { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}` };

// Pipes content to the print script. Resolves with its stdout, rejects with its stderr.
export async function print(content) {
  const child = execFile("/bin/bash", [PRINT_SCRIPT], { env });
  child.stdin.end(content);
  const stdout = await new Promise((resolve, reject) => {
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)),
    );
  });
  return stdout.trim();
}

// Printer state and pending jobs from lpstat. Rejects if the printer is unknown.
export async function status() {
  try {
    const state = await run("lpstat", ["-p", PRINTER], { env });
    const jobs = await run("lpstat", ["-o", PRINTER], { env }).catch(() => ({ stdout: "" }));
    return `${state.stdout.trim()}\n${jobs.stdout.trim() || "No pending jobs."}`;
  } catch (e) {
    throw new Error(`Could not reach ${PRINTER}: ${e.stderr || e.message}`);
  }
}
