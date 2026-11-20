<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import PlanSelector from '../components/PlanSelector.vue'
import PlanLotSizing from '../components/PlanLotSizing.vue'
import RiskLotCalculator from '../components/RiskLotCalculator.vue'
import FpDate from '../components/FpDate.vue'
import { activePlan, addTradeTier, removeTradeTier } from '../utils/planStore'
import { activeAccount } from '../utils/mt5Accounts'
import { usePlanTracker } from '../utils/usePlanTracker'
import {
    numOrNull, requiredPctPerTrade, requiredAmountPerTrade,
    tradesToGoal, dollarsToPips, pipsRealismVerdict, pipValuePerLot,
    tierRateResolver, LOT_STEP, withLots, fmt, fmtCompact, pnlClass, toneClass,
} from '../utils/planMath'

/* ---- Top-level sub-tabs inside Trading Plan ---- */
const TABS = [
    { id: 'plan', label: 'Per-Trade Plan', icon: 'uil-chart-line' },
    { id: 'lotCalc', label: 'Risk & Lot Size', icon: 'uil-balance-scale' },
]
const storedTab = localStorage.getItem('tradenote_plan_tab')
const activeTab = ref(TABS.some((t) => t.id === storedTab) ? storedTab : 'plan')
watch(activeTab, (v) => localStorage.setItem('tradenote_plan_tab', v))

/* ---- Shared plan projection + live History tracker ---- */
const { projection, tracker, loading: trackerLoading, refresh: refreshTracker, toggleSkipTrade } = usePlanTracker()

/* ---- Per-trade plan inputs ---- */
const start = computed(() => numOrNull(activePlan.value.startBalance))
const goal = computed(() => numOrNull(activePlan.value.goalBalance))
const horizonTrades = computed(() => {
    const n = numOrNull(activePlan.value.horizonTrades)
    return n != null && n >= 1 ? Math.min(Math.floor(n), 2000) : null
})

const targetMode = computed({
    get: () => (activePlan.value.tradeTargetMode === 'amount' ? 'amount' : 'pct'),
    set: (v) => { activePlan.value.tradeTargetMode = v === 'amount' ? 'amount' : 'pct' },
})
const tradePct = computed(() => numOrNull(activePlan.value.tradePct))
const tradeAmount = computed(() => numOrNull(activePlan.value.tradeAmount))
const isAmountMode = computed(() => targetMode.value === 'amount')

const tiers = computed(() => activePlan.value.tradeTiers || [])
const hasTiers = computed(() =>
    tiers.value.some((t) => t && t.pct !== '' && t.pct != null && Number.isFinite(Number(t.pct))),
)
const hasAnyTarget = computed(() =>
    isAmountMode.value ? tradeAmount.value > 0 : (tradePct.value > 0 || hasTiers.value),
)

/* Exact trade count to reach goal at the current target (even when horizonTrades differs) */
const goalTradesResult = computed(() => {
    if (!(start.value > 0) || !(goal.value > 0) || !hasAnyTarget.value) return null
    return tradesToGoal({
        start: start.value,
        goal: goal.value,
        pctPerTrade: tradePct.value == null ? 0 : tradePct.value,
        tradeAmount: isAmountMode.value ? tradeAmount.value : null,
        tiers: isAmountMode.value ? [] : tiers.value,
    })
})

/* Required %/trade and $/trade to hit goal within `horizonTrades` */
const goalSeek = computed(() => {
    if (!(start.value > 0) || !(goal.value > 0) || !horizonTrades.value) return null
    const pctNeeded = requiredPctPerTrade(start.value, goal.value, horizonTrades.value)
    const amtNeeded = requiredAmountPerTrade(start.value, goal.value, horizonTrades.value)
    if (pctNeeded == null) return null
    return {
        trades: horizonTrades.value,
        requiredPctPerTrade: pctNeeded,
        requiredAmountPerTrade: amtNeeded,
    }
})

const targetVsGoalSeek = computed(() => {
    if (!goalSeek.value || isAmountMode.value || !(tradePct.value > 0)) return null
    const gap = tradePct.value - goalSeek.value.requiredPctPerTrade
    return { gap, onTrack: gap >= 0 }
})

function applyGoalSeekToTarget() {
    if (!goalSeek.value) return
    targetMode.value = 'pct'
    activePlan.value.tradePct = Number(goalSeek.value.requiredPctPerTrade.toFixed(3))
}

/* ---- Pip distance & lot sizing ---- */
const sizingPips = computed(() => {
    const n = numOrNull(activePlan.value.targetPips)
    return n > 0 ? n : null
})

const lotSize = computed(() => numOrNull(activePlan.value.lotSize))

const trade1TargetDollars = computed(() => {
    if (isAmountMode.value) return tradeAmount.value > 0 ? tradeAmount.value : null
    if (!(start.value > 0) || (tradePct.value == null && !hasTiers.value)) return null
    const dollars = start.value * tierRateResolver(tradePct.value, tiers.value)(start.value)
    return dollars > 0 ? dollars : null
})

/* Size the next trade on current live balance once trades have started */
const nextTradeDollars = computed(() => tracker.value.nextTrade?.targetDollars ?? trade1TargetDollars.value)
const nextTradeBasis = computed(() => {
    if (isAmountMode.value || hasTiers.value) return ''
    const bal = tracker.value.nextTrade?.baseBalance ?? start.value
    if (!(bal > 0) || !(tradePct.value > 0)) return ''
    return `${fmt(tradePct.value, 2)}% of ${fmt(bal, 0)}`
})

const trade1PipsNeeded = computed(() => {
    if (!projection.value || !(lotSize.value > 0)) return null
    const t1Profit = projection.value.trades[0]?.profit
    const pips = dollarsToPips(t1Profit, activePlan.value.symbol, lotSize.value)
    return pips == null ? null : { pips, ...pipsRealismVerdict(pips) }
})

