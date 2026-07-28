#!/usr/bin/env bash
#
# Stop the TradeNote project, pushing the session's work to R2 first.
#
# This is the other half of start.sh. start.sh RESTORES from R2 before anything
# else, which DROPs the local collections -- so whatever was journalled during a
# session (notes, tags, screenshots, day files) has to reach R2 before the next
# start, or it is destroyed by that restore. Backing up at shutdown is what makes
# the Windows -> Mac hand-off safe: sync MT5 on Windows, ./stop.sh, then
# ./start.sh on the Mac and the day's work is there.
#
# The backup refuses to run on an empty or unreadable database (see
# scripts/r2-backup.sh), so a broken session can never wipe the R2 snapshot.
#
# Usage:
#   ./stop.sh                 # back up, then stop the containers
#   ./stop.sh --skip-backup   # just stop (the session's work stays local only)
#   ./stop.sh --keep-running  # back up but leave the app running
#   ./stop.sh --mode prod     # compose file to use (default: dev)
set -o pipefail

MODE="dev"; SKIP_BACKUP=0; KEEP_RUNNING=0

usage() {
  cat <<'EOF'
Usage: ./stop.sh [options]
  --mode dev|local|prod   compose file to use (default: dev)
  --skip-backup           don't push to R2 before stopping. The session's work
                          then exists only in the local database, and the next
                          ./start.sh will drop it when it restores from R2.
  --keep-running          back up but leave the containers up
  -h, --help              show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)         MODE="${2:-}"; shift 2;;
    --skip-backup)  SKIP_BACKUP=1; shift;;
    --keep-running) KEEP_RUNNING=1; shift;;
    -h|--help)      usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 64;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

section() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
warn()    { printf '\033[33mWARNING: %s\033[0m\n' "$1" >&2; }

case "$MODE" in
  dev)   COMPOSE_FILE="docker-compose-dev.yml";;
  local) COMPOSE_FILE="docker-compose-local.yml";;
  prod)  COMPOSE_FILE="docker-compose.yml";;
  *) echo "Invalid --mode: $MODE (use dev|local|prod)" >&2; exit 64;;
esac

if ! docker info >/dev/null 2>&1; then
  warn "Docker is not running — nothing to stop, and the backup needs the mongo container."
  exit 0
fi

# 1. --- Back up while MongoDB is still up -------------------------------------
if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  section "Backing up to R2 before shutdown"
  rc=0
  bash "$ROOT_DIR/scripts/r2-backup.sh" --compose-file "$COMPOSE_FILE" || rc=$?
  if [[ $rc -ne 0 ]]; then
    # Stopping now would leave the session's work only in the local Docker
    # volume, and the next start would drop it. Keep everything up instead.
    warn "Backup failed (exit $rc) — leaving the app RUNNING so nothing is lost. Fix the error above and re-run ./stop.sh, or use --skip-backup to stop anyway."
    exit "$rc"
  fi
fi

# 2. --- Stop the containers ---------------------------------------------------
if [[ "$KEEP_RUNNING" -eq 1 ]]; then
  printf '\n\033[32mBackup done; app left running.\033[0m\n'
  exit 0
fi

section "Stopping TradeNote"
if docker compose -f "$COMPOSE_FILE" down; then
  printf '\n\033[32mStopped. Data is in R2 — run ./start.sh on the other machine.\033[0m\n'
else
  warn "docker compose down failed — see the message above."
  exit 1
fi
