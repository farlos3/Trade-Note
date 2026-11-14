<script setup>
import { computed } from 'vue'
import { pageId, selectedMonth, selectedPlSatisfaction, amountCase, calendarData, miniCalendarsData, timeZoneTrade, spinnerLoadingPage, filteredTrades, notes } from '../stores/globals';
import { useThousandCurrencyFormat, useTwoDecCurrencyFormat, useMountCalendar, useMountDaily } from '../utils/utils';
import { buildCalendarWeeks, isSameYearMonth } from '../utils/calendarSummary';
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
dayjs.extend(utc)
import isoWeek from 'dayjs/plugin/isoWeek.js'
dayjs.extend(isoWeek)
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(timezone)
import duration from 'dayjs/plugin/duration.js'
dayjs.extend(duration)
import updateLocale from 'dayjs/plugin/updateLocale.js'
dayjs.extend(updateLocale)
import localizedFormat from 'dayjs/plugin/localizedFormat.js'
dayjs.extend(localizedFormat)
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
dayjs.extend(customParseFormat)


// Column order must match the calendarize() offset in utils/calendar.js (0 = Sunday).
const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]

const viewedMonthParts = computed(() => {
    const d = dayjs(selectedMonth.value.start * 1000).tz(timeZoneTrade.value)
    return { year: d.year(), month: d.month() }
})

const nowMonthParts = computed(() => {
    const d = dayjs().tz(timeZoneTrade.value)
    return { year: d.year(), month: d.month() }
})

const isViewingLatestMonth = computed(() =>
    isSameYearMonth(
        viewedMonthParts.value.year,
        viewedMonthParts.value.month,
        nowMonthParts.value.year,
        nowMonthParts.value.month
    )
)

const calendarWeeks = computed(() => buildCalendarWeeks(calendarData, amountCase.value))

// Year-at-a-glance summary. On the Calendar page filteredTrades already spans
// the full calendar year (see useGetSelectedRange), independent of which month
// the grid above is showing, so aggregate it per month plus a year total.
const yearSummary = computed(() => {
    const year = viewedMonthParts.value.year
    const { year: nowYear, month: nowMonth } = nowMonthParts.value
    const key = amountCase.value + 'Proceeds'
    const months = Array.from({ length: 12 }, (_, m) => ({
        m,
        label: dayjs().month(m).format('MMM'),
        total: 0,
        trades: 0,
        has: false,
        isLatest: isSameYearMonth(year, m, nowYear, nowMonth)
    }))
    for (const t of filteredTrades) {
        if (Number(t.year) !== year) continue
        const mi = Number(t.month)
        if (mi < 0 || mi > 11 || !t.pAndL) continue
        months[mi].total += Number(t.pAndL[key] || 0)
        months[mi].trades += Number(t.pAndL.trades || 0)
        months[mi].has = true
    }
    const yearTotal = months.reduce((s, x) => s + x.total, 0)
    return { year, months, yearTotal }
})

//console.log("perdio range "+JSON.stringify(periodRange))

