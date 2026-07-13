#!/usr/bin/env bash
#
# Add this machine's current public IP to the MongoDB Atlas project IP access list.
#
# TradeNote connects to MongoDB Atlas, which only accepts connections from
# whitelisted IPs. Home / office IPs change, so this script:
#   1. Looks up the current public IP.
#   2. Removes stale entries this script added before (comment prefix match).
#   3. Adds the current IP if it is not already whitelisted.
#
# Credentials come from .env (ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY /
# ATLAS_PROJECT_ID) unless passed as flags. Uses curl (HTTP Digest auth, which
# the Atlas Admin API requires) and jq.
#
# Usage: ./scripts/update-atlas-ip.sh [--env-file PATH] [--public-key K]
#                                     [--private-key K] [--project-id ID]
set -euo pipefail

ENV_FILE=""
PUBLIC_KEY=""
PRIVATE_KEY=""
PROJECT_ID=""
COMMENT="TradeNote auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)    ENV_FILE="${2:-}"; shift 2;;
    --public-key)  PUBLIC_KEY="${2:-}"; shift 2;;
    --private-key) PRIVATE_KEY="${2:-}"; shift 2;;
    --project-id)  PROJECT_ID="${2:-}"; shift 2;;
    --comment)     COMMENT="${2:-}"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 64;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${ENV_FILE:=$ROOT_DIR/.env}"

read_env() {
  local key="$1" val=""
  if [[ -f "$ENV_FILE" ]]; then
    val="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | sed -E "s/^${key}=//" || true)"
  fi
  # strip one layer of surrounding quotes, if present
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

[[ -n "$PUBLIC_KEY"  ]] || PUBLIC_KEY="$(read_env ATLAS_PUBLIC_KEY)"
[[ -n "$PRIVATE_KEY" ]] || PRIVATE_KEY="$(read_env ATLAS_PRIVATE_KEY)"
[[ -n "$PROJECT_ID"  ]] || PROJECT_ID="$(read_env ATLAS_PROJECT_ID)"

if [[ -z "$PUBLIC_KEY" || -z "$PRIVATE_KEY" || -z "$PROJECT_ID" ]]; then
  echo "WARNING: Atlas API not configured. Set ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY / ATLAS_PROJECT_ID in $ENV_FILE" >&2
  echo "Skipping IP update. (Atlas -> Access Manager -> API Keys, role 'Project IP Access List Admin'.)" >&2
  exit 2
fi

command -v curl >/dev/null 2>&1 || { echo "curl not found." >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "jq not found. Install: brew install jq (mac) / sudo apt-get install jq (linux)" >&2; exit 1; }

BASE="https://cloud.mongodb.com/api/atlas/v2"
ACCEPT="Accept: application/vnd.atlas.2023-11-15+json"

# atlas METHOD URL [BODY] -> prints "<body>\n<http_code>"
atlas() {
  local method="$1" url="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS --digest -u "$PUBLIC_KEY:$PRIVATE_KEY" \
      -H "$ACCEPT" -H "Content-Type: application/json" \
      -X "$method" -d "$body" -w $'\n%{http_code}' "$url"
  else
    curl -sS --digest -u "$PUBLIC_KEY:$PRIVATE_KEY" \
      -H "$ACCEPT" -X "$method" -w $'\n%{http_code}' "$url"
  fi
}

get_public_ip() {
  local ip
  for url in https://api.ipify.org https://checkip.amazonaws.com https://ifconfig.me/ip; do
    ip="$(curl -fsS --max-time 15 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      printf '%s' "$ip"; return 0
    fi
  done
  return 1
}

IP="$(get_public_ip)" || { echo "Could not determine public IP (all lookup services failed)." >&2; exit 1; }
echo "Current public IP: $IP"

resp="$(atlas GET "$BASE/groups/$PROJECT_ID/accessList?itemsPerPage=500")"
code="$(printf '%s' "$resp" | tail -n1)"
list_body="$(printf '%s' "$resp" | sed '$d')"

if [[ ! "$code" =~ ^2 ]]; then
  echo "WARNING: Atlas GET accessList failed (HTTP $code): $list_body" >&2
  exit 1
fi

already="$(printf '%s' "$list_body" | jq -r --arg ip "$IP" \
  '[.results[]? | select(.ipAddress==$ip or .cidrBlock==($ip+"/32"))] | length')"

# Remove entries this script added for a previous (now different) IP.
stale="$(printf '%s' "$list_body" | jq -r --arg ip "$IP" --arg c "$COMMENT" '
  .results[]?
  | select((.comment // "") | startswith($c))
  | (.ipAddress // .cidrBlock) as $v
  | select($v != $ip and $v != ($ip + "/32"))
  | $v')"

if [[ -n "$stale" ]]; then
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    enc="$(jq -rn --arg v "$entry" '$v|@uri')"
    dresp="$(atlas DELETE "$BASE/groups/$PROJECT_ID/accessList/$enc")"
    dcode="$(printf '%s' "$dresp" | tail -n1)"
    echo "Removed stale IP $entry (HTTP $dcode)"
  done <<< "$stale"
fi

if [[ "${already:-0}" != "0" ]]; then
  echo "IP $IP is already whitelisted. Nothing to do."
  exit 0
fi

stamp="$(date '+%Y-%m-%d %H:%M')"
body="$(jq -cn --arg ip "$IP" --arg c "$COMMENT $stamp" '[{ipAddress:$ip, comment:$c}]')"
presp="$(atlas POST "$BASE/groups/$PROJECT_ID/accessList" "$body")"
pcode="$(printf '%s' "$presp" | tail -n1)"

if [[ "$pcode" =~ ^2 ]]; then
  echo "Whitelisted $IP in Atlas project $PROJECT_ID."
  exit 0
else
  pbody="$(printf '%s' "$presp" | sed '$d')"
  echo "WARNING: Atlas POST accessList failed (HTTP $pcode): $pbody" >&2
  exit 1
fi
