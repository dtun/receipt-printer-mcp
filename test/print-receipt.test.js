import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("..", import.meta.url).pathname;
let dir, out, client;

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "index.js")],
    env: {
      ...process.env,
      PRINT_SCRIPT: join(root, "test/fixtures/fake-print.sh"),
      FAKE_OUT: out,
      ...extraEnv,
    },
  });
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
}

const print = (text) => client.callTool({ name: "print_receipt", arguments: { text } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "receipt-mcp-"));
  out = join(dir, "printed.txt");
});

afterEach(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("sends the text to the printer unchanged", async () => {
  await connect();
  const art = "  /\\_/\\\n ( o.o )\n  > ^ <";
  const res = await print(art);
  assert.equal(res.isError, undefined);
  assert.equal(readFileSync(out, "utf8"), art);
});

test("rejects lines over 48 columns without printing anything", async () => {
  await connect();
  const res = await print(`fits\n${"x".repeat(48)}\n${"x".repeat(49)}`);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /line 3: 49 chars/);
  assert.equal(existsSync(out), false);
});

test("measures width in characters, not bytes", async () => {
  await connect();
  const res = await print("é".repeat(48));
  assert.equal(res.isError, undefined);
});

test("reports printer failures as tool errors", async () => {
  await connect({ FAKE_FAIL: "lp: printer not found" });
  const res = await print("hello");
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /printer not found/);
});
