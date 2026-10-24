#!/usr/bin/env bash
# Installs the print agent as a launchd service for the current user: it
# starts at login, restarts if it exits, and logs to ~/Library/Logs.
#
#   agent/macos/install.sh            install or update, then (re)start
#   agent/macos/install.sh uninstall  stop and remove the service
#
# Settings live in ~/.config/receipt-printer/agent.env (created on first run).

set -euo pipefail

LABEL="receipt-printer-mcp.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$HOME/.config/receipt-printer/agent.env"
LOG="$HOME/Library/Logs/receipt-printer-agent.log"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAIN="gui/$(id -u)"

stop() { launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; }

if [[ "${1:-}" == "uninstall" ]]; then
  stop
  rm -f "$PLIST"
  echo "Removed $LABEL. Settings kept in $ENV_FILE."
  exit 0
fi

NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }

if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<'ENV'
# The deployed Worker, e.g. https://receipt-printer.example.workers.dev
RECEIPT_SERVER_URL=
# Same value as the Worker's AGENT_TOKEN secret
AGENT_TOKEN=
# Optional: a different print script
# PRINT_SCRIPT=
ENV
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Fill it in, then run this again."
  exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=$ENV_FILE</string>
    <string>$REPO/agent/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

stop
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Started $LABEL. Logs: tail -f $LOG"
