<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { startBalance, horizonMonths, dailyPct, goalBalance } from '../utils/planSettings'
import {
    numOrNull, tradingDaysAhead, buildProjection, rollup, requiredPctPerDay, realismVerdict,
    fmt, pnlClass, toneClass,
} from '../utils/planMath'

/* Pure calculator — no journal data involved. Inputs start empty on purpose:
   nothing is computed until you enter your own numbers. */
const start = computed(() => numOrNull(startBalance.value))
const months = computed(() => {
    const n = numOrNull(horizonMonths.value)
    return n != null && n >= 1 && n <= 120 ? Math.floor(n) : null
})
const target = computed(() => numOrNull(dailyPct.value))
const goal = computed(() => numOrNull(goalBalance.value))

const projection = computed(() =>
    start.value > 0 && months.value && target.value != null
        ? buildProjection(start.value, target.value, months.value)
        : null,
)

const goalSeek = computed(() => {
    if (!(start.value > 0) || !(goal.value > 0) || !months.value) return null
    const days = tradingDaysAhead(months.value)
    const p = requiredPctPerDay(start.value, goal.value, days)
    if (p == null) return null
    return { requiredPctPerDay: p, tradingDays: days, ...realismVerdict(p) }
})

/* How far to zoom into the compounding: every trading day, or rolled up. */
const GRANULARITIES = [
    { id: 'daily', label: 'Daily' },
    { id: 'weekly', label: 'Weekly' },
    { id: 'monthly', label: 'Monthly' },
]
const granularity = ref('daily')
const rows = computed(() => (projection.value ? rollup(projection.value.days, granularity.value) : []))

/* ---- Balance curve (one series per trading day) ----
   Single series, so no legend — the card title names it. Colors come from the
   app's own theme tokens; text stays in text tokens, never the series colour. */
const ACCENT = '#2f9bff'
const SURFACE = '#1b1f2a'
const INK_MUTED = 'rgba(237, 240, 247, 0.40)'

const chartEl = ref(null)
let chart = null

function renderChart() {
    if (!chartEl.value || !projection.value) return
    if (!chart) chart = echarts.init(chartEl.value)
    const days = projection.value.days

    chart.setOption({
        backgroundColor: 'transparent',
        grid: { left: 4, right: 12, top: 16, bottom: 4, containLabel: true },
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.25)', width: 1 } },
            backgroundColor: SURFACE,
            borderColor: 'rgba(255,255,255,0.12)',
            textStyle: { color: 'rgba(237,240,247,0.92)', fontSize: 12 },
            formatter: (params) => {
                const d = days[params[0].dataIndex]
                if (!d) return ''
                return `<div style="font-weight:700;margin-bottom:4px">Day ${d.n} · ${d.date} · ${d.weekday}</div>` +
                    `Opening: ${fmt(d.opening)}<br/>` +
                    `Profit: ${fmt(d.profit)}<br/>` +
                    `<b>Closing: ${fmt(d.closing)}</b><br/>` +
                    `Cumulative: ${fmt(d.cumulativeReturnPct)}%`
            },
        },
        xAxis: {
            type: 'category',
            data: days.map((d) => d.date),
            boundaryGap: false,
            axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
            axisTick: { show: false },
            axisLabel: { color: INK_MUTED, fontSize: 10, hideOverlap: true },
        },
        yAxis: {
            type: 'value',
            scale: true,
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
            axisLabel: { color: INK_MUTED, fontSize: 10, formatter: (v) => Number(v).toLocaleString() },
        },
        series: [{
            type: 'line',
            data: days.map((d) => d.closing),
            showSymbol: false,          // markers appear on hover only
            symbolSize: 8,
            lineStyle: { color: ACCENT, width: 2 },
            // 2px surface ring so the hovered point reads against the line
            itemStyle: { color: ACCENT, borderColor: SURFACE, borderWidth: 2 },
            areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(47,155,255,0.28)' },
                    { offset: 1, color: 'rgba(47,155,255,0.02)' },
                ]),
            },
        }],
    }, true)
    chart.resize()
}