const goalSeekPipsTrade1 = computed(() => {
    if (!goalSeek.value || !(start.value > 0) || !(lotSize.value > 0)) return null
    const t1Dollars = start.value * (goalSeek.value.requiredPctPerTrade / 100)
    const pips = dollarsToPips(t1Dollars, activePlan.value.symbol, lotSize.value)
    return pips == null ? null : { pips, ...pipsRealismVerdict(pips) }
})

const hasActualTrades = computed(() => tracker.value.trackedTrades.length > 0)

const rows = computed(() => {
    const liveSteps = tracker.value.liveSteps || []
    if (!liveSteps.length) return []
    const withLotRows = withLots(liveSteps, sizingPips.value, activePlan.value.symbol)
    const nextN = tracker.value.nextTrade?.n
    const goalHitN = tracker.value.liveGoalStep

    return withLotRows.map((r) => ({
        ...r,
        lotShort: r.lot != null && r.profit > 0 && r.lotDollars < 0.9 * r.profit,
        isNext: r.n === nextN,
        isGoalHit: goal.value > 0 && r.n === goalHitN,
    }))
})

const progressBarPct = computed(() => {
    const p = tracker.value.progressToGoalPct
    if (p == null || !Number.isFinite(p)) return 0
    return Math.max(0, Math.min(100, p))
})

function lotLabel(r) {
    if (r.lot == null) return '—'
    return r.lot >= LOT_STEP ? fmt(r.lot, 2) : '<0.01'
}

function lotTitle(r) {
    if (r.lotExact == null) return ''
    return `exact ${fmt(r.lotExact, 4)} lot · at ${r.lot >= LOT_STEP ? fmt(r.lot, 2) : '0.00'} lot this makes ${fmt(r.lotDollars)} of the ${fmt(r.profit)} target`
}

/* ---- Balance curve (Baseline Plan vs Actual vs Live Path per trade) ---- */
const ACCENT = '#2f9bff'
const ACTUAL_GREEN = '#00CA73'
const LIVE_CYAN = '#38bdf8'
const SURFACE = '#1b1f2a'
const INK_MUTED = 'rgba(237, 240, 247, 0.60)'

const chartEl = ref(null)
let chart = null

function renderChart() {
    if (activeTab.value !== 'plan' || !chartEl.value || !projection.value) return
    if (chart && chart.getDom() !== chartEl.value) { chart.dispose(); chart = null }
    if (!chart) chart = echarts.init(chartEl.value)
    const list = projection.value.trades
    const actualList = tracker.value.trackedTrades
    const liveSteps = tracker.value.liveSteps || []
    const hasGoal = goal.value > 0
    const hasActual = actualList.length > 0
    const maxLen = Math.max(list.length, actualList.length, liveSteps.length)
    const categories = Array.from({ length: maxLen }, (_, i) => `#${i + 1}`)
    const planSeriesData = Array.from({ length: maxLen }, (_, i) => list[i]?.closing ?? null)
    const actualSeriesData = hasActual
        ? Array.from({ length: maxLen }, (_, i) => actualList[i]?.actualBalance ?? null)
        : []
    const livePathData = hasActual && liveSteps.length > actualList.length
        ? Array.from({ length: maxLen }, (_, i) => {
            if (i === actualList.length - 1) return actualList[i].actualBalance
            if (i >= actualList.length && liveSteps[i]?.isProjected) return liveSteps[i].closing
            return null
        })
        : []

    const series = [{
        name: hasActual ? 'Baseline Plan' : 'Plan',
        type: 'line',
        data: planSeriesData,
        showSymbol: !hasActual && maxLen <= 40,
        symbolSize: 6,
        lineStyle: { color: ACCENT, width: hasActual ? 1.5 : 2, type: hasActual ? 'dashed' : 'solid' },
        itemStyle: { color: ACCENT, borderColor: SURFACE, borderWidth: 2 },
        areaStyle: hasActual ? undefined : {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(47,155,255,0.22)' },
                { offset: 1, color: 'rgba(47,155,255,0.02)' },
            ]),
        },
        markLine: hasGoal ? {
            silent: true,
            symbol: 'none',
            lineStyle: { color: ACTUAL_GREEN, type: 'dashed', width: 1.5 },
            label: {
                formatter: `Goal ${fmtCompact(goal.value, 0)}`,
                color: ACTUAL_GREEN,
                fontSize: 11,
                position: 'insideEndTop',
            },
            data: [{ yAxis: goal.value }],
        } : undefined,
    }]

    if (actualSeriesData.length) {
        series.push({
            name: 'Actual',
            type: 'line',
            data: actualSeriesData,
            connectNulls: false,
            showSymbol: true,
            symbol: 'circle',
            symbolSize: 7,
            lineStyle: { color: ACTUAL_GREEN, width: 2.5 },
            itemStyle: { color: ACTUAL_GREEN, borderColor: SURFACE, borderWidth: 2 },
        })
    }

    if (livePathData.length) {
        series.push({
            name: 'Live Path',
            type: 'line',
            data: livePathData,
            connectNulls: false,
            showSymbol: maxLen <= 40,
            symbolSize: 5,
            lineStyle: { color: LIVE_CYAN, width: 2, type: 'dotted' },
            itemStyle: { color: LIVE_CYAN, borderColor: SURFACE, borderWidth: 1.5 },
        })
    }

    chart.setOption({
        backgroundColor: 'transparent',
        legend: hasActual ? {
            top: 0,
            right: 12,
            textStyle: { color: INK_MUTED, fontSize: 11 },
        } : undefined,
        grid: { left: 4, right: 16, top: hasActual ? 28 : 20, bottom: 4, containLabel: true },
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.25)', width: 1 } },
            backgroundColor: SURFACE,
            borderColor: 'rgba(255,255,255,0.12)',
            textStyle: { color: 'rgba(237,240,247,0.92)', fontSize: 12 },
            formatter: (params) => {
                const idx = params[0]?.dataIndex
                if (idx == null) return ''
                const t = list[idx]
                const ls = liveSteps[idx]
                const a = actualList[idx]
                const lines = [`<div style="font-weight:700;margin-bottom:4px">Trade #${idx + 1}</div>`]
                if (ls && hasActual && ls.isProjected) {
                    lines.push(
                        `Live target: ${fmt(ls.opening)} → <b>${fmt(ls.targetClosing)}</b> (+${fmt(ls.profit)} · ${fmt(ls.ratePct, 2)}%)`,
                    )
                    if (ls.progressPct != null) lines.push(`To goal: ${fmt(Math.min(ls.progressPct, 999), 1)}%`)
                }
                if (t) {
                    lines.push(
                        `${hasActual ? 'Baseline Plan' : 'Plan'}: ${fmt(t.opening)} → <b>${fmt(t.closing)}</b> (+${fmt(t.profit)} · ${fmt(t.ratePct, 2)}%)`,
                    )
                    if (!hasActual && t.progressPct != null) lines.push(`To goal: ${fmt(Math.min(t.progressPct, 999), 1)}%`)
                }
                if (a) {
                    const netSign = a.net >= 0 ? '+' : ''
                    const netColor = a.net >= 0 ? ACTUAL_GREEN : '#F6465D'
                    lines.push(
                        `<div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.12)">` +
                        `Actual (${a.symbol} · ${a.dateIso}): <span style="color:${netColor};font-weight:600">${netSign}${fmt(a.net)}</span><br/>` +
                        `<b>Actual Bal: ${fmt(a.actualBalance)}</b>` +
                        (a.diffFromPlan != null ? ` (${a.diffFromPlan >= 0 ? '+' : ''}${fmt(a.diffFromPlan)} vs baseline)` : '') +
                        `</div>`,
                    )
                }
                return lines.join('<br/>')
            },
        },
        xAxis: {
            type: 'category',
            data: categories,
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
        series,
    }, true)
    requestAnimationFrame(() => chart && chart.resize())
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

