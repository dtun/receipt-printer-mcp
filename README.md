# receipt-printer-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude print to a
Rongta RP820 thermal receipt printer: notes, tickets, ASCII art coloring pages,
anything that fits on a roll of 80mm paper.

There are two ways to connect:

- **Local:** Claude Desktop on the machine the printer is plugged into
  (`index.js`). See [Setup](#setup).
- **Remote:** Claude on any device, including the mobile app, from anywhere.
  See [Remote access](#remote-access).

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

## Remote access

```
Claude (phone/web) ──► Worker on Cloudflare (worker/)
                         /mcp    the same two tools, behind an emailed code
                         /agent  home agent's WebSocket
                         PrinterHub Durable Object queues jobs
                              ▲
                              │ outbound WebSocket, no open ports
                              │
                       Print agent at home (agent/) ──► print.sh ──► printer
```

Claude reaches the printer through a Cloudflare Worker. A small agent at home
keeps a connection open to it and prints whatever arrives, using the same
print script as the local server. Nothing at home accepts incoming
connections.

- Only addresses listed in `ALLOWED_EMAILS` can connect. Adding the connector
  emails a 6-digit code to the address you enter; 5 wrong codes and you start
  over, and each address gets at most 5 codes an hour.
- If the agent is offline, up to 20 receipts wait in the queue and print when
  it reconnects.
- Delivery is at most once: if the connection drops mid-job, a receipt can be
  lost, but it never prints twice.
- Text from Claude is stripped of control characters before printing, so it
  can't send raw printer commands.

### 1. Deploy the Worker

Requires a Cloudflare account. From `worker/`:

```sh
npm install
npx wrangler login
npx wrangler deploy
```

Note the URL it prints, such as
`https://receipt-printer.<you>.workers.dev`. Wrangler creates the `OAUTH_KV`
namespace on first deploy; if your version asks for an id instead, run
`npx wrangler kv namespace create OAUTH_KV` and add the id to
`wrangler.jsonc`.

### 2. Set up email for sign-in codes

Codes are sent from the address in `EMAIL_FROM` (`wrangler.jsonc`), which must
be on a domain with [Email Routing](https://developers.cloudflare.com/email-routing/)
turned on. On the Workers Free plan, mail can only go to
[verified destination addresses](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/),
so verify each person's address under **Email → Email Routing → Destination
addresses**. On Workers Paid it can go to any address.

### 3. Set the Worker's secrets

```sh
npx wrangler secret put ALLOWED_EMAILS   # comma separated: you@example.com,them@example.com
openssl rand -hex 32                     # copy this for the next prompt and for the agent
npx wrangler secret put AGENT_TOKEN
```

If you serve the Worker from a custom domain, also set `PUBLIC_URL` to it.

### 4. Run the agent on the Mac

Requires Node.js 22 or later and the print script from
[Requirements](#requirements).

```sh
agent/macos/install.sh   # first run creates ~/.config/receipt-printer/agent.env
# fill in RECEIPT_SERVER_URL and AGENT_TOKEN, then:
agent/macos/install.sh   # installs and starts the LaunchAgent
tail -f ~/Library/Logs/receipt-printer-agent.log
```

It starts at login and restarts if it exits. Receipts only print while the
Mac is awake. Turning on "Prevent automatic sleeping when the display is off"
in System Settings helps. Run `agent/macos/install.sh uninstall` to remove it.

### 5. Add the connector in Claude

Each person does this on their own account: **Settings → Connectors → Add
custom connector**, with the URL

```
https://receipt-printer.<you>.workers.dev/mcp
```

Enter your email, type in the code you're sent, and the tools show up in
Claude on the web, desktop, and mobile.

### Printing from another Worker

Other Workers in the same Cloudflare account can print without going through
`/mcp`. Add a service binding to the calling Worker's `wrangler.jsonc`:

```jsonc
"services": [{ "binding": "PRINTER", "service": "receipt-printer", "entrypoint": "PrinterService" }]
```

Then call it over RPC:

```js
const result = await env.PRINTER.print("Buy milk\n");
const status = await env.PRINTER.status();
```

Both methods resolve to `{ ok: boolean, message: string }` and don't throw for
expected problems: an offline agent, lines over 48 characters, a full queue, or
a printer error come back as `ok: false` with a message you can pass on to a
person. A receipt queued while the agent is offline is `ok: true`, because it
will print once the agent reconnects. Text is limited to 10,000 characters.

The binding is the only way in, so `PrinterService` has no sign-in of its own.

### Moving the agent to a Raspberry Pi

The Worker and the connectors stay as they are; only the agent moves.

1. On the Pi, install Node.js 22+ and clone this repo.
2. Write a print script for the Pi. With the printer plugged in over USB it
   usually appears as `/dev/usb/lp0` (add your user to the `lp` group):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   {
     cat
     printf '\n\n\n'          # feed past the print head
     printf '\x1dV\x42\x00'   # GS V 66 0: feed + partial cut
   } > /dev/usb/lp0
   echo "Sent to /dev/usb/lp0."
   ```

   For a printer on the network, replace the redirect with
   `| nc -q1 <printer-ip> 9100`.

3. Create `~/.config/receipt-printer/agent.env` with `RECEIPT_SERVER_URL`,
   the same `AGENT_TOKEN`, and `PRINT_SCRIPT` pointing at that script. Run
   `chmod 600` on it.
4. Run the agent with systemd, in `/etc/systemd/system/receipt-printer-agent.service`
   (adjust the user and paths):

   ```ini
   [Unit]
   Description=Receipt printer agent
   Wants=network-online.target
   After=network-online.target

   [Service]
   User=pi
   ExecStart=/usr/bin/node --env-file=/home/pi/.config/receipt-printer/agent.env /home/pi/receipt-printer-mcp/agent/index.js
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   sudo systemctl enable --now receipt-printer-agent
   ```

5. Run `agent/macos/install.sh uninstall` on the Mac. The Pi's connection
   replaces the Mac's as soon as it connects.

`printer_status` asks CUPS (`lpstat`), so on a Pi without CUPS it reports
that it can't reach the printer, even though printing works.

## Development

```sh
npm test
```

The tests drive the server through a real MCP client with a fake print
script, so they never touch the printer. They also cover the agent.

The Worker has its own tests, which run in the Workers runtime:

```sh
cd worker && npm test
```

To run the Worker locally, copy `worker/.dev.vars.example` to
`worker/.dev.vars`, fill it in, and run `npm run dev`.

### Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- Versions follow [Semantic Versioning](https://semver.org/), with changes
  recorded in [CHANGELOG.md](CHANGELOG.md).

### Releasing

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry.
3. Commit as `chore(release): x.y.z`.
4. Tag `vx.y.z` and push the tag.