async function monthLastNext(param) {
    await (spinnerLoadingPage.value = true)
    selectedMonth.value.start = dayjs.tz(selectedMonth.value.start * 1000, timeZoneTrade.value).add(param, 'month').startOf('month').unix()
    /* reuse just created .start because we only show one month at a time */
    selectedMonth.value.end = dayjs.tz(selectedMonth.value.start * 1000, timeZoneTrade.value).endOf('month').unix()
    //console.log("selectedMonth.value.start " + selectedMonth.value.start+" selectedMonth.value.end " + selectedMonth.value.end)
    localStorage.setItem('selectedMonth', JSON.stringify(selectedMonth.value))
    
    if (pageId.value == "calendar") {
        useMountCalendar()
    }

    if (pageId.value == "daily") {
        useMountDaily()
    }
}
</script>
<template>
    <div class="col-12">
        <div v-bind:class="[pageId === 'calendar' ? 'justify-content-center' : '', 'row']">
            <div class="col-12">
                <div class="calMonthNav">
                    <i class="uil uil-angle-left-b calNavBtn pointerClass" v-on:click="monthLastNext(-1)"></i>
                    <span class="calMonthLabelWrap" v-if="calendarData.hasOwnProperty(0)">
                        <span class="calMonthLabel">{{ calendarData[0][0].month }}</span>
                        <span v-if="pageId == 'calendar' && isViewingLatestMonth" class="calLatestBadge" title="Latest month">
                            <span class="calLatestDot"></span>Latest
                        </span>
                    </span>
                    <i class="uil uil-angle-right-b calNavBtn pointerClass" v-on:click="monthLastNext(1)"></i>
                </div>
            </div>
        </div>
    </div>
    <div v-bind:class="[pageId === 'calendar' ? 'mb-4' : '', 'col-12']">
        <div v-if="pageId == 'calendar'" class="calMonthGrid">
            <div class="calWeekday" v-for="day in days" :key="day">{{ day }}</div>
            <div class="calWeekday calWeekHeading">Weekly</div>
            <template v-for="w in calendarWeeks" :key="w.index">
                <template v-for="(cell, dIdx) in w.cells" :key="`${w.index}-${dIdx}`">
                    <div v-if="cell && cell.day > 0"
                        v-bind:class="[{ 'greenTradeDiv': selectedPlSatisfaction == 'pl' ? cell.pAndL[amountCase + 'Proceeds'] >= 0 : cell.satisfaction == true, 'redTradeDiv': selectedPlSatisfaction == 'pl' ? cell.pAndL[amountCase + 'Proceeds'] < 0 : cell.satisfaction == false }, 'calDivDash', 'calCellPos']">
                        <!-- Same whole-day note flag as the History day cards -- a
                             note set on this date shows here too. -->
                        <i v-if="cell.dateUnix && notes.some(n => n.tradeId === 'day' && n.dateUnix === cell.dateUnix && n.note && n.note.trim())"
                            class="uil uil-bell calNoteBell" title="Day note"></i>
                        <p class="mb-1 dayNumber">{{ cell.day }}</p>
                        <div class="d-none d-md-block text-center calCellBody">
                            <p class="calAmount mb-1" v-show="cell.pAndL[amountCase + 'Proceeds'] !== undefined">
                                {{ (cell.pAndL[amountCase + 'Proceeds'] >= 0 ? '+' : '') + useTwoDecCurrencyFormat(cell.pAndL[amountCase + 'Proceeds']) }}
                            </p>
                            <p class="calTrades mb-0" v-show="cell.pAndL.trades">{{ cell.pAndL.trades }} trades</p>
                        </div>
                    </div>
                    <div v-else class="calDivDash calDayEmpty"></div>
                </template>
                <div v-bind:class="['calWeekCell', w.has ? (w.total >= 0 ? 'calWeekWin' : 'calWeekLoss') : 'calWeekEmpty']">
                    <div class="calWeekMeta">
                        <span class="calWeekNum">W{{ w.weekNum }}</span>
                        <span class="calWeekRange">{{ w.rangeLabel }}</span>
                    </div>
                    <div class="calWeekAmount" v-if="w.has">
                        {{ (w.total >= 0 ? '+' : '') + useTwoDecCurrencyFormat(w.total) }}
                    </div>
                    <div class="calWeekDash" v-else>—</div>
                    <div class="calWeekTrades" v-if="w.has">{{ w.trades }} {{ w.trades === 1 ? 'trade' : 'trades' }}</div>
                </div>
            </template>
        </div>
        <div v-else class="row">
            <div class="col" v-for="(day, index) in days" :key="day">
                <div class="calWeekday">{{ day }}</div>
                <div v-for="(line, lineIdx) in calendarData" :key="lineIdx">
                    <div class="row">
                        <div v-show="line[index] != 0"
                            v-bind:class="[{ 'greenTradeDiv': selectedPlSatisfaction == 'pl' ? line[index].pAndL[amountCase + 'Proceeds'] >= 0 : line[index].satisfaction == true, 'redTradeDiv': selectedPlSatisfaction == 'pl' ? line[index].pAndL[amountCase + 'Proceeds'] < 0 : line[index].satisfaction == false, 'calDivDay': pageId == 'daily', 'calDivDash': pageId == 'calendar' }, 'col', 'calCellPos']">
                            <!-- Same whole-day note flag as the History day cards -- a
                                 note set on this date shows here too. -->
                            <i v-if="line[index].dateUnix && notes.some(n => n.tradeId === 'day' && n.dateUnix === line[index].dateUnix && n.note && n.note.trim())"
                                class="uil uil-bell calNoteBell" title="Day note"></i>
                            <p class="mb-1 dayNumber" v-show="line[index].day != 0">{{ line[index].day }}</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- YEAR-AT-A-GLANCE SUMMARY -->
    <div v-if="pageId == 'calendar'" class="col-12 mt-2 mb-4">
        <div class="yearSummaryHead">
            <span class="yearSummaryTitle">{{ yearSummary.year }} summary</span>
            <span class="yearSummaryTotal" :class="yearSummary.yearTotal >= 0 ? 'ySumPos' : 'ySumNeg'">
                {{ (yearSummary.yearTotal >= 0 ? '+' : '') + useTwoDecCurrencyFormat(yearSummary.yearTotal) }}
            </span>
        </div>
        <div class="yearGrid">
            <div v-for="mo in yearSummary.months" :key="mo.m"
                v-bind:class="['yearCell', mo.has ? (mo.total >= 0 ? 'yearWin' : 'yearLoss') : 'yearEmpty', { 'yearCellLatest': mo.isLatest }]">
                <div class="yearMonth">
                    <span>{{ mo.label }}</span>
                    <span v-if="mo.isLatest" class="yearLatestBadge" title="Latest month">
                        <span class="calLatestDot"></span>Latest
                    </span>
                </div>
                <div class="yearAmount" v-show="mo.has">
                    {{ (mo.total >= 0 ? '+' : '') + useTwoDecCurrencyFormat(mo.total) }}
                </div>
                <div class="yearTrades" v-show="mo.has">{{ mo.trades }} trades</div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.calMonthNav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.25rem;
    margin-bottom: 0.75rem;
}

.calMonthLabelWrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
}

.calMonthLabel {
    font-weight: 700;
    font-size: 1rem;
    color: var(--white-87);
    min-width: 130px;
    text-align: center;
}

.calLatestBadge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.14rem 0.5rem;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--blue-active-color, #38bdf8);
    background: rgba(56, 189, 248, 0.14);
    border: 1px solid rgba(56, 189, 248, 0.35);
    line-height: 1.2;
}

.calLatestDot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: #00CA73;
    box-shadow: 0 0 6px #00CA73;
    flex-shrink: 0;
}

.calNavBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    color: var(--white-87);
    background-color: var(--black-bg-7);
    border: 1px solid var(--border-subtle);
    font-size: 1.1rem;
    transition: background-color 0.15s ease, border-color 0.15s ease;
}

.calNavBtn:hover {
    background-color: var(--surface-hover);
    border-color: var(--border-strong);
}

/* Calendar-page 8-column grid (Su..Sa + Weekly summary) */
.calMonthGrid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr)) minmax(140px, 1fr);
    gap: 6px;
    align-items: stretch;
}

.calMonthGrid .calWeekday {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--white-60);
    padding-bottom: 0.2rem;
    border: 1px solid transparent;
    text-align: center;
}

.calMonthGrid .calWeekHeading {
    color: var(--blue-active-color, #38bdf8);
    margin-left: 14px;
    position: relative;
}

.calMonthGrid .calWeekHeading::before,
.calWeekCell::before {
    content: '';
    position: absolute;
    left: -11px;
    top: -4px;
    bottom: -4px;
    width: 1px;
    background: var(--border-strong, rgba(255, 255, 255, 0.18));
    pointer-events: none;
}

.calMonthGrid .calWeekHeading::before {
    top: 2px;
}

.calWeekCell:last-child::before {
    bottom: 0;
}

.calMonthGrid .calDivDash {
    margin: 0;
    height: 100%;
}

.calDayEmpty {
    opacity: 0.32;
    pointer-events: none;
}

.calWeekCell {
    position: relative;
    margin-left: 14px;
    border-radius: var(--radius-sm, 8px);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    padding: 0.55rem 0.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.18rem;
    text-align: center;
}

.calWeekEmpty {
    background-color: var(--black-bg-7, rgba(255, 255, 255, 0.02));
    color: var(--white-60);
}

.calWeekWin {
    background-color: rgba(0, 202, 115, 0.09);
    border-color: rgba(0, 202, 115, 0.28);
}

.calWeekLoss {
    background-color: rgba(246, 70, 93, 0.09);
    border-color: rgba(246, 70, 93, 0.28);
}

.calWeekMeta {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--white-70, rgba(237, 240, 247, 0.72));
}

.calWeekNum {
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.06rem 0.32rem;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.07);
    color: var(--white-87, rgba(237, 240, 247, 0.92));
}

.calWeekRange {
    opacity: 0.85;
}

.calWeekAmount {
    font-weight: 800;
    font-size: 1.05rem;
    line-height: 1.2;
}

.calWeekWin .calWeekAmount {
    color: #00CA73;
}

