#!/usr/bin/env bash
#
# Back up the database to R2 on a schedule (macOS LaunchAgent), so the day's work
# reaches R2 without having to remember ./tradenote.sh stop.
#
# Why this matters: ./tradenote.sh start RESTORES from R2 before anything else, and that
# DROPS the local collections. Anything journalled since the last backup -- notes,
# tags, screenshots -- is gone at that point. tradenote.sh stop backs up on the way out, but
# only if you remember to use it; this closes the gap.
#
# Safe to run often, in two senses. run-backup.sh compares a fingerprint of the
# database (per-collection counts + newest _updated_at) against the last
# successful backup and does nothing when they match, so an idle machine
# generates no R2 traffic at all -- which is what makes a two-minute cadence
# reasonable. And scripts/r2-backup.sh refuses to upload an empty or unreadable
# database, so a bad moment can never overwrite a good snapshot.
#
# Usage:
#   ./scripts/install-backup-agent.sh                  # install, checks every 2 minutes
#   ./scripts/install-backup-agent.sh --interval 600   # check every 10 minutes instead
#   ./scripts/install-backup-agent.sh --status
#   ./scripts/install-backup-agent.sh --logs
#   ./scripts/install-backup-agent.sh --uninstall
set -o pipefail

LABEL="com.tradenote.r2backup"
INTERVAL=120
ACTION="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)  INTERVAL="${2:-120}"; shift 2;;
    --uninstall) ACTION="uninstall"; shift;;
    --status)    ACTION="status"; shift;;
    --logs)      ACTION="logs"; shift;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 64;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/.." && pwd)"
RUNNER="$HERE/run-backup.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT_DIR/backup/logs/backup.log"
DOMAIN="gui/$(id -u)"

die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "LaunchAgents are macOS-only. On Windows use a Scheduled Task running scripts/r2-backup.sh."

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
    [[ -f "$PLIST" ]] && { rm -f "$PLIST"; echo "Removed $PLIST"; }
    echo "Done. Backups now only happen via ./tradenote.sh stop or ./tradenote.sh start."
    exit 0;;
esac

[[ "$INTERVAL" =~ ^[0-9]+$ && "$INTERVAL" -ge 30 ]] || die "--interval must be a whole number of seconds, at least 30."
[[ -f "$RUNNER" ]] || die "$RUNNER not found."
chmod +x "$RUNNER"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT_DIR/backup/logs"

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

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap failed. Check $PLIST"

printf '\033[32mInstalled %s — checks every %ss, uploads only when the database changed.\033[0m\n' "$LABEL" "$INTERVAL"
cat <<EOF

  status:  ./scripts/install-backup-agent.sh --status
  logs:    ./scripts/install-backup-agent.sh --logs
  remove:  ./scripts/install-backup-agent.sh --uninstall

At this cadence ./tradenote.sh stop is optional: the most you can lose by closing the lid
is whatever happened in the last couple of minutes. Keep using it when you want
that window closed to zero before switching machines.
EOF
