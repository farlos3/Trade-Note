/**
 * Trading-plan math, shared by the Trading Plan and Plan vs Actual pages.
 * Everything compounds on trading days only — weekends are market-closed.
 */
import dayjs from 'dayjs'

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

export function buildProjection(start, pctPerDay, months, deposits = [], fromDate, tiers = [], withdrawals = []) {
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
            // the account grows); flat plans return the same rate every day.
            const profit = (opening + dep) * rateAt(opening + dep)
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
function pipSizeFor(symbol) {
    const s = (symbol || '').toUpperCase()
    if (s.includes('JPY')) return 0.01
    if (s.includes('XAU')) return 0.01
    if (s.includes('XAG')) return 0.001
    return 0.0001
}

function contractSizeFor(symbol) {
    const s = (symbol || '').toUpperCase()
    if (s.includes('XAU')) return 100
    if (s.includes('XAG')) return 5000
    return 100000 // standard forex lot
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

/* ---- shared formatting ---- */
export const fmt = (n, d = 2) =>
    n == null || n === '' ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
export const pnlClass = (n) => (n == null ? '' : n > 0 ? 'greenTrade' : n < 0 ? 'redTrade' : '')
export const toneClass = (t) => (t === 'ok' ? 'greenTrade' : t === 'bad' ? 'redTrade' : t === 'warn' ? 'warnTrade' : '')
