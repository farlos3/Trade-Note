#!/usr/bin/env bash
#
# Run the MT5 -> TradeNote sync on a schedule on macOS, via a LaunchAgent.
# The macOS counterpart of the Windows Scheduled Task in README.md.
#
# A one-minute cadence is cheap because the sync short-circuits on its own:
#   - TradeNote not running        -> exits immediately
#   - MT5 / the EA not running     -> exits (bridge file older than 90s)
#   - no new closed deal           -> exits without pushing
#
# Usage:
#   ./mt5-sync/install-sync-agent.sh                 # install, every 1 minute
#   ./mt5-sync/install-sync-agent.sh --interval 300  # every 5 minutes
#   ./mt5-sync/install-sync-agent.sh --status
#   ./mt5-sync/install-sync-agent.sh --uninstall
#   ./mt5-sync/install-sync-agent.sh --logs          # tail the sync log
set -o pipefail

LABEL="com.tradenote.mt5sync"
INTERVAL=60
ACTION="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)  INTERVAL="${2:-60}"; shift 2;;
    --uninstall) ACTION="uninstall"; shift;;
    --status)    ACTION="status"; shift;;
    --logs)      ACTION="logs"; shift;;
    -h|--help)   sed -n '2,18p' "$0"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 64;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/run-sync.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HERE/logs/sync.log"
# Modern launchctl works on a per-user domain rather than the deprecated
# load/unload verbs.
DOMAIN="gui/$(id -u)"

warn() { printf '\033[33mWARNING: %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "LaunchAgents are macOS-only. On Windows use the Scheduled Task in mt5-sync/README.md."

case "$ACTION" in
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      printf '\033[32m%s is loaded.\033[0m\n' "$LABEL"
      launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
        | grep -E "state =|last exit code =|runs =" | sed 's/^[[:space:]]*/  /'
      echo "  plist: $PLIST"
      echo "  log:   ${LOG/#$HOME/~}"
    else
      echo "$LABEL is not loaded."
    fi
    exit 0;;
  logs)
    [[ -f "$LOG" ]] || die "No log yet at $LOG — the agent has not run."
    tail -n 40 "$LOG"
    exit 0;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "Unloaded $LABEL."
    if [[ -f "$PLIST" ]]; then rm -f "$PLIST"; echo "Removed $PLIST"; fi
    echo "Done. The sync now only runs when you call ./start.sh."
    exit 0;;
esac

[[ "$INTERVAL" =~ ^[0-9]+$ && "$INTERVAL" -ge 10 ]] || die "--interval must be a whole number of seconds, at least 10."
[[ -f "$RUNNER" ]] || die "$RUNNER not found."
chmod +x "$RUNNER"

mkdir -p "$HOME/Library/LaunchAgents" "$HERE/logs"

# StandardOut/ErrorPath capture anything launchd itself reports (the runner
# already redirects the sync's own output into the same log).
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$RUNNER</string>
    </array>
    <key>StartInterval</key>
    <integer>$INTERVAL</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

# Replace any previous copy, otherwise bootstrap fails with "service already loaded".
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap failed. Check $PLIST"

printf '\033[32mInstalled %s — runs every %ss.\033[0m\n' "$LABEL" "$INTERVAL"
cat <<EOF

  status:    ./mt5-sync/install-sync-agent.sh --status
  logs:      ./mt5-sync/install-sync-agent.sh --logs
  remove:    ./mt5-sync/install-sync-agent.sh --uninstall

It runs whether or not a Terminal is open, but does nothing unless TradeNote is
up AND MetaTrader 5 is running with the TradeNoteExport EA attached.
EOF
