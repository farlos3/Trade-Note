#!/usr/bin/env bash
#
# MT5 -> TradeNote agent: only the part that has to run on the machine with
# MetaTrader 5. Use it when TradeNote itself is hosted elsewhere (Render, a VPS), so
# there is no Docker app to start here.
#
#   mt5-sync/mt5-agent.sh start     check the target, sync once, start the live feed
#   mt5-sync/mt5-agent.sh stop      stop the live feed
#   mt5-sync/mt5-agent.sh status    where it points, whether it answers, what is running
#   mt5-sync/mt5-agent.sh check     only: does the target answer, accept the api key,
#                                   and allow the account MT5 is logged into?
#
# Nothing is sent unless the terminal's account (<login>@<server>) is in the
# TradeNote user's allowed list -- edited only in TradeNote, Settings -> MT5
# accounts allowed to sync. The server enforces the same list on every push.
#
# Where it sends is `[tradenote] url` + `api_key` in mt5-sync/config.ini (the same
# two values the sync and the live feed already read). The every-minute journal sync
# is the scheduled task from scripts/install-agents.ps1; this script adds the part
# that task does not cover -- the live feed -- and a way to verify the target.
#
# Needs: MetaTrader 5 open and logged in, Python with `requests`
# (and `MetaTrader5` on Windows). The api key is never printed.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/.." && pwd)"
CONFIG="$HERE/config.ini"
LIVE_LOG="$HERE/live-agent.log"
PID_FILE="$HERE/.live-agent.pid"
SYNC_LOG="$HERE/logs/sync.log"

say()  { printf '\033[36m== %s ==\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

is_windows() { command -v powershell >/dev/null 2>&1; }

[[ -f "$CONFIG" ]] || die "Missing $CONFIG (copy config.example.ini -> config.ini and fill it in)."

PY=""
for cand in python3 python; do
  command -v "$cand" >/dev/null 2>&1 || continue
  if "$cand" -c "import requests" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[[ -n "$PY" ]] || die "No Python with 'requests'. Run: python -m pip install --user requests MetaTrader5 openpyxl"

cfg() {   # cfg <section> <key>
  "$PY" -c 'import configparser,sys
c=configparser.ConfigParser(); c.read(sys.argv[1],encoding="utf-8")
print(c.get(sys.argv[2],sys.argv[3],fallback="").strip())' "$CONFIG" "$1" "$2"
}

URL="$(cfg tradenote url)"; URL="${URL%/}"
API_KEY="$(cfg tradenote api_key)"
[[ -n "$URL" ]]     || die "[tradenote] url is empty in config.ini"
[[ -n "$API_KEY" ]] || die "[tradenote] api_key is empty in config.ini"
HOST="$(printf '%s' "$URL" | sed -E 's#^[a-z]+://##; s#[/:].*$##')"
is_remote() { [[ "$HOST" != "localhost" && "$HOST" != "127.0.0.1" && "$HOST" != "host.docker.internal" ]]; }

# HTTP status of an authenticated GET; 000 = no answer. Only the STATUS is judged:
# curl under Git Bash on Windows can exit non-zero on a perfectly good response.
probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "${1:-30}" -H "api-key: $API_KEY" "$URL/api/journal/version" 2>/dev/null
}

check_target() {
  local code
  printf 'Target: %s%s\n' "$HOST" "$(is_remote && echo ' (remote)' || echo ' (this machine)')"
  code="$(probe 30)"
  if [[ "$code" == "000" ]] && is_remote; then
    echo "No answer yet -- a hosted free instance may be waking up; waiting..."
    code="$(probe 90)"
  fi
  case "$code" in
    200) ok "Reachable, api key accepted."; return 0;;
    401|403) warn "Reached $HOST but it REFUSED the api key (HTTP $code). Check api_key in config.ini, and that the same key exists in Settings -> API Keys."; return 1;;
    404) warn "Reached $HOST but the API is not up (HTTP 404). On a hosted app this usually means the database connection failed -- check its logs."; return 1;;
    000) warn "Cannot reach $URL. Check the url, your connection, and that the service is deployed."; return 1;;
    *)   warn "Unexpected answer from $HOST (HTTP $code)."; return 1;;
  esac
}

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  if is_windows; then
    # Windows pids (what Start-Process records); the command line rules out a recycled pid.
    powershell -NoProfile -Command \
      "\$p = Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" -ErrorAction SilentlyContinue; \
       if (\$p -and \$p.CommandLine -like '*mt5_live.py*') { exit 0 } else { exit 1 }" >/dev/null 2>&1
    return $?
  fi
  kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q "mt5_live.py"
}

live_pid() {
  local p=""
  [[ -f "$PID_FILE" ]] && p="$(tr -dc '0-9' < "$PID_FILE")"
  pid_alive "$p" && printf '%s' "$p"
}

stop_live() {
  local pid; pid="$(live_pid)"
  [[ -n "$pid" ]] || return 0
  if is_windows; then taskkill //PID "$pid" //F >/dev/null 2>&1; else kill "$pid" 2>/dev/null; fi
  sleep 1
}

