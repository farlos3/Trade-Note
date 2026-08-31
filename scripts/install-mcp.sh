#!/usr/bin/env bash
#
# Register the TradeNote MCP server with Claude Desktop, on macOS or Windows.
#
# Writes a "tradenote" entry into Claude Desktop's claude_desktop_config.json,
# MERGING into whatever is already there — other MCP servers you have configured
# are left untouched, and the previous file is kept as a .bak.
#
# Config location (created if missing):
#   macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
#   Windows  %APPDATA%\Claude\claude_desktop_config.json
#   Linux    ~/.config/Claude/claude_desktop_config.json
#
# Usage:
#   ./scripts/install-mcp.sh            # install / update the entry
#   ./scripts/install-mcp.sh --print    # show what would be written, change nothing
#   ./scripts/install-mcp.sh --remove   # take the entry back out
set -o pipefail

ACTION="install"
case "${1:-}" in
  --print)  ACTION="print";;
  --remove) ACTION="remove";;
  -h|--help) sed -n '2,20p' "$0"; exit 0;;
  "") ;;
  *) echo "Unknown arg: $1" >&2; exit 64;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_JS="$ROOT_DIR/mcp-server/server.mjs"

warn() { printf '\033[33mWARNING: %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

[[ -f "$SERVER_JS" ]] || die "$SERVER_JS not found."

# --- Locate Claude Desktop's config, per platform ----------------------------
if [[ -n "${APPDATA:-}" ]]; then
  CFG_DIR="$APPDATA/Claude"                                   # Windows (Git Bash)
elif [[ -d "$HOME/Library/Application Support" ]]; then
  CFG_DIR="$HOME/Library/Application Support/Claude"           # macOS
else
  CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"           # Linux
fi
CFG="$CFG_DIR/claude_desktop_config.json"

# --- node: Claude Desktop launches with a minimal PATH, so use an absolute one -
NODE_BIN="$(command -v node 2>/dev/null)"
[[ -n "$NODE_BIN" ]] || die "node not found on PATH. Install Node.js 18+ first."

if [[ ! -d "$ROOT_DIR/mcp-server/node_modules" ]]; then
  warn "mcp-server dependencies are not installed — running npm install."
  (cd "$ROOT_DIR/mcp-server" && npm install --silent) || die "npm install failed."
fi

TZ_TRADE="$(grep -E '^TRADENOTE_TZ=' "$ROOT_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)"
[[ -n "$TZ_TRADE" ]] || TZ_TRADE="Asia/Bangkok"

# On Windows, Claude Desktop is a native app and needs a Windows-style path, not
# the /c/... form Git Bash uses. cygpath does that conversion when present.
to_native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
NODE_NATIVE="$(to_native "$NODE_BIN")"
SERVER_NATIVE="$(to_native "$SERVER_JS")"

export CFG NODE_NATIVE SERVER_NATIVE TZ_TRADE ACTION
python3 - <<'PY'
import json, os, shutil, sys

cfg_path = os.environ["CFG"]
action   = os.environ["ACTION"]

entry = {
    "command": os.environ["NODE_NATIVE"],
    "args": [os.environ["SERVER_NATIVE"]],
    # The MCP server runs on the host, so it reaches MongoDB on the published
    # port. .env holds the in-container hostname (mongo:27017), which does not
    # resolve here; db.mjs rewrites it, and this makes the intent explicit.
    "env": {
        "TRADENOTE_TZ": os.environ["TZ_TRADE"],
        "MCP_MONGO_URI": "mongodb://localhost:27017/tradenote",
    },
}

if action == "print":
    print(json.dumps({"mcpServers": {"tradenote": entry}}, indent=2))
    print(f"\nWould be merged into: {cfg_path}")
    sys.exit(0)

cfg = {}
if os.path.exists(cfg_path):
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except json.JSONDecodeError as e:
        sys.exit(f"ERROR: {cfg_path} is not valid JSON ({e}). Fix or move it, then re-run.")
    shutil.copy2(cfg_path, cfg_path + ".bak")
    print(f"Backed up existing config -> {os.path.basename(cfg_path)}.bak")

servers = cfg.setdefault("mcpServers", {})
if action == "remove":
    if servers.pop("tradenote", None) is None:
        print("No 'tradenote' entry to remove.")
    else:
        print("Removed the 'tradenote' entry.")
else:
    existing = sorted(k for k in servers if k != "tradenote")
    servers["tradenote"] = entry
    print(f"Registered 'tradenote'." + (f" Kept: {', '.join(existing)}." if existing else ""))

os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"Wrote {cfg_path}")
PY

rc=$?
[[ $rc -ne 0 ]] && exit $rc

if [[ "$ACTION" == "install" ]]; then
  cat <<'EOF'

Next:
  1. Quit Claude Desktop completely and reopen it (it reads the config at start).
  2. The TradeNote tools appear under the tools icon in a new chat.
  3. Ask e.g. "Analyse my trading behaviour this month" or
     "Am I revenge trading? Use find_behavior_patterns."

The database must be running (./tradenote.sh start) for the tools to return anything.
EOF
fi
