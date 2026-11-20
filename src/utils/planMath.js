/**
 * Trading-plan math, shared by the Trading Plan and Plan vs Actual pages.
 * Everything compounds on trading days only — weekends are market-closed.
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(utc)
dayjs.extend(timezone)

/** '' / null / non-numeric -> null, so empty inputs never compute silently. */
export function numOrNull(v) {
    if (v === '' || v == null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}

/** A plan's start date is INCLUSIVE: if it's a trading day, day 1 is that date. */
function anchorOf(fromDate) {
    const d = fromDate ? dayjs(fromDate) : dayjs()
    return d.isValid() ? d.startOf('day') : dayjs().startOf('day')
}

/** Calendar weeks (fractional) from fromDate through +months. */
export function calendarWeeksAhead(months, fromDate) {
    const start = anchorOf(fromDate)
    const end = start.add(months, 'month')
    return end.diff(start, 'day') / 7
}

/**
 * Re-express a required %/day as the equivalent %/period, given how many
 * trading days compound within one period on average (e.g. ~5 trading days
 * per calendar week). Same total growth, same underlying plan -- just a
 * different unit to think in. Not a separate calculation: compounding the
 * returned rate over the corresponding number of periods reproduces exactly
 * the same total growth as compounding pctPerDay over daysPerPeriod days.
 */
export function equivalentPctForNDays(pctPerDay, daysPerPeriod) {
    if (pctPerDay == null || !(daysPerPeriod > 0)) return null
    return (Math.pow(1 + pctPerDay / 100, daysPerPeriod) - 1) * 100
}

/** Weekdays from fromDate (inclusive) through +months. */
export function tradingDaysAhead(months, fromDate) {
    const startDay = anchorOf(fromDate)
    const end = startDay.add(months, 'month')
    let cur = startDay
    let n = 0
    while (!cur.isAfter(end, 'day')) {
        const dow = cur.day()
        if (dow !== 0 && dow !== 6) n++
        cur = cur.add(1, 'day')
    }
    return n
}

/** Trading days strictly between fromDate and today (0 if fromDate is today or in the future). */
export function tradingDaysElapsed(fromDate) {
    const startDay = anchorOf(fromDate)
    const today = dayjs().startOf('day')
    if (!today.isAfter(startDay, 'day')) return 0
    let cur = startDay.add(1, 'day')
    let n = 0
    while (!cur.isAfter(today, 'day')) {
        const dow = cur.day()
        if (dow !== 0 && dow !== 6) n++
        cur = cur.add(1, 'day')
    }
    return n
}

/**
 * Compound pctPerDay over weekdays only, from fromDate (inclusive) through
 * +months. Keeps every step so the maths can be followed day by day: each
 * trading day is opening -> +deposit -> +profit -> closing.
 *
 * `deposits` is an optional array of one-off `{ date: 'YYYY-MM-DD', amount }`
 * entries — add money whenever you actually did, no fixed cadence. A deposit
 * dated on a weekend lands on the next trading day; one dated before the plan
 * starts is clamped to day 1. Deposits dated after the horizon ends don't
 * apply — `ignoredDeposited` reports how much so the UI can flag it.
 *
 * Returns `contributed` (start + deposits applied) so profit can exclude
 * money you paid in — otherwise deposits would masquerade as trading gains.
 */
/**
 * Turn tiered daily rates into a function balance -> rate. The flat `pctPerDay`
 * is the STARTING rate; each tier `{ from, pct }` steps the rate to `pct` %/day
 * once the balance reaches `from`. The highest `from` at or below the balance
 * wins, so tiers read as "when the account reaches $X, switch to Y%/day"
 * (e.g. start 5%/day, from $5,000 -> 3%, from $10,000 -> 1%). Below the first
 * `from` the flat rate applies. With no usable tiers it's just the flat rate.
 */
export function tierRateResolver(pctPerDay, tiers) {
    const list = (Array.isArray(tiers) ? tiers : [])
        .map((t) => ({
            from: t.from === '' || t.from == null ? null : Number(t.from),
            pct: Number(t.pct),
        }))
        .filter((t) => Number.isFinite(t.pct) && t.from !== null && Number.isFinite(t.from))
        .sort((a, b) => a.from - b.from)
    // Below the first threshold: the flat target; if that's blank, the first tier.
    const base = Number.isFinite(pctPerDay) ? pctPerDay / 100 : (list.length ? list[0].pct / 100 : 0)
    if (!list.length) return () => base
    return (balance) => {
        let rate = base
        for (const t of list) {
            if (balance >= t.from) rate = t.pct / 100
            else break
        }
        return rate
    }
}

export function buildProjection(start, pctPerDay, months, deposits = [], fromDate, tiers = [], withdrawals = [], options = {}) {
    /* A flat amount per trading day, instead of a percentage.
     *
     * A percentage compounds -- the same 1% is a different sum every day -- which
     * is the right model for growing an account and the wrong one for someone
     * whose goal is a wage. When dailyAmount is set it wins over pctPerDay (and
     * over the tiers, which step a RATE and have nothing to step here), and the
     * curve becomes a straight line rather than a compounding one.
     *
     * Passed as an option rather than a positional argument so the existing four
     * call sites keep working untouched. */
    const dailyAmount = Number(options.dailyAmount)
    const useAmount = Number.isFinite(dailyAmount) && dailyAmount > 0
    const rateAt = tierRateResolver(pctPerDay, tiers)
    const startDay = anchorOf(fromDate)
    const end = startDay.add(months, 'month')

    // Bucket cash movements onto the trading day each one lands on. Deposits and
    // withdrawals share the same date rules (weekend -> next open day, before the
    // start -> day 1, after the horizon -> ignored).
    const bucket = (items) => {
        const map = new Map()
        let ignored = 0
        for (const it of items || []) {
            if (!it || !(Number(it.amount) > 0) || !it.date) continue
            let dd = dayjs(it.date)
            if (!dd.isValid()) continue
            dd = dd.startOf('day')
            if (dd.isBefore(startDay, 'day')) dd = startDay
            if (dd.isAfter(end, 'day')) { ignored += Number(it.amount); continue }
            while (dd.day() === 0 || dd.day() === 6) dd = dd.add(1, 'day')
            const key = dd.format('YYYY-MM-DD')
            map.set(key, (map.get(key) || 0) + Number(it.amount))
        }
        return { map, ignored }
    }
    const { map: byDate, ignored: ignoredDeposited } = bucket(deposits)
    const { map: wdByDate, ignored: ignoredWithdrawn } = bucket(withdrawals)

    let bal = start
    let n = 0
    let deposited = 0
    let withdrawn = 0
    const days = []

    let cur = startDay
    while (!cur.isAfter(end, 'day')) {
        const dow = cur.day() // 0 = Sun, 6 = Sat -> market closed, no compounding
        if (dow !== 0 && dow !== 6) {
            const key = cur.format('YYYY-MM-DD')
            const opening = bal
            const dep = byDate.get(key) || 0
            if (dep) deposited += dep
            // Rate can depend on the day's balance (tiered plans step it down as
            // the account grows); flat plans return the same rate every day. A
            // fixed daily amount ignores the balance entirely.
            const profit = useAmount ? dailyAmount : (opening + dep) * rateAt(opening + dep)
            const afterProfit = opening + dep + profit
            // Withdrawals come out after the day's profit; never take out more than
            // is there (a plan can't go negative from a scheduled withdrawal).
            let wd = wdByDate.get(key) || 0
            if (wd > afterProfit) wd = Math.max(afterProfit, 0)
            if (wd) withdrawn += wd
            bal = afterProfit - wd
            n++
            days.push({
                n,
                date: key,
                weekday: cur.format('ddd'),
                opening,
                deposit: dep,
                profit,
                withdrawal: wd,
                closing: bal,
                contributed: start + deposited,
                // Gain keeps money already withdrawn in the numerator — it was profit
                // you took out, not capital lost.
                cumulativeReturnPct: ((bal + withdrawn - start - deposited) / (start + deposited)) * 100,
            })
        }
        cur = cur.add(1, 'day')
    }

    const contributed = start + deposited
    return {
        tradingDays: n,
        finalBalance: bal,
        deposited,
        ignoredDeposited,
        withdrawn,
        ignoredWithdrawn,
        contributed,
        // Trading gain only: money paid in isn't profit, money taken out still counts
        // as gain (final balance + what you withdrew, less what you contributed).
        profit: bal + withdrawn - contributed,
        totalReturnPct: contributed > 0 ? ((bal + withdrawn - contributed) / contributed) * 100 : 0,
        days,
    }
}

/**
 * Collapse the day-by-day rows to one row per week or month. Rows keep a common
 * shape so one table can render any granularity.
 */
export function rollup(days, granularity) {
    if (granularity === 'daily') {
        return days.map((d) => ({
            n: d.n,
            label: `${d.date} · ${d.weekday}`,
            tradingDays: 1,
            opening: d.opening,
            deposit: d.deposit || 0,
            withdrawal: d.withdrawal || 0,
            profit: d.profit,
            closing: d.closing,
            cumulativeReturnPct: d.cumulativeReturnPct,
            // Present only when the days went through withLots().
            lot: d.lot,
            lotExact: d.lotExact,
            lotDollars: d.lotDollars,
            lotShort: lotFallsShort(d),
        }))
    }
    const keyOf = (d) =>
        granularity === 'weekly' ? dayjs(d.date).startOf('week').format('YYYY-MM-DD') : d.date.slice(0, 7)

    const groups = new Map()
    for (const d of days) {
        const k = keyOf(d)
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(d)
    }
    return [...groups.values()].map((g) => {
        const first = g[0]
        const last = g[g.length - 1]
        const depositInPeriod = g.reduce((s, d) => s + (d.deposit || 0), 0)
        const withdrawalInPeriod = g.reduce((s, d) => s + (d.withdrawal || 0), 0)
        return {
            n: last.n,
            label: granularity === 'monthly' ? last.date.slice(0, 7) : `${first.date} → ${last.date}`,
            tradingDays: g.length,
            opening: first.opening,
            deposit: depositInPeriod,
            withdrawal: withdrawalInPeriod,
            // Trading gain only — deposits/withdrawals accounted for separately
            // (add the withdrawal back: it left the balance but was still profit).
            profit: last.closing - first.opening - depositInPeriod + withdrawalInPeriod,
            closing: last.closing,
            cumulativeReturnPct: last.cumulativeReturnPct,
            // The lot changes daily inside a period as the balance grows, so a
            // grouped row carries where it starts and where it ends.
            lotFrom: first.lot,
            lotTo: last.lot,
            lotShort: g.some(lotFallsShort),
        }
    })
}

/**
 * Pip size / contract size per symbol, mirroring src/utils/addOrder.js (the
 * manual-order form's conventions). Duplicated rather than imported: that
 * module transitively pulls in the Parse SDK and global stores, which would
 * make this file unusable outside a browser -- planMath.js is deliberately
 * plain so it can be unit-tested directly with plain Node. Keep in sync if
 * addOrder.js's tables change.
 */
const ASSET_CLASSES = [
    { pipSize: 1, contractSize: 1, match: ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'DOGE', 'ADA', 'BNB'] },
    {
        pipSize: 1, contractSize: 1,
        match: ['USA100', 'US100', 'NAS', 'NDX', 'USTEC', 'USA30', 'US30', 'DJ30', 'USA500', 'US500',
            'SPX', 'GER40', 'DE40', 'DAX', 'UK100', 'FTSE', 'JP225', 'NIKKEI', 'NETH25', 'EU50',
            'STOXX', 'HK50', 'AUS200', 'FRA40', 'ESP35'],
    },
    { pipSize: 0.01, contractSize: 100, match: ['OIL', 'WTI', 'BRENT'] },
    { pipSize: 0.01, contractSize: 100, match: ['XAU'] },
    { pipSize: 0.001, contractSize: 1000, match: ['XAG'] },
    { pipSize: 0.01, contractSize: 100000, match: ['JPY'] },
]