const onResize = () => chart && chart.resize()

onMounted(() => {
    renderChart()
    window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
    if (chart) { chart.dispose(); chart = null }
})

// The chart element only exists once there is a projection, so wait for the DOM.
watch(projection, async (p) => {
    if (!p) {
        if (chart) { chart.dispose(); chart = null }
        return
    }
    await nextTick()
    renderChart()
})
</script>

<template>
    <div class="planPage p-3">
        <p class="txt-small text-muted mb-3">
            Compounds on trading days only — weekends (market closed) are skipped.
            To compare this plan against what you actually traded, see <a href="/plan-vs-actual">Plan vs Actual</a>.
        </p>

        <div class="planInputs mb-4">
            <div>
                <label class="planLabel">Starting balance</label>
                <input type="number" min="0" step="100" placeholder="e.g. 1000" class="form-control form-control-sm"
                    v-model="startBalance" />
            </div>
            <div>
                <label class="planLabel">Horizon (months)</label>
                <input type="number" min="1" max="120" step="1" placeholder="e.g. 3" class="form-control form-control-sm"
                    v-model="horizonMonths" />
            </div>
        </div>

        <!-- ---------- Target projection ---------- -->
        <div class="planCard mb-3">
            <div class="planCardHead">
                <span class="planCardTitle">Target projection</span>
                <div class="inlineInput">
                    <label class="planLabel mb-0">Target % per day</label>
                    <input type="number" step="0.1" placeholder="e.g. 1" class="form-control form-control-sm"
                        v-model="dailyPct" />
                </div>
            </div>

            <template v-if="projection">
                <div class="statGrid my-3">
                    <div class="statTile">
                        <div class="statLabel">Trading days</div>
                        <div class="statValue">{{ projection.tradingDays }}</div>
                        <div class="statSub">Mon–Fri only</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Projected balance</div>
                        <div class="statValue" v-bind:class="pnlClass(projection.profit)">{{ fmt(projection.finalBalance) }}</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Total profit</div>
                        <div class="statValue" v-bind:class="pnlClass(projection.profit)">{{ fmt(projection.profit) }}</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Total return</div>
                        <div class="statValue" v-bind:class="pnlClass(projection.totalReturnPct)">{{ fmt(projection.totalReturnPct) }}%</div>
                    </div>
                </div>

                <!-- Balance curve, one point per trading day -->
                <div class="chartWrap mb-3">
                    <div class="chartTitle">Balance per trading day</div>
                    <div ref="chartEl" class="chartBox"></div>
                </div>

                <!-- Step-by-step compounding -->
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
                    <span class="txt-small text-muted">
                        Each trading day: <code>closing = opening × (1 + {{ fmt(target, 2) }}%)</code> — the next day opens
                        on that closing balance.
                    </span>
                    <div class="btn-group btn-group-sm" role="group">
                        <button v-for="g in GRANULARITIES" :key="g.id" type="button"
                            v-bind:class="['btn', 'btn-sm', granularity === g.id ? 'btn-primary' : 'btn-outline-secondary']"
                            v-on:click="granularity = g.id">{{ g.label }}</button>
                    </div>
                </div>

                <div class="tableScroll">
                    <table class="table table-sm breakTable mb-0">
                        <thead>
                            <tr>
                                <th>{{ granularity === 'daily' ? 'Day' : 'Period' }}</th>
                                <th class="text-end" v-if="granularity !== 'daily'">Days</th>
                                <th class="text-end">Opening</th>
                                <th class="text-end">Profit</th>
                                <th class="text-end">Closing</th>
                                <th class="text-end">Cumulative</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="r in rows" :key="r.label">
                                <td>
                                    <span v-if="granularity === 'daily'" class="dayNum">{{ r.n }}</span>{{ r.label }}
                                </td>
                                <td class="text-end" v-if="granularity !== 'daily'">{{ r.tradingDays }}</td>
                                <td class="text-end">{{ fmt(r.opening) }}</td>
                                <td class="text-end" v-bind:class="pnlClass(r.profit)">{{ fmt(r.profit) }}</td>
                                <td class="text-end fw-bold">{{ fmt(r.closing) }}</td>
                                <td class="text-end" v-bind:class="pnlClass(r.cumulativeReturnPct)">{{ fmt(r.cumulativeReturnPct) }}%</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="txt-small text-muted mt-2 mb-0">
                    {{ rows.length }} rows · weekends skipped (market closed)
                </p>
            </template>
            <div v-else class="hintLine">Enter a starting balance, horizon, and target % per day.</div>
        </div>

        <!-- ---------- Goal seek ---------- -->
        <div class="planCard">
            <div class="planCardHead">
                <span class="planCardTitle">Goal seek — what % per day do I need?</span>
                <div class="inlineInput">
                    <label class="planLabel mb-0">Goal balance</label>
                    <input type="number" min="0" step="100" placeholder="e.g. 10000" class="form-control form-control-sm"
                        v-model="goalBalance" />
                </div>
            </div>

            <template v-if="goalSeek">
                <p class="goalLine mt-3 mb-1">
                    To reach <strong>{{ fmt(goal, 0) }}</strong> from <strong>{{ fmt(start, 0) }}</strong>
                    in <strong>{{ months }}</strong> month(s) — {{ goalSeek.tradingDays }} trading days — you need
                    <strong v-bind:class="toneClass(goalSeek.tone)">{{ fmt(goalSeek.requiredPctPerDay, 3) }}% per day</strong>.
                </p>
                <p class="txt-small mb-0" v-bind:class="toneClass(goalSeek.tone)">
                    <i class="uil uil-info-circle me-1"></i>{{ goalSeek.verdict }}
                </p>
            </template>
            <div v-else class="hintLine">Enter a starting balance, horizon, and goal balance.</div>
        </div>

        <p class="txt-small text-muted mt-3">
            <i class="uil uil-exclamation-triangle me-1"></i>Projections are hypothetical: they assume a constant daily
            return with full compounding. Real results vary — use them to set targets, not as a guarantee.
        </p>
    </div>
