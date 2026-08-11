# MT5 → TradeNote auto-sync

Pulls closed deals from your **MetaTrader 5** terminal and pushes them into
TradeNote automatically, on a schedule. Runs on the same machine as MT5 —
**Windows or macOS**.

> Only **MetaTrader 5** is supported (not MT4), and TradeNote treats MT5 trades
> as **forex**. Symbols 6 letters long (EURUSD, XAUUSD, …) are detected as forex.

## How it works

```
MT5 terminal ──► mt5_sync.py ──► POST /api/trades ──► TradeNote ──► MongoDB
  (deals)        (build XLSX,        (api-key)         (parse +
                  base64)                               round-trips)
```

## Two ways to reach MT5

`mt5_sync.py` picks one automatically; everything after that point is identical.

| Backend | Platform | How |
|---------|----------|-----|
| **native** | Windows only | The `MetaTrader5` Python package talks to the terminal directly. |
| **bridge** | **macOS**, Linux, Windows | The `TradeNoteExport` EA runs *inside* the terminal and writes a JSON file; the sync reads that. |

The native package is a **Windows-only wheel** bound to `terminal64.dll` — it
cannot be installed on macOS at all. The bridge inverts the direction: instead of
Python reaching into MT5, MQL5 (which runs inside the terminal on every platform)
pushes the data out. Force one with `[mt5] backend = native|bridge`.

## macOS setup (the bridge)

```bash
./mt5-sync/install-ea.sh          # copy the EA into MT5's Experts folder
```

It finds the data folder itself, including **portable** installs (where MT5 keeps
its data next to `terminal64.exe` instead of under `%APPDATA%`) and the Wine
bottle MT5-for-Mac uses. Launch MT5 at least once first so the folders exist.

Then, inside MT5 — these steps are GUI-only, MetaEditor's headless `/compile`
does not work under the Wine build MT5 for Mac ships:

1. **Tools → MetaQuotes Language Editor** (F4)
2. Open `Experts/TradeNoteExport.mq5`, press **F7** to compile
3. Back in the terminal, right-click Navigator → **Refresh**
4. Drag **TradeNoteExport** onto any chart, tick **Allow Algo Trading**, OK

A 🙂 in the chart corner means it is running, and the chart shows the time of the
last export. `./start.sh` then picks the data up with no further setup.

The EA writes `tradenote_deals.json` into `<data folder>/MQL5/Files` every 15
seconds, and immediately whenever a deal closes. The sync treats a file older
than 90 seconds as "terminal not running" and skips the run, so a closed
terminal never gets pushed as an empty account.

> **Scope of the export:** the EA exports its own `LookbackDays` window (7 by
> default). Deposits and withdrawals older than that window are not visible to
> the sync — raise the EA's `LookbackDays` input if you need the full history.

Each run re-sends a **sliding window** of recent deals (default: the last 2 days)
and lets TradeNote drop the ones it already has — TradeNote dedups imports by
trade date, so re-sending never creates duplicates and always re-pairs a trade's
open + close legs even if they arrived in different runs. `state.json` keeps a
small watermark (the newest deal already pushed) used only to skip the push/email
when nothing new has closed, so a 1-minute schedule stays quiet between trades.

> **Broker time:** MT5 reports deal times in *broker-server* time, which the API
> returns ahead of your PC clock (HFMarkets is UTC+3). The sync pads its query
> window into the future to account for this — don't be surprised if `state.json`
> holds a timestamp that looks a few hours ahead.

## One-time setup

### 1. Install dependencies
```powershell
pip install MetaTrader5 openpyxl requests   # Windows
```
```bash
pip3 install openpyxl requests              # macOS -- MetaTrader5 is Windows-only
```

### 2. Make sure MT5 can be reached
Either:
- **Open the MT5 terminal and log into your account** (simplest — leave the
  `[mt5]` login/password/server blank in `config.ini`), or
- Fill `login`, `password`, `server` in `config.ini` so the script logs in itself.

> In MT5: Tools → Options → Expert Advisors → enable "Allow automated trading"
> is not required for read-only history, but the terminal must be able to log in.

### 3. Configure
`config.ini` is already created with your local TradeNote URL and API key.
Edit it if you deploy TradeNote elsewhere or rotate the key. Get a new key any
time from TradeNote → **Settings → API Keys**.

### 4. Test it
```powershell
python mt5-sync\mt5_sync.py
```
Expected output ends with `TradeNote response:  -> Saved Trades to ParseNode DB`.
Check your TradeNote dashboard — the trades should appear.

## Run it automatically — macOS (LaunchAgent)

```bash
./mt5-sync/install-sync-agent.sh                 # every 1 minute
./mt5-sync/install-sync-agent.sh --interval 300  # every 5 minutes
./mt5-sync/install-sync-agent.sh --status
./mt5-sync/install-sync-agent.sh --logs
./mt5-sync/install-sync-agent.sh --uninstall
```

Runs whether or not a Terminal is open. A one-minute cadence is cheap because
each run short-circuits: TradeNote down, MT5/EA not running (bridge file older
than 90s), or no newly closed deal all exit immediately without pushing.

Output goes to `mt5-sync/logs/sync.log` (gitignored), trimmed to the last 2000
lines once it passes 5 MB.

> `run-sync.sh` picks the python3 that can actually `import requests, openpyxl`
> rather than the first one on PATH. A Mac usually has several, and the
> dependencies are typically installed into only one of them — choosing by path
> order silently fails every single run.

## Run it automatically — Windows (Task Scheduler)

Runs **every minute** for near-real-time syncing (Task Scheduler's shortest
interval). It only pushes when a new trade has closed, so a 1-minute cadence is
cheap. From a PowerShell in the project folder:

```powershell
# Resolve the python that actually has the MT5 packages, and the sync folder,
# without hardcoding machine-specific paths. Run this from the mt5-sync folder.
$py = & python -c "import sys; print(sys.executable)"
$wd = (Get-Location).Path
$script = Join-Path $wd "mt5_sync.py"

$action = New-ScheduledTaskAction -Execute $py -Argument "`"$script`"" -WorkingDirectory $wd
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$rep = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$trigger.Repetition = $rep.Repetition
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Interactive: runs in your logged-on session so it can reach the open MT5 terminal.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "TradeNote MT5 Sync" -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description "Sync MetaTrader 5 deals into TradeNote every minute (near real-time)"
```

Manage it:
```powershell
Start-ScheduledTask -TaskName "TradeNote MT5 Sync"     # run now
Get-ScheduledTask    -TaskName "TradeNote MT5 Sync"     # status
Unregister-ScheduledTask -TaskName "TradeNote MT5 Sync" -Confirm:$false   # remove
```

> The MT5 terminal must be running (and logged in) when the task fires.

## Notes & caveats

- **Dedup**: TradeNote drops any imported trade whose date already exists, so the
  sliding window is safe to re-send every run. To force a clean re-pull, reset
  `state.json` to `{}` (or delete it) and widen `lookback_days` — already-imported
  dates simply won't duplicate.
- **Dedup limit**: TradeNote only compares against the 50 most recent existing
  trades. Keep `lookback_days` small enough that the window holds fewer than 50
  trades, or heavy days could slip past the filter.
- **Cloud (Render) target**: point `url` at your Render URL and the same key
  must exist on that instance's user. The machine running this script still needs
  the local MT5 terminal.
- Secrets (`config.ini`) and `state.json` are gitignored.