const FOREX_SPEC = { pipSize: 0.0001, contractSize: 100000 }

function assetSpecFor(symbol) {
    if (!symbol) return FOREX_SPEC
    const s = String(symbol).toUpperCase()
    return ASSET_CLASSES.find((c) => c.match.some((m) => s.includes(m))) || FOREX_SPEC
}

export function pipSizeFor(symbol) {
    return assetSpecFor(symbol).pipSize
}

export function contractSizeFor(symbol) {
    return assetSpecFor(symbol).contractSize
}

/** USD per pip, per 1.00 lot, for `symbol`. */
export function pipValuePerLot(symbol) {
    return pipSizeFor(symbol) * contractSizeFor(symbol)
}

/** A dollar P&L, expressed in pips at the given symbol + lot size. Null if
 * lotSize isn't a usable positive number -- never silently divide by zero. */
export function dollarsToPips(dollars, symbol, lotSize) {
    const lot = Number(lotSize)
    if (dollars == null || !(lot > 0)) return null
    const perPip = pipValuePerLot(symbol) * lot
    return perPip > 0 ? dollars / perPip : null
}

/**
 * Position sizing: the lot that makes `dollars` over a `pips` distance on
 * `symbol` -- dollars / (pips x $ per pip per lot). The same formula the
 * trader's own journal sheet uses ("Lot Size ที่แนะนำ": 10% of 100 = $10 over
 * 1000 points on XAUUSD = 0.01 lot). Null on unusable input rather than a
 * divide-by-zero.
 */
