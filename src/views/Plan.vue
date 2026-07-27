<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import PlanSelector from '../components/PlanSelector.vue'
import PlanDepositsEditor from '../components/PlanDepositsEditor.vue'
import PlanWithdrawalsEditor from '../components/PlanWithdrawalsEditor.vue'
import FpDate from '../components/FpDate.vue'
import { activePlan, addTier, removeTier } from '../utils/planStore'
import {
    numOrNull, buildProjection, rollup, requiredPctPerDay, realismVerdict,
    calendarWeeksAhead, equivalentPctForNDays, dollarsToPips, pipsRealismVerdict,
    fmt, pnlClass, toneClass,
} from '../utils/planMath'

/* Pure calculator — no journal data involved. Inputs start empty on purpose:
   nothing is computed until you enter your own numbers. Everything reads from
   the active plan (see PlanSelector) so multiple plans don't share values. */
const start = computed(() => numOrNull(activePlan.value.startBalance))
const months = computed(() => {
    const n = numOrNull(activePlan.value.horizonMonths)
    return n != null && n >= 1 && n <= 120 ? Math.floor(n) : null
})
const target = computed(() => numOrNull(activePlan.value.dailyPct))
const goal = computed(() => numOrNull(activePlan.value.goalBalance))
const startDate = computed(() => activePlan.value.startDate)
const deposits = computed(() => activePlan.value.deposits)
const withdrawals = computed(() => activePlan.value.withdrawals || [])

// Optional stepped daily target (lower the %/day as the account grows).
const tiers = computed(() => activePlan.value.tiers || [])
const hasTiers = computed(() =>
    tiers.value.some((t) => t && t.pct !== '' && t.pct != null && Number.isFinite(Number(t.pct))),
)

const projection = computed(() =>
    start.value > 0 && months.value && (target.value != null || hasTiers.value)
        ? buildProjection(start.value, target.value == null ? 0 : target.value,
            months.value, deposits.value, startDate.value, tiers.value, withdrawals.value)
        : null,
)

const goalSeek = computed(() => {
    if (!(start.value > 0) || !(goal.value > 0) || !months.value) return null
    const p = requiredPctPerDay(start.value, goal.value, months.value, deposits.value, startDate.value, withdrawals.value)
    if (p == null) return null
    const days = projection.value ? projection.value.tradingDays
        : buildProjection(start.value, 0, months.value, deposits.value, startDate.value).tradingDays
    // Weekly-equivalent of the same daily rate -- same plan, easier to reason
    // about than a bare daily %. avgTradingDaysPerWeek uses the actual horizon
    // (not a flat assumption of 5) so it stays correct for any date range.
    const weeks = calendarWeeksAhead(months.value, startDate.value)
    const avgTradingDaysPerWeek = weeks > 0 ? days / weeks : 5
    const requiredPctPerWeek = equivalentPctForNDays(p, avgTradingDaysPerWeek)
    // Verdict/tone always judge the underlying daily reality -- it's the same
    // plan whichever unit you display it in.
    return {
        requiredPctPerDay: p,
        requiredPctPerWeek,
        weeks,
        tradingDays: days,
        ...realismVerdict(p),
    }
})

/* Goal seek's headline number: daily or weekly. Weekly by default -- easier
   to reason about than a bare daily % for most traders. */
const GOAL_SEEK_UNITS = [
    { id: 'week', label: 'Weekly' },
    { id: 'day', label: 'Daily' },
]
const goalSeekUnit = ref('week')

/* ---- Tie Goal seek to Target projection above it ----
   How the Target % per day you've already set compares to what this goal
   actually needs, plus a one-click way to carry the goal-seek result up into
   the Target field so the projection/chart/table above recompute against it. */
const targetVsGoalSeek = computed(() => {
    if (!goalSeek.value || target.value == null) return null
    const gap = target.value - goalSeek.value.requiredPctPerDay // + = ahead of what's needed, - = short
    return { gap, onTrack: gap >= 0 }
})

function applyGoalSeekToTarget() {
    if (!goalSeek.value) return
    // 3dp matches how the rate is displayed elsewhere on this page.
    activePlan.value.dailyPct = Number(goalSeek.value.requiredPctPerDay.toFixed(3))
}

/* ---- Pips/day: the same $/day target, in the unit you actually trade in ----
   Day 1's $ profit (not a later day) — the required $ grows as the balance
   compounds, so this is a starting-point estimate, not a constant target. */
const lotSize = computed(() => numOrNull(activePlan.value.lotSize))

const targetPipsPerDay = computed(() => {
    if (!projection.value || !(lotSize.value > 0)) return null
    const day1Profit = projection.value.days[0]?.profit
    const pips = dollarsToPips(day1Profit, activePlan.value.symbol, lotSize.value)
    return pips == null ? null : { pips, ...pipsRealismVerdict(pips) }
})

