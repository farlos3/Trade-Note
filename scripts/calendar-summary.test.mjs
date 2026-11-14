#!/usr/bin/env node
/**
 * Unit tests for src/utils/calendarSummary.js — pure Node, no DB or browser.
 * Run: node scripts/calendar-summary.test.mjs
 */
import { buildCalendarWeeks, isSameYearMonth } from '../src/utils/calendarSummary.js'

let failures = 0
function check(name, cond, detail = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ' — ' + detail : ''}`)
    if (!cond) failures++
}

check('isSameYearMonth matches identical year/month', isSameYearMonth(2026, 10, 2026, 10) === true)
check('isSameYearMonth rejects different month', isSameYearMonth(2026, 9, 2026, 10) === false)
check('isSameYearMonth rejects different year', isSameYearMonth(2025, 10, 2026, 10) === false)

check('empty calendarData returns empty array', buildCalendarWeeks(null).length === 0)

const emptyCell = () => ({ month: 'November 2026', day: 0, dateUnix: null, pAndL: [] })
const dayCell = (day, net, gross, trades) => ({
    month: 'November 2026',
    day,
    dateUnix: 1700000000 + day * 86400,
    pAndL: trades > 0 ? { netProceeds: net, grossProceeds: gross, trades } : [],
})

const mockCalendar = {
    '0': [dayCell(1, 100, 110, 2), dayCell(2, -30, -25, 1), dayCell(3, 0, 0, 0), dayCell(4, 0, 0, 0), dayCell(5, 0, 0, 0), dayCell(6, 0, 0, 0), dayCell(7, 0, 0, 0)],
    '1': [dayCell(8, -50, -40, 2), dayCell(9, 0, 0, 0), dayCell(10, 0, 0, 0), dayCell(11, 0, 0, 0), dayCell(12, 0, 0, 0), dayCell(13, 0, 0, 0), dayCell(14, 0, 0, 0)],
    '2': [dayCell(15, 0, 0, 0), dayCell(16, 0, 0, 0), dayCell(17, 0, 0, 0), dayCell(18, 0, 0, 0), dayCell(19, 0, 0, 0), dayCell(20, 0, 0, 0), dayCell(21, 0, 0, 0)],
    '4': [dayCell(29, 0, 0, 1), dayCell(30, 0, 0, 0), emptyCell(), emptyCell(), emptyCell(), emptyCell(), emptyCell()],
}

const weeksNet = buildCalendarWeeks(mockCalendar, 'net')
check('produces 4 non-empty weeks', weeksNet.length === 4)
check('W1 rangeLabel is 1–7', weeksNet[0].rangeLabel === '1–7')
check('W1 net total is 70', weeksNet[0].total === 70 && weeksNet[0].trades === 3 && weeksNet[0].has === true)
check('W2 negative total is -50', weeksNet[1].total === -50 && weeksNet[1].trades === 2 && weeksNet[1].has === true)
check('W3 no trades has=false', weeksNet[2].has === false && weeksNet[2].trades === 0)
check('partial W4 rangeLabel is 29–30 and breakeven has=true', weeksNet[3].weekNum === 4 && weeksNet[3].rangeLabel === '29–30' && weeksNet[3].has === true && weeksNet[3].total === 0)

const weeksGross = buildCalendarWeeks(mockCalendar, 'gross')
check('W1 gross total is 85', weeksGross[0].total === 85)

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
}
console.log('\nAll checks passed')