export function lotForDollars(dollars, pips, symbol) {
    const p = Number(pips)
    if (!(dollars > 0) || !(p > 0)) return null
    const perPipPerLot = pipValuePerLot(symbol)
    return perPipPerLot > 0 ? dollars / (p * perPipPerLot) : null
}

/** The smallest lot increment brokers accept. */
export const LOT_STEP = 0.01

/**
 * Round a lot DOWN to the broker's 0.01 step. Down, never to-nearest: the % of
 * the account is the ceiling the trader chose, and rounding up would quietly
 * size a position past it. The epsilon absorbs float noise (0.01 / 0.01 coming
 * back as 0.9999...) so an exact 0.01 is not floored to 0.
 */
export function floorLot(lot) {
    if (lot == null) return null
    return Math.floor(lot / LOT_STEP + 1e-9) * LOT_STEP
}

/**
 * The lot each projected day calls for, at a fixed pip distance: that day's
 * profit target / (pips x $ per pip per lot), floored to the 0.01 step. This
 * is what ties the projection to position sizing -- 10% of a balance that has
 * doubled is twice the dollars, so over the same distance it needs twice the
 * lot, and the table says so day by day instead of leaving it to be redone by
 * hand as the account grows.
 *
 * Also returns what the floored lot actually makes (`lotDollars`), because at
 * small balances the floor can cut deep: 10% of $195 over 1000 pips is 0.0195
 * lot, and the tradeable 0.01 makes $10, not $19.49. Callers flag that rather
 * than present the target as reachable at that size.
 *
 * Returns the days unchanged when no usable pip distance is given.
 */