const goalSeekPipsPerDay = computed(() => {
    if (!goalSeek.value || !(start.value > 0) || !(lotSize.value > 0)) return null
    const day1Dollars = start.value * (goalSeek.value.requiredPctPerDay / 100)
    const pips = dollarsToPips(day1Dollars, activePlan.value.symbol, lotSize.value)
    return pips == null ? null : { pips, ...pipsRealismVerdict(pips) }
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
const INK_MUTED = 'rgba(237, 240, 247, 0.60)'

const chartEl = ref(null)
let chart = null

function renderChart() {
    if (!chartEl.value || !projection.value) return
    // Re-init if a prior instance is bound to a replaced/detached DOM node
    // (v-if recreated the div, or HMR left an orphaned instance) — otherwise
    // echarts draws into the old node and the visible box stays blank.
    if (chart && chart.getDom() !== chartEl.value) { chart.dispose(); chart = null }
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
                    (d.deposit ? `Deposit: +${fmt(d.deposit)}<br/>` : '') +
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
    // Resize after layout settles — a resize while the container is still 0-sized
    // (mid reactive flush / just-created by v-if) would leave the canvas blank.
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
        <PlanSelector />

        <p class="txt-small text-muted mb-3">
            Compounds on trading days only — weekends (market closed) are skipped.
            To compare this plan against what you actually traded, see <a href="/plan-vs-actual">Plan vs Actual</a>.
        </p>

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
                <label class="planLabel">Symbol</label>
                <input type="text" placeholder="e.g. XAUUSD" class="form-control form-control-sm"
                    v-model="activePlan.symbol" />
            </div>
            <div>
                <label class="planLabel">Lot size</label>
                <input type="number" min="0" step="0.01" placeholder="e.g. 0.01" class="form-control form-control-sm"
                    v-model="activePlan.lotSize" />
            </div>
        </div>

        <!-- ---------- Deposits (ad-hoc, no fixed cadence) ---------- -->
        <div class="planCard mb-3">
            <PlanDepositsEditor :plan="activePlan" />
        </div>

        <!-- ---------- Withdrawals (ad-hoc, with a note) ---------- -->
        <div class="planCard mb-3">
            <PlanWithdrawalsEditor :plan="activePlan" />
        </div>

        <!-- ---------- Target projection ---------- -->
        <div class="planCard mb-3">
            <div class="planCardHead">
                <span class="planCardTitle">Target projection</span>
                <div class="inlineInput">
                    <label class="planLabel mb-0">Target % per day</label>
                    <input type="number" step="0.1" placeholder="e.g. 1" class="form-control form-control-sm"
                        v-model="activePlan.dailyPct" />
                </div>
            </div>

            <!-- Optional: step the daily % down as the balance grows -->
            <div class="tierBlock mt-2">
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-1">
                    <span class="txt-small text-muted">
                        <i class="uil uil-layer-group me-1"></i>Step the daily % down as the balance grows
                        (optional) — start at the Target % above, then e.g. from $5,000 → 3%/day, from $10,000 → 1%/day.
                    </span>
                    <button type="button" class="btn btn-sm btn-outline-secondary"
                        v-on:click="addTier(activePlan)">+ Add step</button>
                </div>
                <div v-if="tiers.length" class="tierRows">
                    <div v-for="t in tiers" :key="t.id" class="tierRow">
                        <span class="tierLabel">When balance reaches</span>
                        <input type="number" step="100" placeholder="e.g. 10000"
                            class="form-control form-control-sm tierNum" v-model="t.from" />
                        <span class="tierLabel">switch to</span>
                        <input type="number" step="0.1" placeholder="%/day"
                            class="form-control form-control-sm tierNum" v-model="t.pct" />
                        <span class="tierLabel">%/day</span>
                        <i class="uil uil-trash-alt pointerClass tierDel"
                            v-on:click="removeTier(activePlan, t.id)"></i>
                    </div>
                    <p class="txt-small text-muted mb-0" v-if="hasTiers">
                        Below the first level the flat "Target % per day" applies; each level switches
                        the rate once the balance reaches it.
                    </p>
                </div>
            </div>

            <template v-if="projection">
                <div class="statGrid my-3">
                    <div class="statTile">
                        <div class="statLabel">Principal</div>
                        <div class="statValue">{{ fmt(start, 0) }}</div>
                        <div class="statSub">money you started with</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Trading days</div>
                        <div class="statValue">{{ projection.tradingDays }}</div>
                        <div class="statSub">Mon–Fri only</div>
                    </div>
                    <div class="statTile" v-if="projection.deposited > 0">
                        <div class="statLabel">Extra deposits</div>
                        <div class="statValue">{{ fmt(projection.deposited) }}</div>
                        <div class="statSub" v-if="projection.ignoredDeposited > 0">
                            +{{ fmt(projection.ignoredDeposited) }} outside horizon, ignored
                        </div>
                        <div class="statSub" v-else>added on top of principal</div>
                    </div>
                    <div class="statTile" v-if="projection.withdrawn > 0">
                        <div class="statLabel">Withdrawn</div>
                        <div class="statValue redTrade">−{{ fmt(projection.withdrawn) }}</div>
                        <div class="statSub" v-if="projection.ignoredWithdrawn > 0">
                            +{{ fmt(projection.ignoredWithdrawn) }} outside horizon, ignored
                        </div>
                        <div class="statSub" v-else>taken out along the way</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Projected balance</div>
                        <div class="statValue" v-bind:class="pnlClass(projection.profit)">{{ fmt(projection.finalBalance) }}</div>
                        <div class="statSub" v-if="projection.deposited > 0">of which contributed: {{ fmt(projection.contributed) }}</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Trading profit</div>
                        <div class="statValue" v-bind:class="pnlClass(projection.profit)">{{ fmt(projection.profit) }}</div>
                        <div class="statSub" v-if="projection.deposited > 0">excludes deposits</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Total return</div>
                        <div class="statValue" v-bind:class="pnlClass(projection.totalReturnPct)">{{ fmt(projection.totalReturnPct) }}%</div>
                        <div class="statSub" v-if="projection.deposited > 0">on capital contributed</div>
                    </div>
                    <div class="statTile" v-if="targetPipsPerDay">
                        <div class="statLabel">Pips needed (day 1)</div>
                        <div class="statValue" v-bind:class="toneClass(targetPipsPerDay.tone)">{{ fmt(targetPipsPerDay.pips, 0) }}</div>
                        <div class="statSub">{{ activePlan.symbol || 'symbol' }} · {{ fmt(lotSize, 2) }} lot</div>
                    </div>
                </div>

                <p v-if="targetPipsPerDay" class="txt-small mb-3" v-bind:class="toneClass(targetPipsPerDay.tone)">
                    <i class="uil uil-info-circle me-1"></i>{{ targetPipsPerDay.verdict }}
                    <span class="pipsCalibrationNote">— 500–2000 pips/day calibrated to your own feedback; bands past that (aggressive/unrealistic) are an extrapolated guess, adjust as you see fit.</span>
                </p>
                <p v-else-if="lotSize == null" class="hintLine mb-3">Enter a lot size above to see this target in pips/day.</p>

                <!-- Balance curve, one point per trading day -->
                <div class="chartWrap mb-3">
                    <div class="chartTitle">Balance per trading day</div>
                    <div ref="chartEl" class="chartBox"></div>
                </div>

                <!-- Step-by-step compounding -->
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
                    <span class="txt-small text-muted">
                        Each trading day: <code>closing = (opening<span v-if="projection.deposited > 0"> + deposit</span>) × (1 + <span v-if="hasTiers">stepped %/day</span><span v-else>{{ fmt(target, 2) }}%</span>)</code>
                        — the next day opens on that closing balance.
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
                                <th class="text-end" v-if="projection.deposited > 0">Deposit</th>
                                <th class="text-end" v-if="projection.withdrawn > 0">Withdraw</th>
                                <th class="text-end">Profit</th>
                                <th class="text-end" v-if="lotSize != null">Pips</th>
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
                                <td class="text-end" v-if="projection.deposited > 0">
                                    <span v-if="r.deposit">+{{ fmt(r.deposit) }}</span><span v-else class="text-muted">—</span>
                                </td>
                                <td class="text-end" v-if="projection.withdrawn > 0">
                                    <span v-if="r.withdrawal" class="redTrade">−{{ fmt(r.withdrawal) }}</span><span v-else class="text-muted">—</span>
                                </td>
                                <td class="text-end" v-bind:class="pnlClass(r.profit)">{{ fmt(r.profit) }}</td>
                                <td class="text-end" v-if="lotSize != null">{{ fmt(dollarsToPips(r.profit, activePlan.symbol, lotSize), 0) }}</td>
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
        <div class="planCard mt-3">
            <div class="planCardHead">
                <span class="planCardTitle">Goal seek — what % per {{ goalSeekUnit }} do I need?</span>
                <div class="d-flex align-items-end gap-2">
                    <div class="btn-group btn-group-sm" role="group">
                        <button v-for="u in GOAL_SEEK_UNITS" :key="u.id" type="button"
                            v-bind:class="['btn', 'btn-sm', goalSeekUnit === u.id ? 'btn-primary' : 'btn-outline-secondary']"
                            v-on:click="goalSeekUnit = u.id">{{ u.label }}</button>
                    </div>
                    <div class="inlineInput">
                        <label class="planLabel mb-0">Goal balance</label>
                        <input type="number" min="0" step="100" placeholder="e.g. 10000" class="form-control form-control-sm"
                            v-model="activePlan.goalBalance" />
                    </div>
                </div>
            </div>

            <template v-if="goalSeek">
                <p class="goalLine mt-3 mb-1">
                    To reach <strong>{{ fmt(goal, 0) }}</strong> from <strong>{{ fmt(start, 0) }}</strong><span
                        v-if="deposits.length"> plus your deposits</span>
                    in <strong>{{ months }}</strong> month(s) — {{ goalSeek.tradingDays }} trading days — you need
                    <strong v-if="goalSeekUnit === 'week'" v-bind:class="toneClass(goalSeek.tone)">{{ fmt(goalSeek.requiredPctPerWeek, 2) }}% per week</strong>
                    <strong v-else v-bind:class="toneClass(goalSeek.tone)">{{ fmt(goalSeek.requiredPctPerDay, 3) }}% per day</strong>.
                </p>
                <p class="txt-small mb-1" style="opacity: 0.7;">
                    Same plan, other unit:
                    <span v-if="goalSeekUnit === 'week'">{{ fmt(goalSeek.requiredPctPerDay, 3) }}% per day</span>
                    <span v-else>{{ fmt(goalSeek.requiredPctPerWeek, 2) }}% per week</span>
                    (~{{ fmt(goalSeek.tradingDays / goalSeek.weeks, 1) }} trading days/week over {{ fmt(goalSeek.weeks, 1) }} weeks)
                </p>
                <p class="txt-small mb-0" v-bind:class="toneClass(goalSeek.tone)">
                    <i class="uil uil-info-circle me-1"></i>{{ goalSeek.verdict }}
                </p>

                <!-- Ties this result back to the Target projection card above -->
                <div class="targetCompareRow mt-2">
                    <p v-if="targetVsGoalSeek" class="txt-small mb-0" v-bind:class="targetVsGoalSeek.onTrack ? 'greenTrade' : 'redTrade'">
                        <i v-bind:class="targetVsGoalSeek.onTrack ? 'uil uil-check-circle' : 'uil uil-arrow-up'" class="me-1"></i>
                        Your Target above is <strong>{{ fmt(target, 2) }}%/day</strong> —
                        <span v-if="targetVsGoalSeek.onTrack">{{ fmt(targetVsGoalSeek.gap, 3) }}%/day ahead of what this goal needs.</span>
                        <span v-else>{{ fmt(-targetVsGoalSeek.gap, 3) }}%/day short of what this goal needs.</span>
                    </p>
                    <p v-else class="txt-small mb-0 hintLine" style="margin-top:0">Set a Target % per day above to compare it against this goal.</p>
                    <button type="button" class="btn btn-outline-primary btn-sm" v-on:click="applyGoalSeekToTarget">
                        <i class="uil uil-arrow-up me-1"></i>Apply {{ fmt(goalSeek.requiredPctPerDay, 3) }}%/day to Target
                    </button>
                </div>

                <p v-if="goalSeekPipsPerDay" class="txt-small mt-2 mb-0" v-bind:class="toneClass(goalSeekPipsPerDay.tone)">
                    <i class="uil uil-info-circle me-1"></i>≈ <strong>{{ fmt(goalSeekPipsPerDay.pips, 0) }} pips on day 1</strong>
                    ({{ activePlan.symbol || 'symbol' }}, {{ fmt(lotSize, 2) }} lot) — {{ goalSeekPipsPerDay.verdict }}
                    <span class="pipsCalibrationNote">Required pips grow as your balance compounds, so this is a starting-point estimate, not a fixed daily target. 500–2000 pips/day calibrated to your own feedback; bands past that are an extrapolated guess.</span>
                </p>
                <p v-else-if="lotSize == null" class="hintLine mt-2 mb-0">Enter a lot size above to see this in pips/day.</p>
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
    color: var(--white-60);
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
    /* 0.45 measured 3.65:1 — below the 4.5:1 minimum. 0.6 lands at 5.5:1. */
    opacity: 0.6;
}

.planInputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
    max-width: 860px;
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

/* Explicit colour, not opacity: opacity would multiply with the inherited
   alpha and drop this below the readable threshold. */
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

/* amber: "aggressive" verdicts sit between the app's green/red */
.warnTrade {
    color: #e0a800;
}

/* Disclaimer inline with the pips verdict — de-emphasized but still readable
   on its own (explicit colour, not opacity, for the same reason as .hintLine). */
.pipsCalibrationNote {
    display: block;
    margin-top: 0.25rem;
    color: var(--white-60);
}

/* Stepped daily-% editor */
.tierBlock {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 0.6rem;
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
