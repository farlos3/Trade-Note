#!/usr/bin/env bash
#
# Push the local MongoDB up to Cloudflare R2 as Parquet.
#
# Wraps backup/backup_to_r2.py with the guards that make it safe to run
# unattended. backup_to_r2.py overwrites data/<db>/latest/, so uploading a
# database that is empty -- or whose state could not be read at all -- would
# destroy the only remaining copy of the history. Both cases refuse to upload.
#
# Shared by start.sh (after the MT5 sync) and stop.sh (before shutting down), so
# the guard lives in exactly one place.
#
# Usage: scripts/r2-backup.sh [--compose-file <file>]
# Exit:  0 always for "nothing to do" / skipped; non-zero only if the upload
#        itself failed, so callers can warn without aborting the whole run.
set -o pipefail

COMPOSE_FILE="docker-compose-dev.yml"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file) COMPOSE_FILE="${2:-}"; shift 2;;
    -h|--help) sed -n '2,15p' "$0"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 64;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

warn() { printf '\033[33mWARNING: %s\033[0m\n' "$1" >&2; }

read_env() {
  local key="$1" val=""
  [[ -f "$ENV_FILE" ]] && val="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | sed -E "s/^${key}=//" || true)"
  printf '%s' "$val"
}

DB_NAME="$(read_env TRADENOTE_DATABASE)"; [[ -n "$DB_NAME" ]] || DB_NAME="tradenote"

PY=""
if command -v python3 >/dev/null 2>&1; then PY="python3"
elif command -v python >/dev/null 2>&1; then PY="python"; fi

# Prints a number, or NOTHING when the count could not be established. A blank
# result must never be read as "empty" -- see the guard below.
count_trades() {
  local out
  out="$(docker compose -f "$COMPOSE_FILE" exec -T mongo mongosh --quiet --eval \
        "print(db.getSiblingDB('$DB_NAME').getCollection('trades').countDocuments())" \
        2>/dev/null | tail -n1 | tr -d '[:space:]')"
  [[ "$out" =~ ^[0-9]+$ ]] && printf '%s' "$out"
}

if [[ -z "$PY" ]]; then
  warn "Python not found; skipping the R2 backup. Install Python 3, then: pip install pymongo pyarrow boto3"
  exit 0
fi
if ! "$PY" -c "import pymongo, pyarrow, boto3" >/dev/null 2>&1; then
  warn "R2 backup needs missing packages. Run: $PY -m pip install --user pymongo pyarrow boto3"
  exit 0
fi

n="$(count_trades)"
if [[ -z "$n" ]]; then
  warn "Could not read MongoDB — skipping the backup rather than overwrite the R2 snapshot with an unknown state."
  exit 0
fi
if [[ "$n" -eq 0 ]]; then
  warn "MongoDB holds no trades — skipping the backup so the existing R2 snapshot is not overwritten with an empty database."
  exit 0
fi

rc=0
"$PY" "$ROOT_DIR/backup/backup_to_r2.py" || rc=$?
if [[ $rc -ne 0 ]]; then
  warn "R2 backup did not complete (exit $rc) — see the message above. The R2 snapshot is unchanged."
  exit "$rc"
fi
printf '\033[32mBacked up %s trade(s) to R2.\033[0m\n' "$n"
