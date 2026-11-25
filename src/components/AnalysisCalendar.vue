<script setup>
/**
 * Trading calendar for the AI Analysis page: the analysed period's days laid out by
 * month (P&L, trades, W/L per day, a weekly total column) with the month's headline
 * stats. Built only from the analysis response's `daily` rows, so it always shows
 * exactly the window the analysis used. Month helpers are the Calendar page's own
 * (calendarSummary.js), so both calendars count a month the same way.
 */
import { ref, computed, watch } from 'vue'
import { buildCalendarWeeks, summarizeMonth, monthGridFromDaily } from '../utils/calendarSummary'

const props = defineProps({
    daily: { type: Array, default: () => [] },
})

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// Months that have trades in the period, oldest first ("YYYY-MM").
const months = computed(() => [...new Set(props.daily.map((d) => String(d.date).slice(0, 7)))].sort())
const idx = ref(0)
watch(months, (m) => { idx.value = Math.max(0, m.length - 1) }, { immediate: true })   // newest by default

const ym = computed(() => {
    const key = months.value[idx.value]
    return key ? { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 } : null
})
const weeks = computed(() => (ym.value ? buildCalendarWeeks(monthGridFromDaily(props.daily, ym.value.year, ym.value.month), 'net') : []))
const summary = computed(() => summarizeMonth(weeks.value, 'net'))
// Older cached analyses carry no per-day wins/losses; hide the W/L parts then.
const hasWl = computed(() => props.daily.some((d) => d.wins != null))

const pl = (cell) => (cell && cell.pAndL && !Array.isArray(cell.pAndL) ? cell.pAndL : null)
const money = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
const dayLabel = (d) => (d && ym.value ? `${d.day} ${MONTHS[ym.value.month].slice(0, 3)}` : '')
</script>

<template>
    <div v-if="ym" class="acCard mb-4">
        <div class="acHead">
            <h6 class="mb-0 acTitle">Trading calendar</h6>
            <div class="acNav">
                <button type="button" class="acNavBtn" :disabled="idx === 0" aria-label="Previous month"
                    v-on:click="idx--"><i class="uil uil-angle-left-b"></i></button>
                <span class="acMonth">{{ MONTHS[ym.month] }} {{ ym.year }}</span>
                <button type="button" class="acNavBtn" :disabled="idx >= months.length - 1" aria-label="Next month"
                    v-on:click="idx++"><i class="uil uil-angle-right-b"></i></button>
            </div>
        </div>

        <div class="acStats">
            <div>
                <span class="acLabel">Month P&amp;L</span>
                <strong :class="summary.total >= 0 ? 'greenTrade' : 'redTrade'">{{ money(summary.total) }}</strong>
                <span class="acSub">{{ summary.trades }} trades</span>
            </div>
            <div>
                <span class="acLabel">Green days</span>
                <strong>{{ summary.greenDays }} <span class="acSub">/ {{ summary.tradingDays }} days</span></strong>
                <span class="acSub" v-if="summary.tradingDays">{{ Math.round(summary.greenDays / summary.tradingDays * 100) }}% of traded days</span>
            </div>
            <div>
                <span class="acLabel">Win rate</span>
                <strong>{{ hasWl && summary.winRatePct != null ? Math.round(summary.winRatePct) + '%' : '—' }}</strong>
                <span class="acSub" v-if="hasWl"><span class="greenTrade">{{ summary.wins }}W</span> / <span class="redTrade">{{ summary.losses }}L</span></span>
            </div>
            <div>
                <span class="acLabel">Best day</span>
                <strong class="greenTrade">{{ summary.best ? money(summary.best.total) : '—' }}</strong>
                <span class="acSub">{{ dayLabel(summary.best) }}</span>
            </div>
            <div>
                <span class="acLabel">Worst day</span>
                <strong class="redTrade">{{ summary.worst ? money(summary.worst.total) : '—' }}</strong>
                <span class="acSub">{{ dayLabel(summary.worst) }}</span>
            </div>
        </div>

        <div class="acGrid">
            <div class="acWeekday" v-for="d in DAYS" :key="d">{{ d }}</div>
            <div class="acWeekday">Week</div>
            <template v-for="w in weeks" :key="w.index">
                <template v-for="(cell, i) in w.cells" :key="`${w.index}-${i}`">
                    <div v-if="cell.day > 0 && pl(cell) && pl(cell).trades > 0"
                        :class="['acDay', pl(cell).netProceeds >= 0 ? 'acWin' : 'acLoss']">
                        <span class="acDayNum">{{ cell.day }}</span>
                        <span class="acAmt" :class="pl(cell).netProceeds >= 0 ? 'greenTrade' : 'redTrade'">{{ money(pl(cell).netProceeds) }}</span>
                        <span class="acSub">{{ pl(cell).trades }} trades</span>
                        <span v-if="pl(cell).netWinsCount != null" class="acWl">
                            <span class="greenTrade">{{ pl(cell).netWinsCount }}W</span> / <span class="redTrade">{{ pl(cell).netLossCount }}L</span>
                        </span>
                    </div>
                    <div v-else-if="cell.day > 0" class="acDay acEmpty"><span class="acDayNum">{{ cell.day }}</span></div>
                    <div v-else class="acPad"></div>
                </template>
                <div class="acDay acWeek">
                    <span class="acSub">Total</span>
                    <template v-if="w.has">
                        <span class="acAmt" :class="w.total >= 0 ? 'greenTrade' : 'redTrade'">{{ money(w.total) }}</span>
                        <span class="acSub">{{ w.trades }} trades</span>
                    </template>
                    <span v-else class="acSub">—</span>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.acCard {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    background: rgba(255, 255, 255, 0.02);
    overflow: hidden;
}

.acHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
}

.acTitle { font-weight: 700; }

.acNav { display: flex; align-items: center; gap: 0.5rem; }
.acMonth { font-weight: 700; min-width: 9rem; text-align: center; }

.acNavBtn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
    background: var(--black-bg-7);
    color: var(--white-87);
}

.acNavBtn:disabled { opacity: 0.35; }

.acStats {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    border-bottom: 1px solid var(--border-subtle);
}

.acStats > div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.6rem 0.9rem;
}

.acStats > div + div { border-left: 1px solid var(--border-subtle); }
.acStats strong { font-size: 1.2rem; font-weight: 800; }
.acLabel { font-size: 0.72rem; color: var(--white-60); }
.acSub { font-size: 0.7rem; color: var(--white-60); font-weight: 400; }

.acGrid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr)) minmax(80px, 1fr);
    gap: 6px;
    padding: 0.9rem;
}

.acWeekday {
    text-align: center;
    font-size: 0.75rem;
    color: var(--white-60);
    padding-bottom: 0.2rem;
}

.acDay {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 74px;
    padding: 0.35rem 0.2rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    text-align: center;
    line-height: 1.25;
}

.acWin { background: rgba(0, 202, 115, 0.12); border-color: rgba(0, 202, 115, 0.3); }
.acLoss { background: rgba(246, 70, 93, 0.12); border-color: rgba(246, 70, 93, 0.3); }
.acEmpty .acDayNum { color: var(--white-38); }
.acWeek { background: rgba(255, 255, 255, 0.03); border-color: var(--border-subtle); }

.acDayNum { font-size: 0.72rem; color: var(--white-60); }
.acAmt { font-weight: 800; font-size: 0.9rem; }
.acWl { font-size: 0.68rem; font-weight: 600; }

@media (max-width: 768px) {
    .acStats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .acStats > div { border-left: 0 !important; border-top: 1px solid var(--border-subtle); }
    .acGrid { gap: 3px; padding: 0.5rem; grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .acGrid > .acWeekday:nth-child(8), .acWeek { display: none; }
    .acDay { min-height: 48px; }
    .acDay .acSub, .acWl { display: none; }
    .acAmt { font-size: 0.68rem; }
}
</style>
