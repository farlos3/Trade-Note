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

/** Weekdays between tomorrow and +months. */
export function tradingDaysAhead(months) {
    const startDay = dayjs().startOf('day')
    const end = startDay.add(months, 'month')
    let cur = startDay.add(1, 'day')
    let n = 0
    while (!cur.isAfter(end, 'day')) {
        const dow = cur.day()
        if (dow !== 0 && dow !== 6) n++
        cur = cur.add(1, 'day')
    }
    return n
}

/**
 * Compound pctPerDay over weekdays only, keeping every step so the maths can be
 * followed day by day: each trading day is opening -> +profit -> closing.
 */
export function buildProjection(start, pctPerDay, months) {
    const r = pctPerDay / 100
    const startDay = dayjs().startOf('day')
    const end = startDay.add(months, 'month')
    let bal = start
    let n = 0
    const days = []

    let cur = startDay.add(1, 'day')
    while (!cur.isAfter(end, 'day')) {
        const dow = cur.day() // 0 = Sun, 6 = Sat -> market closed, no compounding
        if (dow !== 0 && dow !== 6) {
            const opening = bal
            const profit = bal * r
            bal = opening + profit
            n++
            days.push({
                n,
                date: cur.format('YYYY-MM-DD'),
                weekday: cur.format('ddd'),
                opening,
                profit,
                closing: bal,
                cumulativeReturnPct: (bal / start - 1) * 100,
            })
        }
        cur = cur.add(1, 'day')
    }

    return {
        tradingDays: n,
        finalBalance: bal,
        totalReturnPct: (bal / start - 1) * 100,
        profit: bal - start,
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
        return {
            n: last.n,
            label: granularity === 'monthly' ? last.date.slice(0, 7) : `${first.date} → ${last.date}`,
            tradingDays: g.length,
            opening: first.opening,
            profit: last.closing - first.opening,
            closing: last.closing,
            cumulativeReturnPct: last.cumulativeReturnPct,
        }
    })
}

/** start * (1+r)^days = goal  ->  r = (goal/start)^(1/days) - 1, as a percentage. */
export function requiredPctPerDay(start, goal, tradingDays) {
    if (!(start > 0) || !(goal > 0) || !tradingDays) return null
    return (Math.pow(goal / start, 1 / tradingDays) - 1) * 100
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
