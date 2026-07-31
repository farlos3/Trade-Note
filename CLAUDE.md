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
  format with the trade tz (`dayInTz` in `mcp-server/analysis.mjs`). Order day comes
  from the position's **open time**.
- **Backend restart.** `index.mjs` is the Express + Parse backend. Frontend hot-reloads,
  but backend edits need:
  `docker compose -f docker-compose-dev.yml restart tradenote`
- **Dev stack.** `docker-compose-dev.yml` → `tradenote_app` (:8080) + `tradenote_mongo`
  (:27017). App connects over the compose network at `mongo:27017`; host tools use
  `localhost:27017`.

## Secrets — never commit

`.env`, `mt5-sync/config.ini`, `mt5-sync/state.json`, and `backup/data/` are gitignored.
Redact MongoDB URIs in output. Destructive DB ops (e.g. `deleteMany`) need explicit
user authorization.
