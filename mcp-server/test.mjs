#!/usr/bin/env node
/**
 * Self-test for the pure analysis logic. Uses synthetic day documents — no DB.
 * Run: node test.mjs
 */
import { flattenTrades, computeStats, findBehaviorPatterns, computeDailyBreakdown } from './analysis.mjs'
import { normalizeLang, headingsFor, buildSystemPrompt, deriveMetrics, HEADINGS } from './skills/behavior-coach.mjs'

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

// --- Daily breakdown (plan vs actual) ---
const daily1 = computeDailyBreakdown(trades)
check('daily: one row for the single day', daily1.length === 1)
check('daily: net = -70 (sum of the day)', approx(daily1[0].net, -70))
check('daily: 5 trades on that day', daily1[0].trades === 5)
check('daily: date is the day of the doc', daily1[0].date === D1)

const daily2 = computeDailyBreakdown(multi)
check('daily: three rows for three days', daily2.length === 3)
check('daily: sorted oldest first', daily2[0].date === '2026-02-02' && daily2[2].date === '2026-02-04')
check('daily: trades per day 5/1/1', daily2.map(d => d.trades).join(',') === '5,1,1')
check('daily: net per day 25/5/5', daily2.map(d => d.net).join(',') === '25,5,5')
check('daily: empty input -> []', computeDailyBreakdown([]).length === 0)

// --- Empty input is safe ---
const empty = computeStats(flattenTrades([]), 'UTC')
check('empty -> 0 trades, winRate 0', empty.trades === 0 && empty.winRate === 0)


// --- Behaviour-coach skill: language + derived figures ---
check('lang: th and en are accepted', normalizeLang('th') === 'th' && normalizeLang('EN') === 'en')
check('lang: unknown or missing falls back to en',
  normalizeLang('fr') === 'en' && normalizeLang(undefined) === 'en' && normalizeLang('') === 'en')
check('headings: four per language, same count',
  HEADINGS.en.length === 4 && HEADINGS.th.length === 4)
check('headings: no heading is empty or shared between languages',
  HEADINGS.th.every((h, i) => h && h !== HEADINGS.en[i]))

const enPrompt = buildSystemPrompt({ lang: 'en' })
const thPrompt = buildSystemPrompt({ lang: 'th' })
check('prompt(en): asks for English and lists the English headings',
  enPrompt.includes('write the whole reply in English') && headingsFor('en').every((h) => enPrompt.includes(h)))
check('prompt(th): asks for Thai and lists the Thai headings',
  thPrompt.includes('Thai (ภาษาไทย)') && headingsFor('th').every((h) => thPrompt.includes(h)))
check('prompt(th): does not also demand English output',
  !thPrompt.includes('write the whole reply in English'))
check('prompt(en): English headings only, none of the Thai ones leak in',
  headingsFor('th').every((h) => !enPrompt.includes(h)))
check('prompt: default language is English', buildSystemPrompt() === enPrompt)
check('prompt: forbids Markdown in both languages',
  enPrompt.includes('plain text only') && thPrompt.includes('plain text only'))
check('prompt: tells the model not to call a net-positive flag a leak',
  enPrompt.includes('net POSITIVE') && thPrompt.includes('net POSITIVE'))

// Worked example from a real window: avg win 14.50, avg loss 9.84, win rate 43.4%.
const dm = deriveMetrics(
  { avgWin: 14.5, avgLoss: 9.84, winRate: 0.434, netPnL: 55.33 },
  { overtrading: { netOnFlaggedDays: -29.69 } })
check('derive: break-even win rate = loss / (win + loss) = 0.404', dm.breakEvenWinRate === 0.404)
check('derive: payoff ratio = 1.47', dm.payoffRatio === 1.47)
check('derive: edge margin is +3.0 points above break-even', dm.edgeMargin === 3)
check('derive: net without flagged days = 55.33 - (-29.69) = 85.02', dm.netWithoutFlaggedDays === 85.02)
const below = deriveMetrics({ avgWin: 17.08, avgLoss: 19.76, winRate: 0.521, netPnL: -448.93 }, null)
check('derive: a payoff under 1 puts break-even above 50% and the margin negative',
  below.breakEvenWinRate > 0.5 && below.edgeMargin < 0)
check('derive: a missing average gives nulls, never a guess',
  deriveMetrics({ avgWin: 0, avgLoss: 5, winRate: 0.5, netPnL: 1 }, null).breakEvenWinRate === null)
check('derive: no stats gives null figures and empty thin-bucket lists',
  deriveMetrics(null, null).breakEvenWinRate === null &&
  deriveMetrics(null, null).thinBuckets.byEntryHour.length === 0)
const thin = deriveMetrics({
  avgWin: 1, avgLoss: 1, winRate: 0.5, netPnL: 0,
  byEntryHour: { '12:00': { count: 4 }, '19:00': { count: 10 }, '13:00': { count: 6 } },
  byWeekday: { Fri: { count: 12 }, Sat: { count: 4 } },
  bySymbol: { XAUUSD: { count: 78 } },
}, null).thinBuckets
check('derive: under 10 trades is thin; exactly 10 is not',
  thin.byEntryHour.join() === '12:00,13:00' && thin.byWeekday.join() === 'Sat' && thin.bySymbol.length === 0)
check('prompt: points the model at the thin-bucket list',
  enPrompt.includes('derived.thinBuckets') && thPrompt.includes('derived.thinBuckets'))
check('prompt: keeps the per-trade lot cap and the daily volume flag apart',
  enPrompt.includes('lotCap is a ceiling on ONE trade') && enPrompt.includes('does not belong under the watch-outs'))
check('prompt: forbids quoting JSON field names',
  enPrompt.includes('never by') && enPrompt.includes('JSON field names'))

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