.calWeekLoss .calWeekAmount {
    color: var(--red-color, #F6465D);
}

.calWeekDash {
    font-size: 0.95rem;
    opacity: 0.5;
}

.calWeekTrades {
    font-weight: 600;
    font-size: 0.76rem;
    color: var(--white-60, rgba(237, 240, 247, 0.6));
}

@media (max-width: 767.98px) {
    .calMonthGrid {
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 4px;
    }

    .calWeekHeading {
        display: none;
    }

    .calWeekCell {
        grid-column: 1 / -1;
        flex-direction: row;
        justify-content: space-between;
        min-height: 36px;
        padding: 0.35rem 0.65rem;
        margin-left: 0;
        margin-bottom: 0.35rem;
    }

    .calWeekCell::before {
        display: none;
    }

    .calWeekAmount {
        font-size: 0.92rem;
    }
}

/* Calendar-page day cells: heavier text, centered + larger P/L amount */
.calDivDash {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}

.calDivDash .calCellBody {
    width: 100%;
}

.calCellPos {
    position: relative;
}

/* Small badge in the cell's corner -- unobtrusive at the mini-calendar's tiny
   cell size, still legible on the full Calendar page's larger cells. */
.calNoteBell {
    position: absolute;
    top: 2px;
    right: 3px;
    font-size: 0.7rem;
    color: #f59e0b;
    text-shadow: 0 0 4px rgba(245, 158, 11, 0.6);
}

.dayNumber {
    font-weight: 700;
    color: #ffffff;
}

.calCellBody {
    font-weight: 600;
    color: #ffffff;
}

.calTrades {
    font-weight: 600;
    font-size: 0.82rem;
    color: #ffffff;
}

.calAmount {
    text-align: center;
    font-weight: 800;
    font-size: 1.1rem;
    line-height: 1.2;
    color: #ffffff;
}

/* Near-black text on both fills -- bright green and the still-light red both
   contrast better with dark labels than with white ones. */
.greenTradeDiv .dayNumber,
.greenTradeDiv .calTrades,
.greenTradeDiv .calAmount {
    color: #013820;
}

.redTradeDiv .dayNumber,
.redTradeDiv .calTrades,
.redTradeDiv .calAmount {
    color: #2a0808;
}

/* ===== Year-at-a-glance summary ===== */
.yearSummaryHead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.6rem;
    padding: 0 0.25rem;
}

.yearSummaryTitle {
    font-weight: 700;
    font-size: 1rem;
    color: var(--white-87, rgba(255, 255, 255, 0.87));
}

.yearSummaryTotal {
    font-weight: 800;
    font-size: 1.15rem;
}

.ySumPos {
    color: #00CA73;
}

.ySumNeg {
    color: var(--red-color);
}

.yearGrid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 0.6rem;
}

@media (max-width: 992px) {
    .yearGrid {
        grid-template-columns: repeat(3, 1fr);
    }
}

@media (max-width: 576px) {
    .yearGrid {
        grid-template-columns: repeat(2, 1fr);
    }
}

.yearCell {
    border-radius: 10px;
    padding: 0.7rem 0.5rem;
    text-align: center;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
    min-height: 76px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
}

.yearCellLatest {
    box-shadow: 0 0 0 1.5px rgba(56, 189, 248, 0.7);
}

.yearEmpty {
    background-color: var(--black-bg-7, rgba(255, 255, 255, 0.02));
    color: var(--white-50, rgba(255, 255, 255, 0.4));
}

/* Same bright green as the day cells (.greenTradeDiv), so the year strip
   matches the grid above -- near-black text on both fills. */
.yearWin {
    background-color: #00CA73;
    border-color: #00CA73;
    color: #013820;
}

.yearLoss {
    background-color: var(--red-color);
    border-color: var(--red-color);
    color: #350f0d;
}

/* Explicit on each child so nothing else in the cascade can win a different
   color back. */
.yearWin .yearMonth,
.yearWin .yearAmount,
.yearWin .yearTrades {
    color: #013820;
}

.yearLoss .yearMonth,
.yearLoss .yearAmount,
.yearLoss .yearTrades {
    color: #350f0d;
}

.yearMonth {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    font-weight: 700;
    font-size: 0.9rem;
}

.yearLatestBadge {
    display: inline-flex;
    align-items: center;
    gap: 0.24rem;
    padding: 0.1rem 0.38rem;
    border-radius: 999px;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(14, 16, 21, 0.55);
    color: #edf0f7;
    border: 1px solid rgba(255, 255, 255, 0.25);
    line-height: 1.15;
}

.yearAmount {
    font-weight: 800;
    font-size: 1.05rem;
}

.yearTrades {
    font-weight: 600;
    font-size: 0.72rem;
    opacity: 0.85;
}
</style>