export function withLots(days, pips, symbol) {
    const p = Number(pips)
    const perPipPerLot = pipValuePerLot(symbol)
    if (!(p > 0) || !(perPipPerLot > 0)) return days
    return days.map((d) => {
        const exact = d.profit > 0 ? d.profit / (p * perPipPerLot) : null
        const lot = exact == null ? null : floorLot(exact)
        return { ...d, lot, lotExact: exact, lotDollars: lot >= LOT_STEP ? lot * p * perPipPerLot : 0 }
    })
}

/** True when the tradeable lot makes noticeably less (>10% short) than the day's target. */
const lotFallsShort = (d) => d.lot != null && d.profit > 0 && d.lotDollars < 0.9 * d.profit

/**
 * Pip distances worth offering when the trader has not picked one. Gold is
 * quoted in 0.01 pips, so a normal day there is hundreds to thousands of pips
 * (the 500-2000 band calibrated in pipsRealismVerdict); a forex major moves
 * tens. One list for both would be useless for one of them.
 */
export function suggestedPipDistances(symbol) {
    const s = (symbol || '').toUpperCase()
    if (s.includes('XAU')) return [100, 200, 300, 500, 1000, 1500, 2000]
    if (pipSizeFor(s) >= 1) return [10, 20, 50, 100, 150, 200, 300]
    return [10, 20, 30, 50, 100, 150, 200]
}

/**
 * Realism verdict calibrated to a specific trader's own feedback, not a
 * generic rule: they said 500-1000 pips/day is "easier", and 1000-2000 is
 * "not too much or too little" (comfortably plausible) for XAUUSD at their
 * usual size. Bands below/above that range are OUR extrapolation (doubling
 * pattern: 500 -> 1000 -> 2000 -> 4000), not something they specified --
 * the UI must say so, since these numbers are a guess past that point.
 */
export function pipsRealismVerdict(pipsPerDay) {
    const p = pipsPerDay
    if (p == null) return null
    if (p <= 500) return { verdict: 'Conservative — comfortably achievable.', tone: 'ok' }
    if (p <= 1000) return { verdict: 'Easy — well within a normal trading day.', tone: 'ok' }
    if (p <= 2000) return { verdict: 'Moderate — plausible with a solid setup.', tone: 'warn' }
    if (p <= 4000) return { verdict: 'Aggressive — needs a strong trending day.', tone: 'bad' }
    return { verdict: 'Unrealistic — more movement than most days offer.', tone: 'bad' }
}

/**
 * Daily % needed to turn `start` into `goal`.
 *
 * With no deposits this is the closed form r = (goal/start)^(1/days) - 1.
 * Deposits break that identity (cash arrives mid-way and compounds for less
 * time), so solve numerically instead — final balance is strictly increasing in
 * r, which makes bisection safe and exact to the tolerance.
 */
export function requiredPctPerDay(start, goal, months, deposits = [], fromDate, withdrawals = []) {
    if (!(start > 0) || !(goal > 0) || !months) return null

    const hasCashFlow = (arr) => Array.isArray(arr) && arr.some((x) => x && Number(x.amount) > 0 && x.date)
    // The closed form only holds with no mid-way cash flows; any deposit or
    // withdrawal breaks it, so solve numerically in that case.
    if (!hasCashFlow(deposits) && !hasCashFlow(withdrawals)) {
        const days = tradingDaysAhead(months, fromDate)
        if (!days) return null
        return (Math.pow(goal / start, 1 / days) - 1) * 100
    }

    const finalAt = (pct) => buildProjection(start, pct, months, deposits, fromDate, [], withdrawals).finalBalance
    // Deposits alone may already clear the goal -> 0%/day (or less) suffices.
    if (finalAt(0) >= goal) return 0

    let lo = 0
    let hi = 1 // %/day
    for (let i = 0; i < 60 && finalAt(hi) < goal; i++) hi *= 2
    if (finalAt(hi) < goal) return null // unreachable within sane bounds

    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2
        if (finalAt(mid) < goal) lo = mid
        else hi = mid
        if (hi - lo < 1e-9) break
    }
    return (lo + hi) / 2
}

/**
 * Goal seek the other way round: at the plan's own target, how long until the
 * balance reaches `goal`? The usual goal seek needs a horizon to answer "what %
 * do I need"; this needs none, because the target already fixes the pace and
 * only the date is unknown.
 *
 * Runs the same buildProjection the projection card uses -- so deposits,
 * withdrawals, tiers and $/day mode all count exactly as they do there -- out
 * to 120 months (the Horizon field's own maximum) and takes the first trading
 * day that closes at or above the goal. Null if it isn't reached in that window.
 */