watch([projection, tracker, goal, activeTab], async ([p, , , tab]) => {
    if (tab !== 'plan' || !p) {
        if (chart) { chart.dispose(); chart = null }
        return
    }
    await nextTick()
    renderChart()
})
</script>

<template>
    <div class="planPage p-3">
        <!-- ==================== SUB-TABS ==================== -->
        <div class="planTabs mb-3" role="tablist" aria-label="Trading Plan views">
            <button v-for="tab in TABS" :key="tab.id" type="button" role="tab"
                :aria-selected="activeTab === tab.id"
                v-bind:class="['planTabBtn', { active: activeTab === tab.id }]"
                v-on:click="activeTab = tab.id">
                <i v-bind:class="['uil', tab.icon, 'me-1']"></i>{{ tab.label }}
            </button>
        </div>

        <!-- ==================== TAB 1: PER-TRADE PLAN ==================== -->
        <template v-if="activeTab === 'plan'">
            <PlanSelector />

            <p class="txt-small text-muted mb-3">
                Compounds trade by trade and checks off each closed trade from <a href="/daily">History</a>
                <span v-if="activeAccount"> (account: <strong>{{ activeAccount }}</strong>)</span>.
                To project future growth from your actual daily pace, see <a href="/forecast">Growth Forecast</a>.
            </p>

            <div class="planInputs mb-3">
                <div>
                    <label class="planLabel">Plan start date</label>
                    <FpDate mode="date" class="form-control-sm" placeholder="YYYY-MM-DD" v-model="activePlan.startDate" />
                </div>
                <div>
                    <label class="planLabel">Starting balance</label>
                    <input type="number" min="0" step="100" placeholder="e.g. 1000" class="form-control form-control-sm"
                        v-model="activePlan.startBalance" />
                </div>
                <div>
                    <label class="planLabel">Goal balance</label>
                    <input type="number" min="0" step="100" placeholder="e.g. 10000" class="form-control form-control-sm"
                        v-model="activePlan.goalBalance" />
                </div>
                <div>
                    <label class="planLabel">Trades (optional)</label>
                    <input type="number" min="1" max="2000" step="1" placeholder="auto to goal"
                        class="form-control form-control-sm" v-model="activePlan.horizonTrades" />
                </div>
                <div>
                    <label class="planLabel">Symbol</label>
                    <input type="text" placeholder="e.g. XAUUSD, USA100" class="form-control form-control-sm"
                        v-model="activePlan.symbol" />
                </div>
                <div>
                    <label class="planLabel">Lot size (optional)</label>
                    <input type="number" min="0" step="0.01" placeholder="e.g. 0.05" class="form-control form-control-sm"
                        v-model="activePlan.lotSize" />
                </div>
            </div>

            <!-- ---------- Live Progress from History ---------- -->
            <div class="planCard trackerCard mb-3" v-if="start > 0">
                <div class="trackerHead">
                    <div class="d-flex flex-wrap align-items-center gap-2">
                        <span class="planCardTitle">
                            <i class="uil uil-check-circle me-1 text-success"></i>Live Progress from History
                        </span>
                        <span class="trackerStatusBadge"
                            :class="tracker.goalReached ? 'done' : (tracker.tradesTaken > 0 ? 'active' : 'idle')">
                            <template v-if="tracker.goalReached">Goal reached</template>
                            <template v-else-if="tracker.tradesTaken > 0">
                                Trade #{{ tracker.tradesTaken }} done · Next: #{{ tracker.nextTrade.n }}
                            </template>
                            <template v-else>Waiting for Trade #1 (from {{ activePlan.startDate || 'start' }})</template>
                        </span>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="trackerLoading"
                            v-on:click="refreshTracker" title="Refresh closed trades">
                            <i class="uil uil-sync me-1"></i>{{ trackerLoading ? 'Syncing…' : 'Sync' }}
                        </button>
                        <a href="/daily" class="btn btn-sm btn-outline-secondary">
                            History <i class="uil uil-arrow-right ms-1"></i>
                        </a>
                    </div>
                </div>

                <div v-if="tracker.progressToGoalPct != null" class="trackerProgressWrap mt-2">
                    <div class="trackerProgressTrack">
                        <div class="trackerProgressFill" :style="{ width: progressBarPct + '%' }"></div>
                    </div>
                    <span class="trackerProgressText">
                        {{ fmt(Math.max(0, tracker.progressToGoalPct), 1) }}%
                        <span v-if="goal > 0">to {{ fmtCompact(goal, 0) }}</span>
                        <span v-else>of plan</span>
                    </span>
                </div>

                <div class="statGrid mt-2">
                    <div class="statTile">
                        <div class="statLabel">Trades tracked</div>
                        <div class="statValue">
                            {{ tracker.tradesTaken }}<span v-if="tracker.liveTotalTrades" class="statDenom"> / {{ tracker.liveTotalTrades }}</span>
                        </div>
                        <div class="statSub">
                            {{ tracker.wins }}W · {{ tracker.losses }}L
                            <span v-if="tracker.winRatePct != null"> ({{ fmt(tracker.winRatePct, 0) }}%)</span>
                            <span v-if="tracker.plannedTotalTrades && tracker.liveTotalTrades !== tracker.plannedTotalTrades">
                                · baseline {{ tracker.plannedTotalTrades }}
                            </span>
                            <span v-if="tracker.excludedCount"> · {{ tracker.excludedCount }} skipped</span>
                        </div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Actual balance</div>
                        <div class="statValue" v-bind:class="pnlClass(tracker.actualNet)"
                            :title="fmt(tracker.currentBalance)">
                            {{ fmtCompact(tracker.currentBalance) }}
                        </div>
                        <div class="statSub">
                            Net {{ tracker.actualNet >= 0 ? '+' : '' }}{{ fmt(tracker.actualNet) }}
                            <span v-if="tracker.actualReturnPct != null">
                                ({{ tracker.actualReturnPct >= 0 ? '+' : '' }}{{ fmt(tracker.actualReturnPct, 1) }}%)
                            </span>
                        </div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Plan ladder</div>
                        <div class="statValue" v-if="tracker.tradesTaken > 0 && tracker.varianceAtStep != null"
                            v-bind:class="pnlClass(tracker.varianceAtStep)"
                            :title="fmt(tracker.varianceAtStep)">
                            {{ tracker.varianceAtStep >= 0 ? '+' : '' }}{{ fmtCompact(tracker.varianceAtStep) }}
                        </div>
                        <div class="statValue" v-else>Step #{{ tracker.milestoneStep }}</div>
                        <div class="statSub" v-if="tracker.tradesTaken > 0 && tracker.plannedAtStep != null">
                            Step #{{ tracker.milestoneStep }} cleared · Plan #{{ tracker.tradesTaken }} = {{ fmt(tracker.plannedAtStep) }}
                        </div>
                        <div class="statSub" v-else-if="tracker.nextMilestoneRow">
                            Next step #{{ tracker.nextMilestoneRow.n }} at {{ fmt(tracker.nextMilestoneRow.closing) }}
                        </div>
                        <div class="statSub" v-else>No trades yet</div>
                    </div>
                    <div class="statTile" v-if="goal > 0">
                        <div class="statLabel">Remaining to goal</div>
                        <div class="statValue greenTrade" v-if="tracker.goalReached">Reached!</div>
                        <div class="statValue" v-else :title="fmt(tracker.remainingToGoalDollars)">
                            {{ fmtCompact(tracker.remainingToGoalDollars) }}
                        </div>
                        <div class="statSub" v-if="tracker.goalReached">
                            +{{ fmt(tracker.currentBalance - goal) }} above {{ fmtCompact(goal, 0) }}
                        </div>
                        <div class="statSub" v-else-if="tracker.tradesLeftAtPlanRate != null">
                            ~{{ tracker.tradesLeftAtPlanRate }} trade(s) left at plan rate
                        </div>
                        <div class="statSub" v-else>from current balance</div>
                    </div>
                    <div class="statTile" v-else>
                        <div class="statLabel">Next trade (#{{ tracker.nextTrade.n }})</div>
                        <div class="statValue text-blue" v-if="tracker.nextTrade.targetDollars != null">
                            +{{ fmtCompact(tracker.nextTrade.targetDollars) }}
                        </div>
                        <div class="statValue" v-else>—</div>
                        <div class="statSub" v-if="tracker.nextTrade.targetClosing != null">
                            Target bal: {{ fmt(tracker.nextTrade.targetClosing) }}
                        </div>
                    </div>
                </div>
            </div>

            <!-- ---------- Per-Trade Target Projection ---------- -->
            <div class="planCard mb-3">
                <div class="planCardHead">
                    <span class="planCardTitle">Target per trade</span>
                    <div class="d-flex align-items-end gap-2">
                        <div class="btn-group btn-group-sm" role="group" aria-label="Target unit">
                            <button type="button" v-on:click="targetMode = 'pct'"
                                v-bind:class="['btn', 'btn-sm', !isAmountMode ? 'btn-primary' : 'btn-outline-secondary']">% / trade</button>
                            <button type="button" v-on:click="targetMode = 'amount'"
                                v-bind:class="['btn', 'btn-sm', isAmountMode ? 'btn-primary' : 'btn-outline-secondary']">$ / trade</button>
                        </div>
                        <div class="inlineInput" v-if="!isAmountMode">
                            <label class="planLabel mb-0">Target % per trade</label>
                            <input type="number" min="0" step="0.5" placeholder="e.g. 3"
                                class="form-control form-control-sm" v-model="activePlan.tradePct" />
                        </div>
                        <div class="inlineInput" v-else>
                            <label class="planLabel mb-0">Target $ per trade</label>
                            <input type="number" min="0" step="5" placeholder="e.g. 50"
                                class="form-control form-control-sm" v-model="activePlan.tradeAmount" />
                        </div>
                    </div>
                </div>

                <p v-if="isAmountMode" class="txt-small text-muted mb-0 mt-2">
                    A flat profit per trade. It does not compound, so each trade adds the same dollar amount.
                </p>

                <!-- Optional: step the %/trade down as the balance grows -->
                <div class="tierBlock mt-2" v-if="!isAmountMode">
                    <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-1">
                        <span class="txt-small text-muted">
                            <i class="uil uil-layer-group me-1"></i>Step the %/trade down as the balance grows
                            (optional) — e.g. from $5,000 → 2%/trade, from $10,000 → 1%/trade.
                        </span>
                        <button type="button" class="btn btn-sm btn-outline-secondary"
                            v-on:click="addTradeTier(activePlan)">+ Add step</button>
                    </div>
                    <div v-if="tiers.length" class="tierRows">
                        <div v-for="t in tiers" :key="t.id" class="tierRow">
                            <span class="tierLabel">When balance reaches</span>
                            <input type="number" step="100" placeholder="e.g. 5000"
                                class="form-control form-control-sm tierNum" v-model="t.from" />
                            <span class="tierLabel">switch to</span>
                            <input type="number" step="0.5" placeholder="%/trade"
                                class="form-control form-control-sm tierNum" v-model="t.pct" />
                            <span class="tierLabel">%/trade</span>
                            <i class="uil uil-trash-alt pointerClass tierDel"
                                v-on:click="removeTradeTier(activePlan, t.id)"></i>
                        </div>
                        <p class="txt-small text-muted mb-0" v-if="hasTiers">
                            Below the first level the flat "Target % per trade" applies; each level switches
                            the rate once the balance reaches it.
                        </p>
                    </div>
                </div>

                <!-- Lot sizing for Next Trade (live balance when trades exist, else Trade #1) -->
                <PlanLotSizing class="mt-3" :plan="activePlan" :dollars="nextTradeDollars" :basis="nextTradeBasis">
                    <template v-if="tracker.tradesTaken > 0">
                        Sized for <strong>Trade #{{ tracker.nextTrade.n }}</strong> on your current balance
                        (<strong>{{ fmt(tracker.currentBalance) }}</strong>).
                    </template>
                    <template v-else>
                        Sized for Trade #1 — as the balance grows, the same % needs a bigger lot: with a pip/point distance
                        set, the table below shows the lot for every trade on the way.
                    </template>
                </PlanLotSizing>

                <template v-if="projection">
                    <div class="statGrid my-3">
                        <div class="statTile">
                            <div class="statLabel">Principal</div>
                            <div class="statValue" :title="fmt(start, 0)">{{ fmtCompact(start, 0) }}</div>
                            <div class="statSub">starting balance</div>
                        </div>
                        <div class="statTile" v-bind:class="{ highlightTile: goal > 0 }">
                            <div class="statLabel">{{ goal > 0 ? 'Trades to goal' : 'Trades simulated' }}</div>
                            <div class="statValue greenTrade" v-if="goal > 0 && projection.alreadyAtGoal">0</div>
                            <div class="statValue greenTrade" v-else-if="goal > 0 && projection.goalTrades != null">
                                {{ projection.goalTrades }}
                            </div>
                            <div class="statValue warnTrade" v-else-if="goal > 0 && projection.hitCap">&gt; 2,000</div>
                            <div class="statValue" v-else>{{ projection.tradeCount }}</div>
                            <div class="statSub" v-if="goal > 0 && projection.alreadyAtGoal">already at goal</div>
                            <div class="statSub" v-else-if="goal > 0 && projection.goalTrades != null">
                                trades to reach {{ fmtCompact(goal, 0) }}
                            </div>
                            <div class="statSub" v-else-if="goal > 0">not reached in 2,000 trades</div>
                            <div class="statSub" v-else>trade-by-trade count</div>
                        </div>
                        <div class="statTile">
                            <div class="statLabel">Projected balance</div>
                            <div class="statValue" v-bind:class="pnlClass(projection.profit)"
                                :title="fmt(projection.finalBalance)">{{ fmtCompact(projection.finalBalance) }}</div>
                            <div class="statSub">after {{ projection.tradeCount }} trade(s)</div>
                        </div>
                        <div class="statTile">
                            <div class="statLabel">Trading profit</div>
                            <div class="statValue" v-bind:class="pnlClass(projection.profit)"
                                :title="fmt(projection.profit)">{{ fmtCompact(projection.profit) }}</div>
                            <div class="statSub">net gain over principal</div>
                        </div>
                        <div class="statTile">
                            <div class="statLabel">Total return</div>
                            <div class="statValue" v-bind:class="pnlClass(projection.totalReturnPct)"
                                :title="fmt(projection.totalReturnPct) + '%'">{{ fmtCompact(projection.totalReturnPct) }}%</div>
                            <div class="statSub">compounded return</div>
                        </div>
                        <div class="statTile" v-if="trade1PipsNeeded">
                            <div class="statLabel">Pips needed (Trade #1)</div>
                            <div class="statValue" v-bind:class="toneClass(trade1PipsNeeded.tone)"
                                :title="fmt(trade1PipsNeeded.pips, 0)">{{ fmtCompact(trade1PipsNeeded.pips, 0) }}</div>
                            <div class="statSub">{{ activePlan.symbol || 'symbol' }} · {{ fmt(lotSize, 2) }} lot</div>
                        </div>
                    </div>

                    <!-- Balance curve, one point per trade -->
                    <div class="chartWrap mb-3">
                        <div class="chartTitle">Balance per trade <span v-if="hasActualTrades" class="text-muted fw-normal">— Baseline Plan vs Actual &amp; Live Path</span></div>
                        <div ref="chartEl" class="chartBox"></div>
                    </div>

                    <!-- Trade-by-trade table -->
                    <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
                        <span class="txt-small text-muted">
                            <template v-if="hasActualTrades">
                                Opening compounds from previous balance (actual when closed, target from Trade #{{ tracker.nextTrade.n }} onward)
                            </template>
                            <template v-else>
                                Each trade:
                                <code v-if="!isAmountMode">closing = opening × (1 + <span v-if="hasTiers">stepped %</span><span v-else>{{ fmt(tradePct, 2) }}%</span>)</code>
                                <code v-else>closing = opening + {{ fmt(tradeAmount) }}</code>
                            </template>
                            — {{ rows.length }} step(s) shown<span v-if="hasActualTrades"> · {{ tracker.tradesTaken }} checked off</span>.
                        </span>
                    </div>

                    <div class="tableScroll">
                        <table class="table table-sm breakTable mb-0">
                            <thead>
                                <tr>
                                    <th class="text-center" style="width:3.6rem">Check</th>
                                    <th>Trade</th>
                                    <th class="text-end">Opening</th>
                                    <th class="text-end" v-if="!isAmountMode">Target %</th>
                                    <th class="text-end">Target Profit</th>
                                    <th class="text-end" v-if="lotSize != null">Pips</th>
                                    <th class="text-end" v-if="sizingPips">Lot @ {{ fmt(sizingPips, 0) }} pips</th>
                                    <th class="text-end">Target Closing</th>
                                    <th>Actual Trade</th>
                                    <th class="text-end">Actual Bal</th>
                                    <th class="text-end">Cumulative</th>
                                    <th class="text-end" v-if="goal > 0">To goal</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="r in rows" :key="r.n"
                                    v-bind:class="{
                                        goalHitRow: r.isGoalHit,
                                        doneTradeRow: !!r.actual && !r.isGoalHit,
                                        nextTradeRow: r.isNext && !r.actual,
                                    }">
                                    <td class="text-center">
                                        <span v-if="r.actual" class="stepCheckDone"
                                            :title="`Done on ${r.actual.dateIso}`">
                                            <i class="uil uil-check-circle"></i>
                                        </span>
                                        <span v-else-if="r.isNext" class="stepNextBadge">NEXT</span>
                                        <span v-else class="text-muted opacity-50">·</span>
                                    </td>
                                    <td><span class="dayNum">#{{ r.n }}</span>Trade {{ r.n }}</td>
                                    <td class="text-end">{{ r.opening != null ? fmt(r.opening) : '—' }}</td>
                                    <td class="text-end" v-if="!isAmountMode">{{ r.ratePct != null ? fmt(r.ratePct, 2) + '%' : '—' }}</td>
                                    <td class="text-end" v-bind:class="r.profit != null ? pnlClass(r.profit) : ''">
                                        {{ r.profit != null ? '+' + fmt(r.profit) : '—' }}
                                    </td>
                                    <td class="text-end" v-if="lotSize != null">
                                        {{ r.profit != null ? fmt(dollarsToPips(r.profit, activePlan.symbol, lotSize), 0) : '—' }}
                                    </td>
                                    <td class="text-end" v-if="sizingPips"
                                        v-bind:class="r.lotShort ? 'warnTrade' : 'lotCell'" :title="lotTitle(r)">
                                        {{ lotLabel(r) }}
                                    </td>
                                    <td class="text-end fw-bold">{{ r.targetClosing != null ? fmt(r.targetClosing) : '—' }}</td>
                                    <td>
                                        <div v-if="r.actual" class="actualCell">
                                            <span class="actualMeta">{{ r.actual.symbol }}</span>
                                            <span class="actualDate">{{ r.actual.dateIso }}</span>
                                            <span v-bind:class="pnlClass(r.actual.net)" class="fw-semibold">
                                                {{ r.actual.net >= 0 ? '+' : '' }}{{ fmt(r.actual.net) }}
                                            </span>
                                            <button type="button" class="skipMiniBtn" title="Skip this trade from plan count"
                                                v-on:click="toggleSkipTrade(r.actual.id)">
                                                <i class="uil uil-times"></i>
                                            </button>
                                        </div>
                                        <span v-else class="text-muted opacity-50">—</span>
                                    </td>
                                    <td class="text-end">
                                        <template v-if="r.actual">
                                            <span class="fw-bold">{{ fmt(r.actual.actualBalance) }}</span>
                                            <span v-if="r.actual.diffFromPlan != null"
                                                class="diffTag ms-1"
                                                v-bind:class="pnlClass(r.actual.diffFromPlan)"
                                                :title="`vs baseline plan (${fmt(r.actual.plannedBalance)})`">
                                                ({{ r.actual.diffFromPlan >= 0 ? '+' : '' }}{{ fmt(r.actual.diffFromPlan) }})
                                            </span>
                                        </template>
                                        <span v-else class="text-muted opacity-50">—</span>
                                    </td>
                                    <td class="text-end" v-bind:class="r.cumulativeReturnPct != null ? pnlClass(r.cumulativeReturnPct) : ''">
                                        {{ r.cumulativeReturnPct != null ? (r.cumulativeReturnPct >= 0 ? '+' : '') + fmt(r.cumulativeReturnPct) + '%' : '—' }}
                                    </td>
                                    <td class="text-end" v-if="goal > 0"
                                        v-bind:class="r.progressPct >= 100 ? 'greenTrade fw-bold' : ''">
                                        {{ r.progressPct != null ? fmt(Math.min(r.progressPct, 999), 1) + '%' : '—' }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Skipped trades restore strip -->
                    <div v-if="tracker.excludedTrades.length" class="skippedStrip mt-2">
                        <span class="txt-small text-muted me-2">
                            <i class="uil uil-filter-slash me-1"></i>Skipped ({{ tracker.excludedTrades.length }}):
                        </span>
                        <button v-for="ex in tracker.excludedTrades" :key="ex.id" type="button"
                            class="skippedChip" title="Click to restore to plan count"
                            v-on:click="toggleSkipTrade(ex.id)">
                            {{ ex.dateIso }} · {{ ex.symbol }}
                            <span v-bind:class="pnlClass(ex.net)">({{ ex.net >= 0 ? '+' : '' }}{{ fmt(ex.net) }})</span>
                            <i class="uil uil-redo ms-1"></i>
                        </button>
                    </div>

                    <p class="txt-small text-muted mt-2 mb-0" v-if="sizingPips">
                        Lot = that trade's profit ÷ ({{ fmt(sizingPips, 0) }} pips ×
                        {{ fmt(pipValuePerLot(activePlan.symbol), 2) }}/pip/lot), rounded down —
                        <span class="warnTrade">amber</span> where the tradeable lot makes &gt;10% less than the target (hover for detail).
                    </p>
                </template>

                <div v-else class="hintLine">
                    <span v-if="start > 0 && hasAnyTarget">
                        Enter a <strong>Goal balance</strong> or <strong>Trades</strong> count above to see the trade-by-trade table.
                    </span>
                    <span v-else>
                        Enter a starting balance, goal balance (or number of trades), and target % or $ per trade.
                    </span>
                </div>
            </div>

            <!-- ---------- Goal seek (per trade) ---------- -->
            <div class="planCard">
                <div class="planCardHead">
                    <span class="planCardTitle">Goal seek — how many trades or what % per trade?</span>
                    <div class="d-flex align-items-end gap-2">
                        <div class="inlineInput">
                            <label class="planLabel mb-0">Within trades</label>
                            <input type="number" min="1" max="2000" step="1" placeholder="e.g. 50"
                                class="form-control form-control-sm" v-model="activePlan.horizonTrades" />
                        </div>
                        <div class="inlineInput">
                            <label class="planLabel mb-0">Goal balance</label>
                            <input type="number" min="0" step="100" placeholder="e.g. 10000"
                                class="form-control form-control-sm" v-model="activePlan.goalBalance" />
                        </div>
                    </div>
                </div>

                <!-- At current target: how many trades to goal -->
                <p v-if="goalTradesResult" class="goalLine mt-3 mb-0">
                    <template v-if="goalTradesResult.already">
                        You're already at or above <strong>{{ fmt(goal, 0) }}</strong>.
                    </template>
                    <template v-else>
                        At your target
                        (<strong>{{ isAmountMode ? fmt(tradeAmount) + ' / trade' : (hasTiers ? 'stepped % / trade' : fmt(tradePct, 2) + '% / trade') }}</strong>),
                        you reach <strong>{{ fmt(goal, 0) }}</strong> from <strong>{{ fmt(start, 0) }}</strong> in
                        <strong class="greenTrade">{{ goalTradesResult.trades }} trade(s)</strong>
                        (ending at <strong>{{ fmt(goalTradesResult.finalBalance) }}</strong>).
                    </template>
                </p>
                <p v-else-if="start > 0 && goal > 0 && hasAnyTarget" class="hintLine mb-0">
                    At your target this goal isn't reached within 2,000 trades.
                </p>

                <!-- Within N trades: what %/trade is needed -->
                <template v-if="goalSeek">
                    <p class="goalLine mt-3 mb-1">
                        To reach <strong>{{ fmt(goal, 0) }}</strong> from <strong>{{ fmt(start, 0) }}</strong>
                        within <strong>{{ goalSeek.trades }}</strong> trade(s), you need
                        <strong class="text-blue">{{ fmt(goalSeek.requiredPctPerTrade, 3) }}% per trade</strong>
                        <span class="text-muted">(compounded)</span>
                        <span v-if="goalSeek.requiredAmountPerTrade > 0">
                            or flat <strong>+${{ fmt(goalSeek.requiredAmountPerTrade) }} / trade</strong>
                        </span>.
                    </p>

                    <div class="targetCompareRow mt-2">
                        <p v-if="targetVsGoalSeek" class="txt-small mb-0"
                            v-bind:class="targetVsGoalSeek.onTrack ? 'greenTrade' : 'redTrade'">
                            <i v-bind:class="targetVsGoalSeek.onTrack ? 'uil uil-check-circle' : 'uil uil-arrow-up'"
                                class="me-1"></i>
                            Your Target above is <strong>{{ fmt(tradePct, 2) }}%/trade</strong> —
                            <span v-if="targetVsGoalSeek.onTrack">
                                {{ fmt(targetVsGoalSeek.gap, 3) }}%/trade ahead of what {{ goalSeek.trades }} trades need.
                            </span>
                            <span v-else>
                                {{ fmt(-targetVsGoalSeek.gap, 3) }}%/trade short of reaching the goal in {{ goalSeek.trades }} trades.
                            </span>
                        </p>
                        <p v-else class="txt-small mb-0 hintLine" style="margin-top:0">
                            Set a Target % per trade above to compare against this pace.
                        </p>
                        <button type="button" class="btn btn-outline-primary btn-sm" v-on:click="applyGoalSeekToTarget">
                            <i class="uil uil-arrow-up me-1"></i>Apply {{ fmt(goalSeek.requiredPctPerTrade, 3) }}%/trade to Target
                        </button>
                    </div>

                    <p v-if="goalSeekPipsTrade1" class="txt-small mt-2 mb-0" v-bind:class="toneClass(goalSeekPipsTrade1.tone)">
                        <i class="uil uil-info-circle me-1"></i>≈ <strong>{{ fmt(goalSeekPipsTrade1.pips, 0) }} pips on Trade #1</strong>
                        ({{ activePlan.symbol || 'symbol' }}, {{ fmt(lotSize, 2) }} lot).
                    </p>
                </template>

                <div v-if="!goalSeek && !goalTradesResult" class="hintLine">
                    <span v-if="!(start > 0) || !(goal > 0)">Enter a starting balance and a goal balance.</span>
                    <span v-else>
                        Enter <strong>Within trades</strong> (to solve %/trade) or set a <strong>Target per trade</strong> above (to count how many trades it takes).
                    </span>
                </div>
            </div>

            <p class="txt-small text-muted mt-3">
                <i class="uil uil-exclamation-triangle me-1"></i>Projections are hypothetical: they assume consecutive
                winning trades at your target with full compounding. Use position sizing &amp; risk management on every trade.
            </p>
        </template>

        <!-- ==================== TAB 2: RISK & LOT SIZE CALCULATOR ==================== -->
        <RiskLotCalculator v-else />
    </div>
</template>

<style scoped>
.planTabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 0.6rem;
}

.planTabBtn {
    background-color: var(--black-bg-7);
    border: 1px solid var(--border-strong);
    color: var(--white-60);
    border-radius: var(--radius-sm);
    padding: 0.4rem 0.85rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}

.planTabBtn:hover {
    color: var(--white-87);
    background-color: var(--surface-hover);
}

.planTabBtn.active {
    background-color: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
}

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
    min-width: 0;
}

.highlightTile {
    border-color: rgba(0, 202, 115, 0.35);
    background-color: rgba(0, 202, 115, 0.06);
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
    overflow-wrap: anywhere;
}

.statSub {
    font-size: 0.72rem;
    opacity: 0.6;
}

.breakTable {
    font-size: 0.85rem;
}

.goalHitRow {
    background-color: rgba(0, 202, 115, 0.08);
}

.chartWrap {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    padding: 0.6rem 0.4rem 0.4rem;
}

.chartTitle {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--white-60);
    padding-left: 0.5rem;
}

