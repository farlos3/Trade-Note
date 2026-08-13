<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import axios from 'axios'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'; dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'; dayjs.extend(timezone)
import { timeZoneTrade, currentUser } from '../stores/globals'
import PlanSelector from '../components/PlanSelector.vue'
import PlanDepositsEditor from '../components/PlanDepositsEditor.vue'
import FpDate from '../components/FpDate.vue'
import { activePlan } from '../utils/planStore'
import { numOrNull, buildProjection, fmt, pnlClass } from '../utils/planMath'
import { useJournalUpdates } from '../utils/journalStream'

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

// ...and again whenever the journal itself moves, so a page left open doesn't keep
// comparing the plan against a stale "actual".
let unsubscribeJournal = null
onMounted(() => { unsubscribeJournal = useJournalUpdates(load) })
onBeforeUnmount(() => { if (unsubscribeJournal) unsubscribeJournal() })

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
   day's real net P&L (real ups/downs — NOT a smoothed average). Real MT5 cash
   flows move it too: a withdrawal drops the line on the day money left, a deposit
   lifts it on the day money landed — so topping the account back up after blowing
   it reads as new capital, not as a winning day. The Plan line is the pure target
   pace and does NOT move on either (see the buildProjection call below). */
const equity = computed(() => {
    if (!daily.value || !daily.value.length || !(start.value > 0)) return null
    const s = start.value
    const t = target.value
    const tz = timeZoneTrade.value || 'UTC'
    const accs = (currentUser.value && Array.isArray(currentUser.value.mt5Accounts)) ? currentUser.value.mt5Accounts : []
    // Net P&L per traded date.
    const netByDate = new Map()
    daily.value.forEach((d) => netByDate.set(d.date, (netByDate.get(d.date) || 0) + (Number(d.net) || 0)))
    const firstDate = [...netByDate.keys()].sort()[0]
    // Real cash flows from MT5's dated balance ops (pushed by the sync), summed
    // per date. A cash flow on a day with no trades still gets its own point.
    const cashFlows = accs.flatMap((a) => (Array.isArray(a.cashFlows) ? a.cashFlows : []))
    const sumByDate = (type) => {
        const m = new Map()
        cashFlows
            .filter((cf) => cf && cf.type === type)
            .forEach((cf) => {
                const date = dayjs.unix(Number(cf.t)).tz(tz).format('YYYY-MM-DD')
                const amt = Math.abs(Number(cf.amount) || 0)
                if (amt > 0 && date >= firstDate) m.set(date, (m.get(date) || 0) + amt)
            })
        return m
    }
    const wdByDate = sumByDate('withdrawal')
    const depByDate = sumByDate('deposit')
    // EVERY calendar day between the first and last event -- weekends and holidays
    // included. A traded-days-only axis squeezes a 3-day weekend into the same gap
    // as an overnight, so distance along the axis wouldn't mean elapsed time and a
    // "straight" line wouldn't actually be straight in time. Filling the calendar
    // makes the axis real time, which is what the linear Plan line below needs.
    const eventDates = [...new Set([...netByDate.keys(), ...wdByDate.keys(), ...depByDate.keys()])].sort()
    const allDates = []
    if (eventDates.length) {
        const last = dayjs(eventDates[eventDates.length - 1])
        for (let d = dayjs(eventDates[0]); !d.isAfter(last, 'day'); d = d.add(1, 'day')) {
            allDates.push(d.format('YYYY-MM-DD'))
        }
    }

    // Plan drawn as ONE straight line spanning the whole chart. Its endpoints still
    // come from the real compounding target (so where the plan says you should end
    // up stays honest), but the path between them is linear -- readable at a glance,
    // and defined on every day including ones the market is closed. Previously this
    // was the raw compounding curve, which only existed on trading weekdays inside
    // the projection window, so the line started late, ended early and broke on
    // weekends.
    let planFirst = null, planLast = null, planSlope = 0
    if (t != null && startDate.value && allDates.length) {
        const monthsToToday = Math.max(1, dayjs().diff(dayjs(startDate.value), 'month') + 2)
        const proj = buildProjection(s, t, monthsToToday, [], startDate.value, tiers.value, [])
        const days = proj.days || []
        // Plan value on a date, extended past both ends of the projection: before
        // the plan starts nothing has compounded yet (= start balance); after the
        // last projected day, hold the final value.
        const planAt = (date) => {
            if (!days.length || date < days[0].date) return s
            let best = days[0]
            for (const d of days) {
                if (d.date > date) break
                best = d
            }
            return best.closing
        }
        planFirst = planAt(allDates[0])
        planLast = planAt(allDates[allDates.length - 1])
        planSlope = allDates.length > 1 ? (planLast - planFirst) / (allDates.length - 1) : 0
    }

    let withdrawnCum = 0, depositedCum = 0, netCum = 0
    const dates = [], plan = [], deltas = []
    const cumActual = [], cumPlan = [], dayActual = [], dayPlan = [], withdrawals_ = [], deposits_ = []
    allDates.forEach((date, i) => {
        const isTraded = netByDate.has(date)
        const net = netByDate.get(date) || 0
        const wdToday = wdByDate.get(date) || 0
        const depToday = depByDate.get(date) || 0
        withdrawnCum += wdToday
        depositedCum += depToday
        netCum += net
        dates.push(date)
        // On a day with no trade and no cash flow this is 0, so the balance simply
        // carries forward -- a flat segment across the closed market.
        deltas.push(net + depToday - wdToday)
        // Cumulative profit is what TRADING earned, so it tracks neither cash flow:
        // it is just the running sum of net P&L. Deposits are new capital, not a
        // gain -- without this, topping up a blown account would show as a huge win.
        cumActual.push(Number(netCum.toFixed(2)))
        // Daily P&L view is per TRADED day; a day with no trade has no bar (null,
        // not 0) so the line doesn't dip to zero across weekends.
        dayActual.push(isTraded ? Number(net.toFixed(2)) : null)
        withdrawals_.push(Number(wdToday.toFixed(2)))
        deposits_.push(Number(depToday.toFixed(2)))

        if (planFirst != null) {
            const p = planFirst + planSlope * i
            plan.push(Number(p.toFixed(2)))
            cumPlan.push(Number((p - s).toFixed(2)))
            // A linear plan needs the same profit every day, which is exactly the
            // slope -- so the Daily view compares against a flat target line.
            dayPlan.push(Number(planSlope.toFixed(2)))
        } else {
            plan.push(null); cumPlan.push(null); dayPlan.push(null)
        }
    })

    /* Actual equity anchored on the balance MT5 actually reports, walked BACKWARD.
       Adding up forward from the plan's startBalance double-counts, because
       startBalance is normally the money you funded the account with and those same
       funding deposits are also in cashFlows -- measured: ~486 charted vs 188.56
       real. Anchoring at the newest point makes today's value right by construction
       and pushes any journal-vs-broker drift into the distant past. Without a live
       MT5 balance there is nothing truer to anchor to, so fall back to startBalance. */
    const liveBalance = accs.length ? Number(accs[0].balance) : null
    const actual = new Array(allDates.length)
    if (Number.isFinite(liveBalance)) {
        let bal = liveBalance
        for (let i = allDates.length - 1; i >= 0; i--) {
            actual[i] = Number(bal.toFixed(2))
            bal -= deltas[i]
        }
    } else {
        let bal = s
        for (let i = 0; i < allDates.length; i++) {
            bal += deltas[i]
            actual[i] = Number(bal.toFixed(2))
        }
    }

    return {
        dates, actual, plan, cumActual, cumPlan, dayActual, dayPlan,
        withdrawals: withdrawals_,
        deposits: deposits_,
        totalWithdrawn: Number(withdrawnCum.toFixed(2)),
        totalDeposited: Number(depositedCum.toFixed(2)),
        withdrawnOutsideRange: 0,
    }
})

