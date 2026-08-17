# ARCHITECTURE — codebase map

Reference map so an LLM can jump straight to the right file instead of scanning
the whole tree. TradeNote is a self-hosted trading journal (fork of
github.com/Eleven-Trading/TradeNote). Keep this file updated when structure
changes.

## Stack

- **Frontend** — Vue 3 (`<script setup>`), Vue Router, Pinia (light use), ECharts,
  dayjs (utc/timezone/isoWeek), Quill editor. Built with Vite. SPA under `src/`.
- **Backend** — single file `index.mjs`: an Express + Parse Server instance. Serves
  the built SPA, the Parse API, plus custom REST endpoints (R2 uploads, account,
  AI analysis). No separate backend folder.
- **Database** — MongoDB (local container `tradenote_mongo`, or Atlas). Parse stores
  documents; trades are stored as **per-day documents** (one doc per calendar day).
- **Object storage** — Cloudflare R2 (S3 API): trade screenshots, day-summary files,
  playbooks, and DB backups (parquet).
- **MT5 sync** — `mt5-sync/mt5_sync.py`, Windows **and** macOS, pulls deals from MetaTrader 5
  and pushes them into TradeNote every minute (Windows Scheduled Task).
- **MCP server** — `mcp-server/`, exposes trade stats / behavior patterns to Claude
  (Desktop / Code) over MCP.

## Runtime (dev)

- `docker-compose-dev.yml` — dev stack. `tradenote_app` (Vite hot-reload, `node index.mjs`,
  port 8080) + `tradenote_mongo` (port 27017). Source bind-mounted; **backend edits
  to `index.mjs` need `docker compose -f docker-compose-dev.yml restart tradenote`**,
  frontend hot-reloads.
- `docker-compose.yml` / `docker-compose-local.yml` — prod / local-image variants.
- `start.sh` — restore DB from R2 (+ safety mongodump) then bring stack up.
- `stop.sh` — backup DB to R2 then bring stack down. Used for cross-machine moves
  (backup on machine A, restore on machine B).

## Timezone gotcha (important)

- Trades bucket by **trade timezone** (`timeZoneTrade`, e.g. Asia/Bangkok UTC+7), not
  UTC. Broker time is UTC+3; host UTC+7.
- A trade day-doc's `dateUnix` = **start-of-day in the trade tz**, stored as unix
  seconds. Formatting it with `toISOString()` (UTC) shifts the label back one day —
  always format with the trade tz. See `computeDailyBreakdown` / `dayInTz` in
  `mcp-server/analysis.mjs`.
- Order day is derived from **open time** (positions held past midnight stay on their
  open day).

---

## Root / config

| File | Purpose |
|------|---------|
| `index.mjs` | **Backend.** Express + Parse Server. Custom endpoints: R2 upload/delete, `POST /api/account` (MT5 balance + dated `cashFlows`), `GET /api/analysis/behavior` (rule-based stats + daily P&L breakdown + notes), `GET /api/analysis/fingerprint`, `POST /api/analysis/ai-summary` (Claude LLM, off unless `ANTHROPIC_API_KEY`). |
| `index.html` | SPA entry HTML (Vite). |
| `package.json` / `package-lock.json` | Frontend + backend deps and scripts. |
| `vite.config.js` | Vite build/dev config. `optimizeDeps.include` + `server.warmup` to cut first-visit lazy-compile lag. |
| `requiredClasses.json` | Parse schema — the classes/columns TradeNote provisions on boot. |
| `render.yaml`, `captain-definition`, `docs/DEPLOY.md` | Hosting/deploy configs (Render, CapRover). |
| `.env.example` | Env template (Mongo, Parse app id/master key, R2, MT5 login, `ANTHROPIC_API_KEY`, `ANALYSIS_MODEL`, `OVERTRADE_LOT_CAP`). Real `.env` is gitignored. |
| `.mcp.json` | Claude Code MCP registration for the local `mcp-server`. |
| `scripts/backup-mongodb.sh` | Ad-hoc mongodump helper. |

## `src/` — Vue app

### Entry / shell
| File | Purpose |
|------|---------|
| `src/main.js` | App bootstrap: Vue, router, Pinia, global styles, Parse init. |
| `src/App.vue` | Root component / router outlet. |
| `src/router/index.js` | Routes (lazy `() => import()`). `/daily` titled **History**. |
| `src/layouts/Dashboard.vue` | Authenticated app shell (nav + side menu + content). |
| `src/layouts/LoginRegister.vue` | Unauthenticated shell. |

