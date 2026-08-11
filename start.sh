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
# Step 4 is a three-stage data cycle, in this order:
#   4a restore  pull the R2 Parquet snapshot into MongoDB (always, so a start
#               always begins from the backup -- including when MT5 won't open)
#   4b update   read MetaTrader 5 and layer newer trades on top. Windows only:
#               the MetaTrader5 wheel binds to the terminal's DLL and installs
#               nowhere else, so on macOS/Linux 4a is the only data source.
#   4c backup   push the result back to R2 for the next start.
#
# The app is served BUNDLED by default (NODE_ENV=prod inside the container): the
# frontend is built to dist/ and served hash-cached, which is far faster to use
# because every nav link in this app is a full page reload. Pass --hot for the
# Vite dev server instead when you are editing frontend code. Note this is a
# different axis from --mode, which picks the compose file / image.
#
# Usage:
#   ./start.sh                # full run, bundled app (fast)
#   ./start.sh --hot          # Vite dev server + hot-reload, for development
#   ./start.sh --mode prod    # published image
#   ./start.sh --ip-only      # just refresh the Atlas IP whitelist
#   ./start.sh --skip-sync    # don't read MetaTrader 5
#   ./start.sh --skip-restore # keep the local DB; don't pull the R2 backup
#   ./start.sh --skip-backup  # don't push the result back to R2
set -o pipefail

MODE="dev"
# NODE_ENV handed to the container. Only docker-compose-dev.yml reads it
# (`NODE_ENV: ${NODE_ENV:-dev}`); the other compose files pin their own.
APP_ENV="prod"
UPDATE_IP=0; SKIP_DOCKER=0; SKIP_SYNC=0; IP_ONLY=0; SKIP_RESTORE=0; SKIP_BACKUP=0

usage() {
  cat <<'EOF'
Usage: ./start.sh [options]
  --mode dev|local|prod   compose file to use (default: dev)
  --hot                   run the Vite dev server (hot-reload) instead of the
                          bundled build. Slower to navigate — use while editing
                          frontend code. Default is the bundled build.
  --update-ip             whitelist this machine's public IP in Atlas before starting.
                          Only needed if the Atlas Network Access list is NOT 0.0.0.0/0.
  --ip-only               only refresh the Atlas IP whitelist, then exit
  --skip-docker           skip starting Docker
  --skip-sync             skip the MT5 -> TradeNote sync (the update step)
  --skip-restore          don't pull the R2 backup at startup. By default every
                          run restores it first (after dumping the current DB to
                          backup/pre-restore/), then syncs newer trades on top.
  --skip-backup           don't push the database back to R2 at the end. The
                          backup is skipped anyway when the database is empty or
                          unreadable, so a bad run can't overwrite the snapshot.
  -h, --help              show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)        MODE="${2:-}"; shift 2;;
    --hot)         APP_ENV="dev"; shift;;
    --update-ip)   UPDATE_IP=1; shift;;
    --ip-only)     IP_ONLY=1; UPDATE_IP=1; shift;;
    --skip-ip)     UPDATE_IP=0; shift;;   # kept for compatibility (now the default)
    --skip-docker) SKIP_DOCKER=1; shift;;
    --skip-sync)   SKIP_SYNC=1; shift;;
    --skip-restore) SKIP_RESTORE=1; shift;;
    --skip-backup) SKIP_BACKUP=1; shift;;
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

# SUPPORTS_APP_ENV: whether the compose file takes NODE_ENV from the environment.
# Only the dev one does; the others pin their own, so --hot is meaningless there.
case "$MODE" in
  dev)   COMPOSE_FILE="docker-compose-dev.yml";   BUILD=1; SUPPORTS_APP_ENV=1;;
  local) COMPOSE_FILE="docker-compose-local.yml"; BUILD=1; SUPPORTS_APP_ENV=0;;
  prod)  COMPOSE_FILE="docker-compose.yml";       BUILD=0; SUPPORTS_APP_ENV=0;;
  *) echo "Invalid --mode: $MODE (use dev|local|prod)" >&2; exit 64;;
esac
if [[ "$SUPPORTS_APP_ENV" -eq 0 ]]; then
  APP_ENV=""   # leave the compose file's own NODE_ENV alone
