<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import axios from 'axios'
import dayjs from 'dayjs'
import { timeZoneTrade } from '../stores/globals'
import PlanSelector from '../components/PlanSelector.vue'
import PlanDepositsEditor from '../components/PlanDepositsEditor.vue'
import FpDate from '../components/FpDate.vue'
import { activePlan } from '../utils/planStore'
import { numOrNull, buildProjection, fmt, pnlClass } from '../utils/planMath'

/* Everything here reads from the active plan (see PlanSelector) — the same
   plan you edit on the Trading Plan page, including its deposits. */
const start = computed(() => numOrNull(activePlan.value.startBalance))
const months = computed(() => {
    const n = numOrNull(activePlan.value.horizonMonths)
    return n != null && n >= 1 && n <= 120 ? Math.floor(n) : null
})
const target = computed(() => numOrNull(activePlan.value.dailyPct))
const startDate = computed(() => activePlan.value.startDate)
const deposits = computed(() => activePlan.value.deposits)
const withdrawals = computed(() => activePlan.value.withdrawals || [])
const tiers = computed(() => activePlan.value.tiers || [])
const hasTiers = computed(() =>
    tiers.value.some((t) => t && t.pct !== '' && t.pct != null && Number.isFinite(Number(t.pct))),
)

/* ---- Real per-day P&L from the journal ---- */
const PERIODS = [
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
    { id: '90d', label: '90 days' },
    { id: 'all', label: 'All' },
]
const period = ref('30d')
const loading = ref(false)
const error = ref(null)
const daily = ref(null)

function rangeFor(p) {
    if (p === 'all') return { from: null, to: null }
    const d = p === '7d' ? 7 : p === '90d' ? 90 : 30
    return { from: dayjs().subtract(d, 'day').format('YYYY-MM-DD'), to: dayjs().add(1, 'day').format('YYYY-MM-DD') }
}

async function load() {
    loading.value = true
    error.value = null
    try {
        const { from, to } = rangeFor(period.value)
        const params = { tz: timeZoneTrade.value || 'UTC' }
        if (from) params.from = from
        if (to) params.to = to
        const res = await axios.get('/api/analysis/behavior', { params })
        daily.value = res.data.daily || []
    } catch (e) {
        error.value = e?.response?.data?.error || e.message
        daily.value = null
    } finally {
        loading.value = false
    }
}

// Pull the real account's traded P&L automatically — on open and whenever the
// period changes — so "actual" always reflects the live journal without a click.
onMounted(load)
watch(period, load)

const actual = computed(() => {
    if (!daily.value || !daily.value.length) return null
    const totalNet = daily.value.reduce((s, d) => s + d.net, 0)
    const avgDailyNet = totalNet / daily.value.length
    return {
        tradedDays: daily.value.length,
        winDays: daily.value.filter((d) => d.net > 0).length,
        totalNet,
        avgDailyNet,
        pctPerDay: start.value > 0 ? (avgDailyNet / start.value) * 100 : null,
    }
})

/** Real equity curve: your actual balance day by day, stepping by each traded
   day's real net P&L (real ups/downs — NOT a smoothed average). The Plan line is
   the target rate compounded over the same trading days, for a like-for-like
   "where I am vs where the plan said" comparison. Deposits aren't added here —
   this tracks trading P&L, not cash movements. */
const equity = computed(() => {
    if (!daily.value || !daily.value.length || !(start.value > 0)) return null
    const rows = [...daily.value].sort((a, b) => (a.date < b.date ? -1 : 1))
    const s = start.value
    const t = target.value
    let bal = s
    const dates = [], actual = [], plan = []
    // Same numbers expressed as profit rather than balance, for the P&L views.
    const cumActual = [], cumPlan = [], dayActual = [], dayPlan = []
    rows.forEach((d, i) => {
        const net = Number(d.net) || 0
        bal += net
        dates.push(d.date)
        actual.push(Number(bal.toFixed(2)))
        cumActual.push(Number((bal - s).toFixed(2)))
        dayActual.push(Number(net.toFixed(2)))
        if (t != null) {
            const planBal = s * Math.pow(1 + t / 100, i + 1)
            plan.push(Number(planBal.toFixed(2)))
            cumPlan.push(Number((planBal - s).toFixed(2)))
            // Profit the plan needs on this specific day: the compounded balance
            // going into the day, times the daily rate. It grows day by day, so a
            // flat line here would understate what the plan asks for later on.
            dayPlan.push(Number((s * Math.pow(1 + t / 100, i) * (t / 100)).toFixed(2)))
        } else {
            plan.push(null); cumPlan.push(null); dayPlan.push(null)
        }
    })
    return { dates, actual, plan, cumActual, cumPlan, dayActual, dayPlan }
})

