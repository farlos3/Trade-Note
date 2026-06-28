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

The script keeps a watermark in `state.json` and only sends deals newer than the
last successful sync.

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

Run every 30 minutes (adjust as you like). From an **admin PowerShell** in the
project folder:

```powershell
$py = (Get-Command python).Source
$script = "D:\Trader\TradeNote\mt5-sync\mt5_sync.py"
$action = New-ScheduledTaskAction -Execute $py -Argument "`"$script`"" -WorkingDirectory "D:\Trader\TradeNote\mt5-sync"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "TradeNote MT5 Sync" -Action $action -Trigger $trigger `
    -Description "Sync MetaTrader 5 deals into TradeNote"
```

Manage it:
```powershell
Start-ScheduledTask -TaskName "TradeNote MT5 Sync"     # run now
Get-ScheduledTask    -TaskName "TradeNote MT5 Sync"     # status
Unregister-ScheduledTask -TaskName "TradeNote MT5 Sync" -Confirm:$false   # remove
```

> The MT5 terminal must be running (and logged in) when the task fires.

## Notes & caveats

- **Dedup**: the script advances its watermark only after a successful push, so
  deals aren't re-sent. If you ever need to re-import, delete `state.json` and set
  `lookback_days`, but be aware TradeNote may duplicate trades for a date that was
  already imported — manage that from TradeNote → Imports.
- **Cloud (Render) target**: point `url` at your Render URL and the same key
  must exist on that instance's user. The machine running this script still needs
  the local MT5 terminal.
- Secrets (`config.ini`) and `state.json` are gitignored.