### Views (pages — one per route)
| File | Purpose |
|------|---------|
| `src/views/Dashboard.vue` | Home dashboard: stat tiles (2-tier: Total Trades / Profit / Win Rate hero), Equity chart (withdrawal-aware), Cumulated P&L, per-side stats. |
| `src/views/Daily.vue` | **History** page. Per-day cards; Daily/Weekly/Monthly filter with group subtotals. |
| `src/views/Calendar.vue` | Monthly P&L calendar grid. |
| `src/views/PlanVsActual.vue` | Plan target vs actual equity + daily P&L. Equity is withdrawal-aware (merged timeline); **plan line does NOT subtract withdrawals**. |
| `src/views/Plan.vue` | Create/edit growth plans (start balance, % per day, deposits, withdrawals). |
| `src/views/Analysis.vue` | AI Analysis. Rule-based behavior summary (English) + fingerprint cache; "Analyze behavior" button calls LLM; export prompt+data JSON for Claude. |
| `src/views/AddTrades.vue` / `Imports.vue` | Import trades (broker CSV / manual). |
| `src/views/AddDiary.vue` / `Diary.vue` | Diary entries (rich text + day files preview). Three tabs: Day / Week / Plan. |
| `src/views/WeeklyPlan.vue` | **Weekly Plan** page (Journal section). Next week + this week pinned as the two actionable cards, older weeks as history; Monday/Friday reminder banner. Same `notes` week records as the gate popup and Diary's Plan tab. |
| `src/views/AddScreenshot.vue` / `Screenshots.vue` | Trade screenshots (stored in R2). |
| `src/views/AddPlaybook.vue` / `Playbook.vue` | Trading playbooks. |
| `src/views/AddExcursions.vue` | MAE/MFE excursion entry. |
| `src/views/Settings.vue` | User settings (timezone, currency, broker, etc.). |
| `src/views/Login.vue` / `Register.vue` | Auth pages. |
| `src/views/Checkout.vue` / `CheckoutSuccess.vue` | Upstream billing pages (unused in self-host). |

### Components
| File | Purpose |
|------|---------|
| `src/components/Nav.vue` | Top nav bar. Version check is non-blocking (cached in sessionStorage). |
| `src/components/SideMenu.vue` | Left menu (Daily labeled History). |
| `src/components/Filters.vue` | Date-range / account filter bar shared across pages. |
| `src/components/Calendar.vue` | Calendar grid cell renderer. |
| `src/components/AddOrderModal.vue` | Manual order entry modal. |
| `src/components/Screenshot.vue` | Single screenshot card. |
| `src/components/PlanSelector.vue` | Active-plan dropdown. |
| `src/components/PlanDepositsEditor.vue` / `PlanWithdrawalsEditor.vue` | Edit a plan's deposits / withdrawals. |
| `src/components/LoginRegister.vue` | Shared auth form. |
| `src/components/FpDate.vue` | Flatpickr date field wrapper. |
| `src/components/NoData.vue`, `SpinnerLoadingPage.vue`, `ReturnToTopButton.vue` | UI primitives. |
| `src/components/icons/*.vue` | Static SVG icons (upstream boilerplate). |

### Stores / utils
| File | Purpose |
|------|---------|
| `src/stores/globals.js` | Global reactive refs (currentUser, filters, selected ranges, mt5Accounts, etc.). Central shared state. |
| `src/stores/counter.js` | Upstream Pinia example (largely unused). |
| `src/utils/utils.js` | Core helpers: tab init, Parse init, current-user check, misc. |
| `src/utils/trades.js` | Fetch/filter trades (`useGetFilteredTrades`, `useGetTrades`, per-day filtering). |
| `src/utils/addTrades.js` | Build/insert trades from imports; dedupe against existing. |
| `src/utils/addOrder.js` | Forex pip/contract-size/PnL math for manual orders. |
| `src/utils/brokers.js` | Per-broker CSV parsers (TradeZero, MetaTrader5, Td Ameritrade, …). |
| `src/utils/calendar.js` | Build calendar P&L data. |
| `src/utils/charts.js` | ECharts helpers (line/double-line/pie renderers). |
| `src/utils/daily.js` | Daily satisfaction + daily-page data helpers. |
| `src/utils/weeklyGates.js` | Weekly discipline gates (Friday plan / Monday review / missing reflection) + the shared read-write helpers for week plan records. `loadWeekNotes()` is the unfiltered loader; `daily.js`'s `useGetWeekNotes()` drops weeks with no summary and no plan text. |
| `src/utils/dayFiles.js` | Upload/list/delete day-summary files (R2). Supports multiple files per day. |
| `src/utils/diary.js` | Diary CRUD (upload is fire-and-forget; errors only logged). |
| `src/utils/screenshots.js` | Screenshot fetch/paginate/scroll. |
| `src/utils/playbooks.js` | Playbook CRUD. |
| `src/utils/filters.js` | Filter state helpers. |
| `src/utils/planMath.js` | Plan projection math: `numOrNull`, `buildProjection`, compounding, `fmt`, `pnlClass`. |
| `src/utils/planStore.js` | Plan persistence + `activePlan` / `plans` reactive store. |
| `src/utils/r2.js` | Client helpers hitting backend R2 upload/delete; remote-image detection. |