/** Same horizon, but compounding at the rate you actually achieved. */
const actualProjection = computed(() =>
    actual.value?.pctPerDay != null && start.value > 0 && months.value
        ? buildProjection(start.value, actual.value.pctPerDay, months.value, deposits.value, startDate.value)
        : null,
)

/** The plan's own projection, for a side-by-side comparison. */
const targetProjection = computed(() =>
    start.value > 0 && months.value && (target.value != null || hasTiers.value)
        ? buildProjection(start.value, target.value == null ? 0 : target.value,
            months.value, deposits.value, startDate.value, tiers.value, withdrawals.value)
        : null,
)

/* ---- Compounding curves: plan vs actual pace ----
   Two series, so a legend is always shown. Colours are fixed per series
   (identity, not rank) and validated for colour-blind separation against this
   dark surface. Deliberately NOT green/red — those mean profit/loss here. */
const PLAN_COLOR = '#2f9bff'   // app accent, same hue the Trading Plan chart uses
const ACTUAL_COLOR = '#f59e0b' // amber: CVD-separated from the blue on every channel
const SURFACE = '#1b1f2a'
const INK_MUTED = 'rgba(237, 240, 247, 0.60)'

// Profit/loss colouring, only used by the daily bars where the sign IS the
// message. The line charts stay blue/amber so plan-vs-actual never reads as
// good-vs-bad.
const WIN_COLOR = '#00CA73'
const LOSS_COLOR = '#f87171'

const CHART_MODES = [
    { value: 'equity', label: 'Equity', title: 'Equity — your actual trades per day vs plan pace' },
    { value: 'cumulative', label: 'Cumulative P&L', title: 'Cumulative profit since the start balance vs plan pace' },
    { value: 'daily', label: 'Daily P&L', title: 'Profit per traded day vs the profit the plan needs that day' },
]
const chartMode = ref(localStorage.getItem('planVsActualChartMode') || 'equity')
if (!CHART_MODES.some((m) => m.value === chartMode.value)) chartMode.value = 'equity'
watch(chartMode, (v) => localStorage.setItem('planVsActualChartMode', v))

const chartTitle = computed(
    () => (CHART_MODES.find((m) => m.value === chartMode.value) || CHART_MODES[0]).title,
)

const chartEl = ref(null)
let chart = null

const hasChart = computed(() => !!equity.value)

function renderChart() {
    if (!chartEl.value || !hasChart.value) return
    if (!chart) chart = echarts.init(chartEl.value)

    const eq = equity.value
    const dates = eq.dates
    const mode = chartMode.value
    const planData = mode === 'equity' ? eq.plan : mode === 'cumulative' ? eq.cumPlan : eq.dayPlan
    const actualData = mode === 'equity' ? eq.actual : mode === 'cumulative' ? eq.cumActual : eq.dayActual
    const planName = mode === 'daily'
        ? `Plan needs (${fmt(target.value, 2)}%/day)`
        : `Plan (${fmt(target.value, 2)}%/day)`

    const series = []
    if (planData.some((v) => v != null)) {
        series.push({
            name: planName,
            type: 'line',
            data: planData,
            showSymbol: false,
            lineStyle: { color: PLAN_COLOR, width: 2, type: 'dashed' },
            itemStyle: { color: PLAN_COLOR, borderColor: SURFACE, borderWidth: 2 },
            z: 3,
        })
    }
    if (mode === 'daily') {
        // Bars, not a line: each day is an independent amount, and colouring by
        // sign is the whole point of this view.
        series.push({
            name: 'Actual (real trades)',
            type: 'bar',
            data: actualData.map((v) => ({
                value: v,
                itemStyle: { color: v >= 0 ? WIN_COLOR : LOSS_COLOR },
            })),
            barMaxWidth: 28,
            z: 2,
        })
    } else {
        series.push({
            name: 'Actual (real trades)',
            type: 'line',
            data: actualData,
            showSymbol: true,
            symbolSize: 6,
            lineStyle: { color: ACTUAL_COLOR, width: 2 },
            itemStyle: { color: ACTUAL_COLOR, borderColor: SURFACE, borderWidth: 2 },
            areaStyle: { color: 'rgba(245, 158, 11, 0.08)' },
        })
    }

    chart.setOption({
        backgroundColor: 'transparent',
        legend: {
            top: 0,
            textStyle: { color: INK_MUTED, fontSize: 11 },
            itemWidth: 14,
            itemHeight: 8,
        },
        grid: { left: 4, right: 12, top: 34, bottom: 4, containLabel: true },
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.25)', width: 1 } },
            backgroundColor: SURFACE,
            borderColor: 'rgba(255,255,255,0.12)',
            textStyle: { color: 'rgba(237,240,247,0.92)', fontSize: 12 },
            formatter: (params) => {
                const i = params[0].dataIndex
                const head = `<div style="font-weight:700;margin-bottom:4px">${dates[i]}</div>`
                const lines = params.map(
                    (p) => `${p.marker} ${p.seriesName}: <b>${fmt(p.value)}</b>`,
                )
                if (params.length === 2) {
                    const diff = params[1].value - params[0].value
                    lines.push(`<span style="opacity:.7">Gap: ${diff >= 0 ? '+' : ''}${fmt(diff)}</span>`)
                }
                return head + lines.join('<br/>')
            },
        },
        xAxis: {
            type: 'category',
            data: dates,
            // Bars need to sit inside their slot; lines should reach the edges.
            boundaryGap: mode === 'daily',
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
        series,
    }, true)
    chart.resize()
}

