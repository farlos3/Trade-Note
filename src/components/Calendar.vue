<script setup>
import { computed } from 'vue'
import { pageId, selectedMonth, selectedPlSatisfaction, amountCase, calendarData, miniCalendarsData, timeZoneTrade, spinnerLoadingPage, filteredTrades } from '../stores/globals';
import { useThousandCurrencyFormat, useTwoDecCurrencyFormat, useMountCalendar, useMountDaily } from '../utils/utils';
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

// Year-at-a-glance summary. On the Calendar page filteredTrades already spans
// the full calendar year (see useGetSelectedRange), independent of which month
// the grid above is showing, so aggregate it per month plus a year total.
const yearSummary = computed(() => {
    const year = dayjs(selectedMonth.value.start * 1000).tz(timeZoneTrade.value).year()
    const key = amountCase.value + 'Proceeds'
    const months = Array.from({ length: 12 }, (_, m) => ({
        m, label: dayjs().month(m).format('MMM'), total: 0, trades: 0, has: false
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
                    <span class="calMonthLabel" v-if="calendarData.hasOwnProperty(0)">{{ calendarData[0][0].month }}</span>
                    <i class="uil uil-angle-right-b calNavBtn pointerClass" v-on:click="monthLastNext(1)"></i>
                </div>
            </div>
        </div>
    </div>
    <div v-bind:class="[pageId === 'calendar' ? 'mb-4' : '', 'col-12']">
        <div class="row">
            <div class="col" v-for="(day, index) in days">
                <div class="calWeekday">{{ day }}</div>
                <div v-for="line in calendarData">
                    <div class="row">
                        <div v-show="line[index] != 0"
                            v-bind:class="[{ 'greenTradeDiv': selectedPlSatisfaction == 'pl' ? line[index].pAndL[amountCase + 'Proceeds'] >= 0 : line[index].satisfaction == true, 'redTradeDiv': selectedPlSatisfaction == 'pl' ? line[index].pAndL[amountCase + 'Proceeds'] < 0 : line[index].satisfaction == false, 'calDivDay': pageId == 'daily', 'calDivDash': pageId == 'calendar' }, 'col']">
                            <p class="mb-1 dayNumber" v-show="line[index].day != 0">{{ line[index].day }}</p>
                            <div v-if="pageId == 'calendar'" class="d-none d-md-block text-center calCellBody">
                                <p class="calAmount mb-1" v-show="line[index].pAndL[amountCase + 'Proceeds']">
                                    {{ (line[index].pAndL[amountCase + 'Proceeds'] >= 0 ? '+' : '') + useTwoDecCurrencyFormat(line[index].pAndL[amountCase + 'Proceeds']) }}
                                </p>
                                <p class="calTrades mb-0" v-show="line[index].pAndL.trades">{{ line[index].pAndL.trades }} trades</p>
                            </div>
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
                v-bind:class="['yearCell', mo.has ? (mo.total >= 0 ? 'yearWin' : 'yearLoss') : 'yearEmpty']">
                <div class="yearMonth">{{ mo.label }}</div>
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

.calMonthLabel {
    font-weight: 700;
    font-size: 1rem;
    color: var(--white-87);
    min-width: 130px;
    text-align: center;
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
    font-weight: 700;
    font-size: 0.9rem;
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