### Assets
| File | Purpose |
|------|---------|
| `src/assets/base.css`, `main.css`, `style-dark.css` | Global + dark-theme styles. |

## `mcp-server/` — MCP + analysis engine

| File | Purpose |
|------|---------|
| `mcp-server/server.mjs` | MCP server entry. Tools: `get_trade_stats`, `find_behavior_patterns`, `list_trades`, `get_journal_notes`. |
| `mcp-server/analysis.mjs` | Pure analysis functions (shared with `index.mjs`): `flattenTrades`, `computeStats`, `findBehaviorPatterns` (revenge trading, overtrading by count/lots/oversized), `computeDailyBreakdown`, tz helpers (`localParts`, `dayInTz`). |
| `mcp-server/db.mjs` | Mongo connection for host-side tools. `resolveMongoUri()` (container vs host), `getDb()` (reconnect-safe), `fetchDayDocs`, `fetchTradesFingerprint`. |
| `mcp-server/inspect-schema.mjs` | One-off: dump collection shapes. |
| `mcp-server/test.mjs` | Unit checks for analysis functions. |
| `mcp-server/.env.example`, `package.json`, `README.md` | MCP config/deps/docs. |

## `mt5-sync/` — MetaTrader 5 sync

| File | Purpose |
|------|---------|
| `mt5-sync/mt5_sync.py` | Reads MT5 deals, maps to trades, buckets by trade tz, computes account financials (deposits/withdrawals as dated `cashFlows`), pushes to `POST /api/account` + trade import. Email notify is commented out. Two interchangeable backends (`pick_backend`), see below. |
| `mt5-sync/mql5/TradeNoteExport.mq5` | Read-only Expert Advisor. Runs inside the terminal and writes deals + account + open positions + balance ops to `<data folder>/MQL5/Files/tradenote_deals.json` every 15s and on each `OnTrade`. Temp-file-then-rename, so a reader never sees a partial write. |
| `mt5-sync/install-ea.sh` | Copies the EA into every MT5 `MQL5/Experts` folder found — normal, portable, and macOS Wine-bottle layouts. Compiling (F7) stays manual: MetaEditor's headless `/compile` does not work under MT5-for-Mac's Wine build. |
| `mt5-sync/config.example.ini` | Template (backend, login, server, TradeNote URL). Real `config.ini` + `state.json` gitignored. |
| `mt5-sync/templates/` | Chart templates (`.tpl`) exported from MT5, so the same chart setup restores on any machine. |

**Backends.** `NativeBackend` uses the `MetaTrader5` package — a Windows-only
wheel bound to `terminal64.dll`, so it cannot exist on macOS. `BridgeBackend`
reads the EA's JSON instead and works everywhere; it is what makes the sync run
on the Mac. Both expose the same methods (`account_info`, `history_deals_get`,
`positions_get`, …), so everything downstream is backend-agnostic. `import
MetaTrader5` is optional and the `DEAL_TYPE_*` enum values are defined locally,
otherwise importing the module would fail outright off Windows. The bridge treats
a file older than `BRIDGE_STALE_SECONDS` (90s) as "terminal not running", so a
closed terminal is never pushed as a zero-balance account.

## `backup/` + `scripts/`

| File | Purpose |
|------|---------|
| `backup/backup_to_r2.py` | Dump Mongo → parquet → R2 (connects `localhost:27017`). |
| `backup/restore_from_r2.py` | Pull latest parquet from R2 → restore into Mongo. |
| `scripts/r2-backup.sh` | Wrapper invoked by scheduled task / `stop.sh`. |
| `scripts/seed-mock-data.mjs`, `clear-mock-data.mjs`, `check-data.mjs` | Dev data seed / wipe / inspect. |
| `scripts/migrate-screenshots-to-r2.mjs` | One-off: move legacy screenshots into R2. |
| `scripts/install-mcp.sh` | Install/register the MCP server. |
| `scripts/update-atlas-ip.{sh,ps1}` | Whitelist current IP in MongoDB Atlas. |

## `brokers/`

CSV import templates + conversion notes for supported brokers.

## `codemirror-graphql/`

Vendored third-party GraphQL editor addon. **Not application code — ignore.**