const onResize = () => chart && chart.resize()
window.addEventListener('resize', onResize)

onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
    if (chart) { chart.dispose(); chart = null }
})

// The canvas only exists once there is something to draw. Switching mode has to
// re-render too, since the series type and axis change with it.
watch([equity, chartMode], async () => {
    if (!hasChart.value) {
        if (chart) { chart.dispose(); chart = null }
        return
    }
    await nextTick()
    renderChart()
}, { immediate: true })
</script>

<template>
    <div class="planPage p-3">
        <PlanSelector />

        <p class="txt-small text-muted mb-3">
            Compares what you actually traded against the plan you set on
            <a href="/plan">Trading Plan</a>. This is the same plan — editing it here updates that page too.
        </p>

        <!-- Plan inputs (shared with /plan) -->
        <div class="planInputs mb-3">
            <div>
                <label class="planLabel">Start date</label>
                <FpDate mode="date" v-model="activePlan.startDate" />
            </div>
            <div>
                <label class="planLabel">Starting balance</label>
                <input type="number" min="0" step="100" placeholder="e.g. 1000" class="form-control form-control-sm"
                    v-model="activePlan.startBalance" />
            </div>
            <div>
                <label class="planLabel">Horizon (months)</label>
                <input type="number" min="1" max="120" step="1" placeholder="e.g. 3" class="form-control form-control-sm"
                    v-model="activePlan.horizonMonths" />
            </div>
            <div>
                <label class="planLabel">Target % per day</label>
                <input type="number" step="0.1" placeholder="e.g. 1" class="form-control form-control-sm"
                    v-model="activePlan.dailyPct" />
            </div>
        </div>

        <div class="planCard mb-3">
            <PlanDepositsEditor :plan="activePlan" />
        </div>

        <div class="planCard">
            <div class="planCardHead">
                <span class="planCardTitle">Your actual results</span>
                <div class="d-flex align-items-center gap-2">
                    <div class="btn-group btn-group-sm" role="group">
                        <button v-for="p in PERIODS" :key="p.id" type="button"
                            v-bind:class="['btn', 'btn-sm', period === p.id ? 'btn-primary' : 'btn-outline-secondary']"
                            v-on:click="period = p.id">{{ p.label }}</button>
                    </div>
                    <button type="button" class="btn btn-success btn-sm" v-on:click="load" :disabled="loading">
                        <span v-if="loading" class="spinner-border spinner-border-sm me-2" role="status"></span>
                        Load my results
                    </button>
                </div>
            </div>

            <div v-if="error" class="alert alert-danger py-2 mt-3 mb-0">{{ error }}</div>
            <div v-else-if="daily === null" class="hintLine">
                Click <strong>Load my results</strong> to pull the P&amp;L you actually made, per day, from your journal.
            </div>
            <div v-else-if="!actual" class="hintLine">No trades in the selected period — nothing to compare against yet.</div>
            <div v-else-if="!(start > 0)" class="hintLine">Enter a starting balance above to express your results as % per day.</div>
            <template v-else>
                <div class="statGrid my-3">
                    <div class="statTile">
                        <div class="statLabel">Principal</div>
                        <div class="statValue">{{ fmt(start, 0) }}</div>
                        <div class="statSub">starting balance</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Days traded</div>
                        <div class="statValue">{{ actual.tradedDays }}</div>
                        <div class="statSub">{{ actual.winDays }} green · {{ actual.tradedDays - actual.winDays }} red</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Avg P&amp;L / day</div>
                        <div class="statValue" v-bind:class="pnlClass(actual.avgDailyNet)">{{ fmt(actual.avgDailyNet) }}</div>
                        <div class="statSub">net {{ fmt(actual.totalNet) }}</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Actual % per day</div>
                        <div class="statValue" v-bind:class="pnlClass(actual.pctPerDay)">{{ fmt(actual.pctPerDay, 3) }}%</div>
                        <div class="statSub">of {{ fmt(start, 0) }}</div>
                    </div>
                    <div class="statTile" v-if="target != null">
                        <div class="statLabel">Gap vs target</div>
                        <div class="statValue" v-bind:class="pnlClass(actual.pctPerDay - target)">
                            {{ fmt(actual.pctPerDay - target, 3) }}%
                        </div>
                        <div class="statSub">target {{ fmt(target, 2) }}% / day</div>
                    </div>
                </div>

                <div v-if="hasChart" class="chartWrap mb-3">
                    <div class="chartHead">
                        <div class="chartTitle">{{ chartTitle }}</div>
                        <div class="chartModes" role="group" aria-label="Chart type">
                            <button v-for="m in CHART_MODES" :key="m.value" type="button"
                                :class="['chartModeBtn', { active: chartMode === m.value }]"
                                :aria-pressed="chartMode === m.value" v-on:click="chartMode = m.value">
                                {{ m.label }}
                            </button>
                        </div>
                    </div>
                    <div ref="chartEl" class="chartBox"></div>
                </div>

                <p v-if="actualProjection" class="goalLine mb-0">
                    At your actual pace, {{ fmt(start, 0) }} becomes
                    <strong v-bind:class="pnlClass(actualProjection.profit)">{{ fmt(actualProjection.finalBalance) }}</strong>
                    in {{ months }} month(s)
                    (<span v-bind:class="pnlClass(actualProjection.totalReturnPct)">{{ fmt(actualProjection.totalReturnPct) }}%</span>)<span
                        v-if="targetProjection"> — vs <strong class="planHi">{{ fmt(targetProjection.finalBalance) }}</strong>
                        (<span class="planHi">{{ fmt(targetProjection.totalReturnPct) }}%</span>) if you hit your
                        <span class="targetHi">{{ fmt(target, 2) }}%/day target</span></span>.
                </p>
                <p v-else-if="!months" class="hintLine mb-0">Enter a horizon above to project your actual pace forward.</p>

                <p class="txt-small text-muted mt-2 mb-0">
                    <i class="uil uil-info-circle me-1"></i>Actual % per day = average daily net P&amp;L ÷ your starting
                    balance, over the days you actually traded in the selected period.
                </p>
            </template>
        </div>
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

.planInputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.75rem;
    max-width: 720px;
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

.goalLine {
    font-size: 0.92rem;
}

/* Plan target highlight — same blue as the Plan line in the chart, so the
   target figure reads as "plan", distinct from the green/red actual. */
.planHi {
    color: #2f9bff;
    font-weight: 700;
}

.targetHi {
    font-weight: 700;
    text-decoration: underline;
}

.chartWrap {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    padding: 0.6rem 0.4rem 0.4rem;
}

.chartHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
}

.chartTitle {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--white-60);
    padding-left: 0.5rem;
}

.chartModes {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 0.4rem;
    background: rgba(255, 255, 255, 0.04);
}

.chartModeBtn {
    border: 0;
    background: transparent;
    color: var(--white-60);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.25rem 0.6rem;
    border-radius: 0.3rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease;
}

.chartModeBtn:hover {
    color: var(--white-87);
}

.chartModeBtn.active {
    background: rgba(47, 155, 255, 0.18);
    color: #2f9bff;
}

.chartBox {
    width: 100%;
    height: 280px;
}

/* Explicit colour, not opacity: opacity would multiply with the inherited
   alpha and drop this below the readable threshold. */
.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
    margin-top: 0.75rem;
}
</style>