/* Headline figures pulled out of the equity series so the template reads as
   labels, not index arithmetic. `earned` is trading P&L only — it deliberately
   equals actual.totalNet, which is why the two are never shown as separate
   tiles. */
const balanceNow = computed(() =>
    equity.value ? equity.value.actual[equity.value.actual.length - 1] : null)
const earnedNow = computed(() =>
    equity.value ? equity.value.cumActual[equity.value.cumActual.length - 1] : null)
const hasCashFlow = computed(() =>
    !!equity.value && (equity.value.totalDeposited > 0 || equity.value.totalWithdrawn > 0))
const netCashFlow = computed(() =>
    equity.value ? equity.value.totalDeposited - equity.value.totalWithdrawn : 0)

/* How many tiles actually render. Two of them are conditional, so the desktop
   grid takes its column count from this instead of a hard-coded 6 -- otherwise a
   plan with no daily target (5 tiles) would leave one empty column track. */
const statTileCount = computed(() =>
    4 + (target.value != null ? 1 : 0) + (hasCashFlow.value ? 1 : 0))

/* Breakeven: how far the account still is from the money actually put into it,
   and how long earning that back takes at the pace being traded now.
   "Breakeven" here means the balance climbing back to your NET CONTRIBUTION
   (everything deposited minus everything withdrawn) -- not to some past peak,
   which was never your money to begin with. Read straight off MT5's own cash
   flows so it stays right regardless of how the plan's startBalance is set. */
