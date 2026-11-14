/**
 * Pure daily-results analysis and forward equity growth forecasting.
 * Zero external dependencies (no DOM / Parse / dayjs) so it runs in both
 * Vite/browser and plain Node unit tests.
 */

const round = (n, d = 2) => {
    const f = 10 ** d
    return Math.round((n + Number.EPSILON) * f) / f
}

const MS_PER_DAY = 86400000

/** Parse 'YYYY-MM-DD' into a UTC midnight Date, or null if invalid. */
function parseIso(iso) {
    if (typeof iso !== 'string') return null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
    if (!m) return null
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3])
    const dt = new Date(Date.UTC(y, mo, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null
    return dt
}

function formatIso(dt) {
    return dt.toISOString().slice(0, 10)
}

function todayIsoLocal() {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

function addDaysUtc(dt, days) {
    return new Date(dt.getTime() + days * MS_PER_DAY)
}

function addMonthsUtc(dt, months) {
    const y = dt.getUTCFullYear()
    const m = dt.getUTCMonth()
    const d = dt.getUTCDate()
    const targetMonth = m + months
    const res = new Date(Date.UTC(y, targetMonth, 1))
    const maxDay = new Date(Date.UTC(res.getUTCFullYear(), res.getUTCMonth() + 1, 0)).getUTCDate()
    res.setUTCDate(Math.min(d, maxDay))
    return res
}

function diffDaysUtc(a, b) {
    return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY)
}

/** Deterministic PRNG (Mulberry32) so bootstrap bands never jitter between renders. */
function mulberry32(seed) {
    let a = seed >>> 0
    return function () {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function medianOf(sorted) {
    if (!sorted.length) return 0
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantileOf(sorted, q) {
    if (!sorted.length) return 0
    if (sorted.length === 1) return sorted[0]
    const pos = (sorted.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    if (lo === hi) return sorted[lo]
    const frac = pos - lo
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

function countWeekdaysInclusive(startIso, endIso) {
    const s = parseIso(startIso)
    const e = parseIso(endIso)
    if (!s || !e || e.getTime() < s.getTime()) return 0
    let count = 0
    for (let d = s; d.getTime() <= e.getTime(); d = addDaysUtc(d, 1)) {
        const dow = d.getUTCDay()
        if (dow !== 0 && dow !== 6) count++
    }
    return count
}

/**
 * Reconstruct historical daily equity curve, cash flows, and pre-trade capital base
 * per traded date. Anchors backward from `liveBalance` when finite so today's
 * balance matches the broker exactly; otherwise walks forward from `startBalance`.
 */
export function reconstructActualSeries({
    daily = [],
    cashFlows = [],
    liveBalance = null,
    startBalance = null,
    tz = 'UTC',
    today = null,
    planAtDate = null,
} = {}) {
    if (!Array.isArray(daily) || !daily.length) return null

    const netByDate = new Map()
    for (const d of daily) {
        if (!d || !d.date) continue
        netByDate.set(d.date, (netByDate.get(d.date) || 0) + (Number(d.net) || 0))
    }
    if (!netByDate.size) return null

    const tradedDates = [...netByDate.keys()].sort()
    const firstDate = tradedDates[0]
    const lastTradedDate = tradedDates[tradedDates.length - 1]

    const toDateInTz = (unixSec) => {
        const ms = Number(unixSec) * 1000
        if (!Number.isFinite(ms)) return null
        try {
            return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz || 'UTC' })
        } catch {
            return new Date(ms).toISOString().slice(0, 10)
        }
    }

    const sumByDate = (type) => {
        const m = new Map()
        for (const cf of cashFlows || []) {
            if (!cf || cf.type !== type) continue
            const date = toDateInTz(cf.t)
            const amt = Math.abs(Number(cf.amount) || 0)
            if (date && amt > 0 && date >= firstDate) {
                m.set(date, (m.get(date) || 0) + amt)
            }
        }
        return m
    }

    const wdByDate = sumByDate('withdrawal')
    const depByDate = sumByDate('deposit')

    const eventDates = [...new Set([...netByDate.keys(), ...wdByDate.keys(), ...depByDate.keys()])].sort()
    const parsedToday = today ? parseIso(today) : null
    const todayIso = parsedToday ? formatIso(parsedToday) : todayIsoLocal()

    // Extend calendar axis up to today (if today >= lastEvent) so historical equity
    // connects cleanly to the forward forecast starting tomorrow.
    const lastEvent = eventDates[eventDates.length - 1]
    const endIso = todayIso > lastEvent ? todayIso : lastEvent

    const allDates = []
    const firstDt = parseIso(eventDates[0])
    const lastDt = parseIso(endIso)
    if (firstDt && lastDt) {
        for (let d = firstDt; d.getTime() <= lastDt.getTime(); d = addDaysUtc(d, 1)) {
            allDates.push(formatIso(d))
        }
    }

    const s = Number.isFinite(Number(startBalance)) && Number(startBalance) > 0 ? Number(startBalance) : 0
    let withdrawnCum = 0
    let depositedCum = 0
    let netCum = 0
    let withdrawnOutsideRange = 0
    for (const [d, amt] of wdByDate.entries()) {
        if (d > lastTradedDate) withdrawnOutsideRange += amt
    }

    const dates = []
    const deltas = []
    const cumActual = []
    const dayActual = []
    const withdrawals = []
    const deposits = []
    const plan = []
    const cumPlan = []
    const dayPlan = []

    const planFirst = typeof planAtDate === 'function' ? planAtDate(allDates[0]) : null
    const planLast = typeof planAtDate === 'function' ? planAtDate(allDates[allDates.length - 1]) : null
    const planSlope = planFirst != null && planLast != null && allDates.length > 1
        ? (planLast - planFirst) / (allDates.length - 1)
        : 0

    for (let i = 0; i < allDates.length; i++) {
        const date = allDates[i]
        const isTraded = netByDate.has(date)
        const net = netByDate.get(date) || 0
        const wdToday = wdByDate.get(date) || 0
        const depToday = depByDate.get(date) || 0
        withdrawnCum += wdToday
        depositedCum += depToday
        netCum += net

        dates.push(date)
        deltas.push(net + depToday - wdToday)
        cumActual.push(round(netCum))
        dayActual.push(isTraded ? round(net) : null)
        withdrawals.push(round(wdToday))
        deposits.push(round(depToday))

        if (planFirst != null && planLast != null) {
            const p = planFirst + planSlope * i
            plan.push(round(p))
            cumPlan.push(round(p - planFirst))
            dayPlan.push(round(planSlope))
        } else {
            plan.push(null)
            cumPlan.push(null)
            dayPlan.push(null)
        }
    }

    const hasLive = liveBalance != null && Number.isFinite(Number(liveBalance))
    const actual = new Array(allDates.length)
    if (hasLive) {
        let bal = Number(liveBalance)
        for (let i = allDates.length - 1; i >= 0; i--) {
            actual[i] = round(bal)
            bal -= deltas[i]
        }
    } else {
        let bal = s
        for (let i = 0; i < allDates.length; i++) {
            bal += deltas[i]
            actual[i] = round(bal)
        }
    }

    // Opening equity used to measure daily % return on each traded day:
    // closing_i = openingBeforeTrade_i + net_i - wd_i  =>  openingBeforeTrade_i = closing_i - net_i + wd_i
    const openingByDate = new Map()
    for (let i = 0; i < allDates.length; i++) {
        const date = allDates[i]
        if (!netByDate.has(date)) continue
        const net = netByDate.get(date) || 0
        const wdToday = wdByDate.get(date) || 0
        openingByDate.set(date, actual[i] - net + wdToday)
    }

    const currentBalance = hasLive ? Number(liveBalance) : actual[actual.length - 1]

    return {
        dates,
        actual,
        plan,
        cumActual,
        cumPlan,
        dayActual,
        dayPlan,
        withdrawals,
        deposits,
        totalWithdrawn: round(withdrawnCum),
        totalDeposited: round(depositedCum),
        withdrawnOutsideRange: round(withdrawnOutsideRange),
        openingByDate,
        currentBalance: round(currentBalance),
        lastTradedDate,
        anchorDate: endIso,
    }
}

/**
 * Summarize actual daily trading results into empirical distribution, cadence,
 * and percentage return metrics for forecasting.
 */
export function analyzeDailyResults(daily = [], openingByDate = null, fallbackBalance = null) {
    if (!Array.isArray(daily) || !daily.length) return null

    const sorted = [...daily]
        .filter((d) => d && d.date)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    if (!sorted.length) return null

    const fb = Number(fallbackBalance)
    const rows = sorted.map((d) => {
        const net = Number(d.net) || 0
        const baseRaw = openingByDate instanceof Map ? openingByDate.get(d.date) : null
        // Guard against division by tiny/zero residual balance before an account reset
        const isTinyArtifact = baseRaw != null && baseRaw > 0 && baseRaw < 10 && Math.abs(net) > baseRaw * 5
        const base = (baseRaw > 0 && !isTinyArtifact) ? baseRaw : (fb > 0 ? fb : null)
        const usableBase = base != null && base > 0 ? base : null
        const pct = usableBase != null ? net / usableBase : null
        return {
            date: d.date,
            net,
            trades: Number(d.trades) || 0,
            base: usableBase,
            pct,
        }
    })

    const n = rows.length
    const nets = rows.map((r) => r.net)
    const sortedNets = [...nets].sort((a, b) => a - b)

    const winDays = rows.filter((r) => r.net > 0).length
    const lossDays = rows.filter((r) => r.net < 0).length
    const flatDays = n - winDays - lossDays
    const dayWinRate = winDays / n

    const totalNet = nets.reduce((s, v) => s + v, 0)
    const meanNet = totalNet / n
    const medianNet = medianOf(sortedNets)
    const variance = n > 1
        ? nets.reduce((s, v) => s + (v - meanNet) ** 2, 0) / (n - 1)
        : 0
    const stdNet = Math.sqrt(variance)

    let bestDay = rows[0]
    let worstDay = rows[0]
    let grossWinDays = 0
    let grossLossDays = 0
    for (const r of rows) {
        if (r.net > bestDay.net) bestDay = r
        if (r.net < worstDay.net) worstDay = r
        if (r.net > 0) grossWinDays += r.net
        else if (r.net < 0) grossLossDays += Math.abs(r.net)
    }
    const dailyProfitFactor = grossLossDays > 0 ? grossWinDays / grossLossDays : null

    const recentCount = n >= 4 ? Math.min(10, Math.max(3, Math.ceil(n / 2))) : n
    const recentRows = rows.slice(-recentCount)
    const recentMeanNet = recentRows.reduce((s, r) => s + r.net, 0) / recentRows.length
    const recentMedianNet = medianOf([...recentRows.map((r) => r.net)].sort((a, b) => a - b))

    // Daily % return metrics (fractional, converted to % for display)
    const pctRows = rows.filter((r) => r.pct != null && Number.isFinite(r.pct))
    let meanPct = null
    let medianPct = null
    let geoMeanPct = null
    let recentMeanPct = null
    if (pctRows.length) {
        const pcts = pctRows.map((r) => r.pct)
        meanPct = (pcts.reduce((s, v) => s + v, 0) / pcts.length) * 100
        medianPct = medianOf([...pcts].sort((a, b) => a - b)) * 100

        const validFactors = pcts.map((r) => Math.max(1e-6, 1 + r))
        const logSum = validFactors.reduce((s, f) => s + Math.log(f), 0)
        geoMeanPct = (Math.exp(logSum / validFactors.length) - 1) * 100

        const recentPctRows = pctRows.slice(-Math.min(recentCount, pctRows.length))
        recentMeanPct = (recentPctRows.reduce((s, r) => s + r.pct, 0) / recentPctRows.length) * 100
    }

    // Actual trading cadence across calendar weeks
    const firstDate = rows[0].date
    const lastDate = rows[n - 1].date
    const calendarSpanDays = Math.max(1, diffDaysUtc(parseIso(lastDate), parseIso(firstDate)) + 1)
    const weekdaysInSpan = Math.max(1, countWeekdaysInclusive(firstDate, lastDate))
    const activeDayRatio = calendarSpanDays >= 7
        ? Math.min(1, Math.max(0.1, n / weekdaysInSpan))
        : Math.min(1, Math.max(0.2, n / weekdaysInSpan))
    const tradedDaysPerWeek = activeDayRatio * 5

    // Momentum & skew diagnostics
    let momentum = 'steady'
    if (n >= 6) {
        const scale = Math.max(stdNet * 0.2, Math.abs(meanNet) * 0.25, 1)
        if (recentMeanNet - meanNet > scale) momentum = 'accelerating'
        else if (meanNet - recentMeanNet > scale) momentum = 'cooling'
    }
    const outlierSkew = n >= 4 && stdNet > 0 && Math.abs(meanNet - medianNet) > stdNet * 0.4

    const sampleConfidence = n >= 30 ? 'high' : n >= 10 ? 'moderate' : 'low'

    return {
        tradedDays: n,
        winDays,
        lossDays,
        flatDays,
        dayWinRate,
        totalNet: round(totalNet),
        meanNet: round(meanNet),
        medianNet: round(medianNet),
        stdNet: round(stdNet),
        bestDay: { date: bestDay.date, net: round(bestDay.net) },
        worstDay: { date: worstDay.date, net: round(worstDay.net) },
        dailyProfitFactor: dailyProfitFactor != null ? round(dailyProfitFactor, 2) : null,
        recentCount,
        recentMeanNet: round(recentMeanNet),
        recentMedianNet: round(recentMedianNet),
        meanPct,
        medianPct,
        geoMeanPct,
        recentMeanPct,
        firstDate,
        lastDate,
        calendarSpanDays,
        weekdaysInSpan,
        activeDayRatio,
        tradedDaysPerWeek: round(tradedDaysPerWeek, 1),
        momentum,
        outlierSkew,
        sampleConfidence,
        rows,
    }
}

/**
 * Project future equity growth from actual daily results using:
 * 1) A deterministic expected trajectory (Compound % or Fixed $/day, using Mean / Median / Recent pace)
 * 2) A deterministic seeded bootstrap simulation (P10 / P50 / P90 confidence fan)
 *    respecting actual trading-day frequency (`activeDayRatio`) and optional fixed monthly cost drag.
 */
export function buildGrowthForecast({
    summary,
    currentBalance = 0,
    horizonMonths = 3,
    mode = 'compound',
    paceBasis = 'mean',
    monthlyCost = 0,
    includeCosts = true,
    goalBalance = null,
    anchorDate = null,
    simCount = 400,
    planAtDate = null,
} = {}) {
    if (!summary || !summary.rows || !summary.rows.length) return null

    const months = Math.max(1, Math.min(120, Math.floor(Number(horizonMonths) || 3)))
    const startBal = Number.isFinite(Number(currentBalance)) ? Number(currentBalance) : 0
    const canCompound = startBal > 0 && summary.meanPct != null
    const effectiveMode = mode === 'compound' && canCompound ? 'compound' : 'linear'

    const startDay = (anchorDate && parseIso(anchorDate)) || parseIso(todayIsoLocal())
    const endDay = addMonthsUtc(startDay, months)

    const futureWeekdays = []
    const calDeltas = []
    let prevDay = startDay
    for (let d = addDaysUtc(startDay, 1); d.getTime() <= endDay.getTime(); d = addDaysUtc(d, 1)) {
        const dow = d.getUTCDay()
        if (dow !== 0 && dow !== 6) {
            futureWeekdays.push(formatIso(d))
            calDeltas.push(diffDaysUtc(d, prevDay))
            prevDay = d
        }
    }
    if (!futureWeekdays.length) return null

    const DAYS_PER_MONTH = 30.4375
    const costPerCalDay = includeCosts && Number(monthlyCost) > 0 ? Number(monthlyCost) / DAYS_PER_MONTH : 0
    const activeRatio = Math.min(1, Math.max(0.05, Number(summary.activeDayRatio) || 1))

    // Pick central tendency pace for expected trajectory
    const pacePct = paceBasis === 'median'
        ? (summary.medianPct ?? summary.meanPct ?? 0)
        : paceBasis === 'recent'
            ? (summary.recentMeanPct ?? summary.meanPct ?? 0)
            : (summary.meanPct ?? 0)

    const paceDollar = paceBasis === 'median'
        ? summary.medianNet
        : paceBasis === 'recent'
            ? summary.recentMeanNet
            : summary.meanNet

    // Expected deterministic trajectory
    const expectedEquity = []
    const expectedCum = []
    let expBal = startBal
    let expCum = 0
    let totalCostDrag = 0
    const dailyFactor = effectiveMode === 'compound'
        ? Math.pow(Math.max(1e-6, 1 + pacePct / 100), activeRatio)
        : 1

    const goal = Number(goalBalance) > 0 ? Number(goalBalance) : null
    let expectedGoalEta = null
    if (goal && startBal >= goal) {
        expectedGoalEta = { tradingDays: 0, date: formatIso(startDay), already: true }
    }

    for (let t = 0; t < futureWeekdays.length; t++) {
        const costHere = costPerCalDay * calDeltas[t]
        totalCostDrag += costHere
        if (effectiveMode === 'compound') {
            const nextBal = Math.max(0, expBal * dailyFactor - costHere)
            expCum += nextBal - expBal
            expBal = nextBal
        } else {
            const gain = paceDollar * activeRatio - costHere
            expCum += gain
            expBal += gain
        }
        expectedEquity.push(round(expBal))
        expectedCum.push(round(expCum))
        if (goal && !expectedGoalEta && expBal >= goal) {
            expectedGoalEta = { tradingDays: t + 1, date: futureWeekdays[t], already: false }
        }
    }

    // Bootstrap pool: for 'recent' basis, weight recent rows slightly more by sampling
    // from the recent slice if >= 5 days, else full pool; for mean/median, full pool.
    const baseRows = paceBasis === 'recent' && summary.rows.length >= 6
        ? summary.rows.slice(-summary.recentCount)
        : summary.rows
    const pool = baseRows.map((r) => ({
        net: r.net,
        // Cap single-day compounding return at reasonable bounds if base was tiny, fallback to currentBalance
        pct: r.pct != null && Number.isFinite(r.pct)
            ? Math.max(-0.99, r.pct)
            : (startBal > 0 ? Math.max(-0.99, r.net / startBal) : 0),
    }))

    const K = futureWeekdays.length
    const N = Math.max(50, Math.min(1000, Math.floor(simCount)))
    const seed = (summary.tradedDays * 1009) ^ Math.round(summary.totalNet * 100) ^ (months * 37) ^ (paceBasis.length * 131)
    const rand = mulberry32(seed)

    // Column-major matrix of simulated balances at step t so percentiles sort cleanly
    const cols = Array.from({ length: K }, () => new Float64Array(N))
    let profitPaths = 0
    let goalPaths = 0

    for (let s = 0; s < N; s++) {
        let bal = startBal
        let hitGoal = goal != null && startBal >= goal
        for (let t = 0; t < K; t++) {
            const costHere = costPerCalDay * calDeltas[t]
            if (rand() < activeRatio) {
                const sample = pool[Math.floor(rand() * pool.length)]
                if (effectiveMode === 'compound') {
                    bal = Math.max(0, bal * Math.max(0, 1 + sample.pct) - costHere)
                } else {
                    bal = bal + sample.net - costHere
                }
            } else if (costHere > 0) {
                bal = effectiveMode === 'compound' ? Math.max(0, bal - costHere) : bal - costHere
            }
            cols[t][s] = bal
            if (goal != null && !hitGoal && bal >= goal) hitGoal = true
        }
        if (bal > startBal) profitPaths++
        if (hitGoal) goalPaths++
    }

    const p10Equity = new Array(K)
    const p50Equity = new Array(K)
    const p90Equity = new Array(K)
    const p10Cum = new Array(K)
    const p50Cum = new Array(K)
    const p90Cum = new Array(K)

    for (let t = 0; t < K; t++) {
        const sorted = Array.from(cols[t]).sort((a, b) => a - b)
        const q10 = quantileOf(sorted, 0.10)
        const q50 = quantileOf(sorted, 0.50)
        const q90 = quantileOf(sorted, 0.90)
        p10Equity[t] = round(q10)
        p50Equity[t] = round(q50)
        p90Equity[t] = round(q90)
        p10Cum[t] = round(q10 - startBal)
        p50Cum[t] = round(q50 - startBal)
        p90Cum[t] = round(q90 - startBal)
    }

    let planEquity = null
    let planCum = null
    if (typeof planAtDate === 'function') {
        const pe = []
        const pc = []
        let anyPlan = false
        const planAnchor = planAtDate(formatIso(startDay))
        const cumBase = planAnchor != null && Number.isFinite(planAnchor) ? planAnchor : startBal
        for (const d of futureWeekdays) {
            const v = planAtDate(d)
            if (v != null && Number.isFinite(v)) {
                anyPlan = true
                pe.push(round(v))
                pc.push(round(v - cumBase))
            } else {
                pe.push(null)
                pc.push(null)
            }
        }
        if (anyPlan) {
            planEquity = pe
            planCum = pc
        }
    }

    const endExpected = expectedEquity[K - 1]
    const expectedGain = round(endExpected - startBal)
    const expectedReturnPct = startBal > 0 ? round((expectedGain / startBal) * 100) : null

    return {
        months,
        effectiveMode,
        paceBasis,
        pacePct: round(pacePct, 3),
        paceDollar: round(paceDollar),
        activeDayRatio: round(activeRatio, 3),
        futureTradingDays: K,
        expectedTradedDays: round(K * activeRatio, 1),
        anchorDate: formatIso(startDay),
        startBalance: round(startBal),
        dates: futureWeekdays,
        expectedEquity,
        p10Equity,
        p50Equity,
        p90Equity,
        expectedCum,
        p10Cum,
        p50Cum,
        p90Cum,
        planEquity,
        planCum,
        endExpected,
        endP10: p10Equity[K - 1],
        endP50: p50Equity[K - 1],
        endP90: p90Equity[K - 1],
        expectedGain,
        expectedReturnPct,
        totalCostDrag: round(totalCostDrag),
        probProfit: round((profitPaths / N) * 100, 1),
        probGoal: goal != null ? round((goalPaths / N) * 100, 1) : null,
        expectedGoalEta,
    }
}
