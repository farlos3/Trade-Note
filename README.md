<p style='font-size:2.5em;' align="center">TradeNote — MT5 edition</p>
<p style='font-size:16px;' align="center">A self-hosted, single-user trading journal with automatic MetaTrader 5 sync</p>

---

> **Built on / forked from [Eleven-Trading/TradeNote](https://github.com/Eleven-Trading/TradeNote.git).**
> This is a customised fork that keeps the original TradeNote app and adds live
> MetaTrader 5 syncing, a local (no-cloud) database, and Parquet backups to
> Cloudflare R2. All credit for the base journal goes to the upstream project;
> like it, this fork is licensed under **GNU GPL v3**.

TradeNote is an open-source trading journal for traders who care about owning
their data. The upstream project stores, analyses and visualises your trades.
**This fork** turns it into a hands-off, single-user setup: run one command and
your MetaTrader 5 trades flow in on their own, your data lives on your machine,
and backups go to your own R2 bucket.

## Screenshots

<!-- Drop your real screenshots in docs/images/ and uncomment the lines below.
![Dashboard](docs/images/dashboard.png)
![Calendar](docs/images/calendar.png)
![Plan vs Actual](docs/images/plan-vs-actual.png)
-->

## What this fork adds

- **MetaTrader 5 → TradeNote auto-sync** (Windows). Closed deals are pulled from
  the running MT5 terminal and imported automatically, near real-time (every
  minute), with no console window. See [`mt5-sync/`](mt5-sync/).
- **Single-user auto-login** — skip the login page; the app signs in as the
  seeded user (`TRADENOTE_AUTO_LOGIN`).
- **Local MongoDB, no cloud** — the database runs in a Docker `mongo` service on
  a local volume. No Atlas required.
- **Parquet backups to Cloudflare R2** — every collection (images included) is
  exported to Parquet and pushed to your R2 bucket under `data/`. See
  [`backup/`](backup/).
- **Dashboard account panel** — broker, MT5 account number, balance, deposits and
  withdrawals, pushed live from the account.
- **Dashboard key stats** — total trades, win rate, wins/losses, profit factor,
  average win/loss.
- **Calendar** — year-at-a-glance summary, cleaner month grid, per-day P&L.
- **Plan vs Actual** — the *actual* line is your real day-by-day equity curve
  (real ups and downs), auto-loaded from the journal, compared against the plan.
- **Per-trade principle notes** — write the rationale for each trade inline on the
  Screenshots page.
- Quality fixes: 2-decimal money everywhere, stale filter auto-heal on reload,
  and a fix for the "Invalid session token" login loop.

## Requirements

- **Docker Desktop** (runs the app + local MongoDB)
- **Windows** with **MetaTrader 5** installed — for the automatic sync
  (the `MetaTrader5` Python package is Windows-only; see *macOS* below)
- **Python 3** with `pip install MetaTrader5 openpyxl requests` — for the sync
- A `.env` file (copy from [`.env.example`](.env.example))

## Quick start

```powershell
# Windows
.\start.ps1                 # dev mode (hot reload)
.\start.ps1 -Mode local     # built image, no hot reload
.\start.ps1 -Mode prod      # published image
```
```bash
# macOS / Linux
./start.sh --skip-sync      # MT5 sync is Windows-only (see below)
```

`start.ps1` / `start.sh` will:
1. Start the app **and local MongoDB** in Docker.
2. Wait until the web app answers.
3. **Launch the MetaTrader 5 terminal** (Windows, if not already open).
4. Run the MT5 → TradeNote sync once.

Then open **http://localhost:8080**. With `TRADENOTE_AUTO_LOGIN=true` you land
straight on the dashboard.

## MetaTrader 5 auto-sync

The bridge lives in [`mt5-sync/mt5_sync.py`](mt5-sync/mt5_sync.py). It pulls closed
deals, rebuilds them into the XLSX layout TradeNote's MetaTrader 5 importer
expects, and posts them to `/api/trades` with an API key. Highlights:

- **Near real-time** — a Windows Scheduled Task runs it every minute
  (`pythonw`, no window). It only pushes when a new trade has closed.
- **Lifecycle-bound** — it does nothing unless **TradeNote is running** and the
  **MT5 terminal is already open**; it never force-launches MT5 on its own (only
  the start script does, once).
- **Correct dates/times** — MT5 reports deal times in broker-server time; the
  sync reads them so the journal matches what the terminal shows.
- **No duplicates** — a sliding window is re-sent each run and TradeNote dedups by
  trade date, so trades are always complete and never doubled.
- **Account snapshot** — balance, deposits and withdrawals are pushed for the
  Dashboard panel.

Full setup, config and the scheduled-task command are in
[`mt5-sync/README.md`](mt5-sync/README.md).

## Local database & backups

The app uses the local `mongo` service (data in the `mongo_data` Docker volume).
Backups are written as **Parquet** and uploaded to **Cloudflare R2** under
`data/`, with a `latest/` copy plus dated snapshots. Images are included (they
live inside the `screenshots` collection).

```powershell
python backup\backup_to_r2.py     # back up now
python backup\restore_from_r2.py  # restore the latest snapshot
```

Requires `pip install pymongo pyarrow boto3` and `R2_ACCOUNT_ID` + `R2_BUCKET`
(plus the R2 keys) set in `.env`. Details and Atlas→local migration in
[`backup/README.md`](backup/README.md).

## Configuration (`.env`)

| Key | Purpose |
|-----|---------|
| `MONGO_URI` | Database. Default `mongodb://mongo:27017/tradenote` (local). |
| `TRADENOTE_DATABASE` | Database name (e.g. `tradenote`). |
| `APP_ID`, `MASTER_KEY` | Parse app id / master key (random strings). |
| `TRADENOTE_PORT` | Web port (default `8080`). |
| `TRADENOTE_USER`, `TRADENOTE_PASSWORD` | Seeded single-user login. |
| `TRADENOTE_AUTO_LOGIN` | `true` to skip the login page. |
| `MT5_TERMINAL_PATH` | Optional path to `terminal64.exe` for the start script. |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 for images **and** Parquet backups. |

> **Security:** with auto-login on, anyone who can reach the app is logged in.
> Keep it on a private/local address only.

## macOS

The TradeNote app itself is cross-platform and runs on macOS via Docker
(`./start.sh --skip-sync`). The **MetaTrader 5 auto-sync is Windows-only** — the
`MetaTrader5` Python package has no macOS build. On a Mac, either:

- Import trades manually: export a **Trade History Report (XLSX)** from MT5 and
  upload it on the **Imports** page (broker = MetaTrader 5), or
- Run `mt5_sync.py` on a Windows machine/VM that has MT5 open and point its
  `url` at this instance.

## Credits & license

- Base journal: **[Eleven-Trading/TradeNote](https://github.com/Eleven-Trading/TradeNote.git)** — 🌐 [website](https://tradenote.co) · 📚 [docs](https://tradenote.co/project-overview.html) · 💬 [Discord](https://discord.gg/ZbHekKYb85)
- This fork adds the MT5 sync, local database and Parquet/R2 backup layer on top.

Licensed under the **GNU GPL v3**, the same license as the upstream project.