fi

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
  echo "${APP_ENV:+NODE_ENV=$APP_ENV }${compose_cmd[*]}"
  # Exported rather than prefixed so it reaches compose's variable substitution.
  if ! NODE_ENV="$APP_ENV" "${compose_cmd[@]}"; then
    echo "ERROR: docker compose failed." >&2
    exit 1
  fi

  # 3. --- Wait for the app ---
  section "Waiting for TradeNote at $APP_URL"

  # Judge readiness by the HTTP status, NOT by curl's exit code: curl under Git
  # Bash on Windows routinely exits 23 ("client returned ERROR on write") even on a
  # perfectly good 200, which made this warn "did not respond" on every single run
  # while the app was in fact up. Any three-digit status means something is
  # listening and answering; only 000 means nothing is there yet.
  wait_for_app() {
    local tries="${1:-40}" code
    for _ in $(seq 1 "$tries"); do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$APP_URL" 2>/dev/null || true)"
      [[ -n "$code" && "$code" != "000" ]] && return 0
      sleep 3
    done
    return 1
  }

  ready=0
  wait_for_app && ready=1

  # A dependency added to package.json is the usual reason the app won't boot,
  # and it has a specific cause: the compose file mounts /app/node_modules as an
  # ANONYMOUS volume. That volume is filled once, from the image, the first time
  # the container is created -- and then never refreshed. Rebuilding the image
  # installs the new package into the image, but the container keeps mounting the
  # stale volume over it, so node exits at import time with ERR_MODULE_NOT_FOUND
  # and the container restart-loops. Recreating the service with renewed
  # anonymous volumes is what actually fixes it.
  #
  # --renew-anon-volumes is scoped to the tradenote service, so the mongo
  # service's NAMED volume (mongo_data, holding every trade) is not touched.
  # `down -v` would wipe it and must never be used for this.
  # Logs are captured into a variable rather than piped straight into grep: with
  # `set -o pipefail`, `grep -q` exits at the first match and closes the pipe,
  # docker compose dies of SIGPIPE, and pipefail reports that failure as the
  # pipeline's status -- so the test reads false exactly when it matched.
  applogs=""
  if [[ "$ready" -eq 0 ]]; then
    applogs="$(docker compose -f "$COMPOSE_FILE" logs --tail 80 tradenote 2>/dev/null || true)"
  fi
  if [[ -n "$applogs" ]] && grep -qE "ERR_MODULE_NOT_FOUND|Cannot find package" <<<"$applogs"; then
    missing="$(grep -oE "Cannot find package '[^']+'" <<<"$applogs" | tail -n1 | sed -E "s/.*'([^']+)'.*/\1/")"
    warn "App failed to start: ${missing:+package \"$missing\" missing — }the container's node_modules volume is older than the image. Recreating it (mongo and its data are untouched)."
    if docker compose -f "$COMPOSE_FILE" up -d --force-recreate --renew-anon-volumes tradenote; then
      wait_for_app && ready=1
    fi
  fi

  if [[ "$ready" -eq 1 ]]; then
    printf '\033[32mTradeNote is up at %s\033[0m\n' "$APP_URL"
  else
    warn "TradeNote did not respond within ~2 min. Check logs: docker compose -f $COMPOSE_FILE logs -f tradenote"
  fi

  # Bundled mode serves dist/, so dist/ has to exist and match the current source
  # -- otherwise the app serves a stale build, or nothing at all on a fresh clone.
  # Built inside the container because that is where node_modules lives (the host
  # has none; the compose file mounts an anonymous volume over it).
  # Deliberately AFTER the readiness check: vite build is CPU-heavy, and running it
  # while the container is still booting starved the server enough that the wait
  # above timed out and cried wolf on an app that was actually fine.
  if [[ "$APP_ENV" == "prod" ]]; then
    section "Building the frontend bundle (dist/)"
    if docker compose -f "$COMPOSE_FILE" exec -T tradenote npx vite build >/dev/null 2>&1; then
      printf '\033[32mBundle built.\033[0m\n'
    else
      warn "Frontend build failed — the app will serve the previous dist/ (or nothing if this is a first run). Re-run manually to see the error: npm run rebuild"
    fi
  fi
fi

# 4. --- Trade data: restore from R2, then update ------------------------------
# Order matters and is deliberate: every start begins from the R2 backup (the
# canonical state), and only then are newer trades layered on top from MT5.
#
# Restoring is destructive -- restore_from_r2.py DROPs each collection before
# reinserting -- so anything created locally since the last backup (notes, tags,
# screenshots, trades) would be gone. A mongodump of the live DB is therefore
# taken first, every time, and the restore is skipped outright if that dump
# cannot be produced. Pass --skip-restore to start from the local DB as-is.

PY=""
if command -v python3 >/dev/null 2>&1; then PY="python3"
elif command -v python >/dev/null 2>&1; then PY="python"; fi

db_name() {
  local db; db="$(read_env TRADENOTE_DATABASE)"
  [[ -n "$db" ]] || db="tradenote"
  printf '%s' "$db"
}

# Documents in the local `trades` collection. Prints a number, or NOTHING when
# the count could not be established (Mongo unreachable, container still
# booting, unexpected output) -- "couldn't tell" must never read as "empty".
count_trades() {
  local out
  out="$(docker compose -f "$COMPOSE_FILE" exec -T mongo mongosh --quiet --eval \
        "print(db.getSiblingDB('$(db_name)').getCollection('trades').countDocuments())" \
        2>/dev/null | tail -n1 | tr -d '[:space:]')"
  [[ "$out" =~ ^[0-9]+$ ]] && printf '%s' "$out"
}

# Full dump of the live database, kept locally so a restore is always undoable:
#   docker compose -f <file> exec -T mongo mongorestore --archive --drop < <file>
SNAPSHOT_PATH=""
snapshot_local_db() {
  local dir out
  dir="$ROOT_DIR/backup/pre-restore"
  mkdir -p "$dir" || return 1
  out="$dir/$(db_name)-$(date +%Y%m%d-%H%M%S).archive"
  if docker compose -f "$COMPOSE_FILE" exec -T mongo \
       mongodump --db "$(db_name)" --archive --quiet > "$out" 2>/dev/null && [[ -s "$out" ]]; then
    SNAPSHOT_PATH="$out"
    return 0
  fi
  rm -f "$out"
  return 1
}

restore_from_r2() {
  section "Restoring trade data from the R2 backup"

  if [[ -z "$PY" ]]; then
    warn "Python not found; cannot restore from R2. Install Python 3, then: pip install pymongo pyarrow boto3"
    return 0
  fi
  if ! "$PY" -c "import pymongo, pyarrow, boto3" >/dev/null 2>&1; then
    warn "R2 restore needs missing packages. Run: $PY -m pip install --user pymongo pyarrow boto3"
    return 0
  fi

  local n; n="$(count_trades)"
  if [[ -z "$n" ]]; then
    warn "Could not reach MongoDB — skipping the restore rather than risk dropping collections blindly. Check: docker compose -f $COMPOSE_FILE logs mongo"
    return 0
  fi

  if ! snapshot_local_db; then
    warn "Could not dump the current database, so the restore was skipped — it DROPs collections and there would be no way back. Check that the mongo container is up."
    return 0
  fi
  printf '\033[90mSafety dump of the current DB (%s trade(s)): %s\033[0m\n' "$n" "${SNAPSHOT_PATH#$ROOT_DIR/}"

  local rc=0
  "$PY" "$ROOT_DIR/backup/restore_from_r2.py" || rc=$?
  if [[ $rc -ne 0 ]]; then
    warn "R2 restore did not complete (exit $rc) — the local database is untouched, see the message above."
  else
    printf '\033[32mRestored — MongoDB now holds %s trade(s).\033[0m\n' "$(count_trades)"
    # The sync's watermark (mt5-sync/state.json, "newest deal already pushed")
    # lives on this machine, but the restore just rolled the DATABASE back to
    # whatever the snapshot held. A watermark left pointing past the restored
    # data makes the next sync report "Nothing new" and never re-push the trades
    # the restore dropped -- they simply vanish. Clearing it makes the next run
    # re-send its whole window; TradeNote dedups by trade date, so re-sending is
    # free and this is self-healing.
    if [[ -f "$ROOT_DIR/mt5-sync/state.json" ]]; then
      rm -f "$ROOT_DIR/mt5-sync/state.json"
      printf '\033[90mCleared the MT5 sync watermark so the restored window is re-synced.\033[0m\n'
    fi
  fi
  return 0
}

# Push the current database back up to R2. The guards (refuse on an empty or
# unreadable database, so a bad run can't overwrite the snapshot) live in the
# shared script, which stop.sh calls too -- one place, no drift.
backup_to_r2() {
  section "Backing up to R2"
  bash "$ROOT_DIR/scripts/r2-backup.sh" --compose-file "$COMPOSE_FILE" || true
}

# --- Open the terminal, then read it -----------------------------------------
# Runs on both platforms now. mt5_sync.py picks how it talks to MT5: the
# MetaTrader5 package on Windows, or the JSON file the TradeNoteExport EA writes
# from inside the terminal everywhere else (that package is a Windows-only
# wheel). Either way the terminal must be OPEN, so bring it up first.
launch_mt5() {
  section "Launching MetaTrader 5 terminal"
  if command -v tasklist >/dev/null 2>&1; then
    # --- Windows ---
    if tasklist /FI "IMAGENAME eq terminal64.exe" /NH 2>/dev/null | grep -qi "terminal64.exe"; then
      printf '\033[32mMT5 already running.\033[0m\n'
      return 0
    fi
    MT5_PATH="$(read_env MT5_TERMINAL_PATH)"
    [[ -n "$MT5_PATH" ]] || MT5_PATH="C:\\Program Files\\MetaTrader 5\\terminal64.exe"
    if [[ -f "/c/Program Files/MetaTrader 5/terminal64.exe" || -f "${MT5_PATH}" ]]; then
      cmd.exe //c start "" "$MT5_PATH" >/dev/null 2>&1 && \
        printf '\033[32mStarted MT5: %s\033[0m\n' "$MT5_PATH"
      sleep 8   # let it connect before the first sync reads history
    else
      warn "MT5 terminal not found at $MT5_PATH. Set MT5_TERMINAL_PATH in .env, or open MT5 manually."
    fi
    return 0
  fi

  # --- macOS ---
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if pgrep -f "MetaTrader 5.app" >/dev/null 2>&1; then
      printf '\033[32mMT5 already running.\033[0m\n'
      return 0
    fi
    MT5_APP="$(read_env MT5_APP_NAME)"; [[ -n "$MT5_APP" ]] || MT5_APP="MetaTrader 5"
    # -g: leave it in the background rather than stealing focus mid-startup.
    if open -ga "$MT5_APP" 2>/dev/null; then
      printf '\033[32mStarted MT5: %s\033[0m\n' "$MT5_APP"
      sleep 10   # Wine start-up is slower; give the EA time to write its first export
    else
      warn "Could not open \"$MT5_APP\". Set MT5_APP_NAME in .env if the app has a different name, or open MT5 manually."
    fi
    return 0
  fi

  warn "Unsupported platform for auto-launch — open MetaTrader 5 manually."
  return 0
}

sync_from_mt5() {
  launch_mt5

  section "Running MT5 -> TradeNote sync (once)"
  if [[ -z "$PY" ]]; then
    warn "Python not found; skipping MT5 sync. Install Python 3 and: pip install openpyxl requests"
    return 0
  fi
  local rc=0
  "$PY" "$ROOT_DIR/mt5-sync/mt5_sync.py" || rc=$?
  [[ $rc -ne 0 ]] && warn "MT5 sync did not complete (exit $rc). Make sure MetaTrader 5 is open and logged in."
  return 0
}

# 4a. Baseline: whatever is in the R2 backup.
if [[ "$SKIP_RESTORE" -eq 0 ]]; then
  restore_from_r2
fi

# 4b. Update: newer trades straight from the terminal, on either platform. The
# sync itself decides how to reach MT5 and skips cleanly when the terminal (or,
# on macOS, the TradeNoteExport EA) isn't running.
if [[ "$SKIP_SYNC" -eq 0 ]]; then
  sync_from_mt5
fi

# 4c. Persist: push the result back to R2 so the next start picks it up. Runs even
# when the MT5 sync was skipped or failed -- the guard inside is on the database
# having data, not on the sync having succeeded.
if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  backup_to_r2
fi

section "Done"
echo "App:   $APP_URL"
if [[ "$APP_ENV" == "prod" ]]; then
  printf '\033[90mMode:  bundled (fast). Frontend edits need a rebuild: npm run rebuild  |  hot-reload instead: ./start.sh --hot\033[0m\n'
elif [[ "$APP_ENV" == "dev" ]]; then
  printf '\033[90mMode:  Vite dev server (hot-reload). Navigation is slower; drop --hot for the bundled build.\033[0m\n'
fi
printf '\033[90mLogs:  docker compose -f %s logs -f tradenote\033[0m\n' "$COMPOSE_FILE"
printf '\033[90mIP:    only needed if Atlas Network Access is not 0.0.0.0/0  ->  ./start.sh --update-ip\033[0m\n'
