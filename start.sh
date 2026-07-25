#!/usr/bin/env bash
#
# Start the whole TradeNote project.
#   1. Start the TradeNote app in Docker (dev / local / prod compose file).
#   2. Wait until the web app answers on its port.
#   3. Launch the MetaTrader 5 terminal (if not already open; Windows only).
#   4. Run the MT5 -> TradeNote sync once (emails a reminder if new deals).
#
# Atlas IP whitelisting is OPT-IN (--update-ip). The recommended setup is to set
# Atlas Network Access to 0.0.0.0/0 once, which never needs updating again (the
# database is still protected by its user/password + TLS, and Render needs it).
#
# Any step that is not applicable (Atlas keys missing, MT5 terminal closed,
# Python absent) becomes a warning instead of aborting the whole run.
#
# Where trade data comes from depends on the platform (step 3b/4):
#   Windows        -> read MetaTrader 5 directly. The MetaTrader5 Python package
#                     is a Windows-only wheel bound to the terminal's DLL.
#   macOS / Linux  -> that package cannot be installed, so there is no local MT5
#                     to read. Use what is already in MongoDB, and restore the
#                     latest Parquet snapshot from R2 when MongoDB has no trades.
#
# Usage:
#   ./start.sh                # full run, dev hot-reload
#   ./start.sh --mode prod    # published image
#   ./start.sh --ip-only      # just refresh the Atlas IP whitelist
#   ./start.sh --skip-sync    # don't load trade data at all
#   ./start.sh --restore-r2   # force an R2 restore even if MongoDB has trades
set -o pipefail

MODE="dev"
UPDATE_IP=0; SKIP_DOCKER=0; SKIP_SYNC=0; IP_ONLY=0; RESTORE_R2=0

usage() {
  cat <<'EOF'
Usage: ./start.sh [options]
  --mode dev|local|prod   compose file to use (default: dev)
  --update-ip             whitelist this machine's public IP in Atlas before starting.
                          Only needed if the Atlas Network Access list is NOT 0.0.0.0/0.
  --ip-only               only refresh the Atlas IP whitelist, then exit
  --skip-docker           skip starting Docker
  --skip-sync             skip loading trade data entirely
  --restore-r2            force restoring trades from the R2 Parquet backup.
                          Off Windows this happens automatically when MongoDB is
                          empty; this flag also overwrites data that is there.
  -h, --help              show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)        MODE="${2:-}"; shift 2;;
    --update-ip)   UPDATE_IP=1; shift;;
    --ip-only)     IP_ONLY=1; UPDATE_IP=1; shift;;
    --skip-ip)     UPDATE_IP=0; shift;;   # kept for compatibility (now the default)
    --skip-docker) SKIP_DOCKER=1; shift;;
    --skip-sync)   SKIP_SYNC=1; shift;;
    --restore-r2)  RESTORE_R2=1; shift;;
    -h|--help)     usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 64;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

section() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
warn()    { printf '\033[33mWARNING: %s\033[0m\n' "$1" >&2; }

ENV_FILE="$ROOT_DIR/.env"
[[ -f "$ENV_FILE" ]] || warn ".env not found. Copy .env.example -> .env and fill it in first."

read_env() {
  local key="$1" val=""
  if [[ -f "$ENV_FILE" ]]; then
    val="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | sed -E "s/^${key}=//" || true)"
  fi
  printf '%s' "$val"
}

case "$MODE" in
  dev)   COMPOSE_FILE="docker-compose-dev.yml";   BUILD=1;;
  local) COMPOSE_FILE="docker-compose-local.yml"; BUILD=1;;
  prod)  COMPOSE_FILE="docker-compose.yml";       BUILD=0;;
  *) echo "Invalid --mode: $MODE (use dev|local|prod)" >&2; exit 64;;
esac

PORT="$(read_env TRADENOTE_PORT)"; [[ -n "$PORT" ]] || PORT="8080"
APP_URL="http://localhost:$PORT"