</template>

<style scoped>
.statGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.75rem;
}

.statTile {
    background-color: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
}

.statLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
}

.statValue {
    font-size: 1.35rem;
    font-weight: 700;
    margin-top: 0.15rem;
}

.statSub {
    font-size: 0.72rem;
    opacity: 0.6;
}

.breakTable {
    font-size: 0.85rem;
}

.chartWrap {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    padding: 0.6rem 0.4rem 0.4rem;
}

.chartTitle {
    font-size: 0.75rem;
    font-weight: 600;
    opacity: 0.6;
    padding-left: 0.5rem;
}

.chartBox {
    width: 100%;
    height: 260px;
}

/* The daily view can run to hundreds of rows — keep the card a sane height. */
.tableScroll {
    max-height: 420px;
    overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.4rem;
}

.tableScroll thead th {
    position: sticky;
    top: 0;
    background-color: #1b1f2a;
    z-index: 1;
}

.dayNum {
    display: inline-block;
    min-width: 2.2rem;
    opacity: 0.45;
}

.planInputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.75rem;
    max-width: 430px;
}

.planLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin-bottom: 0.2rem;
    display: block;
}

.planCard {
    border: 1px solid rgba(255, 255, 255, 0.06);
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 0.6rem;
    padding: 0.9rem 1rem;
}

.planCardHead {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 0.75rem;
}

.planCardTitle {
    font-weight: 700;
}

.inlineInput {
    min-width: 170px;
}

.goalLine {
    font-size: 0.92rem;
}

.hintLine {
    font-size: 0.85rem;
    opacity: 0.6;
    margin-top: 0.75rem;
}

/* amber: "aggressive" verdicts sit between the app's green/red */
.warnTrade {
    color: #e0a800;
}
</style>
