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
# NOTE: the MT5 sync only works on the machine running MetaTrader 5 (Windows).
#       On macOS use --skip-sync.
#
# Usage:
#   ./start.sh                # full run, dev hot-reload
#   ./start.sh --mode prod    # published image
#   ./start.sh --ip-only      # just refresh the Atlas IP whitelist
#   ./start.sh --skip-sync    # don't run the MT5 sync (e.g. on macOS)
set -o pipefail

MODE="dev"
UPDATE_IP=0; SKIP_DOCKER=0; SKIP_SYNC=0; IP_ONLY=0

usage() {
  cat <<'EOF'
Usage: ./start.sh [options]
  --mode dev|local|prod   compose file to use (default: dev)
  --update-ip             whitelist this machine's public IP in Atlas before starting.
                          Only needed if the Atlas Network Access list is NOT 0.0.0.0/0.
  --ip-only               only refresh the Atlas IP whitelist, then exit
  --skip-docker           skip starting Docker
  --skip-sync             skip the MT5 -> TradeNote sync
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

# 3b. --- Launch the MT5 terminal (once, on project start) --------------------
# The per-minute sync never auto-opens MT5 (it skips when the terminal is closed),
# so starting the project is what brings MT5 up. Windows only; override the path
# with MT5_TERMINAL_PATH in .env. No-op if MT5 is already running or not on Windows.
if [[ "$SKIP_SYNC" -eq 0 ]]; then
  section "Launching MetaTrader 5 terminal"
  if command -v tasklist >/dev/null 2>&1; then
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
  else
    warn "Not on Windows (no tasklist) — open MetaTrader 5 manually before syncing."
  fi
fi

# 4. --- MT5 -> TradeNote sync (once) -----------------------------------------
if [[ "$SKIP_SYNC" -eq 0 ]]; then
  section "Running MT5 -> TradeNote sync (once)"
  PY=""
  if command -v python3 >/dev/null 2>&1; then PY="python3"
  elif command -v python >/dev/null 2>&1; then PY="python"; fi
  if [[ -z "$PY" ]]; then
    warn "Python not found; skipping MT5 sync. Install Python 3 and: pip install MetaTrader5 openpyxl requests"
  else
    rc=0
    "$PY" "$ROOT_DIR/mt5-sync/mt5_sync.py" || rc=$?
    if [[ $rc -ne 0 ]]; then
      warn "MT5 sync did not complete (exit $rc). Make sure MetaTrader 5 is open and logged in (Windows only)."
    fi
  fi
fi

section "Done"
echo "App:   $APP_URL"
printf '\033[90mLogs:  docker compose -f %s logs -f tradenote\033[0m\n' "$COMPOSE_FILE"
printf '\033[90mIP:    only needed if Atlas Network Access is not 0.0.0.0/0  ->  ./start.sh --update-ip\033[0m\n'