export function timeToGoal(start, goal, pctPerDay, fromDate, deposits = [], tiers = [], withdrawals = [], options = {}) {
    if (!(start > 0) || !(goal > 0)) return null
    if (goal <= start) return { tradingDays: 0, date: anchorOf(fromDate).format('YYYY-MM-DD'), already: true }
    const proj = buildProjection(start, pctPerDay, 120, deposits, fromDate, tiers, withdrawals, options)
    const hit = proj.days.find((d) => d.closing >= goal)
    return hit ? { tradingDays: hit.n, date: hit.date, already: false } : null
}

/** How realistic is a given daily target? Used to label goal-seek results. */
export function realismVerdict(pctPerDay) {
    const p = pctPerDay
    if (p <= 0) return { verdict: 'Goal is at or below your starting balance.', tone: 'muted' }
    if (p <= 0.3) return { verdict: 'Conservative — realistic for a disciplined plan.', tone: 'ok' }
    if (p <= 0.7) return { verdict: 'Ambitious but achievable.', tone: 'ok' }
    if (p <= 1.5) return { verdict: 'Aggressive — few traders sustain this.', tone: 'warn' }
    if (p <= 3) return { verdict: 'Very aggressive — rarely sustainable.', tone: 'bad' }
    return { verdict: 'Unrealistic — compounds faster than professionals sustain.', tone: 'bad' }
}

/* ============================================================================
 * PER-TRADE COMPOUNDING & RISK-BASED LOT SIZING
 * ============================================================================ */

export const MAX_TRADE_PROJECTION_STEPS = 2000

/**
 * Project balance trade by trade (ไม้ต่อไม้).
 * - If `numTrades` is provided (>= 1), simulates that exact number of trades.
 * - Otherwise, if `goalBalance` is provided, simulates up to `MAX_TRADE_PROJECTION_STEPS`
 *   until `closing >= goalBalance` so the trader immediately sees how many trades
 *   it takes to reach the goal.
 */
export function buildTradeProjection({
    start,
    pctPerTrade = 0,
    tradeAmount = null,
    numTrades = null,
    goalBalance = null,
    tiers = [],
    maxTrades = MAX_TRADE_PROJECTION_STEPS,
} = {}) {
    if (!(start > 0)) return null
    const amt = Number(tradeAmount)
    const useAmount = Number.isFinite(amt) && amt > 0
    const pct = Number(pctPerTrade)
    const hasTiers = Array.isArray(tiers) && tiers.some((t) => t && t.pct !== '' && t.pct != null && Number.isFinite(Number(t.pct)))
    if (!useAmount && !(pct > 0) && !hasTiers) return null

    const hasGoal = Number(goalBalance) > 0
    const goal = hasGoal ? Number(goalBalance) : null
    const fixedCount = numTrades != null && Number(numTrades) >= 1
        ? Math.min(Math.floor(Number(numTrades)), maxTrades)
        : null

    if (fixedCount == null && !hasGoal) return null

    const rateAt = tierRateResolver(Number.isFinite(pct) ? pct : 0, useAmount ? [] : tiers)
    const rows = []
    let bal = start
    let goalTrades = hasGoal && goal <= start ? 0 : null

    const limit = fixedCount != null ? fixedCount : maxTrades
    for (let n = 1; n <= limit; n++) {
        const opening = bal
        const rate = useAmount ? (opening > 0 ? amt / opening : 0) : rateAt(opening)
        const profit = useAmount ? amt : opening * rate
        if (!useAmount && !(rate > 0)) break
        bal = opening + profit
        if (hasGoal && goalTrades === null && bal >= goal) {
            goalTrades = n
        }
        rows.push({
            n,
            label: `Trade #${n}`,
            opening,
            ratePct: rate * 100,
            profit,
            closing: bal,
            cumulativeReturnPct: ((bal - start) / start) * 100,
            progressPct: hasGoal ? (bal / goal) * 100 : null,
        })
        if (fixedCount == null && hasGoal && bal >= goal) {
            break
        }
    }

    // If a fixed horizon ended before reaching the goal, continue counting silently
    // up to maxTrades so we can still tell the trader which trade hits the goal.
    let reachedGoal = goalTrades !== null
    let hitCap = false
    if (fixedCount != null && hasGoal && goalTrades === null) {
        let probeBal = bal
        for (let n = rows.length + 1; n <= maxTrades; n++) {
            const rate = useAmount ? (probeBal > 0 ? amt / probeBal : 0) : rateAt(probeBal)
            const profit = useAmount ? amt : probeBal * rate
            if (!useAmount && !(rate > 0)) break
            probeBal += profit
            if (probeBal >= goal) {
                goalTrades = n
                reachedGoal = true
                break
            }
        }
        if (goalTrades === null) hitCap = true
    } else if (fixedCount == null && hasGoal && goalTrades === null) {
        hitCap = rows.length >= maxTrades
    }

    const finalBalance = rows.length ? rows[rows.length - 1].closing : start
    return {
        tradeCount: rows.length,
        startBalance: start,
        finalBalance,
        profit: finalBalance - start,
        totalReturnPct: ((finalBalance - start) / start) * 100,
        goalTrades,
        alreadyAtGoal: hasGoal && goal <= start,
        reachedGoal,
        hitCap,
        trades: rows,
    }
}

