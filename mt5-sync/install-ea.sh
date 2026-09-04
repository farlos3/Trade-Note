#!/usr/bin/env bash
#
# Copy the MQL5 sources into every MetaTrader 5 data folder on this machine, so
# they appear in the terminal's Navigator ready to compile:
#   Experts/TradeNoteExport.mq5      - pushes deals/positions out to mt5-sync
#   Indicators/TradeNoteBreakEven.mq5 - draws the open basket's break-even price
#
# Each goes to the folder its type belongs in; MT5 will not load an indicator that
# sits under Experts.
#
# Handles the layouts MT5 actually uses:
#   - macOS: the whole Windows tree lives inside MT5's Wine bottle
#   - portable mode (portable.txt): the data folder IS the install dir, not AppData
#   - normal mode: %APPDATA%\MetaQuotes\Terminal\<hash>
#
# Usage: ./mt5-sync/install-ea.sh [--list]
#   --list   show the folders that would be written to, then exit
set -o pipefail

LIST_ONLY=0
[[ "${1:-}" == "--list" ]] && LIST_ONLY=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# "<subfolder of MQL5>:<file>" -- the destination is part of the entry because it
# differs per file and getting it wrong fails silently inside the terminal.
SOURCES=("Experts:TradeNoteExport.mq5" "Indicators:TradeNoteBreakEven.mq5")
for entry in "${SOURCES[@]}"; do
  src="$HERE/mql5/${entry#*:}"
  [[ -f "$src" ]] || { echo "ERROR: $src not found" >&2; exit 1; }
done

HOME_DIR="$HOME"

# Each call below expands its globs as ARGUMENTS, so paths containing spaces
# ("Application Support", "Program Files") survive intact -- collecting the
# patterns into a string array first and re-splitting them breaks on exactly
# those paths.
found=()
add_matches() {
  local dir
  for dir in "$@"; do
    [[ -d "$dir" ]] && found+=("$dir")
  done
}

shopt -s nullglob   # non-matching globs disappear instead of arriving literally

[[ -n "${APPDATA:-}" ]] && \
  add_matches "$APPDATA/MetaQuotes/Terminal/"*"/MQL5"                              # Windows, normal
add_matches "/c/Program Files/MetaTrader 5/MQL5" \
            "/c/Program Files (x86)/MetaTrader 5/MQL5"                             # Windows, portable
add_matches "$HOME_DIR/Library/Application Support/"*"/drive_c/Program Files/"*"/MQL5" \
            "$HOME_DIR/Library/Application Support/"*"/drive_c/Program Files (x86)/"*"/MQL5"
add_matches "$HOME_DIR/Library/Application Support/"*"/drive_c/users/"*"/AppData/Roaming/MetaQuotes/Terminal/"*"/MQL5"
add_matches "$HOME_DIR/.wine/drive_c/users/"*"/AppData/Roaming/MetaQuotes/Terminal/"*"/MQL5"

shopt -u nullglob

if [[ ${#found[@]} -eq 0 ]]; then
  echo "ERROR: no MetaTrader 5 data folder found." >&2
  echo "Launch MT5 once so it creates its folders, then re-run. If MT5 lives in a" >&2
  echo "non-standard location, copy mt5-sync/mql5/*.mq5 into its MQL5/Experts and" >&2
  echo "MQL5/Indicators folders by hand (MT5 menu: File -> Open Data Folder)." >&2
  exit 1
fi

for mql5 in "${found[@]}"; do
  for entry in "${SOURCES[@]}"; do
    sub="${entry%%:*}"
    file="${entry#*:}"
    dest="$mql5/$sub"
    if [[ "$LIST_ONLY" -eq 1 ]]; then
      echo "$dest/$file"
      continue
    fi
    mkdir -p "$dest" || { echo "WARNING: cannot create $dest" >&2; continue; }
    if cp "$HERE/mql5/$file" "$dest/"; then
      printf '\033[32mInstalled:\033[0m %s/%s\n' "$dest" "$file"
    else
      echo "WARNING: failed to copy into $dest" >&2
    fi
  done
done

[[ "$LIST_ONLY" -eq 1 ]] && exit 0

cat <<'EOF'

Next, inside MetaTrader 5 (these steps are GUI-only -- MetaEditor's headless
/compile does not work under the Wine build MT5 for Mac ships):
  1. Tools -> MetaQuotes Language Editor (F4)
  2. Open Experts/TradeNoteExport.mq5, press F7 to compile
  3. Open Indicators/TradeNoteBreakEven.mq5, press F7 to compile
  4. In the terminal, right-click Navigator -> Refresh
  5. Drag TradeNoteExport onto any chart, tick "Allow Algo Trading", OK
  6. Drag TradeNoteBreakEven onto the chart you trade (no permission needed --
     an indicator cannot trade)
A smiley in the chart corner means the EA is running; the chart shows the time of
the last export. Then ./tradenote.sh start picks the data up automatically.
EOF
