#!/usr/bin/env node
/**
 * Self-test for the pure analysis logic. Uses synthetic day documents — no DB.
 * Run: node test.mjs
 */
import { flattenTrades, computeStats, findBehaviorPatterns } from './analysis.mjs'

let failures = 0
const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

const U = (iso) => Math.floor(Date.parse(iso) / 1000)
const mk = (o) => ({
  id: o.id, symbol: o.symbol ?? 'EURUSD', strategy: o.dir ?? 'long',
  entryTime: U(o.entry), exitTime: U(o.exit),
  entryPrice: 1, exitPrice: 1, buyQuantity: o.size ?? 1, sellQuantity: o.size ?? 1,
  grossProceeds: o.net, netProceeds: o.net, commission: 0,
})

// --- Dataset 1: one day, 5 trades ---
const D1 = '2026-01-05'
const day1 = {
  dateUnix: U(D1 + 'T00:00:00Z'),
  trades: [
    mk({ id: 'A', entry: `${D1}T10:00:00Z`, exit: `${D1}T10:03:00Z`, net: -40, size: 1 }),
    mk({ id: 'B', entry: `${D1}T10:08:00Z`, exit: `${D1}T10:12:00Z`, net: -30, size: 2 }),
    mk({ id: 'C', entry: `${D1}T11:00:00Z`, exit: `${D1}T11:30:00Z`, net: 60, size: 1 }),
    mk({ id: 'D', entry: `${D1}T11:35:00Z`, exit: `${D1}T11:36:00Z`, net: 20, size: 1 }),
    mk({ id: 'E', entry: `${D1}T12:00:00Z`, exit: `${D1}T13:00:00Z`, net: -80, size: 1 }),
  ],
}

const trades = flattenTrades([day1])
check('flatten -> 5 trades', trades.length === 5)
check('flatten sorted by entryTime', trades[0].id === 'A' && trades[4].id === 'E')

const s = computeStats(trades, 'UTC')
check('winRate 0.4', approx(s.winRate, 0.4))
check('netPnL -70', approx(s.netPnL, -70))
check('grossProfit 80', approx(s.grossProfit, 80))
check('grossLoss 150', approx(s.grossLoss, 150))
check('profitFactor 0.53', approx(s.profitFactor, 0.53))
check('avgWin 40', approx(s.avgWin, 40))
check('avgLoss 50', approx(s.avgLoss, 50))
check('expectancy -14', approx(s.expectancy, -14))
check('bySymbol has EURUSD', s.bySymbol.EURUSD?.count === 5)

const b = findBehaviorPatterns(trades, { revengeWindowMinutes: 15, tz: 'UTC' })
check('revenge count 1 (B after A, 5min gap)', b.revengeTrading.count === 1)
check('revenge example is B', b.revengeTrading.examples[0]?.trade.symbol === 'EURUSD' && approx(b.revengeTrading.examples[0].gapMinutes, 5))
check('sizing avgAfterLoss 1.5', approx(b.positionSizingTilt.avgSizeAfterLoss, 1.5))
check('sizing avgAfterWin 1.0', approx(b.positionSizingTilt.avgSizeAfterWin, 1.0))
check('sizing tilt flagged', b.positionSizingTilt.flag != null)
check('holding: losers held longer, flagged', b.holdingTimeBias.flag != null)
check('holding ratio > 1', b.holdingTimeBias.ratio > 1)

// --- Dataset 2: three days (5,1,1) to exercise overtrading ---
const mkDay = (iso, n) => ({
  dateUnix: U(iso + 'T00:00:00Z'),
  trades: Array.from({ length: n }, (_, i) =>
    mk({ id: `${iso}-${i}`, entry: `${iso}T1${i}:00:00Z`, exit: `${iso}T1${i}:05:00Z`, net: 5, size: 1 })),
})
const multi = flattenTrades([mkDay('2026-02-02', 5), mkDay('2026-02-03', 1), mkDay('2026-02-04', 1)])
const b2 = findBehaviorPatterns(multi, { tz: 'UTC' })
check('overtrading median 1', b2.overtrading.medianTradesPerDay === 1)
check('overtrading flags 1 day (the 5-trade day)', b2.overtrading.flaggedDays === 1)
check('overtrading flagged day has 5 trades', b2.overtrading.days[0]?.trades === 5)

// --- Empty input is safe ---
const empty = computeStats(flattenTrades([]), 'UTC')
check('empty -> 0 trades, winRate 0', empty.trades === 0 && empty.winRate === 0)

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