/** Compound % per trade needed to grow `start` to `goal` in `numTrades` trades. */
export function requiredPctPerTrade(start, goal, numTrades) {
    if (!(start > 0) || !(goal > 0) || !(numTrades >= 1)) return null
    if (goal <= start) return 0
    return (Math.pow(goal / start, 1 / Math.floor(numTrades)) - 1) * 100
}

/** Flat $ profit per trade needed to grow `start` to `goal` in `numTrades` trades. */
export function requiredAmountPerTrade(start, goal, numTrades) {
    if (!(start > 0) || !(goal > 0) || !(numTrades >= 1)) return null
    if (goal <= start) return 0
    return (goal - start) / Math.floor(numTrades)
}

/** How many trades at the plan's current target to reach `goal` from `start`. */
export function tradesToGoal({
    start,
    goal,
    pctPerTrade = 0,
    tradeAmount = null,
    tiers = [],
    maxTrades = MAX_TRADE_PROJECTION_STEPS,
} = {}) {
    if (!(start > 0) || !(goal > 0)) return null
    if (goal <= start) return { trades: 0, already: true, finalBalance: start }
    const proj = buildTradeProjection({ start, pctPerTrade, tradeAmount, goalBalance: goal, tiers, maxTrades })
    if (!proj || proj.goalTrades == null) return null
    return { trades: proj.goalTrades, already: false, finalBalance: proj.finalBalance }
}

const RR_LEVELS = [1, 1.5, 2, 3, 4, 5]

/**
 * Risk-based position size calculator:
 *   riskDollars = (riskMode === 'amount') ? riskAmount : balance * (riskPercent / 100)
 *   exactLot    = riskDollars / (slPips * pipValuePerLot)
 * Floored to 0.01 lot so actual risk never exceeds the trader's risk limit.
 */
export function calculateRiskLot({
    balance = null,
    riskMode = 'pct',
    riskPercent = null,
    riskAmount = null,
    slPips = null,
    symbol = 'XAUUSD',
    pipValueOverride = null,
} = {}) {
    const bal = Number(balance)
    const hasBalance = Number.isFinite(bal) && bal > 0
    const sl = Number(slPips)
    if (!(sl > 0)) return null

    const isAmount = riskMode === 'amount'
    let riskDollars = null
    if (isAmount) {
        const amt = Number(riskAmount)
        if (amt > 0) riskDollars = amt
    } else {
        const pct = Number(riskPercent)
        if (hasBalance && pct > 0) riskDollars = bal * (pct / 100)
    }
    if (!(riskDollars > 0)) return null

    const detectedPipSize = pipSizeFor(symbol)
    const detectedContractSize = contractSizeFor(symbol)
    const override = Number(pipValueOverride)
    const pipValue = Number.isFinite(override) && override > 0
        ? override
        : detectedPipSize * detectedContractSize
    if (!(pipValue > 0)) return null

    const exactLot = riskDollars / (sl * pipValue)
    const flooredLot = floorLot(exactLot)
    const belowMin = !(flooredLot >= LOT_STEP)
    const actualRiskDollars = belowMin ? 0 : flooredLot * sl * pipValue
    const minLotRiskDollars = LOT_STEP * sl * pipValue
    const maxSlAtMinLot = riskDollars / (LOT_STEP * pipValue)

    const rrTable = RR_LEVELS.map((rr) => {
        const tpPips = sl * rr
        const profitAtFloored = belowMin ? minLotRiskDollars * rr : actualRiskDollars * rr
        return {
            rr,
            label: `1:${rr}`,
            tpPips,
            profitDollars: profitAtFloored,
            returnPct: hasBalance ? (profitAtFloored / bal) * 100 : null,
            projectedBalance: hasBalance ? bal + profitAtFloored : null,
        }
    })

    return {
        riskDollars,
        riskPctOfBalance: hasBalance ? (riskDollars / bal) * 100 : null,
        pipSize: detectedPipSize,
        contractSize: detectedContractSize,
        pipValuePerLot: pipValue,
        isCustomPipValue: Number.isFinite(override) && override > 0,
        slPips: sl,
        exactLot,
        flooredLot,
        belowMin,
        actualRiskDollars,
        actualRiskPct: hasBalance ? (actualRiskDollars / bal) * 100 : null,
        minLotRiskDollars,
        minLotRiskPct: hasBalance ? (minLotRiskDollars / bal) * 100 : null,
        maxSlAtMinLot,
        rrTable,
    }
}

