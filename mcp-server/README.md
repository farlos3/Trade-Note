# TradeNote MCP server — AI trading-behavior analysis

A small [MCP](https://modelcontextprotocol.io) server that exposes your TradeNote
trades (from MongoDB Atlas) as read-only tools, so an AI agent — **Claude Desktop**
or **Claude Code** — can analyze not just your win rate but your *behavior*:
revenge trading, overtrading, position-size tilt, and holding-time asymmetry.

```
Claude Desktop / Code ──MCP──► this server ──read──► MongoDB Atlas (trades, notes)
   (the analyst)                (4 tools)             (your journal data)
```

## Tools

| Tool | What it returns |
|------|-----------------|
| `get_trade_stats` | Win rate, profit factor, expectancy, avg win/loss; breakdowns by symbol, weekday, entry hour |
| `find_behavior_patterns` | Revenge trades, overtrading days, size-up-after-loss tilt, holding losers longer than winners |
| `list_trades` | Individual round-trip trades (filter by symbol / outcome / date range) |
| `get_journal_notes` | Your written reasons and review notes, to tie behavior to your own commentary |

All tools are **read-only** — the server never writes to the database.

## Prerequisites

- **Node.js 18+**
- The project's `MONGO_URI` (the server reads the repo-root `.env` automatically)
- Your machine's public IP whitelisted in Atlas. This project already automates
  that: run `./start.sh --ip-only` (or `.\scripts\update-atlas-ip.ps1`).

## Install

```bash
cd mcp-server
npm install
```

Quick check it runs (Ctrl-C to stop — it waits for an MCP client on stdio):

```bash
npm start
```

## Connect to Claude Desktop

Edit the config file (create it if missing):

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tradenote": {
      "command": "node",
      "args": ["ABSOLUTE/PATH/TO/TradeNote/mcp-server/server.mjs"],
      "env": {
        "TRADENOTE_TZ": "Asia/Bangkok"
      }
    }
  }
}
```

Use the **absolute** path to `server.mjs`. `MONGO_URI` is picked up from the repo
`.env` automatically (the server resolves it relative to its own location), so you
don't need to repeat the secret here — but you *can* put it under `env` to override.

Restart Claude Desktop. A 🔌/tools icon appears; ask away.

## Connect to Claude Code

```bash
claude mcp add tradenote -- node ABSOLUTE/PATH/TO/TradeNote/mcp-server/server.mjs
```

## Configuration (env, all optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `MONGO_URI` | from `../.env` | Atlas connection string |
| `TRADENOTE_USER` | (all trades) | Restrict to one account (username/email) |
| `TRADENOTE_TZ` | `UTC` | IANA tz for weekday / entry-hour grouping, e.g. `Asia/Bangkok` |

## Example prompts

- "วิเคราะห์พฤติกรรมการเทรดของฉันเดือนนี้ มีนิสัยเสียอะไรบ้าง"
- "Do I revenge trade? Show the trades where it happened and what it cost me."
- "Compare my win rate on XAUUSD vs other symbols, and by weekday."
- "Am I holding losers longer than winners? Tie it to my journal notes."

The agent calls the tools, pulls your real numbers, and reasons over them.

## Privacy & safety

- **Read-only.** No tool can modify or delete trades.
- Trade *summaries* are sent to Claude as context during analysis (inherent to
  using an LLM). Secrets like API keys are never exposed by these tools.
- Data lives in your own Atlas cluster; this server just reads it.

## Development

```bash
npm test              # unit-tests the analysis logic with synthetic data (no DB)
npm run inspect-schema  # prints the real trades/notes schema from your DB
```
