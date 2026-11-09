# CLAUDE.md

Guidance for Claude Code working in this repo.

## Read the map first

**Before broad code searches, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — a
file-by-file map of the whole codebase (stack, runtime, every source path and what
it does). Use it to jump straight to the right file instead of scanning the tree.
Keep it updated when structure changes.

## Must-know gotchas

- **Timezone.** Trades bucket by the *trade timezone* (`timeZoneTrade`, e.g.
  Asia/Bangkok), not UTC. A trade day-doc's `dateUnix` is **start-of-day in the trade
  tz**; formatting it with `toISOString()` (UTC) shifts the label back a day — always
  format with the trade tz (`dayInTz` in `mcp-server/analysis.mjs`). A **closed**
  trade is filed under the day it **closed** (`closeTd`); an open position stays on
  its open day until it closes (src/utils/addTrades.js). History filed the other way
  (by open day) was migrated on 2026-11-09 -- **never change how days are assigned
  without re-filing stored history in the same step**: the importer only rewrites the
  days it covers, so every trade then exists on two days and all stats inflate
  (it happened). `python mt5-sync/reconcile.py` reports `duplicated`; run it after any
  importer change.
- **Backend restart.** `index.mjs` is the Express + Parse backend. Frontend hot-reloads,
  but backend edits need:
  `docker compose -f docker-compose-dev.yml restart tradenote`
- **Dev stack.** `docker-compose-dev.yml` → `tradenote_app` (:8080). The primary
  database is **MongoDB Atlas** (Cluster0, db `tradenote`): `MONGO_URI` is the
  `readWrite` user `tradenote_app`; `BACKUP_MONGO_URI` is the read-only
  `tradenote_backup` (R2 backup, `reconcile.py`). Network Access is `0.0.0.0/0`, so
  the passwords in `.env` are the protection. R2 is backup only: `start` does NOT
  restore from it while `MONGO_URI` is Atlas. The M0 cluster auto-pauses when idle
  and can only be resumed in the Atlas UI. The old local mongo is behind the compose
  profile `localdb` (`tradenote_mongo`, stopped, data kept as an offline fallback).
- **MT5 data is accepted only from allowed accounts.** `/api/trades`, `/api/account`
  and `/api/live` refuse (403) any account not in `_User.allowedSyncAccounts`
  (`<login>@<server>`), checked on the PARSED report for trades. Fails closed: no
  list = no sync. The list is edited only in Settings → "MT5 accounts allowed to
  sync" (logged-in session); the api key alone cannot change it. A new MT5 account
  must be added there before it can sync.
- **dev vs prod mode.** `NODE_ENV` in `docker-compose-dev.yml` defaults to `dev`
  (Vite dev server + hot-reload, but every page load re-fetches ~90 unbundled
  modules — slow navigation, since nav links are plain `<a href>` full reloads).
  For day-to-day *use*, run prod instead — bundled, hash-cached, far faster:
  `NODE_ENV=prod docker compose -f docker-compose-dev.yml up -d`
  In prod mode source edits need a rebuild to appear: `npm run rebuild`
  (≈10s). Switch back with the same `up -d` minus the `NODE_ENV=prod`.

## Secrets — never commit

`.env`, `mt5-sync/config.ini`, `mt5-sync/state.json`, and `backup/data/` are gitignored.
Redact MongoDB URIs in output. Destructive DB ops (e.g. `deleteMany`) need explicit
user authorization.
