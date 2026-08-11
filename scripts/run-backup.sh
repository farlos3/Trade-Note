#!/usr/bin/env bash
#
# One guarded R2 backup, wrapped for the scheduler.
#
# launchd starts jobs with a minimal environment and no working directory, so
# this resolves both. It also caps the log, since a periodic job would otherwise
# grow it without limit.
#
# The guards live in scripts/r2-backup.sh: an empty or unreadable database is
# never uploaded, so a scheduled run can't overwrite a good snapshot with a bad
# one.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/.." && pwd)"
LOG_DIR="$ROOT_DIR/backup/logs"
LOG="$LOG_DIR/backup.log"
MAX_BYTES=$((5 * 1024 * 1024))
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose-dev.yml}"

mkdir -p "$LOG_DIR"

if [[ -f "$LOG" ]]; then
  size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [[ "$size" -gt "$MAX_BYTES" ]]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] (log trimmed to the last 2000 lines)" >> "$LOG"
  fi
fi

cd "$ROOT_DIR" || exit 1

# Docker Desktop may not be up yet after a login; that is a normal skip, not an
# error worth a stack of noise in the log.
if ! docker info >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Docker not running -- skipping backup." >> "$LOG"
  exit 0
fi

# Only upload when the database has actually changed.
#
# This is what lets the schedule be tight enough to feel automatic (a couple of
# minutes) without hammering R2: an idle machine produces no traffic at all, and
# a change is captured almost as soon as it lands. The fingerprint is per
# collection document count + newest _updated_at, which moves on any insert,
# update or delete -- the same signal /api/analysis/fingerprint uses.
DB_NAME="$(grep -E '^TRADENOTE_DATABASE=' "$ROOT_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)"
[[ -n "$DB_NAME" ]] || DB_NAME="tradenote"
STATE="$LOG_DIR/.last-backup-fingerprint"

fingerprint() {
  docker compose -f "$COMPOSE_FILE" exec -T mongo mongosh --quiet --eval "
    const d = db.getSiblingDB('$DB_NAME');
    const skip = ['_Session','_SCHEMA','_Role','_Idempotency'];
    const parts = [];
    d.getCollectionNames().filter(c => !skip.includes(c)).sort().forEach(c => {
      const coll = d.getCollection(c);
      const n = coll.countDocuments();
      const last = coll.find({}, {_updated_at: 1}).sort({_updated_at: -1}).limit(1).toArray();
      const t = last.length && last[0]._updated_at ? new Date(last[0]._updated_at).getTime() : 0;
      parts.push(c + ':' + n + ':' + t);
    });
    print(parts.join('|'));
  " 2>/dev/null | tail -n1 | tr -d '[:space:]'
}

FP="$(fingerprint)"
if [[ -n "$FP" && -f "$STATE" && "$FP" == "$(cat "$STATE" 2>/dev/null)" ]]; then
  # Nothing changed. Stay silent rather than writing a line every couple of
  # minutes, which would bury the runs that matter.
  exit 0
fi

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- database changed, backing up ---"
  bash "$HERE/r2-backup.sh" --compose-file "$COMPOSE_FILE"
} >> "$LOG" 2>&1
rc=$?

# Only remember the fingerprint on success, so a failed upload is retried rather
# than being mistaken for "already backed up".
if [[ $rc -eq 0 && -n "$FP" ]]; then
  printf '%s' "$FP" > "$STATE"
fi
exit 0
