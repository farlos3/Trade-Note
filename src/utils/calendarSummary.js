export function isSameYearMonth(aYear, aMonth, bYear, bMonth) {
    return Number(aYear) === Number(bYear) && Number(aMonth) === Number(bMonth)
}

export function buildCalendarWeeks(calendarData, amountCase = 'net') {
    if (!calendarData || typeof calendarData !== 'object') return []
    const key = amountCase + 'Proceeds'
    const rowKeys = Object.keys(calendarData)
        .filter((k) => Array.isArray(calendarData[k]))
        .sort((a, b) => Number(a) - Number(b))

    const weeks = []
    for (const rowKey of rowKeys) {
        const row = calendarData[rowKey]
        const validCells = row.filter((c) => c && Number(c.day) > 0)
        if (validCells.length === 0) continue

        let total = 0
        let trades = 0
        let has = false
        for (const cell of validCells) {
            const p = cell.pAndL
            if (!p || Array.isArray(p)) continue
            if (p[key] !== undefined || Number(p.trades || 0) > 0) {
                total += Number(p[key] || 0)
                trades += Number(p.trades || 0)
                has = true
            }
        }

        const startDay = Number(validCells[0].day)
        const endDay = Number(validCells[validCells.length - 1].day)
        const rangeLabel = startDay === endDay ? `${startDay}` : `${startDay}–${endDay}`

        weeks.push({
            index: Number(rowKey),
            weekNum: weeks.length + 1,
            cells: row,
            startDay,
            endDay,
            rangeLabel,
            total,
            trades,
            has,
        })
    }
    return weeks
}

/**
 * Month header stats for the Calendar page, from the same weeks the grid draws.
 * Wins/losses are trade counts (pAndL.<case>WinsCount / LossCount); a "green day"
 * is a traded day that closed >= 0. best/worst are null until a day has traded.
 */
export function summarizeMonth(weeks, amountCase = 'net') {
    const key = amountCase + 'Proceeds'
    const out = { total: 0, trades: 0, tradingDays: 0, greenDays: 0, wins: 0, losses: 0, best: null, worst: null }
    for (const w of weeks || []) {
        for (const cell of w.cells || []) {
            const p = cell && cell.pAndL
            if (!cell || !(Number(cell.day) > 0) || !p || Array.isArray(p) || !(Number(p.trades) > 0)) continue
            const total = Number(p[key] || 0)
            out.total += total
            out.trades += Number(p.trades)
            out.wins += Number(p[amountCase + 'WinsCount'] || 0)
            out.losses += Number(p[amountCase + 'LossCount'] || 0)
            out.tradingDays++
            if (total >= 0) out.greenDays++
            const d = { day: Number(cell.day), dateUnix: cell.dateUnix, total }
            if (!out.best || total > out.best.total) out.best = d
            if (!out.worst || total < out.worst.total) out.worst = d
        }
    }
    const decided = out.wins + out.losses
    out.winRatePct = decided > 0 ? (out.wins / decided) * 100 : null
    return out
}

/**
 * One day's closed trades for the day-detail modal, in close order, each with the
 * running total the equity line is drawn from. Open positions are left out (no
 * realised P&L yet), same as the dashboard.
 */
export function summarizeDay(trades, amountCase = 'net') {
    const key = amountCase + 'Proceeds'
    const rows = (trades || [])
        .filter((t) => t && !t.openPosition)
        .map((t) => ({ ...t, pl: Number(t[key] ?? t.grossProceeds ?? 0) }))
        .sort((a, b) => (Number(a.exitTime) - Number(b.exitTime)) || (Number(a.entryTime) - Number(b.entryTime)))
    let run = 0
    for (const r of rows) { run += r.pl; r.cumulative = run }
    const wins = rows.filter((r) => r.pl > 0).length
    const losses = rows.filter((r) => r.pl < 0).length
    return {
        rows,
        total: run,
        wins,
        losses,
        winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    }
}

