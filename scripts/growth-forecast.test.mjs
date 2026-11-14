#!/usr/bin/env node
/**
 * Unit tests for src/utils/growthForecast.js — pure Node, no DB or browser.
 * Run: node scripts/growth-forecast.test.mjs
 */
import {
    reconstructActualSeries,
    analyzeDailyResults,
    buildGrowthForecast,
} from '../src/utils/growthForecast.js'

let failures = 0
const approx = (a, b, eps = 0.05) => Math.abs(a - b) <= eps
function check(name, cond, detail = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ' — ' + detail : ''}`)
    if (!cond) failures++
}

// 1. Empty input safety
check('empty daily -> reconstruct returns null', reconstructActualSeries({ daily: [] }) === null)
check('empty daily -> analyze returns null', analyzeDailyResults([]) === null)
check('null summary -> forecast returns null', buildGrowthForecast({ summary: null }) === null)

// 2. Historical equity reconstruction anchored at liveBalance with cash flows
const sampleDaily = [
    { date: '2026-04-01', net: 100, trades: 2 },
    { date: '2026-04-02', net: -50, trades: 1 },
    { date: '2026-04-03', net: 150, trades: 3 },
    { date: '2026-04-06', net: 80, trades: 2 },
    { date: '2026-04-07', net: 120, trades: 2 },
]
// Net trading P&L = 400. Suppose a $200 deposit on 2026-04-03 and $100 withdrawal on 2026-04-07.
// Starting equity before 04-01 was 1000 -> 04-01: 1100, 04-02: 1050, 04-03: 1050+150+200 = 1400,
// 04-04/05 (weekend): 1400, 04-06: 1480, 04-07: 1480+120-100 = 1500.
const unixOf = (iso) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000)
const eq = reconstructActualSeries({
    daily: sampleDaily,
    cashFlows: [
        { type: 'deposit', t: unixOf('2026-04-03'), amount: 200 },
        { type: 'withdrawal', t: unixOf('2026-04-07'), amount: 100 },
    ],
    liveBalance: 1500,
    startBalance: 1000,
    tz: 'UTC',
    today: '2026-04-07',
})
check('reconstruct produces 7 calendar days (Apr 1..7)', eq && eq.dates.length === 7)
check('reconstruct anchors first day closing at 1100', approx(eq.actual[0], 1100))
check('reconstruct anchors last day closing at liveBalance 1500', approx(eq.actual[6], 1500))
check('cumActual excludes cash flows and equals +400', approx(eq.cumActual[6], 400))
check('dayActual is null on weekend', eq.dayActual[3] === null && eq.dayActual[4] === null)
check('openingByDate on 2026-04-01 is 1000', approx(eq.openingByDate.get('2026-04-01'), 1000))
// On 2026-04-03: prev closing 1050 + deposit 200 = 1250 capital base; closing 1400 - net 150 = 1250
check('openingByDate on deposit day 2026-04-03 includes deposit (1250)', approx(eq.openingByDate.get('2026-04-03'), 1250))

// 3. Empirical daily performance analysis
const summary = analyzeDailyResults(sampleDaily, eq.openingByDate, eq.currentBalance)
check('tradedDays = 5', summary.tradedDays === 5)
check('winDays = 4, lossDays = 1', summary.winDays === 4 && summary.lossDays === 1)
check('meanNet = 80', approx(summary.meanNet, 80))
check('medianNet = 100', approx(summary.medianNet, 100))
check('dailyProfitFactor = (100+150+80+120)/50 = 9.0', approx(summary.dailyProfitFactor, 9.0))
check('activeDayRatio across 5 weekdays (Apr 1..7 has Wed,Thu,Fri,Mon,Tue = 5 weekdays) is 1.0',
    approx(summary.activeDayRatio, 1.0))

// 4. Sparse trader cadence (e.g. 2 traded days over 10 weekdays -> ~0.2 ratio = 1 day/week)
const sparseDaily = [
    { date: '2026-04-01', net: 50, trades: 1 },
    { date: '2026-04-14', net: 50, trades: 1 },
]
const sparseSummary = analyzeDailyResults(sparseDaily, null, 1000)
check('sparse trader activeDayRatio = 0.2 (2 / 10 weekdays)', approx(sparseSummary.activeDayRatio, 0.2))
check('sparse trader tradedDaysPerWeek = 1.0', approx(sparseSummary.tradedDaysPerWeek, 1.0))

// 5. Forecast determinism & band ordering (P10 <= P50 <= P90)
const f1 = buildGrowthForecast({
    summary,
    currentBalance: 1500,
    horizonMonths: 3,
    mode: 'compound',
    paceBasis: 'mean',
    monthlyCost: 30,
    includeCosts: true,
    goalBalance: 3000,
    anchorDate: '2026-04-07',
    simCount: 300,
})
const f2 = buildGrowthForecast({
    summary,
    currentBalance: 1500,
    horizonMonths: 3,
    mode: 'compound',
    paceBasis: 'mean',
    monthlyCost: 30,
    includeCosts: true,
    goalBalance: 3000,
    anchorDate: '2026-04-07',
    simCount: 300,
})
check('forecast is deterministic across calls', f1.endExpected === f2.endExpected && f1.endP50 === f2.endP50)
check('band ordering P10 <= P50 <= P90 at horizon end', f1.endP10 <= f1.endP50 && f1.endP50 <= f1.endP90)
check('positive edge yields endExpected > startBalance', f1.endExpected > 1500)
check('cost drag deducted (~$90 over 3 months)', f1.totalCostDrag > 80 && f1.totalCostDrag < 100)
check('expectedGoalEta finds a hit date before horizon end', f1.expectedGoalEta !== null && !f1.expectedGoalEta.already)

// 6. Linear fixed $/day mode & negative losing expectancy
const losingDaily = [
    { date: '2026-04-01', net: -40, trades: 2 },
    { date: '2026-04-02', net: -20, trades: 1 },
    { date: '2026-04-03', net: 10, trades: 1 },
]
const losingSummary = analyzeDailyResults(losingDaily, null, 500)
const losingForecast = buildGrowthForecast({
    summary: losingSummary,
    currentBalance: 500,
    horizonMonths: 1,
    mode: 'linear',
    paceBasis: 'mean',
    includeCosts: false,
    goalBalance: 1000,
    anchorDate: '2026-04-03',
})
check('losing linear forecast projects decline', losingForecast.endExpected < 500)
check('losing forecast cannot reach higher goal', losingForecast.expectedGoalEta === null)
check('compound mode stays >= 0 even on negative balance input -> falls back to linear', (() => {
    const fNeg = buildGrowthForecast({
        summary: losingSummary,
        currentBalance: -100,
        horizonMonths: 1,
        mode: 'compound',
        anchorDate: '2026-04-03',
    })
    return fNeg.effectiveMode === 'linear'
})())

// 7. Single-day edge case
const oneDaySummary = analyzeDailyResults([{ date: '2026-04-07', net: 25, trades: 1 }], null, 500)
const oneDayForecast = buildGrowthForecast({
    summary: oneDaySummary,
    currentBalance: 500,
    horizonMonths: 1,
    mode: 'compound',
    anchorDate: '2026-04-07',
})
check('single traded day produces valid forecast with sampleConfidence=low',
    oneDaySummary.sampleConfidence === 'low' && oneDayForecast.endExpected > 500 && oneDayForecast.endP10 === oneDayForecast.endP90)

// 8. Stationary Block Bootstrap metadata, time-weighted recent tail retention & drawdown quantiles
const streakDaily = [
    { date: '2026-04-01', net: -250, trades: 2 },
    { date: '2026-04-02', net: -150, trades: 2 },
    { date: '2026-04-03', net: -100, trades: 1 },
    { date: '2026-04-06', net: 40, trades: 1 },
    { date: '2026-04-07', net: 50, trades: 1 },
    { date: '2026-04-08', net: 45, trades: 1 },
    { date: '2026-04-09', net: 60, trades: 1 },
    { date: '2026-04-10', net: 55, trades: 1 },
    { date: '2026-04-13', net: 70, trades: 1 },
    { date: '2026-04-14', net: 65, trades: 1 },
]
const streakSummary = analyzeDailyResults(streakDaily, null, 1000)
const recentWeightedFc = buildGrowthForecast({
    summary: streakSummary,
    currentBalance: 1000,
    horizonMonths: 3,
    mode: 'compound',
    paceBasis: 'recent',
    anchorDate: '2026-04-14',
})
check('default simCount is 1000 with stationary-block metadata',
    recentWeightedFc.bootstrapMeta?.method === 'stationary-block' &&
    recentWeightedFc.bootstrapMeta?.simCount === 1000 &&
    recentWeightedFc.bootstrapMeta?.avgBlockDays >= 2 &&
    recentWeightedFc.bootstrapMeta?.timeWeighted === true)
check('recent mode retains old tail losses via time-weighting (probProfit < 100 & P90 DD > 0)',
    recentWeightedFc.probProfit < 100 && recentWeightedFc.maxDrawdownP90Pct > 0)
check('pathwise drawdown ordering 0 <= P50 DD <= P90 DD <= 100',
    recentWeightedFc.maxDrawdownP50Pct >= 0 &&
    recentWeightedFc.maxDrawdownP50Pct <= recentWeightedFc.maxDrawdownP90Pct &&
    recentWeightedFc.maxDrawdownP90Pct <= 100)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
