# receipt-printer-mcp

Local MCP server that lets Claude Desktop chats print to the Rongta RP820
thermal receipt printer (80mm paper, 48 columns).

## Tools

- `print_receipt(text)`: prints text, then feeds and cuts. Rejects any line
  over 48 characters instead of letting it wrap.
- `printer_status()`: `lpstat` status and pending jobs.

Printing shells out to `~/.claude/skills/print-receipt/print.sh`, so the
printer settings live in one place. Override with the `PRINT_SCRIPT` env var.

## Setup

```sh
npm install
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "receipt-printer": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/dtun/Developer/receipt-printer-mcp/index.js"]
    }
  }
}
```

Fully quit and reopen Claude Desktop.

## Development

```sh
npm test
```

Tests drive the server through a real MCP client with a fake print script,
so they never touch the printer.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
Releases follow [Semantic Versioning](https://semver.org/): bump `version` in
`package.json`, add a `CHANGELOG.md` entry, commit as
`chore(release): x.y.z`, and tag `vx.y.z`.
