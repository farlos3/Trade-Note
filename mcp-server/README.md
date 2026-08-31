# TradeNote MCP server — AI trading-behavior analysis

A small [MCP](https://modelcontextprotocol.io) server that exposes your TradeNote
trades as read-only tools, so an AI agent — **Claude Desktop** or **Claude Code** —
can analyze not just your win rate but your *behavior*: revenge trading,
overtrading, position-size tilt, and holding-time asymmetry.

```
Claude Desktop / Code ──MCP──► this server ──read──► local MongoDB (trades, notes)
   (the analyst)                (4 tools)             (your journal data)
```

The TradeNote web app shows the same flags on its **AI Analysis** page, computed
by the same rules. What the agent adds is interpretation: tying the numbers to
your journal notes and answering follow-up questions.

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
- The project running (`./tradenote.sh start`), so MongoDB is up — the tools read from it
  live. Stop the project and the tools return nothing.

## Install (macOS and Windows)

One command registers the server with Claude Desktop on either platform:

```bash
./scripts/install-mcp.sh          # install / update
./scripts/install-mcp.sh --print  # show what it would write, change nothing
./scripts/install-mcp.sh --remove # take it back out
```

It finds Claude Desktop's config for your platform, runs `npm install` if the
dependencies are missing, **merges** the entry (any other MCP servers you have
are left alone), and keeps the previous file as `.bak`. On Windows it converts
the Git Bash path to a native one, since Claude Desktop is not a Git Bash
process. Then quit Claude Desktop **completely** and reopen it — the config is
read once at startup.

> The server runs on the host, so it connects to MongoDB on `localhost:27017`,
> not the `mongo:27017` in `.env` — that hostname only resolves inside the
> Docker network. `db.mjs` rewrites it, and the installer sets `MCP_MONGO_URI`
> explicitly. Override that variable for a different database.

## Connect to Claude Desktop by hand

Only needed if you'd rather not use the installer. Edit the config file
(create it if missing):

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
| `MCP_MONGO_URI` | rewritten `MONGO_URI` | Connection string for this server. Set it to point somewhere else. |
| `MONGO_URI` | from `../.env` | The app's connection string; its `mongo:` host is rewritten to `localhost` here |
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
- Data lives in your own local MongoDB; this server just reads it.

## Development

```bash
npm test              # unit-tests the analysis logic with synthetic data (no DB)
npm run inspect-schema  # prints the real trades/notes schema from your DB
```