start_live() {
  local pid; pid="$(live_pid)"
  if [[ -n "$pid" ]]; then
    # The agent reads config.ini and imports its code once, when it starts. One that
    # predates an edit (a new url above all) keeps using the old values for days.
    local started newest=0 m f
    started="$(stat -c %Y "$PID_FILE" 2>/dev/null || stat -f %m "$PID_FILE" 2>/dev/null || echo 0)"
    for f in "$HERE/mt5_live.py" "$HERE/mt5_sync.py" "$CONFIG"; do
      m="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"
      [[ "$m" -gt "$newest" ]] && newest="$m"
    done
    if [[ "$started" -gt 0 && "$newest" -le "$started" ]]; then
      ok "Live feed already running (pid $pid)."; return 0
    fi
    warn "Live feed predates a change to its code or config.ini -- restarting it."
    stop_live
  fi
  if is_windows; then
    local win_root; win_root="$(cygpath -w "$ROOT_DIR" 2>/dev/null || printf '%s' "$ROOT_DIR")"
    # Start-Process: detached from this console, so closing the terminal does not kill it.
    powershell -NoProfile -Command \
      "(Start-Process -FilePath '$PY' -ArgumentList '$win_root\\mt5-sync\\mt5_live.py' \
         -WorkingDirectory '$win_root' \
         -RedirectStandardOutput '$win_root\\mt5-sync\\live-agent.log' \
         -RedirectStandardError  '$win_root\\mt5-sync\\live-agent.log.err' \
         -WindowStyle Hidden -PassThru).Id | Set-Content -NoNewline '$win_root\\mt5-sync\\.live-agent.pid'" >/dev/null 2>&1
  else
    nohup "$PY" "$HERE/mt5_live.py" >"$LIVE_LOG" 2>&1 &
    printf '%s' "$!" > "$PID_FILE"; disown 2>/dev/null || true
  fi
  sleep 4
  pid="$(live_pid)"
  if [[ -n "$pid" ]]; then ok "Live feed started (pid $pid)."; else
    warn "Live feed did not stay up. See mt5-sync/live-agent.log and live-agent.log.err"
    [[ -s "$LIVE_LOG" ]] && tail -n 3 "$LIVE_LOG" | sed 's/^/  /' >&2
    return 1
  fi
}

# Is the account the terminal is logged into one this TradeNote user allowed?
# Asked of the server (the list lives there and is edited only from Settings), so
# a terminal on the wrong login is stopped here instead of failing every push.
check_account() {
  "$PY" "$HERE/mt5_sync.py" --check-account 2>&1 | sed -E 's/^\[[^]]*\] //'
  return "${PIPESTATUS[0]}"
}

cmd_start() {
  say "Target"
  check_target || die "Not starting: fix the target first (nothing was sent)."
  say "Account"
  local rc=0; check_account || rc=$?
  case "$rc" in
    0) ;;
    3) die "Not starting: this MT5 account is not allowed to sync. Add it in TradeNote (Settings -> MT5 accounts allowed to sync), or log the terminal into an allowed account.";;
    *) die "Not starting: could not confirm the account (is MetaTrader 5 open and logged in?).";;
  esac
  if is_remote && command -v docker >/dev/null 2>&1 \
     && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx tradenote_app; then
    warn "A local TradeNote container is running too. Only one app should receive the sync: stop it with  docker compose -f docker-compose-dev.yml stop tradenote"
  fi
  say "Journal sync (once)"
  bash "$HERE/run-sync.sh" || warn "Sync run reported a problem."
  [[ -f "$SYNC_LOG" ]] && tail -n 4 "$SYNC_LOG" | cut -c1-180 | sed 's/^/  /'
  say "Live feed"
  start_live
  echo
  echo "The every-minute sync is the scheduled task 'TradeNote MT5 sync' (scripts/install-agents.ps1)."
  echo "Both only deliver data while this machine is on and MetaTrader 5 is open and logged in."
}

cmd_status() {
  say "Status"
  check_target || true
  local pid; pid="$(live_pid)"
  if [[ -n "$pid" ]]; then ok "Live feed: running (pid $pid)"; else warn "Live feed: NOT running (mt5-agent.sh start)"; fi
  [[ -f "$LIVE_LOG" ]] && printf '  last live line: %s\n' "$(tail -n 1 "$LIVE_LOG" | cut -c1-150)"
  [[ -f "$SYNC_LOG" ]] && printf '  last sync line: %s\n' "$(tail -n 1 "$SYNC_LOG" | cut -c1-150)"
  if is_windows; then
    powershell -NoProfile -Command "\$i = Get-ScheduledTask -TaskName 'TradeNote MT5 sync' -ErrorAction SilentlyContinue | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; if (\$i) { 'Sync task: last run ' + \$i.LastRunTime + ', result ' + \$i.LastTaskResult } else { 'Sync task: not installed (scripts/install-agents.ps1)' }" 2>/dev/null | sed 's/^/  /'
  fi
}

case "${1:-}" in
  start)  cmd_start;;
  stop)   stop_live; ok "Live feed stopped.";;
  status) cmd_status;;
  check)  check_target && check_account;;
  *) sed -n 3,15p "$0" | sed 's/^# \{0,1\}//'; [[ -z "${1:-}" ]] || exit 64;;
esac