const breakeven = computed(() => {
    const accs = (currentUser.value && Array.isArray(currentUser.value.mt5Accounts)) ? currentUser.value.mt5Accounts : []
    if (!accs.length) return null
    const balance = Number(accs[0].balance)
    if (!Number.isFinite(balance)) return null
    const flows = accs.flatMap((a) => (Array.isArray(a.cashFlows) ? a.cashFlows : []))
    const sum = (type) => flows
        .filter((f) => f && f.type === type)
        .reduce((acc, f) => acc + Math.abs(Number(f.amount) || 0), 0)
    const deposited = sum('deposit')
    const withdrawn = sum('withdrawal')
    const netIn = deposited - withdrawn
    const gap = netIn - balance          // > 0 means still under water
    const avgPerDay = actual.value && actual.value.avgDailyNet != null ? actual.value.avgDailyNet : null
    // Only meaningful while you're actually making money: at a losing average the
    // gap never closes, so report null and let the UI say so rather than print a
    // negative or infinite "days to go".
    const daysAtCurrentPace = (gap > 0 && avgPerDay > 0) ? gap / avgPerDay : null
    // At the plan's target the balance compounds, so solve balance*(1+t/100)^n = netIn.
    const t = target.value
    const daysAtPlan = (gap > 0 && balance > 0 && t > 0)
        ? Math.log(netIn / balance) / Math.log(1 + t / 100)
        : null
    return { deposited, withdrawn, netIn, balance, gap, avgPerDay, daysAtCurrentPace, daysAtPlan }
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
const LOSS_COLOR = '#F6465D'
// Cash flows are neither profit nor loss, so they get their own hues rather than
// borrowing red/green -- taking planned profit out is not a bad outcome, and
// topping the account up is not a win.
const WITHDRAW_COLOR = '#c084fc'
const DEPOSIT_COLOR = '#38bdf8'

const CHART_MODES = [
    { value: 'equity', label: 'Equity', title: 'Equity — your actual trades per day vs plan pace' },
    { value: 'cumulative', label: 'Cumulative P&L', title: 'Cumulative profit since the start balance vs plan pace' },
    { value: 'daily', label: 'Daily P&L', title: 'Profit per traded day vs the profit the plan needs that day' },
]
const chartMode = ref(localStorage.getItem('planVsActualChartMode') || 'equity')
if (!CHART_MODES.some((m) => m.value === chartMode.value)) chartMode.value = 'equity'
watch(chartMode, (v) => localStorage.setItem('planVsActualChartMode', v))

/* Linear squashes a +10 day to nothing next to a -721 one, which is exactly the
   Daily P&L complaint. Symlog keeps the sign and compresses the extremes so small
   and large days are readable at once. ECharts' own `type: 'log'` cannot be used:
   it rejects zero and negative values, and half this data is negative. */
const Y_SCALES = [
    { value: 'linear', label: 'Linear' },
    { value: 'symlog', label: 'Log' },
]
const yScale = ref(localStorage.getItem('planVsActualYScale') || 'linear')
if (!Y_SCALES.some((s2) => s2.value === yScale.value)) yScale.value = 'linear'
watch(yScale, (v) => localStorage.setItem('planVsActualYScale', v))

// Signed log: sign(v) * log10(1 + |v|). Continuous through zero, unlike log.
const symlog = (v) => (v == null ? null : Math.sign(v) * Math.log10(1 + Math.abs(v)))
const symlogInv = (y) => Math.sign(y) * (Math.pow(10, Math.abs(y)) - 1)

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
    const planRaw = mode === 'equity' ? eq.plan : mode === 'cumulative' ? eq.cumPlan : eq.dayPlan
    const actualRaw = mode === 'equity' ? eq.actual : mode === 'cumulative' ? eq.cumActual : eq.dayActual
    // Series plot transformed values; every label and tooltip reads the raw ones,
    // so the numbers on screen are always the real amounts.
    const useSym = yScale.value === 'symlog'
    const tx = (arr) => (useSym ? arr.map((v) => (v == null ? null : symlog(v))) : arr)
    const planData = tx(planRaw)
    const actualData = tx(actualRaw)
    const planName = mode === 'daily'
        ? `Plan needs (${fmt(target.value, 2)}%/day)`
        : `Plan (${fmt(target.value, 2)}%/day)`

    /* Vertical marks on the days money moved in or out. Attached as markLine
       rather than an extra series so they never enter the legend or the axis
       scale -- a cash flow is an annotation on the curve, not a third quantity
       to compare against. Drawn on the Actual series so they inherit its z. */
    const cashMarks = []
    eq.withdrawals.forEach((amt, i) => {
        if (amt > 0) cashMarks.push({
            xAxis: dates[i], amount: amt,
            lineStyle: { color: WITHDRAW_COLOR },
            label: { color: WITHDRAW_COLOR, formatter: () => `Withdrawal −${fmt(amt, 0)}` },
        })
    })
    eq.deposits.forEach((amt, i) => {
        if (amt > 0) cashMarks.push({
            xAxis: dates[i], amount: amt,
            lineStyle: { color: DEPOSIT_COLOR },
            // A deposit near/above the starting principal, landing right after a
            // losing stretch, reads as re-funding a blown account rather than a
            // routine top-up -- label it that way instead of a bare "+302" a
            // reader has to interpret themselves.
            label: {
                color: DEPOSIT_COLOR,
                formatter: () => (amt >= start.value * 0.8 ? `Account reset +${fmt(amt, 0)}` : `Deposit +${fmt(amt, 0)}`),
            },
        })
    })
    const withdrawalMarkLine = cashMarks.length
        ? {
            silent: true,
            symbol: 'none',
            lineStyle: { width: 1, type: 'dotted' },
            label: { show: true, position: 'insideEndTop', fontSize: 10 },
            data: cashMarks,
        }
        : undefined

    const series = []
    if (planData.some((v) => v != null)) {
        series.push({
            name: planName,
            type: 'line',
            // Not smoothed, unlike Actual below: each point is already an exact
            // compounding calculation (planBal * (1 + pct/100) per traded day,
            // see buildProjection-equivalent loop above) with no noise to
            // visually smooth over. Bezier-interpolating it would only distort
            // the true exponential shape with overshoot between points.
            data: planData,
            showSymbol: false,
            // A date with no plan value (before the plan's start date, or a
            // weekend the market is closed) is null, not 0 -- connectNulls draws
            // a straight line across that gap instead of breaking the line.
            connectNulls: true,
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
            markLine: withdrawalMarkLine,
        })
    } else {
        series.push({
            name: 'Actual (real trades)',
            type: 'line',
            smooth: true,
            data: actualData,
            showSymbol: true,
            symbolSize: 6,
            lineStyle: { color: ACTUAL_COLOR, width: 2 },
            itemStyle: { color: ACTUAL_COLOR, borderColor: SURFACE, borderWidth: 2 },
            areaStyle: { color: 'rgba(245, 158, 11, 0.08)' },
            markLine: withdrawalMarkLine,
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
                // Read the untransformed arrays by index: under a symlog scale
                // p.value is the compressed number, which is meaningless to show.
                const rawFor = (p) => {
                    const src = p.seriesName === planName ? planRaw : actualRaw
                    const v = src[p.dataIndex]
                    return v == null ? null : v
                }
                const lines = params
                    .filter((p) => rawFor(p) != null)
                    .map((p) => `${p.marker} ${p.seriesName}: <b>${fmt(rawFor(p))}</b>`)
                if (params.length === 2) {
                    const a = planRaw[i], b = actualRaw[i]
                    if (a != null && b != null) {
                        const diff = b - a
                        lines.push(`<span style="opacity:.7">Gap: ${diff >= 0 ? '+' : ''}${fmt(diff)}</span>`)
                    }
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
            axisLabel: {
                color: INK_MUTED,
                fontSize: 10,
                // Ticks are positioned in transformed space but must be labelled
                // with the real amount they represent.
                formatter: (v) => Math.round(useSym ? symlogInv(v) : v).toLocaleString(),
            },
        },
        // Drag or scroll inside the plot to zoom. The point of this on the value
        // axis: even with symlog, zooming in is the direct way to inspect a
        // cluster of small days. `filterMode: 'none'` keeps out-of-view points
        // affecting the line instead of chopping the series.
        dataZoom: [
            { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
            { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'shift' },
        ],
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
watch([equity, chartMode, yScale], async () => {
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
                <!-- Six tiles, deliberately. Seven never split evenly across a row,
                     so the last one was left alone and stretched the full width.
                     Two merges got there without dropping a number: Principal folded
                     under Balance (which was previously only visible inside a
                     subtitle), and Deposited/Withdrawn became one Cash flow tile —
                     they are the same category and had carried identical subtitles.
                     "Earned" is not a tile because it is the same value as the net
                     under Avg P&L / day. -->
                <div class="statGrid my-3" :style="{ '--stat-tiles': statTileCount }">
                    <div class="statTile">
                        <div class="statLabel">Balance</div>
                        <div class="statValue">{{ balanceNow == null ? fmt(start, 2) : fmt(balanceNow) }}</div>
                        <div class="statSub">principal {{ fmt(start, 2) }}</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Days traded</div>
                        <div class="statValue">{{ actual.tradedDays }}</div>
                        <div class="statSub">{{ actual.winDays }} green · {{ actual.tradedDays - actual.winDays }} red</div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Avg P&amp;L / day</div>
                        <div class="statValue" v-bind:class="pnlClass(actual.avgDailyNet)">{{ fmt(actual.avgDailyNet) }}</div>
                        <div class="statSub">earned {{ fmt(actual.totalNet) }}</div>
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
                    <!-- Money moved in/out. Kept out of "earned" so a top-up after
                         blowing the account never reads as trading profit. -->
                    <div class="statTile" v-if="hasCashFlow">
                        <div class="statLabel">Cash flow</div>
                        <div class="statValue cashFlowValue">
                            <span v-if="equity.totalDeposited > 0" class="depositHi">+{{ fmt(equity.totalDeposited, 0) }}</span>
                            <span v-if="equity.totalWithdrawn > 0" class="withdrawHi">−{{ fmt(equity.totalWithdrawn, 0) }}</span>
                        </div>
                        <div class="statSub">net {{ netCashFlow >= 0 ? '+' : '−' }}{{ fmt(Math.abs(netCashFlow)) }}</div>
                    </div>
                </div>

                <p v-if="equity && equity.withdrawnOutsideRange > 0" class="hintLine mb-0">
                    {{ fmt(equity.withdrawnOutsideRange) }} of withdrawals fall after the last traded day in this
                    period, so they are not on the curve yet.
                </p>

                <!-- How far from getting the deposited money back, and how long that takes. -->
                <div v-if="breakeven" class="breakevenBox mb-3">
                    <div class="breakevenHead">
                        <span class="breakevenTitle">
                            <i class="uil uil-scales me-1"></i>Back to breakeven
                        </span>
                        <span v-if="breakeven.gap > 0" class="breakevenGap">
                            need <strong>{{ fmt(breakeven.gap) }}</strong> more
                        </span>
                        <span v-else class="breakevenGapOk">
                            above breakeven by <strong>{{ fmt(-breakeven.gap) }}</strong>
                        </span>
                    </div>

                    <div class="breakevenRows">
                        <div class="beRow">
                            <span class="beLabel">Deposited</span>
                            <span class="beVal depositHi">+{{ fmt(breakeven.deposited) }}</span>
                        </div>
                        <div class="beRow">
                            <span class="beLabel">Withdrawn</span>
                            <span class="beVal withdrawHi">−{{ fmt(breakeven.withdrawn) }}</span>
                        </div>
                        <div class="beRow beRowStrong">
                            <span class="beLabel">Your money in (net)</span>
                            <span class="beVal">{{ fmt(breakeven.netIn) }}</span>
                        </div>
                        <div class="beRow">
                            <span class="beLabel">Balance now</span>
                            <span class="beVal" v-bind:class="pnlClass(breakeven.balance - breakeven.netIn)">
                                {{ fmt(breakeven.balance) }}
                            </span>
                        </div>
                    </div>

                    <div v-if="breakeven.gap > 0" class="beProjection">
                        <div v-if="breakeven.daysAtCurrentPace != null" class="beProjLine">
                            At your current pace ({{ fmt(breakeven.avgPerDay) }}/traded day) that is
                            <strong>{{ Math.ceil(breakeven.daysAtCurrentPace) }}</strong> more trading day(s).
                        </div>
                        <div v-else class="beProjLine beProjWarn">
                            <i class="uil uil-exclamation-triangle me-1"></i>
                            Your average is {{ fmt(breakeven.avgPerDay) }} per traded day — losing, so at this pace
                            the gap never closes. It widens.
                        </div>
                        <div v-if="breakeven.daysAtPlan != null" class="beProjLine beProjPlan">
                            Hitting your {{ fmt(target, 2) }}%/day target instead:
                            <strong>{{ Math.ceil(breakeven.daysAtPlan) }}</strong> trading day(s).
                        </div>
                    </div>
                </div>

                <div v-if="hasChart" class="chartWrap mb-3">
                    <div class="chartHead">
                        <div class="chartTitle">{{ chartTitle }}</div>
                        <div class="chartControls">
                            <div class="chartModes" role="group" aria-label="Chart type">
                                <button v-for="m in CHART_MODES" :key="m.value" type="button"
                                    :class="['chartModeBtn', { active: chartMode === m.value }]"
                                    :aria-pressed="chartMode === m.value" v-on:click="chartMode = m.value">
                                    {{ m.label }}
                                </button>
                            </div>
                            <div class="chartModes" role="group" aria-label="Value axis scale">
                                <button v-for="sc in Y_SCALES" :key="sc.value" type="button"
                                    :class="['chartModeBtn', { active: yScale === sc.value }]"
                                    :aria-pressed="yScale === sc.value" v-on:click="yScale = sc.value"
                                    :title="sc.value === 'symlog'
                                        ? 'Compress the extremes so small days stay readable next to large ones'
                                        : 'Plain linear value axis'">
                                    {{ sc.label }}
                                </button>
                            </div>
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
/* Fixed column counts, each a divisor of the six tiles, so every row comes out
   full: 6 across on desktop, 3 on tablet, 2 on phone. Content-driven wrapping
   was the problem before -- auto-fit and flex-wrap both pick whatever number
   happens to fit, and at some widths that leaves the last tile on its own. Flex
   then stretches it across the whole row (a wide box with one small number in
   the corner); grid instead leaves that span empty. Choosing the counts removes
   the case rather than trading one artifact for the other. */
.statGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
}

@media (min-width: 640px) {
    .statGrid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
}

@media (min-width: 1040px) {
    .statGrid {
        grid-template-columns: repeat(var(--stat-tiles, 6), minmax(0, 1fr));
    }
}

/* Width comes from the grid track, so no flex-basis or max-width here -- adding
   either would fight the column definition and reintroduce the leftover strip. */
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

/* Two signed amounts in one value slot. Wraps rather than overflowing when the
   tile is narrow, and steps down a little so "+481 −70" still fits beside the
   single-number tiles on the same row. */
.cashFlowValue {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 1.15rem;
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

/* Matches WITHDRAW_COLOR in the chart, so the tile and the marks read as one
   thing. Not red: a planned withdrawal is not a loss. */
.withdrawHi {
    color: #c084fc;
}

/* Matches DEPOSIT_COLOR. Not green: new capital is not a win. */
.depositHi {
    color: #38bdf8;
}

.breakevenBox {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.6rem;
    background: rgba(255, 255, 255, 0.03);
    padding: 0.85rem 1rem;
}

.breakevenHead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
}

.breakevenTitle {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
}

.breakevenGap {
    font-size: 0.95rem;
    color: #F6465D;
}

.breakevenGapOk {
    font-size: 0.95rem;
    color: #00CA73;
}

.breakevenRows {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.35rem 1.25rem;
}

.beRow {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.85rem;
}

.beRowStrong {
    font-weight: 700;
}

.beLabel {
    color: var(--white-60);
}

.beVal {
    font-variant-numeric: tabular-nums;
}

.beProjection {
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.beProjLine {
    font-size: 0.85rem;
    color: var(--white-70);
}

.beProjLine+.beProjLine {
    margin-top: 0.25rem;
}

.beProjWarn {
    color: #F6465D;
}

.beProjPlan {
    color: #38bdf8;
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

/* Taller than the old 280px: with a range spanning roughly -700 to +450, height
   is what gives a +10 day any pixels at all. Scales with the viewport so it
   doesn't dominate a laptop screen. */
.chartBox {
    width: 100%;
    height: clamp(320px, 52vh, 520px);
}

.chartControls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
}

/* Explicit colour, not opacity: opacity would multiply with the inherited
   alpha and drop this below the readable threshold. */
.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
    margin-top: 0.75rem;
}
</style>
