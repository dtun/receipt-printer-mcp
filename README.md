# receipt-printer-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets Claude Desktop
chats print to a Rongta RP820 thermal receipt printer: notes, tickets, ASCII
art coloring pages, anything that fits on a roll of 80mm paper.

## Tools

| Tool | What it does |
| --- | --- |
| `print_receipt(text)` | Prints the text, then feeds and cuts. Rejects any line over 48 characters so ASCII art never wraps mid-line. |
| `printer_status()` | Reports whether the printer is idle and lists pending jobs (`lpstat`). |

## Requirements

- macOS with the printer installed in CUPS as `Rongta_RP820`
- Node.js 22 or later
- A print script (see below)

### The print script

The server doesn't talk to the printer directly. It pipes text to a shell
script, so the printer settings live in one place and can be shared with other
tools. By default it uses `~/.claude/skills/print-receipt/print.sh`; point
`PRINT_SCRIPT` somewhere else to override.

The script reads text on stdin and sends it raw to the printer, followed by a
feed and an ESC/POS partial cut:

```bash
#!/usr/bin/env bash
set -euo pipefail
{
  cat
  printf '\n\n\n'          # feed past the print head
  printf '\x1dV\x42\x00'   # GS V 66 0: feed + partial cut
} | lp -d Rongta_RP820 -o raw
echo "Sent to Rongta_RP820."
```

## Setup

1. Install dependencies:

   ```sh
   git clone https://github.com/dtun/receipt-printer-mcp.git
   cd receipt-printer-mcp
   npm install
   ```

2. Add the server to
   `~/Library/Application Support/Claude/claude_desktop_config.json`, using
   absolute paths (`which node` gives the first one):

   ```json
   {
     "mcpServers": {
       "receipt-printer": {
         "command": "/opt/homebrew/bin/node",
         "args": ["/path/to/receipt-printer-mcp/index.js"],
         "env": { "PRINT_SCRIPT": "/path/to/print.sh" }
       }
     }
   }
   ```

   `env` is optional if you use the default script location.

3. Fully quit Claude Desktop (Cmd+Q) and reopen it.

4. In a chat, try "check the receipt printer status", then "print a coloring
   page of a dragon".

## Development

```sh
npm test
```

The tests drive the server through a real MCP client with a fake print
script, so they never touch the printer.

### Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- Versions follow [Semantic Versioning](https://semver.org/), with changes
  recorded in [CHANGELOG.md](CHANGELOG.md).

### Releasing

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry.
3. Commit as `chore(release): x.y.z`.
4. Tag `vx.y.z` and push the tag.