.chartBox {
    width: 100%;
    height: 260px;
}

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
    min-width: 2.6rem;
    opacity: 0.6;
}

.planInputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
    gap: 0.75rem;
    max-width: 1040px;
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

.trackerCard {
    border-color: rgba(0, 202, 115, 0.18);
}

.trackerHead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
}

.trackerStatusBadge {
    font-size: 0.74rem;
    font-weight: 600;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--white-60);
    background-color: rgba(255, 255, 255, 0.04);
}

.trackerStatusBadge.active {
    color: var(--accent);
    border-color: rgba(47, 155, 255, 0.35);
    background-color: rgba(47, 155, 255, 0.1);
}

.trackerStatusBadge.done {
    color: #00CA73;
    border-color: rgba(0, 202, 115, 0.4);
    background-color: rgba(0, 202, 115, 0.12);
}

.trackerProgressWrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.trackerProgressTrack {
    flex: 1;
    height: 7px;
    border-radius: 999px;
    background-color: rgba(255, 255, 255, 0.08);
    overflow: hidden;
}

.trackerProgressFill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #2f9bff, #00CA73);
    transition: width 0.25s ease;
}

.trackerProgressText {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--white-87);
    white-space: nowrap;
}

.statDenom {
    font-size: 0.85rem;
    font-weight: 500;
    opacity: 0.55;
}