# 1. --- Atlas IP whitelist (opt-in) ------------------------------------------
# Off by default: the recommended setup is Atlas Network Access = 0.0.0.0/0,
# which never needs updating. Pass --update-ip if you keep a tight whitelist.
if [[ "$UPDATE_IP" -eq 1 ]]; then
  section "Updating MongoDB Atlas IP access list"
  rc=0
  bash "$ROOT_DIR/scripts/update-atlas-ip.sh" --env-file "$ENV_FILE" || rc=$?
  if [[ $rc -eq 2 ]]; then
    warn "Atlas IP step skipped (API keys not configured)."
  elif [[ $rc -eq 3 ]]; then
    warn "Atlas IP step blocked by the API key's own access list — see the fix above."
  elif [[ $rc -ne 0 ]]; then
    warn "Atlas IP update failed (exit $rc) — see the message above."
  fi
fi

if [[ "$IP_ONLY" -eq 1 ]]; then
  printf '\n\033[32mIP-only run complete.\033[0m\n'
  exit 0
fi

# 2. --- Docker: start the app ------------------------------------------------
if [[ "$SKIP_DOCKER" -eq 0 ]]; then
  section "Starting TradeNote (Docker, mode=$MODE)"

  if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker does not appear to be running. Start Docker Desktop and re-run." >&2
    exit 1
  fi

  compose_cmd=(docker compose -f "$COMPOSE_FILE" up -d)
  [[ "$BUILD" -eq 1 ]] && compose_cmd+=(--build)
  echo "${compose_cmd[*]}"
  if ! "${compose_cmd[@]}"; then
    echo "ERROR: docker compose failed." >&2
    exit 1
  fi

  # 3. --- Wait for the app ---
  section "Waiting for TradeNote at $APP_URL"
  ready=0
  for _ in $(seq 1 40); do
    if curl -sS -o /dev/null --max-time 5 "$APP_URL" 2>/dev/null; then ready=1; break; fi
    sleep 3
  done
  if [[ "$ready" -eq 1 ]]; then
    printf '\033[32mTradeNote is up at %s\033[0m\n' "$APP_URL"
  else
    warn "TradeNote did not respond within ~2 min. Check logs: docker compose -f $COMPOSE_FILE logs -f tradenote"
  fi
fi

# 3b/4. --- Load trade data ---------------------------------------------------
# Two mutually exclusive sources, chosen by platform. `tasklist` is the probe:
# it exists only on Windows, which is also the only place the MetaTrader5 Python
# package can be installed (its wheel binds to the terminal's DLL).

PY=""
if command -v python3 >/dev/null 2>&1; then PY="python3"
elif command -v python >/dev/null 2>&1; then PY="python"; fi

# Documents in the local `trades` collection. Prints a number, or NOTHING when
# the count could not be established (Mongo unreachable, container still booting,
# unexpected output). That distinction matters: the restore below DROPs
# collections, so "couldn't tell" must never be mistaken for "empty".
count_trades() {
  local db out
  db="$(read_env TRADENOTE_DATABASE)"; [[ -n "$db" ]] || db="tradenote"
  out="$(docker compose -f "$COMPOSE_FILE" exec -T mongo mongosh --quiet --eval \
        "print(db.getSiblingDB('$db').getCollection('trades').countDocuments())" \
        2>/dev/null | tail -n1 | tr -d '[:space:]')"
  [[ "$out" =~ ^[0-9]+$ ]] && printf '%s' "$out"
}

