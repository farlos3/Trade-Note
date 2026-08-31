#!/usr/bin/env bash
#
# One sync run, wrapped for the scheduler.
#
# launchd starts jobs with a minimal environment and no working directory, so
# this resolves both itself. It also caps the log: at one run a minute the sync
# prints a few lines every time, which would otherwise grow without limit.
#
# Run by hand any time — it is the same single run ./tradenote.sh start performs.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/.." && pwd)"
LOG_DIR="$HERE/logs"
LOG="$LOG_DIR/sync.log"
MAX_BYTES=$((5 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# Keep the tail rather than deleting outright, so the run that tripped the limit
# is still readable.
if [[ -f "$LOG" ]]; then
  size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [[ "$size" -gt "$MAX_BYTES" ]]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] (log trimmed to the last 2000 lines)" >> "$LOG"
  fi
fi

# Pick the interpreter that can actually run the sync, not merely the first one
# on disk. A Mac commonly has several python3s and the dependencies are installed
# into only one of them (here: /usr/bin/python3, via pip --user). Choosing by path
# order picks a Homebrew python without `requests` and the job dies every minute.
# `python` is listed as well as `python3`: on Windows the launcher is `python.exe`
# and `python3` frequently does not resolve at all, so a Mac-shaped list finds
# nothing there and the job exits every run.
PY=""
for cand in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 \
            "$(command -v python3 2>/dev/null)" "$(command -v python 2>/dev/null)"; do
  [[ -n "$cand" ]] || continue
  if "$cand" -c "import requests, openpyxl" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [[ -z "$PY" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] no python3 with the sync dependencies. Install them: python3 -m pip install --user requests openpyxl" >> "$LOG"
  exit 1
fi

cd "$ROOT_DIR" || exit 1
"$PY" "$HERE/mt5_sync.py" "$@" >> "$LOG" 2>&1
