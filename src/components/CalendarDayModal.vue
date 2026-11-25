<script setup>
/**
 * Day detail for the Calendar page: the day's stats, its equity line (running
 * closed P&L) and every closed trade. Opened by clicking a calendar cell; the
 * numbers come from summarizeDay over that day's document in filteredTrades.
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { amountCase, timeZoneTrade } from '../stores/globals'
import { useTwoDecCurrencyFormat, useHourMinuteFormat } from '../utils/utils'
import { summarizeDay } from '../utils/calendarSummary'
import dayjs from 'dayjs'

const props = defineProps({
    dayDoc: { type: Object, required: true },   // one filteredTrades entry (has .trades and .dateUnix)
})
const emit = defineEmits(['close'])

const day = computed(() => summarizeDay(props.dayDoc.trades, amountCase.value))
const title = computed(() => dayjs.unix(props.dayDoc.dateUnix).tz(timeZoneTrade.value).format('dddd, D MMMM YYYY'))
const signed = (n) => (n >= 0 ? '+' : '') + useTwoDecCurrencyFormat(n)

function duration(t) {
    const s = Math.max(0, Number(t.exitTime) - Number(t.entryTime))
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/* Equity line as an inline SVG: x = trade order, y = running total, starting at 0. */
const W = 600, H = 150, PAD = 8
const chart = computed(() => {
    const pts = [0, ...day.value.rows.map((r) => r.cumulative)]
    if (pts.length < 2) return null
    const min = Math.min(...pts), max = Math.max(...pts)
    const span = max - min || 1
    const x = (i) => PAD + (i * (W - 2 * PAD)) / (pts.length - 1)
    const y = (v) => PAD + ((max - v) * (H - 2 * PAD)) / span
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    return {
        line,
        area: `${line} L${x(pts.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`,
        zeroY: y(0).toFixed(1),
        up: day.value.total >= 0,
    }
})

const onKey = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
    <Teleport to="body">
        <div class="cdmBackdrop" v-on:click.self="emit('close')">
            <div class="cdmCard" role="dialog" aria-modal="true" :aria-label="title">
                <div class="cdmHead">
                    <span>{{ title }}</span>
                    <button type="button" class="cdmClose" aria-label="Close" v-on:click="emit('close')">
                        <i class="uil uil-times"></i>
                    </button>
                </div>

                <div class="cdmStats">
                    <div><span class="cdmLabel">Trades</span><strong>{{ day.rows.length }}</strong></div>
                    <div><span class="cdmLabel">Wins</span><strong class="greenTrade">{{ day.wins }}</strong></div>
                    <div><span class="cdmLabel">Losses</span><strong class="redTrade">{{ day.losses }}</strong></div>
                    <div><span class="cdmLabel">Win rate</span>
                        <strong>{{ day.winRatePct == null ? '—' : day.winRatePct.toFixed(1) + '%' }}</strong></div>
                </div>

                <div class="cdmTotal">
                    <span class="cdmLabel">Net P&amp;L</span>
                    <strong :class="day.total >= 0 ? 'greenTrade' : 'redTrade'">{{ signed(day.total) }}</strong>
                </div>

                <svg v-if="chart" class="cdmChart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
                    <defs>
                        <linearGradient id="cdmFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0" :stop-color="chart.up ? '#00CA73' : '#F6465D'" stop-opacity="0.25" />
                            <stop offset="1" :stop-color="chart.up ? '#00CA73' : '#F6465D'" stop-opacity="0" />
                        </linearGradient>
                    </defs>
                    <line :x1="0" :x2="W" :y1="chart.zeroY" :y2="chart.zeroY" class="cdmZero" />
                    <path :d="chart.area" fill="url(#cdmFill)" />
                    <path :d="chart.line" fill="none" :stroke="chart.up ? '#00CA73' : '#F6465D'" stroke-width="2"
                        vector-effect="non-scaling-stroke" stroke-linejoin="round" />
                </svg>

                <div class="cdmTableWrap">
                    <table class="cdmTable">
                        <thead>
                            <tr>
                                <th>Symbol</th><th>Side</th><th class="text-end">Size</th><th class="text-end">Entry</th>
                                <th class="text-end">Exit</th><th class="text-end">Duration</th><th class="text-end">P&amp;L</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(t, i) in day.rows" :key="t.id || i">
                                <td class="fw-semibold">{{ t.symbol }}</td>
                                <td :class="t.strategy === 'short' ? 'redTrade' : 'greenTrade'">{{ t.strategy === 'short' ? 'sell' : 'buy' }}</td>
                                <td class="text-end">{{ Math.max(t.buyQuantity || 0, t.sellQuantity || 0) }}</td>
                                <td class="text-end">{{ useHourMinuteFormat(t.entryTime) }}</td>
                                <td class="text-end">{{ useHourMinuteFormat(t.exitTime) }}</td>
                                <td class="text-end cdmMuted">{{ duration(t) }}</td>
                                <td class="text-end fw-bold" :class="t.pl >= 0 ? 'greenTrade' : 'redTrade'">{{ signed(t.pl) }}</td>
                            </tr>
                            <tr v-if="!day.rows.length"><td colspan="7" class="cdmMuted">No closed trades this day.</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.cdmBackdrop {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
}

.cdmCard {
    width: min(680px, 100%);
    max-height: calc(100vh - 2rem);
    display: flex;
    flex-direction: column;
    background: var(--black-bg-7);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    text-align: left;
}

.cdmHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.85rem 1rem;
    font-weight: 700;
    font-size: 1.05rem;
    border-bottom: 1px solid var(--border-subtle);
}

.cdmClose {
    border: 0;
    background: transparent;
    color: var(--white-60);
    font-size: 1.2rem;
}

.cdmClose:hover { color: var(--white-87); }

.cdmStats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-bottom: 1px solid var(--border-subtle);
}

.cdmStats > div {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.6rem 0.4rem;
    font-size: 1.05rem;
}

.cdmStats > div + div { border-left: 1px solid var(--border-subtle); }

.cdmLabel {
    font-size: 0.72rem;
    color: var(--white-60);
}

.cdmTotal {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
}

.cdmChart {
    width: 100%;
    height: 150px;
    display: block;
    flex: none;
}

.cdmZero {
    stroke: var(--border-strong);
    stroke-dasharray: 4 4;
    vector-effect: non-scaling-stroke;
}

.cdmTableWrap {
    overflow: auto;
    min-height: 0;
}

.cdmTable {
    width: 100%;
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
}

.cdmTable th {
    position: sticky;
    top: 0;
    background: var(--black-bg-5);
    color: var(--white-60);
    font-weight: 600;
    padding: 0.5rem 0.75rem;
}

.cdmTable td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border-subtle);
}

.cdmMuted { color: var(--white-60); }

@media (max-width: 576px) {
    .cdmStats { grid-template-columns: repeat(2, 1fr); }
    .cdmStats > div:nth-child(3) { border-left: 0; }
    .cdmTable th:nth-child(6), .cdmTable td:nth-child(6) { display: none; }
}
</style>