# --- Windows: read MetaTrader 5 directly ---
sync_from_mt5() {
  section "Launching MetaTrader 5 terminal"
  # The per-minute sync never auto-opens MT5 (it skips when the terminal is
  # closed), so starting the project is what brings MT5 up. Override the path
  # with MT5_TERMINAL_PATH in .env. No-op if MT5 is already running.
  if tasklist /FI "IMAGENAME eq terminal64.exe" /NH 2>/dev/null | grep -qi "terminal64.exe"; then
    printf '\033[32mMT5 already running.\033[0m\n'
  else
    MT5_PATH="$(read_env MT5_TERMINAL_PATH)"
    [[ -n "$MT5_PATH" ]] || MT5_PATH="C:\\Program Files\\MetaTrader 5\\terminal64.exe"
    if [[ -f "/c/Program Files/MetaTrader 5/terminal64.exe" || -f "${MT5_PATH}" ]]; then
      cmd.exe //c start "" "$MT5_PATH" >/dev/null 2>&1 && \
        printf '\033[32mStarted MT5: %s\033[0m\n' "$MT5_PATH"
      sleep 8   # let it connect before the first sync reads history
    else
      warn "MT5 terminal not found at $MT5_PATH. Set MT5_TERMINAL_PATH in .env, or open MT5 manually."
    fi
  fi

  section "Running MT5 -> TradeNote sync (once)"
  if [[ -z "$PY" ]]; then
    warn "Python not found; skipping MT5 sync. Install Python 3 and: pip install MetaTrader5 openpyxl requests"
    return
  fi
  local rc=0
  "$PY" "$ROOT_DIR/mt5-sync/mt5_sync.py" || rc=$?
  [[ $rc -ne 0 ]] && warn "MT5 sync did not complete (exit $rc). Make sure MetaTrader 5 is open and logged in."
  return 0
}

# --- Everywhere else: MongoDB, falling back to the R2 Parquet backup ---
load_from_db_or_r2() {
  section "Loading trade data (MongoDB / R2 backup)"
  local n; n="$(count_trades)"

  if [[ -z "$n" ]]; then
    warn "Could not read the trades count from MongoDB — skipping the R2 restore rather than risk overwriting data. Check: docker compose -f $COMPOSE_FILE logs mongo"
    return 0
  fi

  if [[ "$n" -gt 0 && "$RESTORE_R2" -eq 0 ]]; then
    printf '\033[32mMongoDB already holds %s trade(s) — using it.\033[0m\n' "$n"
    printf '\033[90mRe-pull from the R2 snapshot instead:  ./start.sh --restore-r2\033[0m\n'
    return 0
  fi

  if [[ -z "$PY" ]]; then
    warn "Python not found; cannot restore from R2. Install Python 3, then: pip install pymongo pyarrow boto3"
    return 0
  fi
  if ! "$PY" -c "import pymongo, pyarrow, boto3" >/dev/null 2>&1; then
    warn "R2 restore needs missing packages. Run: $PY -m pip install --user pymongo pyarrow boto3"
    return 0
  fi

  if [[ "$n" -gt 0 ]]; then
    # restore_from_r2.py DROPs each collection before reinserting, so this
    # replaces the local data outright -- only ever on an explicit --restore-r2.
    warn "--restore-r2 given: DROPPING the local collections (including the $n trade(s) above) and replacing them with the R2 snapshot."
  else
    echo "MongoDB has no trades — restoring the latest snapshot from R2."
  fi

  local rc=0
  "$PY" "$ROOT_DIR/backup/restore_from_r2.py" || rc=$?
  if [[ $rc -ne 0 ]]; then
    warn "R2 restore did not complete (exit $rc) — see the message above. Check the R2_* keys in .env, or back up first with: $PY backup/backup_to_r2.py"
  else
    printf '\033[32mRestored %s trade(s) from the R2 backup.\033[0m\n' "$(count_trades)"
  fi
  return 0
}

if [[ "$SKIP_SYNC" -eq 0 ]]; then
  if command -v tasklist >/dev/null 2>&1; then
    sync_from_mt5
  else
    load_from_db_or_r2
  fi
fi

section "Done"
echo "App:   $APP_URL"
printf '\033[90mLogs:  docker compose -f %s logs -f tradenote\033[0m\n' "$COMPOSE_FILE"
printf '\033[90mIP:    only needed if Atlas Network Access is not 0.0.0.0/0  ->  ./start.sh --update-ip\033[0m\n'