/**
 * Match closed trades from History (dayDocs) chronologically against a per-trade
 * Trading Plan starting from `startDate`.
 *
 * Returns:
 *   - trackedTrades: chronological list of included trades numbered #1..#K with
 *     actual P&L, running balance, and plan comparison at step #N
 *   - excludedTrades: eligible trades explicitly skipped by the trader
 *   - tradeMap: { [tradeId]: { status: 'tracked'|'excluded', n?, ... } } for O(1) lookup in History
 *   - milestoneStep / nextPlanStep: highest plan ladder step cleared by `currentBalance`
 *   - nextTrade: target dollars & projected balance for Trade #(K+1) on `currentBalance`
 *   - remainingToGoalDollars / tradesLeftAtPlanRate: remaining distance to `goalBalance`
 */
export function trackTradesAgainstPlan({
    startBalance = null,
    goalBalance = null,
    startDate = null,
    pctPerTrade = 0,
    tradeAmount = null,
    tiers = [],
    horizonTrades = null,
    dayDocs = [],
    account = '',
    excludedTradeIds = [],
    projection = null,
    tz = 'UTC',
} = {}) {
    const startNum = Number(startBalance)
    const hasStart = Number.isFinite(startNum) && startNum > 0
    const goalNum = Number(goalBalance)
    const hasGoal = Number.isFinite(goalNum) && goalNum > 0
    const startIso = typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())
        ? startDate.trim()
        : null
    const excludedSet = new Set((excludedTradeIds || []).map(String))
    const zone = tz || 'UTC'

    const eligible = []
    const seenKeys = new Set()

    for (const day of dayDocs || []) {
        const arr = Array.isArray(day?.trades) ? day.trades : []
        for (const t of arr) {
            if (!t || t.openPosition || t.tradesCount === 0) continue
            const tradeAcc = t.account || day.account || ''
            if (account && tradeAcc !== account) continue

            const closeUnix = Number(t.exitTime) || Number(t.closeTd) || Number(t.td) || Number(day.dateUnix) || 0
            let dateIso = ''
            if (closeUnix > 0) {
                try {
                    dateIso = dayjs.unix(closeUnix).tz(zone).format('YYYY-MM-DD')
                } catch {
                    dateIso = dayjs.unix(closeUnix).utc().format('YYYY-MM-DD')
                }
            }
            if (startIso && (!dateIso || dateIso < startIso)) continue

            const id = String(t.id ?? `${closeUnix}_${t.symbol || 'UNK'}_${t.entryTime || 0}`)
            const dedupeKey = `${id}::${closeUnix}::${t.entryTime || 0}`
            if (seenKeys.has(dedupeKey)) continue
            seenKeys.add(dedupeKey)

            const net = t.netProceeds != null
                ? (Number(t.netProceeds) || 0)
                : (Number(t.grossProceeds) || 0)
            const lotRaw = Math.max(Number(t.buyQuantity) || 0, Number(t.sellQuantity) || 0) || Number(t.quantity) || 0

            eligible.push({
                id,
                symbol: t.symbol || 'UNKNOWN',
                direction: t.strategy || t.side || '',
                lot: lotRaw > 0 ? lotRaw : null,
                entryTime: Number(t.entryTime) || 0,
                exitTime: Number(t.exitTime) || closeUnix,
                dateIso,
                net,
                excluded: excludedSet.has(id),
            })
        }
    }

    eligible.sort((a, b) => (a.exitTime - b.exitTime) || (a.entryTime - b.entryTime))

    const trackedTrades = []
    const excludedTrades = []
    const tradeMap = {}

    let runningBal = hasStart ? startNum : 0
    let totalNet = 0
    let wins = 0
    let losses = 0
    let breakEven = 0

    const planRows = Array.isArray(projection?.trades) ? projection.trades : []

    for (const tr of eligible) {
        if (tr.excluded) {
            excludedTrades.push(tr)
            tradeMap[tr.id] = { status: 'excluded', trade: tr }
            continue
        }

        const n = trackedTrades.length + 1
        const openingBalance = runningBal
        runningBal = openingBalance + tr.net
        totalNet += tr.net
        if (tr.net > 0) wins++
        else if (tr.net < 0) losses++
        else breakEven++

        const planRow = planRows[n - 1] || null
        const plannedProfit = planRow ? planRow.profit : null
        const plannedBalance = planRow ? planRow.closing : null
        const diffFromPlan = plannedBalance != null && hasStart ? runningBal - plannedBalance : null
        const beatTradeTarget = plannedProfit != null ? tr.net >= plannedProfit : null

        const item = {
            ...tr,
            n,
            openingBalance,
            actualBalance: runningBal,
            plannedProfit,
            plannedBalance,
            diffFromPlan,
            beatTradeTarget,
        }
        trackedTrades.push(item)
        tradeMap[tr.id] = {
            status: 'tracked',
            n,
            actualBalance: item.actualBalance,
            plannedBalance: item.plannedBalance,
            diffFromPlan: item.diffFromPlan,
            beatTradeTarget: item.beatTradeTarget,
            net: item.net,
        }
    }

    const tradesTaken = trackedTrades.length
    const decided = wins + losses
    const winRatePct = decided > 0 ? (wins / decided) * 100 : null
    const currentBalance = hasStart ? runningBal : null
    const actualReturnPct = hasStart ? (totalNet / startNum) * 100 : null

    const lastTracked = tradesTaken ? trackedTrades[tradesTaken - 1] : null
    const plannedAtStep = lastTracked?.plannedBalance ?? null
    const varianceAtStep = lastTracked?.diffFromPlan ?? null

    // Highest plan step whose closing balance has been reached by currentBalance
    let milestoneStep = 0
    if (hasStart && planRows.length) {
        for (const row of planRows) {
            if (currentBalance + 1e-6 >= row.closing) milestoneStep = row.n
            else break
        }
    }
    const nextMilestoneRow = planRows.find((r) => r.n === milestoneStep + 1) || null

    // Next trade sizing target based on currentBalance (or startBalance if 0 trades yet)
    const amt = Number(tradeAmount)
    const useAmount = Number.isFinite(amt) && amt > 0
    const pctNum = Number(pctPerTrade)
    const baseForNext = currentBalance != null ? currentBalance : (hasStart ? startNum : null)
    const rateAt = tierRateResolver(Number.isFinite(pctNum) ? pctNum : 0, useAmount ? [] : tiers)
    let nextTargetDollars = null
    if (useAmount) {
        nextTargetDollars = amt
    } else if (baseForNext > 0) {
        const rate = rateAt(baseForNext)
        if (rate > 0) nextTargetDollars = baseForNext * rate
    }

    const nextTrade = {
        n: tradesTaken + 1,
        baseBalance: baseForNext,
        targetDollars: nextTargetDollars,
        targetClosing: baseForNext != null && nextTargetDollars != null ? baseForNext + nextTargetDollars : null,
        planRow: planRows[tradesTaken] || null,
    }

    // Remaining distance & trades to Goal from currentBalance
    let goalReached = false
    let remainingToGoalDollars = null
    let progressToGoalPct = null
    let tradesLeftAtPlanRate = null

    if (hasGoal && hasStart) {
        goalReached = currentBalance + 1e-6 >= goalNum
        remainingToGoalDollars = goalReached ? 0 : Math.max(0, goalNum - currentBalance)
        if (goalNum > startNum) {
            progressToGoalPct = ((currentBalance - startNum) / (goalNum - startNum)) * 100
        } else {
            progressToGoalPct = currentBalance >= goalNum ? 100 : 0
        }
        if (goalReached) {
            tradesLeftAtPlanRate = 0
        } else if (currentBalance > 0) {
            const rem = tradesToGoal({
                start: currentBalance,
                goal: goalNum,
                pctPerTrade: Number.isFinite(pctNum) ? pctNum : 0,
                tradeAmount: useAmount ? amt : null,
                tiers: useAmount ? [] : tiers,
            })
            tradesLeftAtPlanRate = rem ? rem.trades : null
        }
    } else if (horizonTrades > 0) {
        progressToGoalPct = (tradesTaken / horizonTrades) * 100
    }

    const plannedTotalTrades = projection ? projection.tradeCount : (horizonTrades > 0 ? horizonTrades : null)

    return {
        startDate: startIso,
        eligibleCount: eligible.length,
        tradesTaken,
        excludedCount: excludedTrades.length,
        wins,
        losses,
        breakEven,
        winRatePct,
        actualNet: totalNet,
        actualReturnPct,
        currentBalance,
        plannedAtStep,
        varianceAtStep,
        milestoneStep,
        nextMilestoneRow,
        plannedTotalTrades,
        goalReached,
        remainingToGoalDollars,
        progressToGoalPct,
        tradesLeftAtPlanRate,
        nextTrade,
        trackedTrades,
        excludedTrades,
        tradeMap,
    }
}


/* ---- shared formatting ---- */
export const fmt = (n, d = 2) =>
    n == null || n === '' ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
/** fmt for space-constrained spots (stat tiles): from a million up, switch to
 *  K/M/B/T so an aggressive compounding target ("7.00T") still fits its box
 *  instead of spilling 20 digits over the neighbouring tile. 'en-US' on purpose:
 *  a Thai-locale compact form ("7 ล้านล้าน") is longer than what it replaces. */
export const fmtCompact = (n, d = 2) => {
    if (n == null || n === '') return '—'
    const v = Number(n)
    if (!(Math.abs(v) >= 1e6)) return fmt(v, d)
    return v.toLocaleString('en-US', { notation: 'compact', minimumFractionDigits: d, maximumFractionDigits: d })
}
export const pnlClass = (n) => (n == null ? '' : n > 0 ? 'greenTrade' : n < 0 ? 'redTrade' : '')
export const toneClass = (t) => (t === 'ok' ? 'greenTrade' : t === 'bad' ? 'redTrade' : t === 'warn' ? 'warnTrade' : '')
