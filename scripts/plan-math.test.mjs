#!/usr/bin/env node
/**
 * Unit tests for per-trade projection & risk lot calculator in src/utils/planMath.js.
 * Run: node scripts/plan-math.test.mjs
 */
import {
    pipSizeFor,
    contractSizeFor,
    pipValuePerLot,
    buildTradeProjection,
    requiredPctPerTrade,
    requiredAmountPerTrade,
    tradesToGoal,
    calculateRiskLot,
    trackTradesAgainstPlan,
} from '../src/utils/planMath.js'

let failures = 0
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps
function check(name, cond, detail = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ' — ' + detail : ''}`)
    if (!cond) failures++
}

// 1. Symbol specs (synced with addOrder.js)
check('XAUUSD spec -> pip 0.01, contract 100, $1/pip/lot',
    pipSizeFor('XAUUSD') === 0.01 && contractSizeFor('XAUUSD') === 100 && pipValuePerLot('XAUUSD') === 1)
check('USA100 spec -> pip 1, contract 1, $1/pt/lot',
    pipSizeFor('USA100') === 1 && contractSizeFor('USA100') === 1 && pipValuePerLot('USA100') === 1)
check('BTCUSD spec -> pip 1, contract 1, $1/pt/lot',
    pipSizeFor('BTCUSD') === 1 && contractSizeFor('BTCUSD') === 1 && pipValuePerLot('BTCUSD') === 1)
check('EURUSD spec -> pip 0.0001, contract 100000, $10/pip/lot',
    pipSizeFor('EURUSD') === 0.0001 && contractSizeFor('EURUSD') === 100000 && approx(pipValuePerLot('EURUSD'), 10))
check('XAGUSD spec -> pip 0.001, contract 1000, $1/pip/lot',
    pipSizeFor('XAGUSD') === 0.001 && contractSizeFor('XAGUSD') === 1000 && approx(pipValuePerLot('XAGUSD'), 1))

// 2. Per-trade projection: goal-driven without numTrades
const pGoal = buildTradeProjection({ start: 1000, pctPerTrade: 10, goalBalance: 2000 })
check('1000 -> 2000 at 10%/trade hits goal on trade #8',
    pGoal && pGoal.goalTrades === 8 && pGoal.tradeCount === 8 && pGoal.reachedGoal === true)
check('trade #8 closing equals 1000 * 1.1^8',
    pGoal && approx(pGoal.finalBalance, 1000 * Math.pow(1.1, 8), 0.01))

// 3. Per-trade projection: fixed numTrades that stops before goal, still reports goalTrades
const pFixed = buildTradeProjection({ start: 1000, pctPerTrade: 10, numTrades: 5, goalBalance: 2000 })
check('fixed 5 trades reports tradeCount=5 and probes goalTrades=8',
    pFixed && pFixed.tradeCount === 5 && pFixed.goalTrades === 8 && pFixed.reachedGoal === true)

// 4. Per-trade projection: flat $ amount mode
const pAmt = buildTradeProjection({ start: 1000, tradeAmount: 100, goalBalance: 1500 })
check('flat $100/trade from 1000 to 1500 takes exactly 5 trades',
    pAmt && pAmt.goalTrades === 5 && pAmt.tradeCount === 5 && approx(pAmt.finalBalance, 1500))

// 5. Per-trade projection: stepped tiers
const pTier = buildTradeProjection({
    start: 1000,
    pctPerTrade: 20,
    numTrades: 2,
    tiers: [{ from: 1200, pct: 10 }],
})
// Trade 1: 1000 -> 1200 (20%); Trade 2: 1200 -> 1320 (10%)
check('stepped trade tier switches rate once balance hits threshold',
    pTier && approx(pTier.trades[0].closing, 1200) && approx(pTier.trades[1].closing, 1320))

// 6. Goal seek helpers
const reqPct = requiredPctPerTrade(1000, 2000, 8)
check('requiredPctPerTrade(1000, 2000, 8) ~ 9.05077%',
    reqPct != null && approx(reqPct, (Math.pow(2, 1 / 8) - 1) * 100, 1e-4))
check('requiredAmountPerTrade(1000, 2000, 8) = 125',
    approx(requiredAmountPerTrade(1000, 2000, 8), 125))
const ttg = tradesToGoal({ start: 1000, goal: 2000, pctPerTrade: 10 })
check('tradesToGoal returns 8 trades', ttg && ttg.trades === 8 && !ttg.already)
const ttgAlready = tradesToGoal({ start: 2000, goal: 1500, pctPerTrade: 10 })
check('tradesToGoal when already at goal returns already=true', ttgAlready && ttgAlready.trades === 0 && ttgAlready.already)

// 7. Invalid inputs guard
check('invalid inputs -> null',
    buildTradeProjection({ start: 0, pctPerTrade: 5, goalBalance: 1000 }) === null &&
    buildTradeProjection({ start: 1000, pctPerTrade: 0, goalBalance: 2000 }) === null &&
    buildTradeProjection({ start: 1000, pctPerTrade: 5 }) === null)

// 8. Risk & Lot Size calculator
const rXau = calculateRiskLot({ balance: 1000, riskMode: 'pct', riskPercent: 2, slPips: 200, symbol: 'XAUUSD' })
// Risk = $20, 200 pips * $1/pip/lot = $200/lot -> 0.10 lot
check('XAUUSD 2% of $1000 over 200 pips -> 0.10 lot, actualRisk=$20',
    rXau && approx(rXau.flooredLot, 0.10) && approx(rXau.actualRiskDollars, 20) && !rXau.belowMin)

const rUsa100 = calculateRiskLot({ riskMode: 'amount', riskAmount: 50, slPips: 100, symbol: 'USA100' })
// Risk = $50, 100 pts * $1/pt/lot -> 0.50 lot
check('USA100 $50 risk over 100 pts -> 0.50 lot',
    rUsa100 && approx(rUsa100.flooredLot, 0.50) && approx(rUsa100.actualRiskDollars, 50))

const rFloor = calculateRiskLot({ riskMode: 'amount', riskAmount: 19, slPips: 1000, symbol: 'XAUUSD' })
// exact 0.019 -> floored 0.01 -> actualRisk = $10
check('floored down to 0.01 never exceeds risk ($19 -> 0.01 lot = $10)',
    rFloor && approx(rFloor.exactLot, 0.019) && approx(rFloor.flooredLot, 0.01) && approx(rFloor.actualRiskDollars, 10))

const rBelowMin = calculateRiskLot({ riskMode: 'amount', riskAmount: 5, slPips: 1000, symbol: 'XAUUSD' })
check('below 0.01 min lot sets belowMin=true and maxSlAtMinLot=500',
    rBelowMin && rBelowMin.belowMin === true && approx(rBelowMin.maxSlAtMinLot, 500))

const rCustom = calculateRiskLot({
    balance: 1000, riskMode: 'pct', riskPercent: 1, slPips: 50, symbol: 'USDJPY', pipValueOverride: 6.5,
})
// $10 / (50 * 6.5) = 10 / 325 = 0.03076 -> floored 0.03 -> actual risk 0.03*325 = 9.75
check('custom pipValueOverride overrides symbol spec',
    rCustom && rCustom.isCustomPipValue && approx(rCustom.flooredLot, 0.03) && approx(rCustom.actualRiskDollars, 9.75))

const r2 = rXau.rrTable.find((x) => x.rr === 2)
check('R:R 1:2 table row computes TP=400 pips, Profit=$40, NewBalance=1040',
    r2 && approx(r2.tpPips, 400) && approx(r2.profitDollars, 40) && approx(r2.projectedBalance, 1040))

// 9. History-to-Plan tracking (trackTradesAgainstPlan)
const projTrack = buildTradeProjection({ start: 1000, pctPerTrade: 10, goalBalance: 1400 })
// 2026-05-01 00:00Z = 1777593600, 2026-05-02 10:00Z = 1777716000, 2026-05-03 10:00Z = 1777802400
const sampleDocs = [
    {
        dateUnix: 1777593600, // 2026-05-01 (before startDate 2026-05-02)
        account: 'MT5_A',
        trades: [
            { id: 'old1', symbol: 'XAUUSD', netProceeds: 50, exitTime: 1777597200, tradesCount: 1 },
        ],
    },
    {
        dateUnix: 1777766400, // 2026-05-03 (unsorted day order in test)
        account: 'MT5_A',
        trades: [
            { id: 't3', symbol: 'XAUUSD', netProceeds: 120, exitTime: 1777806000, tradesCount: 1 },
            { id: 'open1', symbol: 'XAUUSD', netProceeds: 999, exitTime: 1777809600, openPosition: true, tradesCount: 0 },
            { id: 'otherAcc', symbol: 'XAUUSD', netProceeds: 500, exitTime: 1777807000, account: 'MT5_B', tradesCount: 1 },
        ],
    },
    {
        dateUnix: 1777680000, // 2026-05-02
        account: 'MT5_A',
        trades: [
            { id: 't2', symbol: 'USA100', netProceeds: -30, exitTime: 1777720000, tradesCount: 1 },
            { id: 't1', symbol: 'XAUUSD', netProceeds: 110, exitTime: 1777716000, tradesCount: 1 },
        ],
    },
]

const trackedA = trackTradesAgainstPlan({
    startBalance: 1000,
    goalBalance: 1400,
    startDate: '2026-05-02',
    pctPerTrade: 10,
    dayDocs: sampleDocs,
    account: 'MT5_A',
    excludedTradeIds: ['t2'],
    projection: projTrack,
    tz: 'UTC',
})

// Eligible on MT5_A from 2026-05-02: t1 (+110), t2 (-30, skipped), t3 (+120)
// Tracked: #1 t1 (1000 -> 1110, plan #1 = 1100), #2 t3 (1110 -> 1230, plan #2 = 1210)
check('tracker filters by startDate/account/openPosition, sorts chronologically, and handles skipped trades',
    trackedA.eligibleCount === 3 &&
    trackedA.tradesTaken === 2 &&
    trackedA.excludedCount === 1 &&
    trackedA.trackedTrades[0].id === 't1' &&
    trackedA.trackedTrades[1].id === 't3' &&
    trackedA.tradeMap.t1?.n === 1 &&
    trackedA.tradeMap.t2?.status === 'excluded' &&
    trackedA.tradeMap.old1 == null &&
    trackedA.tradeMap.open1 == null &&
    trackedA.tradeMap.otherAcc == null)

check('tracker computes currentBalance=1230, milestoneStep=2 (cleared 1210), variance=+20, nextTrade=#3 at 10% ($123)',
    approx(trackedA.currentBalance, 1230) &&
    trackedA.milestoneStep === 2 &&
    approx(trackedA.varianceAtStep, 20) &&
    trackedA.nextTrade.n === 3 &&
    approx(trackedA.nextTrade.targetDollars, 123) &&
    approx(trackedA.remainingToGoalDollars, 170) &&
    trackedA.tradesLeftAtPlanRate === 2 &&
    trackedA.goalReached === false)

// t1 on 05-02, t3 on 05-03: 2 trades over 2 trading days = 1/day; 2 trades left => 2 days
check('tracker estimates trading days left from the actual trades-per-trading-day pace',
    approx(trackedA.tradesPerTradingDay, 1) && trackedA.tradingDaysLeft === 2)

const trackedGoalHit = trackTradesAgainstPlan({
    startBalance: 1000,
    goalBalance: 1200,
    startDate: '2026-05-02',
    pctPerTrade: 10,
    dayDocs: sampleDocs,
    account: 'MT5_A',
    excludedTradeIds: ['t2'],
    projection: projTrack,
    tz: 'UTC',
})
check('tracker flags goalReached=true when currentBalance exceeds goal',
    trackedGoalHit.goalReached === true &&
    trackedGoalHit.remainingToGoalDollars === 0 &&
    trackedGoalHit.tradesLeftAtPlanRate === 0)

// 10. Dynamic liveSteps chaining after losing trades
const proj500 = buildTradeProjection({ start: 163.05, pctPerTrade: 10, goalBalance: 500 })
const lossDocs = [{
    dateUnix: 1777680000,
    trades: [
        { id: 'l1', symbol: 'XAUUSD', netProceeds: -5.71, exitTime: 1777681000, tradesCount: 1 },
        { id: 'l2', symbol: 'XAUUSD', netProceeds: -11.03, exitTime: 1777682000, tradesCount: 1 },
    ],
}]
const trackedLosses = trackTradesAgainstPlan({
    startBalance: 163.05,
    goalBalance: 500,
    pctPerTrade: 10,
    dayDocs: lossDocs,
    projection: proj500,
    tz: 'UTC',
})
const ls = trackedLosses.liveSteps
check('liveSteps chains each row Opening from previous actual balance and re-projects to goal',
    ls.length === 15 &&
    approx(ls[0].opening, 163.05, 0.01) &&
    approx(ls[0].closing, 157.34, 0.01) &&
    approx(ls[1].opening, 157.34, 0.01) &&
    approx(ls[1].profit, 15.734, 0.01) &&
    approx(ls[1].closing, 146.31, 0.01) &&
    approx(ls[2].opening, 146.31, 0.01) &&
    approx(ls[2].profit, 14.631, 0.01) &&
    approx(ls[2].targetClosing, 160.941, 0.01) &&
    ls[2].isProjected === true &&
    trackedLosses.liveGoalStep === 15 &&
    ls[14].closing >= 500)

// 11. Merging multiple positions into 1 trade step (tradeGroups)
const groupDocs = [{
    dateUnix: 1777680000,
    trades: [
        { id: 'p1', symbol: 'XAUUSD', buyQuantity: 0.02, netProceeds: -10, entryTime: 1777681000, exitTime: 1777681200, tradesCount: 1 },
        { id: 'p2', symbol: 'XAUUSD', buyQuantity: 0.03, netProceeds: 35, entryTime: 1777681050, exitTime: 1777681500, tradesCount: 1 },
        { id: 'p3', symbol: 'EURUSD', buyQuantity: 0.05, netProceeds: 15, entryTime: 1777682000, exitTime: 1777682500, tradesCount: 1 },
    ],
}]
const projGroup = buildTradeProjection({ start: 200, pctPerTrade: 10, goalBalance: 300 })
const trackedMerged = trackTradesAgainstPlan({
    startBalance: 200,
    goalBalance: 300,
    pctPerTrade: 10,
    dayDocs: groupDocs,
    tradeGroups: [['p1', 'p2']],
    projection: projGroup,
    tz: 'UTC',
})
check('tradeGroups merges positions into 1 step, sums net/lot, and maps all legs',
    trackedMerged.tradesTaken === 2 &&
    trackedMerged.wins === 2 &&
    trackedMerged.losses === 0 &&
    trackedMerged.winRatePct === 100 &&
    trackedMerged.trackedTrades[0].isGroup === true &&
    trackedMerged.trackedTrades[0].groupCount === 2 &&
    approx(trackedMerged.trackedTrades[0].net, 25) &&
    approx(trackedMerged.trackedTrades[0].lot, 0.05) &&
    approx(trackedMerged.trackedTrades[0].actualBalance, 225) &&
    trackedMerged.trackedTrades[1].n === 2 &&
    approx(trackedMerged.trackedTrades[1].openingBalance, 225) &&
    approx(trackedMerged.trackedTrades[1].actualBalance, 240) &&
    trackedMerged.tradeMap.p1.n === 1 &&
    trackedMerged.tradeMap.p2.n === 1 &&
    trackedMerged.tradeMap.p1.isGroup === true &&
    trackedMerged.tradeMap.p2.groupNet === 25 &&
    trackedMerged.tradeMap.p3.n === 2 &&
    trackedMerged.tradeMap.p3.isGroup === false)

// When one leg of a 2-leg group is excluded, remaining leg becomes standalone
const trackedFallback = trackTradesAgainstPlan({
    startBalance: 200,
    goalBalance: 300,
    pctPerTrade: 10,
    dayDocs: groupDocs,
    excludedTradeIds: ['p1'],
    tradeGroups: [['p1', 'p2']],
    projection: projGroup,
    tz: 'UTC',
})
check('excluding 1 leg of a 2-leg group dissolves the unit back to standalone',
    trackedFallback.tradesTaken === 2 &&
    trackedFallback.trackedTrades[0].isGroup === false &&
    trackedFallback.trackedTrades[0].id === 'p2' &&
    approx(trackedFallback.currentBalance, 250))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
