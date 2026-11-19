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

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