.doneTradeRow {
    background-color: rgba(0, 202, 115, 0.035);
}

.nextTradeRow {
    background-color: rgba(47, 155, 255, 0.07);
}

.stepCheckDone {
    color: #00CA73;
    font-size: 1rem;
    line-height: 1;
}

.stepNextBadge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
    color: var(--accent);
    border: 1px solid rgba(47, 155, 255, 0.45);
    background-color: rgba(47, 155, 255, 0.12);
}

.actualCell {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
}

.actualMeta {
    font-weight: 600;
}

.actualDate {
    font-size: 0.75rem;
    color: var(--white-60);
}

.diffTag {
    font-size: 0.74rem;
}

.skipMiniBtn {
    border: 0;
    background: transparent;
    color: var(--white-60);
    padding: 0 0.15rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.55;
}

.skipMiniBtn:hover {
    color: #F6465D;
    opacity: 1;
}

.skippedStrip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    padding: 0.45rem 0.65rem;
    border-radius: 0.4rem;
    background-color: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.06);
}

.skippedChip {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background-color: rgba(255, 255, 255, 0.04);
    color: var(--white-87);
    border-radius: 999px;
    padding: 0.12rem 0.5rem;
    font-size: 0.74rem;
    cursor: pointer;
}

.skippedChip:hover {
    border-color: var(--accent);
    color: var(--accent);
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

.planCardHead .btn-group .btn {
    padding: 0.5rem 0.8rem;
    background-color: var(--black-bg-7);
    border-color: var(--border-strong);
    color: var(--white-60);
    box-shadow: none;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}

.planCardHead .btn-group .btn:hover {
    color: var(--white-87);
    background-color: var(--surface-hover);
}

.planCardHead .btn-group .btn.btn-primary {
    background-color: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
}

.goalLine {
    font-size: 0.92rem;
}

.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
    margin-top: 0.75rem;
}

.targetCompareRow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
    background-color: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
}

.warnTrade {
    color: #e0a800;
}

.tierBlock {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 0.6rem;
}

.lotCell {
    color: var(--accent);
}

.tierRows {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.4rem;
}

.tierRow {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
}

.tierLabel {
    font-size: 0.8rem;
    color: var(--white-60);
}

.tierNum {
    width: 120px;
}

.tierDel {
    color: var(--white-60);
    margin-left: 0.2rem;
}

.tierDel:hover {
    color: #dc2626;
}
</style>
