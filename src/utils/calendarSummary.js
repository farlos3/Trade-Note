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
