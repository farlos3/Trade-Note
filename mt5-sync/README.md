# MT5 → TradeNote auto-sync

Pulls closed deals from your **MetaTrader 5** terminal and pushes them into
TradeNote automatically, on a schedule. Runs on the same Windows machine as MT5.

> Only **MetaTrader 5** is supported (not MT4), and TradeNote treats MT5 trades
> as **forex**. Symbols 6 letters long (EURUSD, XAUUSD, …) are detected as forex.

## How it works

```
MT5 terminal ──► mt5_sync.py ──► POST /api/trades ──► TradeNote ──► MongoDB Atlas
  (deals)        (build XLSX,        (api-key)         (parse +
                  base64)                               round-trips)
```

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
pip install MetaTrader5 openpyxl requests
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

## Run it automatically (Task Scheduler)

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
