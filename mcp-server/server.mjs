#!/usr/bin/env node
/**
 * TradeNote MCP server.
 *
 * Exposes read-only tools over your TradeNote trades (MongoDB Atlas) so an MCP
 * client (Claude Desktop / Claude Code) can analyze your trading *behavior* —
 * not just win rate, but revenge trading, overtrading, position-size tilt, and
 * holding-time asymmetry.
 *
 * Config (env or ../.env): MONGO_URI (required), TRADENOTE_USER (optional
 * username/email to scope to one account), TRADENOTE_TZ (optional IANA tz for
 * weekday/hour breakdowns, default UTC).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { fetchDayDocs, fetchNotes, readEnv, closeDb } from './db.mjs'
import { flattenTrades, computeStats, findBehaviorPatterns } from './analysis.mjs'

const TZ = readEnv('TRADENOTE_TZ') || 'UTC'

/** "YYYY-MM-DD" -> unix seconds (UTC midnight). Undefined passes through. */
function isoToUnix(s) {
  if (!s) return undefined
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s)
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${s} (use YYYY-MM-DD)`)
  return Math.floor(ms / 1000)
}

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

const server = new McpServer({ name: 'tradenote', version: '0.1.0' })

server.registerTool(
  'get_trade_stats',
  {
    title: 'Trade statistics',
    description:
      'Headline performance stats for a date range: win rate, profit factor, ' +
      'expectancy, avg win/loss, plus breakdowns by symbol, weekday, and entry hour. ' +
      'Dates are YYYY-MM-DD; omit both for all-time.',
    inputSchema: { from: dateArg, to: dateArg },
  },
  async ({ from, to }) => {
    const days = await fetchDayDocs({ fromUnix: isoToUnix(from), toUnix: isoToUnix(to) })
    const trades = flattenTrades(days)
    return json({ range: { from: from ?? null, to: to ?? null }, timezone: TZ, ...computeStats(trades, TZ) })
  },
)

server.registerTool(
  'find_behavior_patterns',
  {
    title: 'Behavioral red-flags',
    description:
      'Detects behavioral leaks that headline stats hide: revenge trading ' +
      '(re-entering soon after a loss), overtrading days, position-size tilt ' +
      '(sizing up after losses), and holding-time asymmetry (holding losers ' +
      'longer than winners). Dates YYYY-MM-DD; omit for all-time.',
    inputSchema: {
      from: dateArg,
      to: dateArg,
      revenge_window_minutes: z.number().int().positive().max(240).optional(),
    },
  },
  async ({ from, to, revenge_window_minutes }) => {
    const days = await fetchDayDocs({ fromUnix: isoToUnix(from), toUnix: isoToUnix(to) })
    const trades = flattenTrades(days)
    const report = findBehaviorPatterns(trades, {
      revengeWindowMinutes: revenge_window_minutes ?? 15,
      tz: TZ,
    })
    return json({ range: { from: from ?? null, to: to ?? null }, totalTrades: trades.length, ...report })
  },
)

server.registerTool(
  'list_trades',
  {
    title: 'List trades',
    description:
      'List individual round-trip trades, most recent first. Optional filters: ' +
      'symbol, outcome ("win"|"loss"), and a date range. Use to inspect specific ' +
      'trades behind a pattern. Dates YYYY-MM-DD.',
    inputSchema: {
      from: dateArg,
      to: dateArg,
      symbol: z.string().optional(),
      outcome: z.enum(['win', 'loss']).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  },
  async ({ from, to, symbol, outcome, limit }) => {
    const days = await fetchDayDocs({ fromUnix: isoToUnix(from), toUnix: isoToUnix(to) })
    let trades = flattenTrades(days)
    if (symbol) trades = trades.filter((t) => t.symbol.toUpperCase() === symbol.toUpperCase())
    if (outcome === 'win') trades = trades.filter((t) => t.pnl > 0)
    if (outcome === 'loss') trades = trades.filter((t) => t.pnl < 0)
    trades.sort((a, b) => b.entryTime - a.entryTime)
    const sliced = trades.slice(0, limit ?? 50).map((t) => ({
      ...t,
      entry: t.entryTime ? new Date(t.entryTime * 1000).toISOString() : null,
      exit: t.exitTime ? new Date(t.exitTime * 1000).toISOString() : null,
    }))
    return json({ matched: trades.length, returned: sliced.length, trades: sliced })
  },
)

server.registerTool(
  'get_journal_notes',
  {
    title: 'Journal notes',
    description:
      'Your written review notes and reasons for trades in a date range, so ' +
      'behavior can be tied to your own commentary. Dates YYYY-MM-DD.',
    inputSchema: {
      from: dateArg,
      to: dateArg,
      limit: z.number().int().positive().max(300).optional(),
    },
  },
  async ({ from, to, limit }) => {
    const notes = await fetchNotes({ fromUnix: isoToUnix(from), toUnix: isoToUnix(to) })
    const rows = notes.slice(0, limit ?? 100).map((n) => ({
      date: n.dateUnix ? new Date(n.dateUnix * 1000).toISOString().slice(0, 10) : null,
      tradeId: n.tradeId ?? null,
      reason: n.reason ?? null,
      note: n.note ?? null,
    }))
    return json({ count: notes.length, returned: rows.length, notes: rows })
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await closeDb(); process.exit(0) })
}
