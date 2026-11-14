<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import axios from 'axios'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'; dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'; dayjs.extend(timezone)
import { timeZoneTrade } from '../stores/globals'
import PlanSelector from '../components/PlanSelector.vue'
import PlanDepositsEditor from '../components/PlanDepositsEditor.vue'
import PlanCostsEditor from '../components/PlanCostsEditor.vue'
import FpDate from '../components/FpDate.vue'
import PlanLotSizing from '../components/PlanLotSizing.vue'
import { activePlan } from '../utils/planStore'
import {
    numOrNull, buildProjection, tierRateResolver, lotForDollars, floorLot,
    LOT_STEP, fmt, fmtCompact, pnlClass,
} from '../utils/planMath'
import { reconstructActualSeries, analyzeDailyResults, buildGrowthForecast } from '../utils/growthForecast'
import { useJournalUpdates } from '../utils/journalStream'
import { useAuthHeaders } from '../utils/apiAuth'
import { clampFromDate } from '../utils/statsProfile'
import { activeAccount, useScopedMt5Balance, useScopedMt5CashFlows } from '../utils/mt5Accounts'

/* ---- Active plan (optional benchmark + fixed costs + goal) ---- */
const start = computed(() => numOrNull(activePlan.value.startBalance))
const planMonths = computed(() => {
    const n = numOrNull(activePlan.value.horizonMonths)
    return n != null && n >= 1 && n <= 120 ? Math.floor(n) : null
})
const target = computed(() => numOrNull(activePlan.value.dailyPct))
const goalBalance = computed(() => numOrNull(activePlan.value.goalBalance))
const isAmountMode = computed(() => activePlan.value.targetMode === 'amount')
const dailyAmount = computed(() => numOrNull(activePlan.value.dailyAmount))
const projectionOptions = computed(() =>
    isAmountMode.value && dailyAmount.value > 0 ? { dailyAmount: dailyAmount.value } : {})
const hasTarget = computed(() =>
    isAmountMode.value ? dailyAmount.value > 0 : (target.value != null || hasTiers.value))
const startDate = computed(() => activePlan.value.startDate)
const deposits = computed(() => activePlan.value.deposits)
const withdrawals = computed(() => activePlan.value.withdrawals || [])
const tiers = computed(() => activePlan.value.tiers || [])
const hasTiers = computed(() =>
    tiers.value.some((t) => t && t.pct !== '' && t.pct != null && Number.isFinite(Number(t.pct))),
)

/* ---- Real per-day P&L from the journal ---- */
const PERIODS = [
    { id: '7d', label: '7D' },
    { id: '30d', label: '30D' },
    { id: '90d', label: '90D' },
    { id: 'all', label: 'All' },
]
const period = ref(localStorage.getItem('planVsActualPeriod') || '30d')
if (!PERIODS.some((p) => p.id === period.value)) period.value = '30d'
watch(period, (v) => localStorage.setItem('planVsActualPeriod', v))

const loading = ref(false)
const error = ref(null)
const daily = ref(null)

const isoFromUnix = (u) => dayjs.unix(u).tz(timeZoneTrade.value || 'UTC').format('YYYY-MM-DD')

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
        const params = { tz: timeZoneTrade.value || 'UTC', account: activeAccount.value }
        const flooredFrom = clampFromDate(from, isoFromUnix)
        if (flooredFrom) params.from = flooredFrom
        if (to) params.to = to
        const res = await axios.get('/api/analysis/behavior', { params, headers: useAuthHeaders() })
        daily.value = res.data.daily || []
    } catch (e) {
        error.value = e?.response?.data?.error || e.message
        daily.value = null
    } finally {
        loading.value = false
    }
}

onMounted(load)
watch(period, load)
watch(activeAccount, load)

let unsubscribeJournal = null
onMounted(() => { unsubscribeJournal = useJournalUpdates(load) })
onBeforeUnmount(() => { if (unsubscribeJournal) unsubscribeJournal() })

/* ---- Forecast controls (persisted in localStorage) ---- */
const HORIZONS = [1, 3, 6, 12]
const forecastMonths = ref(Number(localStorage.getItem('planForecastMonths')) || 3)
if (![1, 3, 6, 12].includes(forecastMonths.value) && !(forecastMonths.value >= 1 && forecastMonths.value <= 120)) {
    forecastMonths.value = 3
}
watch(forecastMonths, (v) => localStorage.setItem('planForecastMonths', String(v)))

const FORECAST_MODES = [
    { id: 'compound', label: 'Compound (%)' },
    { id: 'linear', label: 'Fixed ($/day)' },
]
const forecastMode = ref(localStorage.getItem('planForecastMode') || 'compound')
if (!FORECAST_MODES.some((m) => m.id === forecastMode.value)) forecastMode.value = 'compound'
watch(forecastMode, (v) => localStorage.setItem('planForecastMode', v))

const PACE_BASES = [
    { id: 'mean', label: 'Average' },
    { id: 'median', label: 'Median' },
    { id: 'recent', label: 'Recent' },
]
const paceBasis = ref(localStorage.getItem('planForecastPace') || 'mean')
if (!PACE_BASES.some((b) => b.id === paceBasis.value)) paceBasis.value = 'mean'
watch(paceBasis, (v) => localStorage.setItem('planForecastPace', v))

const showBand = ref(localStorage.getItem('planForecastShowBand') !== 'false')
watch(showBand, (v) => localStorage.setItem('planForecastShowBand', String(v)))

const includeCosts = ref(localStorage.getItem('planForecastIncludeCosts') !== 'false')
watch(includeCosts, (v) => localStorage.setItem('planForecastIncludeCosts', String(v)))

const showPlanOverlay = ref(localStorage.getItem('planForecastShowPlan') !== 'false')
watch(showPlanOverlay, (v) => localStorage.setItem('planForecastShowPlan', String(v)))

const showPlanConfig = ref(localStorage.getItem('planForecastConfigOpen') === 'true')
watch(showPlanConfig, (v) => localStorage.setItem('planForecastConfigOpen', String(v)))

/* ---- Running cost of the operation ---- */
const DAYS_PER_MONTH = 30.4375

const monthlyCost = computed(() => {
    const rows = Array.isArray(activePlan.value.fixedCosts) ? activePlan.value.fixedCosts : []
    const total = rows.reduce((sum, c) => {
        const n = numOrNull(c.amount)
        return sum + (n != null && n > 0 ? n : 0)
    }, 0)
    return total > 0 ? total : null
})

/* ---- Plan curve lookup (spans both history & future forecast) ---- */
const todayIso = computed(() => dayjs().tz(timeZoneTrade.value || 'UTC').format('YYYY-MM-DD'))

const planCurveLookup = computed(() => {
    if (!(start.value > 0) || !hasTarget.value || !startDate.value) return null
    const horizonEnd = dayjs(todayIso.value).add(forecastMonths.value, 'month')
    const monthsNeeded = Math.max(
        1,
        planMonths.value || 1,
        horizonEnd.diff(dayjs(startDate.value), 'month') + 2,
    )
    const proj = buildProjection(
        start.value,
        target.value == null ? 0 : target.value,
        Math.min(120, monthsNeeded),
        deposits.value,
        startDate.value,
        isAmountMode.value ? [] : tiers.value,
        withdrawals.value,
        projectionOptions.value,
    )
    const days = proj.days || []
    return (date) => {
        if (!days.length || date < days[0].date) return start.value
        let best = days[0]
        for (const d of days) {
            if (d.date > date) break
            best = d
        }
        return best.closing
    }
})

/* ---- Reconstructed historical equity & cash flows ---- */
const liveMt5Balance = computed(() => useScopedMt5Balance())

const equity = computed(() => {
    if (!daily.value || !daily.value.length) return null
    return reconstructActualSeries({
        daily: daily.value,
        cashFlows: useScopedMt5CashFlows(),
        liveBalance: liveMt5Balance.value,
        startBalance: start.value,
        tz: timeZoneTrade.value || 'UTC',
        today: todayIso.value,
        planAtDate: showPlanOverlay.value ? planCurveLookup.value : null,
    })
})

const balanceNow = computed(() => {
    if (Number.isFinite(liveMt5Balance.value)) return liveMt5Balance.value
    return equity.value ? equity.value.currentBalance : null
})

const realBalance = computed(() => {
    const mt5 = liveMt5Balance.value
    if (Number.isFinite(mt5) && mt5 > 0) return { value: mt5, source: 'MT5 balance' }
    if (balanceNow.value != null && balanceNow.value > 0) return { value: balanceNow.value, source: 'journal equity' }
    if (start.value > 0) return { value: start.value, source: 'plan start balance' }
    return null
})

/* ---- Empirical daily results analysis ---- */
const summary = computed(() => {
    if (!daily.value || !daily.value.length) return null
    const fallback = realBalance.value ? realBalance.value.value : start.value
    return analyzeDailyResults(daily.value, equity.value?.openingByDate, fallback)
})

const canCompound = computed(() => {
    const bal = balanceNow.value
    return bal != null && bal > 0 && summary.value?.meanPct != null
})

/* ---- Main forward growth forecast ---- */
const forecast = computed(() => {
    if (!summary.value) return null
    const curBal = balanceNow.value != null ? balanceNow.value : (start.value || 0)
    return buildGrowthForecast({
        summary: summary.value,
        currentBalance: curBal,
        horizonMonths: forecastMonths.value,
        mode: forecastMode.value,
        paceBasis: paceBasis.value,
        monthlyCost: monthlyCost.value || 0,
        includeCosts: includeCosts.value,
        goalBalance: goalBalance.value,
        anchorDate: equity.value?.anchorDate || todayIso.value,
        simCount: 1000,
        planAtDate: showPlanOverlay.value ? planCurveLookup.value : null,
    })
})

/* ---- Side-by-side scenario comparison across all 3 paces ---- */
const paceScenarios = computed(() => {
    if (!summary.value) return []
    const curBal = balanceNow.value != null ? balanceNow.value : (start.value || 0)
    return [
        { id: 'median', label: 'Median pace', hint: 'Typical day (ignores outliers)' },
        { id: 'mean', label: 'Average pace', hint: 'Mean of selected period' },
        { id: 'recent', label: `Recent (${summary.value.recentCount}d)`, hint: 'Latest trading momentum' },
    ].map((item) => {
        const f = buildGrowthForecast({
            summary: summary.value,
            currentBalance: curBal,
            horizonMonths: forecastMonths.value,
            mode: forecastMode.value,
            paceBasis: item.id,
            monthlyCost: monthlyCost.value || 0,
            includeCosts: includeCosts.value,
            anchorDate: equity.value?.anchorDate || todayIso.value,
            simCount: 400,
        })
        return { ...item, forecast: f }
    })
})

/* ---- Historical fixed-cost drag & breakeven per traded day ---- */
const cost = computed(() => {
    if (monthlyCost.value == null || !summary.value) return null
    const total = monthlyCost.value * (summary.value.calendarSpanDays / DAYS_PER_MONTH)
    const refBal = realBalance.value?.value || start.value
    return {
        total,
        spanDays: summary.value.calendarSpanDays,
        netAfter: summary.value.totalNet - total,
        breakEvenPerTradedDay: total / summary.value.tradedDays,
        breakEvenPctPerDay: refBal > 0
            ? (total / summary.value.tradedDays / refBal) * 100
            : null,
    }
})

/* ---- Cash flow & breakeven tracking ---- */
const hasCashFlow = computed(() =>
    !!equity.value && (equity.value.totalDeposited > 0 || equity.value.totalWithdrawn > 0))
const netCashFlow = computed(() =>
    equity.value ? equity.value.totalDeposited - equity.value.totalWithdrawn : 0)

const breakeven = computed(() => {
    const balance = liveMt5Balance.value
    if (!Number.isFinite(balance)) return null
    const flows = useScopedMt5CashFlows()
    const sum = (type) => flows
        .filter((f) => f && f.type === type)
        .reduce((acc, f) => acc + Math.abs(Number(f.amount) || 0), 0)
    const deposited = sum('deposit')
    const withdrawn = sum('withdrawal')
    const netIn = deposited - withdrawn
    const gap = netIn - balance
    const avgPerDay = summary.value ? summary.value.meanNet : null
    const daysAtCurrentPace = (gap > 0 && avgPerDay > 0) ? gap / avgPerDay : null
    const t = target.value
    const daysAtPlan = (gap > 0 && balance > 0 && t > 0)
        ? Math.log(netIn / balance) / Math.log(1 + t / 100)
        : null
    return { deposited, withdrawn, netIn, balance, gap, avgPerDay, daysAtCurrentPace, daysAtPlan }
})

/* ---- Plan target & lot sizing helpers ---- */
const targetDollarsAt = (balance) => {
    if (isAmountMode.value) return dailyAmount.value > 0 ? dailyAmount.value : null
    if (!(balance > 0) || (target.value == null && !hasTiers.value)) return null
    const d = balance * tierRateResolver(target.value, tiers.value)(balance)
    return d > 0 ? d : null
}

const todayDollars = computed(() => (realBalance.value ? targetDollarsAt(realBalance.value.value) : null))

const projectedEndDollars = computed(() =>
    forecast.value && forecast.value.endExpected > 0 ? targetDollarsAt(forecast.value.endExpected) : null)

const projectedEndLot = computed(() => {
    const pips = numOrNull(activePlan.value.targetPips)
    if (!(pips > 0) || !(projectedEndDollars.value > 0)) return null
    return floorLot(lotForDollars(projectedEndDollars.value, pips, activePlan.value.symbol))
})

const planToday = computed(() => {
    if (!(start.value > 0) || !hasTarget.value || !startDate.value || !planCurveLookup.value) return null
    const today = todayIso.value
    if (today < startDate.value) return null
    const balance = planCurveLookup.value(today)
    const pips = numOrNull(activePlan.value.targetPips)
    const dollars = targetDollarsAt(balance)
    const lot = pips > 0 && dollars ? floorLot(lotForDollars(dollars, pips, activePlan.value.symbol)) : null
    return { balance, lot }
})

const planAtForecastEnd = computed(() => {
    if (!forecast.value?.planEquity?.length) return null
    return forecast.value.planEquity[forecast.value.planEquity.length - 1]
})

/* ---- Selected pace label helpers ---- */
const activePacePct = computed(() => {
    if (!summary.value) return null
    if (paceBasis.value === 'median') return summary.value.medianPct
    if (paceBasis.value === 'recent') return summary.value.recentMeanPct
    return summary.value.meanPct
})

const activePaceDollar = computed(() => {
    if (!summary.value) return null
    if (paceBasis.value === 'median') return summary.value.medianNet
    if (paceBasis.value === 'recent') return summary.value.recentMeanNet
    return summary.value.meanNet
})

/* ---- Chart setup ---- */
const PLAN_COLOR = '#2f9bff'
const ACTUAL_COLOR = '#f59e0b'
const FORECAST_COLOR = '#f59e0b'
const P90_COLOR = '#00CA73'
const P10_COLOR = '#F6465D'
const P50_COLOR = '#38bdf8'
const TREND_COLOR = '#a78bfa'
const SURFACE = '#1b1f2a'
const INK_MUTED = 'rgba(237, 240, 247, 0.60)'
const WIN_COLOR = '#00CA73'
const LOSS_COLOR = '#F6465D'
const WITHDRAW_COLOR = '#c084fc'
const DEPOSIT_COLOR = '#38bdf8'

const CHART_MODES = [
    { value: 'forecast', label: 'Equity Forecast', title: 'Actual equity history connected to future growth forecast (with P10–P90 range)' },
    { value: 'cumulative', label: 'Cumulative Growth', title: 'Cumulative trading profit history + projected future gain' },
    { value: 'daily', label: 'Daily P&L', title: 'Real daily P&L bars driving the forecast (mean & median reference lines)' },
]
const chartMode = ref(localStorage.getItem('planVsActualChartMode') || 'forecast')
if (!CHART_MODES.some((m) => m.value === chartMode.value)) chartMode.value = 'forecast'
watch(chartMode, (v) => localStorage.setItem('planVsActualChartMode', v))

const Y_SCALES = [
    { value: 'linear', label: 'Linear' },
    { value: 'symlog', label: 'Log' },
]
const yScale = ref(localStorage.getItem('planVsActualYScale') || 'linear')
if (!Y_SCALES.some((s2) => s2.value === yScale.value)) yScale.value = 'linear'
watch(yScale, (v) => localStorage.setItem('planVsActualYScale', v))

const symlog = (v) => (v == null ? null : Math.sign(v) * Math.log10(1 + Math.abs(v)))
const symlogInv = (y) => Math.sign(y) * (Math.pow(10, Math.abs(y)) - 1)

const chartTitle = computed(
    () => (CHART_MODES.find((m) => m.value === chartMode.value) || CHART_MODES[0]).title,
)

const chartEl = ref(null)
let chart = null

const hasChart = computed(() => !!equity.value && !!forecast.value)

function renderChart() {
    if (!chartEl.value || !hasChart.value) return
    if (!chart) chart = echarts.init(chartEl.value)

    const eq = equity.value
    const fc = forecast.value
    const mode = chartMode.value
    const useSym = yScale.value === 'symlog'
    const txVal = (v) => (v == null ? null : useSym ? symlog(v) : v)
    const txArr = (arr) => arr.map(txVal)

    // Cash flow marks (historical only)
    const cashMarks = []
    eq.withdrawals.forEach((amt, i) => {
        if (amt > 0) cashMarks.push({
            xAxis: eq.dates[i], amount: amt,
            lineStyle: { color: WITHDRAW_COLOR, width: 1, type: 'dotted' },
            label: { color: WITHDRAW_COLOR, fontSize: 10, formatter: () => `WD −${fmt(amt, 0)}` },
        })
    })
    eq.deposits.forEach((amt, i) => {
        if (amt > 0) cashMarks.push({
            xAxis: eq.dates[i], amount: amt,
            lineStyle: { color: DEPOSIT_COLOR, width: 1, type: 'dotted' },
            label: {
                color: DEPOSIT_COLOR,
                fontSize: 10,
                formatter: () => (start.value > 0 && amt >= start.value * 0.8 ? `Reset +${fmt(amt, 0)}` : `Dep +${fmt(amt, 0)}`),
            },
        })
    })

    if (mode === 'daily') {
        const dates = eq.dates
        const rawActual = eq.dayActual
        const rawPlan = eq.dayPlan
        const actualData = txArr(rawActual)
        const planData = txArr(rawPlan)

        const meanLine = summary.value ? dates.map(() => txVal(summary.value.meanNet)) : null
        const medianLine = summary.value ? dates.map(() => txVal(summary.value.medianNet)) : null

        const series = [
            {
                name: 'Daily P&L',
                type: 'bar',
                data: actualData.map((v, i) => ({
                    value: v,
                    itemStyle: { color: rawActual[i] >= 0 ? WIN_COLOR : LOSS_COLOR },
                })),
                barMaxWidth: 28,
                z: 2,
                markLine: cashMarks.length ? { silent: true, symbol: 'none', data: cashMarks } : undefined,
            },
        ]
        if (meanLine) {
            series.push({
                name: `Mean (${fmt(summary.value.meanNet)})`,
                type: 'line',
                data: meanLine,
                showSymbol: false,
                smooth: false,
                lineStyle: { color: TREND_COLOR, width: 2, type: 'dashed' },
                itemStyle: { color: TREND_COLOR },
                z: 3,
            })
        }
        if (medianLine) {
            series.push({
                name: `Median (${fmt(summary.value.medianNet)})`,
                type: 'line',
                data: medianLine,
                showSymbol: false,
                smooth: false,
                lineStyle: { color: P50_COLOR, width: 1.5, type: 'dotted' },
                itemStyle: { color: P50_COLOR },
                z: 3,
            })
        }
        if (showPlanOverlay.value && planData.some((v) => v != null)) {
            series.push({
                name: 'Plan target / day',
                type: 'line',
                data: planData,
                showSymbol: false,
                connectNulls: true,
                lineStyle: { color: PLAN_COLOR, width: 1.8, type: 'dashed' },
                itemStyle: { color: PLAN_COLOR },
                z: 3,
            })
        }

        const rawLookup = {
            'Daily P&L': rawActual,
            ...(meanLine ? { [`Mean (${fmt(summary.value.meanNet)})`]: dates.map(() => summary.value.meanNet) } : {}),
            ...(medianLine ? { [`Median (${fmt(summary.value.medianNet)})`]: dates.map(() => summary.value.medianNet) } : {}),
            'Plan target / day': rawPlan,
        }

        chart.setOption({
            backgroundColor: 'transparent',
            legend: { top: 0, textStyle: { color: INK_MUTED, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
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
                    const lines = params
                        .map((p) => {
                            const arr = rawLookup[p.seriesName]
                            const val = arr ? arr[i] : null
                            return val == null ? null : `${p.marker} ${p.seriesName}: <b>${fmt(val)}</b>`
                        })
                        .filter(Boolean)
                    return head + lines.join('<br/>')
                },
            },
            xAxis: {
                type: 'category',
                data: dates,
                boundaryGap: true,
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
                    formatter: (v) => Math.round(useSym ? symlogInv(v) : v).toLocaleString(),
                },
            },
            dataZoom: [
                { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
                { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'shift' },
            ],
            series,
        }, true)
        chart.resize()
        return
    }

    /* ---- Combined timeline: Historical [0..H-1] + Future [H..H+K-1] ---- */
    const histDates = eq.dates
    const futDates = fc.dates
    const dates = [...histDates, ...futDates]
    const H = histDates.length
    const K = futDates.length
    const todayIdx = H - 1
    const todayDateLabel = histDates[todayIdx]

    const isCum = mode === 'cumulative'
    const histRaw = isCum ? eq.cumActual : eq.actual
    const cumOffset = isCum ? (eq.cumActual[todayIdx] || 0) : 0
    const anchorVal = histRaw[todayIdx]

    // Stitch future curves starting right from todayIdx so there is no gap at Today
    const nullHistPrefix = new Array(Math.max(0, H - 1)).fill(null)
    const nullFutSuffix = new Array(K).fill(null)

    const rawActual = [...histRaw, ...nullFutSuffix]
    const rawExpected = [...nullHistPrefix, anchorVal, ...(isCum ? fc.expectedCum.map((v) => v + cumOffset) : fc.expectedEquity)]
    const rawP10 = [...nullHistPrefix, anchorVal, ...(isCum ? fc.p10Cum.map((v) => v + cumOffset) : fc.p10Equity)]
    const rawP50 = [...nullHistPrefix, anchorVal, ...(isCum ? fc.p50Cum.map((v) => v + cumOffset) : fc.p50Equity)]
    const rawP90 = [...nullHistPrefix, anchorVal, ...(isCum ? fc.p90Cum.map((v) => v + cumOffset) : fc.p90Equity)]

    // Optional Plan target curve across history + future
    const hasHistPlan = eq.plan.some((v) => v != null)
    const hasFutPlan = isCum ? !!fc.planCum : !!fc.planEquity
    let rawPlan = null
    if (showPlanOverlay.value && (hasHistPlan || hasFutPlan)) {
        const histPlan = isCum ? eq.cumPlan : eq.plan
        const planOffset = isCum ? (eq.cumPlan[todayIdx] || 0) : 0
        const futPlan = isCum
            ? (fc.planCum ? fc.planCum.map((v) => (v == null ? null : v + planOffset)) : new Array(K).fill(null))
            : (fc.planEquity || new Array(K).fill(null))
        rawPlan = [...histPlan, ...futPlan]
    }

    // Confidence band in transformed coordinates so symlog renders exact shaded span
    const bandBaseData = rawP10.map(txVal)
    const bandSpanData = rawP90.map((v90, i) => {
        const v10 = rawP10[i]
        if (v90 == null || v10 == null) return null
        return txVal(v90) - txVal(v10)
    })

    const todayMark = {
        xAxis: todayDateLabel,
        lineStyle: { color: 'rgba(255,255,255,0.35)', width: 1.5, type: 'dashed' },
        label: { color: 'rgba(237,240,247,0.85)', fontSize: 10, formatter: () => 'Today' },
    }
    const allMarks = [...cashMarks, todayMark]

    const series = []

    if (showBand.value) {
        series.push(
            {
                name: '_bandBase',
                type: 'line',
                stack: 'confBand',
                data: bandBaseData,
                showSymbol: false,
                silent: true,
                lineStyle: { opacity: 0 },
                tooltip: { show: false },
                z: 1,
            },
            {
                name: 'P10–P90 range',
                type: 'line',
                stack: 'confBand',
                data: bandSpanData,
                showSymbol: false,
                silent: true,
                lineStyle: { opacity: 0 },
                areaStyle: { color: 'rgba(0, 202, 115, 0.14)' },
                z: 1,
            },
            {
                name: 'Optimistic (P90)',
                type: 'line',
                data: txArr(rawP90),
                showSymbol: false,
                smooth: true,
                lineStyle: { color: P90_COLOR, width: 1.2, type: 'dotted', opacity: 0.75 },
                itemStyle: { color: P90_COLOR },
                z: 2,
            },
            {
                name: 'Median (P50)',
                type: 'line',
                data: txArr(rawP50),
                showSymbol: false,
                smooth: true,
                lineStyle: { color: P50_COLOR, width: 1.5, type: 'dotted', opacity: 0.85 },
                itemStyle: { color: P50_COLOR },
                z: 2,
            },
            {
                name: 'Conservative (P10)',
                type: 'line',
                data: txArr(rawP10),
                showSymbol: false,
                smooth: true,
                lineStyle: { color: P10_COLOR, width: 1.2, type: 'dotted', opacity: 0.75 },
                itemStyle: { color: P10_COLOR },
                z: 2,
            },
        )
    }

    if (rawPlan) {
        series.push({
            name: 'Plan target',
            type: 'line',
            data: txArr(rawPlan),
            showSymbol: false,
            connectNulls: true,
            lineStyle: { color: PLAN_COLOR, width: 1.8, type: 'dashed', opacity: 0.85 },
            itemStyle: { color: PLAN_COLOR },
            z: 3,
        })
    }

    series.push(
        {
            name: 'Actual',
            type: 'line',
            smooth: true,
            data: txArr(rawActual),
            showSymbol: H <= 45,
            symbolSize: 5,
            lineStyle: { color: ACTUAL_COLOR, width: 2.2 },
            itemStyle: { color: ACTUAL_COLOR, borderColor: SURFACE, borderWidth: 1.5 },
            areaStyle: { color: 'rgba(245, 158, 11, 0.08)' },
            markLine: { silent: true, symbol: 'none', data: allMarks },
            z: 4,
        },
        {
            name: `Forecast (${PACE_BASES.find((b) => b.id === paceBasis.value)?.label || 'Expected'})`,
            type: 'line',
            smooth: true,
            data: txArr(rawExpected),
            showSymbol: false,
            lineStyle: { color: FORECAST_COLOR, width: 2.2, type: 'dashed' },
            itemStyle: { color: FORECAST_COLOR },
            z: 4,
        },
    )

    // Optional Goal horizontal markLine on Equity Forecast view
    if (!isCum && goalBalance.value > 0) {
        series[series.length - 1].markLine = {
            silent: true,
            symbol: 'none',
            data: [{
                yAxis: txVal(goalBalance.value),
                lineStyle: { color: '#00CA73', width: 1.2, type: 'dashed' },
                label: {
                    color: '#00CA73',
                    fontSize: 10,
                    position: 'insideEndTop',
                    formatter: () => `Goal ${fmtCompact(goalBalance.value, 0)}`,
                },
            }],
        }
    }

    const forecastSeriesName = `Forecast (${PACE_BASES.find((b) => b.id === paceBasis.value)?.label || 'Expected'})`
    const rawMap = {
        Actual: rawActual,
        [forecastSeriesName]: rawExpected,
        'Optimistic (P90)': rawP90,
        'Median (P50)': rawP50,
        'Conservative (P10)': rawP10,
        'Plan target': rawPlan,
    }

    chart.setOption({
        backgroundColor: 'transparent',
        legend: {
            top: 0,
            textStyle: { color: INK_MUTED, fontSize: 11 },
            itemWidth: 14,
            itemHeight: 8,
            data: series.map((s) => s.name).filter((n) => n !== '_bandBase' && n !== 'P10–P90 range'),
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
                const tag = i <= todayIdx ? 'Actual' : 'Forecast'
                const head = `<div style="font-weight:700;margin-bottom:4px">${dates[i]} <span style="opacity:.6;font-weight:400">(${tag})</span></div>`
                const seen = new Set()
                const lines = []
                for (const p of params) {
                    if (p.seriesName === '_bandBase' || p.seriesName === 'P10–P90 range' || seen.has(p.seriesName)) continue
                    seen.add(p.seriesName)
                    const arr = rawMap[p.seriesName]
                    const val = arr ? arr[i] : null
                    if (val == null) continue
                    lines.push(`${p.marker} ${p.seriesName}: <b>${fmt(val)}</b>`)
                }
                if (rawPlan && rawPlan[i] != null) {
                    const comp = i <= todayIdx ? rawActual[i] : rawExpected[i]
                    if (comp != null) {
                        const diff = comp - rawPlan[i]
                        lines.push(`<span style="opacity:.7">vs Plan: ${diff >= 0 ? '+' : ''}${fmt(diff)}</span>`)
                    }
                }
                return head + lines.join('<br/>')
            },
        },
        xAxis: {
            type: 'category',
            data: dates,
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
            axisLabel: {
                color: INK_MUTED,
                fontSize: 10,
                formatter: (v) => {
                    const raw = useSym ? symlogInv(v) : v
                    return Math.abs(raw) >= 1e6 ? fmtCompact(raw, 1) : Math.round(raw).toLocaleString()
                },
            },
        },
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

watch([equity, forecast, chartMode, yScale, showBand, showPlanOverlay, paceBasis, goalBalance], async () => {
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
        <p class="txt-small text-muted mb-2">
            Uses your <strong>actual daily trading results</strong> (win/loss distribution, cadence, and % or $/day pace)
            to project your future equity curve and P10–P90 outcome range.
        </p>

        <p v-if="activeAccount" class="txt-small planScopeNote mb-3">
            <i class="uil uil-info-circle me-1"></i>
            Forecasting from account <strong>{{ activeAccount }}</strong>. Switch accounts in the top bar to project
            another profile.
        </p>

        <!-- ==================== PRIMARY CARD: DAILY RESULTS -> GROWTH FORECAST ==================== -->
        <div class="planCard mb-3">
            <div class="planCardHead">
                <div>
                    <span class="planCardTitle">Daily Results → Growth Forecast</span>
                    <span v-if="summary" class="txt-small text-muted ms-2">
                        based on {{ summary.tradedDays }} traded day(s) ({{ summary.firstDate }} → {{ summary.lastDate }})
                    </span>
                </div>
                <div class="d-flex flex-wrap align-items-center gap-2">
                    <div class="btn-group btn-group-sm" role="group" aria-label="Sample window">
                        <button v-for="p in PERIODS" :key="p.id" type="button"
                            v-bind:class="['btn', 'btn-sm', period === p.id ? 'btn-primary' : 'btn-outline-secondary']"
                            v-on:click="period = p.id">{{ p.label }}</button>
                    </div>
                    <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="load" :disabled="loading"
                        title="Reload journal results">
                        <span v-if="loading" class="spinner-border spinner-border-sm me-1" role="status"></span>
                        <i v-else class="uil uil-sync"></i>
                    </button>
                </div>
            </div>

            <div v-if="error" class="alert alert-danger py-2 mt-3 mb-0">{{ error }}</div>
            <div v-else-if="daily === null" class="hintLine">Loading your daily trading results…</div>
            <div v-else-if="!summary || !forecast" class="hintLine">
                No closed trades in the selected window — switch to <strong>90D</strong> or <strong>All</strong>, or
                record trades to generate a growth forecast.
            </div>
            <template v-else>
                <!-- Interactive forecast controls bar -->
                <div class="forecastControls my-3">
                    <div class="fcGroup">
                        <span class="fcLabel">Horizon</span>
                        <div class="chartModes" role="group" aria-label="Forecast horizon">
                            <button v-for="m in HORIZONS" :key="m" type="button"
                                :class="['chartModeBtn', { active: forecastMonths === m }]"
                                v-on:click="forecastMonths = m">{{ m === 12 ? '1Y' : m + 'M' }}</button>
                            <button v-if="planMonths && !HORIZONS.includes(planMonths)" type="button"
                                :class="['chartModeBtn', { active: forecastMonths === planMonths }]"
                                v-on:click="forecastMonths = planMonths">Plan ({{ planMonths }}M)</button>
                        </div>
                    </div>

                    <div class="fcGroup">
                        <span class="fcLabel">Model</span>
                        <div class="chartModes" role="group" aria-label="Growth model">
                            <button v-for="fm in FORECAST_MODES" :key="fm.id" type="button"
                                :class="['chartModeBtn', { active: forecast.effectiveMode === fm.id }]"
                                :disabled="fm.id === 'compound' && !canCompound"
                                :title="fm.id === 'compound' && !canCompound ? 'Compounding requires a positive account balance' : ''"
                                v-on:click="forecastMode = fm.id">{{ fm.label }}</button>
                        </div>
                    </div>

                    <div class="fcGroup">
                        <span class="fcLabel">Pace</span>
                        <div class="chartModes" role="group" aria-label="Pace basis">
                            <button v-for="b in PACE_BASES" :key="b.id" type="button"
                                :class="['chartModeBtn', { active: paceBasis === b.id }]"
                                v-on:click="paceBasis = b.id">{{ b.label }}</button>
                        </div>
                    </div>

                    <div class="fcToggles">
                        <button type="button" :class="['fcPill', { active: showBand }]"
                            v-on:click="showBand = !showBand"
                            title="Bootstrap 10th–90th percentile outcome range">
                            P10–P90 Band
                        </button>
                        <button v-if="monthlyCost" type="button" :class="['fcPill', { active: includeCosts }]"
                            v-on:click="includeCosts = !includeCosts"
                            title="Subtract monthly fixed costs over calendar days in the forecast">
                            After Costs
                        </button>
                        <button v-if="hasTarget && start > 0 && startDate" type="button"
                            :class="['fcPill', { active: showPlanOverlay }]"
                            v-on:click="showPlanOverlay = !showPlanOverlay"
                            title="Overlay your Trading Plan target curve for comparison">
                            Plan Overlay
                        </button>
                    </div>
                </div>

                <!-- Honest diagnostic pills (sample size, momentum, outlier skew) -->
                <div class="signalStrip mb-3"
                    v-if="summary.sampleConfidence === 'low' || summary.momentum !== 'steady' || summary.outlierSkew">
                    <span v-if="summary.sampleConfidence === 'low'" class="sigBadge sigWarn">
                        <i class="uil uil-exclamation-triangle me-1"></i>
                        Thin sample ({{ summary.tradedDays }}d) — bands sharpen at 10–30+ traded days
                    </span>
                    <span v-if="summary.momentum === 'accelerating'" class="sigBadge sigOk">
                        <i class="uil uil-arrow-growth me-1"></i>
                        Momentum accelerating: last {{ summary.recentCount }}d avg {{ fmt(summary.recentMeanNet) }}/day vs
                        {{ fmt(summary.meanNet) }} overall
                    </span>
                    <span v-else-if="summary.momentum === 'cooling'" class="sigBadge sigWarn">
                        <i class="uil uil-chart-down me-1"></i>
                        Momentum cooling: last {{ summary.recentCount }}d avg {{ fmt(summary.recentMeanNet) }}/day vs
                        {{ fmt(summary.meanNet) }} overall
                    </span>
                    <span v-if="summary.outlierSkew" class="sigBadge sigInfo">
                        <i class="uil uil-info-circle me-1"></i>
                        Mean ({{ fmt(summary.meanNet) }}) differs from Median ({{ fmt(summary.medianNet) }}) — outlier
                        days skew average
                    </span>
                </div>

                <!-- 6 Forecast Summary Tiles -->
                <div class="statGrid my-3" style="--stat-tiles: 6">
                    <div class="statTile">
                        <div class="statLabel">Current Balance</div>
                        <div class="statValue">{{ balanceNow == null ? '—' : fmtCompact(balanceNow) }}</div>
                        <div class="statSub">{{ realBalance ? realBalance.source : 'from journal P&L' }}</div>
                    </div>

                    <div class="statTile">
                        <div class="statLabel">Daily Pace ({{ PACE_BASES.find(b => b.id === paceBasis)?.label }})</div>
                        <div v-if="forecast.effectiveMode === 'compound'" class="statValue"
                            v-bind:class="pnlClass(activePacePct)">
                            {{ activePacePct != null ? fmt(activePacePct, 2) + '%' : '—' }}
                        </div>
                        <div v-else class="statValue" v-bind:class="pnlClass(activePaceDollar)">
                            {{ fmt(activePaceDollar) }}
                        </div>
                        <div class="statSub">
                            {{ fmt(summary.tradedDaysPerWeek, 1) }}d/wk · avg {{ fmt(summary.meanNet) }}
                        </div>
                    </div>

                    <div class="statTile">
                        <div class="statLabel">Projected (+{{ forecast.months }}M)</div>
                        <div class="statValue" v-bind:class="pnlClass(forecast.expectedGain)">
                            {{ fmtCompact(forecast.endExpected) }}
                        </div>
                        <div class="statSub">
                            <span v-bind:class="pnlClass(forecast.expectedGain)">
                                {{ forecast.expectedGain >= 0 ? '+' : '' }}{{ fmtCompact(forecast.expectedGain) }}
                                <template v-if="forecast.expectedReturnPct != null">
                                    ({{ fmt(forecast.expectedReturnPct, 1) }}%)
                                </template>
                            </span>
                        </div>
                    </div>

                    <div class="statTile"
                        :title="`Median max drawdown: ${fmt(forecast.maxDrawdownP50Pct, 1)}% · Worst-10% path drawdown: ${fmt(forecast.maxDrawdownP90Pct, 1)}%`">
                        <div class="statLabel">P10 – P90 Range</div>
                        <div class="statValue rangeValue">
                            {{ fmtCompact(forecast.endP10) }} → {{ fmtCompact(forecast.endP90) }}
                        </div>
                        <div class="statSub">
                            P50 {{ fmtCompact(forecast.endP50) }} · {{ fmt(forecast.probProfit, 0) }}% win · DD₉₀
                            {{ fmt(forecast.maxDrawdownP90Pct, 1) }}%
                        </div>
                    </div>

                    <div class="statTile">
                        <div class="statLabel">Daily Win Rate</div>
                        <div class="statValue">{{ fmt(summary.dayWinRate * 100, 0) }}%</div>
                        <div class="statSub">
                            {{ summary.winDays }}W · {{ summary.lossDays }}L · PF
                            {{ summary.dailyProfitFactor != null ? fmt(summary.dailyProfitFactor, 2) : '∞' }}
                        </div>
                    </div>

                    <div class="statTile" v-if="goalBalance > 0">
                        <div class="statLabel">Goal ({{ fmtCompact(goalBalance, 0) }})</div>
                        <div class="statValue"
                            v-bind:class="forecast.expectedGoalEta ? 'greenTrade' : 'text-muted'">
                            <template v-if="forecast.expectedGoalEta?.already">Reached</template>
                            <template v-else-if="forecast.expectedGoalEta">
                                ~{{ forecast.expectedGoalEta.tradingDays }}d
                            </template>
                            <template v-else>&gt;{{ forecast.months }}M</template>
                        </div>
                        <div class="statSub">
                            <template v-if="forecast.expectedGoalEta && !forecast.expectedGoalEta.already">
                                {{ forecast.expectedGoalEta.date }} · {{ fmt(forecast.probGoal, 0) }}% odds
                            </template>
                            <template v-else>
                                {{ fmt(forecast.probGoal, 0) }}% sim reach odds
                            </template>
                        </div>
                    </div>
                    <div class="statTile" v-else-if="planAtForecastEnd != null">
                        <div class="statLabel">Vs Plan (+{{ forecast.months }}M)</div>
                        <div class="statValue" v-bind:class="pnlClass(forecast.endExpected - planAtForecastEnd)">
                            {{ forecast.endExpected >= planAtForecastEnd ? '+' : '' }}{{ fmtCompact(forecast.endExpected - planAtForecastEnd) }}
                        </div>
                        <div class="statSub">plan target {{ fmtCompact(planAtForecastEnd) }}</div>
                    </div>
                    <div class="statTile" v-else>
                        <div class="statLabel">Forecast Activity</div>
                        <div class="statValue">~{{ fmt(forecast.expectedTradedDays, 0) }}d</div>
                        <div class="statSub">
                            of {{ forecast.futureTradingDays }} market days
                            <template v-if="forecast.totalCostDrag > 0">
                                · −{{ fmt(forecast.totalCostDrag, 0) }} cost
                            </template>
                        </div>
                    </div>
                </div>

                <!-- ECharts Interactive Forecast Chart -->
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
                                        ? 'Compress extremes so small days stay readable next to large ones'
                                        : 'Plain linear value axis'">
                                    {{ sc.label }}
                                </button>
                            </div>
                        </div>
                    </div>
                    <div ref="chartEl" class="chartBox"></div>
                </div>

                <!-- 3-Scenario Comparison Strip -->
                <div class="scenarioGrid mb-3">
                    <div v-for="sc in paceScenarios" :key="sc.id"
                        :class="['scenarioCard', { active: paceBasis === sc.id }]"
                        v-on:click="paceBasis = sc.id">
                        <div class="scHead">
                            <span class="scTitle">{{ sc.label }}</span>
                            <span class="scRate" v-bind:class="pnlClass(sc.forecast?.expectedGain)">
                                <template v-if="sc.forecast?.effectiveMode === 'compound'">
                                    {{ fmt(sc.forecast.pacePct, 2) }}%/d
                                </template>
                                <template v-else-if="sc.forecast">
                                    {{ fmt(sc.forecast.paceDollar) }}/d
                                </template>
                            </span>
                        </div>
                        <div class="scVal" v-if="sc.forecast">
                            {{ fmtCompact(sc.forecast.endExpected) }}
                            <span class="scGain" v-bind:class="pnlClass(sc.forecast.expectedGain)">
                                ({{ sc.forecast.expectedGain >= 0 ? '+' : '' }}{{ fmtCompact(sc.forecast.expectedGain) }})
                            </span>
                        </div>
                        <div class="scHint">{{ sc.hint }}</div>
                    </div>
                </div>

                <!-- Fixed Cost Reality Check -->
                <p v-if="cost" class="hintLine mb-2">
                    Running cost is <strong>{{ fmt(monthlyCost, 2) }}/mo</strong> — over {{ cost.spanDays }}d of history
                    that is {{ fmt(cost.total) }} (net after cost:
                    <strong v-bind:class="pnlClass(cost.netAfter)">{{ fmt(cost.netAfter) }}</strong>).
                    Each traded day must average <strong>{{ fmt(cost.breakEvenPerTradedDay) }}</strong>
                    <span v-if="cost.breakEvenPctPerDay != null">({{ fmt(cost.breakEvenPctPerDay, 3) }}%)</span>
                    just to cover overhead.
                </p>

                <!-- Back to breakeven vs net deposited capital -->
                <div v-if="breakeven" class="breakevenBox mt-2">
                    <div class="breakevenHead">
                        <span class="breakevenTitle">
                            <i class="uil uil-balance-scale me-1"></i>Net Contribution Breakeven
                        </span>
                        <span v-if="breakeven.gap > 0" class="breakevenGap">
                            need <strong>{{ fmt(breakeven.gap) }}</strong> to break even
                        </span>
                        <span v-else class="breakevenGapOk">
                            above net contribution by <strong>{{ fmt(-breakeven.gap) }}</strong>
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
                            <span class="beLabel">Net capital in</span>
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
                            At current average ({{ fmt(breakeven.avgPerDay) }}/traded day):
                            <strong>{{ Math.ceil(breakeven.daysAtCurrentPace) }}</strong> more trading day(s).
                        </div>
                        <div v-else class="beProjLine beProjWarn">
                            <i class="uil uil-exclamation-triangle me-1"></i>
                            Average is {{ fmt(breakeven.avgPerDay) }}/traded day — negative expectancy widens the gap.
                        </div>
                    </div>
                </div>

                <p class="txt-small text-muted mt-3 mb-0">
                    <i class="uil uil-info-circle me-1"></i>
                    Stationary Block Bootstrap ({{ forecast.bootstrapMeta?.simCount.toLocaleString() }} paths, avg
                    {{ forecast.bootstrapMeta?.avgBlockDays }}d streak blocks<template
                        v-if="forecast.bootstrapMeta?.timeWeighted">, time-weighted toward recent days</template>)
                    at {{ fmt(summary.tradedDaysPerWeek, 1) }} traded days/week, skipping weekends.
                    Compounding % scales with balance; Fixed $/day assumes constant size.
                </p>
            </template>
        </div>

        <!-- ==================== LOT FOR TODAY & PROJECTED LOT SCALING ==================== -->
        <div class="planCard mb-3" v-if="todayDollars">
            <div class="planCardHead">
                <span class="planCardTitle">Position Sizing (Today &amp; Projected)</span>
            </div>
            <p class="txt-small mt-2 mb-2">
                Balance now: <strong>{{ fmt(realBalance.value) }}</strong>
                <span class="text-muted">({{ realBalance.source }})</span>
                <template v-if="planToday">
                    · Plan benchmark today: <strong class="planHi">{{ fmt(planToday.balance) }}</strong>
                    (<span v-bind:class="pnlClass(realBalance.value - planToday.balance)">
                        {{ realBalance.value >= planToday.balance ? '+' : '−' }}{{ fmt(Math.abs(realBalance.value - planToday.balance)) }}
                    </span>)
                </template>
                <template v-if="forecast && projectedEndLot != null">
                    · At projected +{{ forecast.months }}M (<strong>{{ fmtCompact(forecast.endExpected) }}</strong>):
                    <strong class="greenTrade">{{ fmt(projectedEndLot, 2) }} lot</strong>
                </template>
            </p>
            <PlanLotSizing :plan="activePlan" :dollars="todayDollars"
                :basis="!isAmountMode && !hasTiers && target != null ? fmt(target, 2) + '% of ' + fmt(realBalance.value) : ''">
                Sized on your real balance today; projected lot shows how size scales if your forecast plays out.
            </PlanLotSizing>
        </div>

        <!-- ==================== COLLAPSIBLE PLAN BENCHMARK & FIXED COSTS ==================== -->
        <div class="planCard">
            <div class="planCardHead configToggleHead" v-on:click="showPlanConfig = !showPlanConfig">
                <div class="d-flex flex-wrap align-items-center gap-2">
                    <span class="planCardTitle">
                        <i :class="['uil', showPlanConfig ? 'uil-angle-down' : 'uil-angle-right', 'me-1']"></i>
                        Plan Benchmark, Goal &amp; Fixed Costs
                    </span>
                    <span class="txt-small text-muted">
                        {{ activePlan.name }}
                        <template v-if="goalBalance > 0"> · Goal {{ fmtCompact(goalBalance, 0) }}</template>
                        <template v-if="hasTarget">
                            · Target {{ isAmountMode ? fmt(dailyAmount) + '/d' : fmt(target, 2) + '%/d' }}
                        </template>
                        <template v-if="monthlyCost"> · Cost {{ fmt(monthlyCost, 0) }}/mo</template>
                    </span>
                </div>
                <span class="txt-small text-muted">{{ showPlanConfig ? 'Hide' : 'Configure' }}</span>
            </div>

            <div v-if="showPlanConfig" class="mt-3">
                <PlanSelector />

                <p class="txt-small text-muted mb-3">
                    Shared with <a href="/plan">Trading Plan</a> — set a goal balance, optional plan target line,
                    or monthly overhead costs to factor into your forecast.
                </p>

                <div class="planInputs mb-3">
                    <div>
                        <label class="planLabel">Goal balance</label>
                        <input type="number" min="0" step="100" placeholder="e.g. 5000"
                            class="form-control form-control-sm" v-model="activePlan.goalBalance" />
                    </div>
                    <div>
                        <label class="planLabel">Start date</label>
                        <FpDate mode="date" v-model="activePlan.startDate" />
                    </div>
                    <div>
                        <label class="planLabel">Starting balance</label>
                        <input type="number" min="0" step="100" placeholder="e.g. 1000"
                            class="form-control form-control-sm" v-model="activePlan.startBalance" />
                    </div>
                    <div>
                        <label class="planLabel">Plan horizon (months)</label>
                        <input type="number" min="1" max="120" step="1" placeholder="e.g. 3"
                            class="form-control form-control-sm" v-model="activePlan.horizonMonths" />
                    </div>
                    <div>
                        <label class="planLabel">Target % per day</label>
                        <input type="number" step="0.1" placeholder="e.g. 1" class="form-control form-control-sm"
                            v-model="activePlan.dailyPct" />
                    </div>
                </div>

                <div class="subCard mb-3">
                    <PlanDepositsEditor :plan="activePlan" />
                </div>

                <div class="subCard">
                    <PlanCostsEditor :plan="activePlan" />
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.planScopeNote {
    color: var(--white-60);
    background: rgba(47, 155, 255, 0.08);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.7rem;
}

.forecastControls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1.1rem;
    padding: 0.6rem 0.75rem;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
}

.fcGroup {
    display: flex;
    align-items: center;
    gap: 0.45rem;
}

.fcLabel {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
}

.fcToggles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-left: auto;
}

.fcPill {
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: transparent;
    color: var(--white-60);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.22rem 0.6rem;
    border-radius: 999px;
    cursor: pointer;
    transition: all 0.15s ease;
}

.fcPill:hover {
    color: var(--white-87);
    border-color: rgba(255, 255, 255, 0.28);
}

.fcPill.active {
    background: rgba(0, 202, 115, 0.16);
    border-color: rgba(0, 202, 115, 0.45);
    color: #00CA73;
}

.signalStrip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.sigBadge {
    font-size: 0.76rem;
    padding: 0.3rem 0.65rem;
    border-radius: 0.4rem;
    border: 1px solid transparent;
}

.sigOk {
    background: rgba(0, 202, 115, 0.10);
    border-color: rgba(0, 202, 115, 0.28);
    color: #00CA73;
}

.sigWarn {
    background: rgba(245, 158, 11, 0.10);
    border-color: rgba(245, 158, 11, 0.28);
    color: #f59e0b;
}

.sigInfo {
    background: rgba(56, 189, 248, 0.10);
    border-color: rgba(56, 189, 248, 0.28);
    color: #38bdf8;
}

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

@media (min-width: 1120px) {
    .statGrid {
        grid-template-columns: repeat(var(--stat-tiles, 6), minmax(0, 1fr));
    }
}

.statTile {
    background-color: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
}

.statLabel {
    font-size: 0.70rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
}

.statValue {
    font-size: 1.28rem;
    font-weight: 700;
    margin-top: 0.15rem;
    font-variant-numeric: tabular-nums;
}

.rangeValue {
    font-size: 1.05rem;
}

.statSub {
    font-size: 0.72rem;
    opacity: 0.65;
    margin-top: 0.1rem;
}

.scenarioGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 0.65rem;
}

.scenarioCard {
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 0.55rem;
    padding: 0.65rem 0.85rem;
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease;
}

.scenarioCard:hover {
    border-color: rgba(255, 255, 255, 0.2);
}

.scenarioCard.active {
    background: rgba(245, 158, 11, 0.08);
    border-color: rgba(245, 158, 11, 0.45);
}

.scHead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.75rem;
}

.scTitle {
    font-weight: 600;
    color: var(--white-87);
}

.scRate {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}

.scVal {
    font-size: 1.08rem;
    font-weight: 700;
    margin-top: 0.2rem;
    font-variant-numeric: tabular-nums;
}

.scGain {
    font-size: 0.8rem;
    font-weight: 600;
}

.scHint {
    font-size: 0.70rem;
    color: var(--white-60);
    margin-top: 0.15rem;
}

.planInputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.75rem;
    max-width: 880px;
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

.subCard {
    border: 1px solid rgba(255, 255, 255, 0.06);
    background-color: rgba(255, 255, 255, 0.02);
    border-radius: 0.5rem;
    padding: 0.75rem 0.9rem;
}

.planCardHead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
}

.configToggleHead {
    cursor: pointer;
    user-select: none;
}

.planCardTitle {
    font-weight: 700;
}

.planHi {
    color: #2f9bff;
    font-weight: 700;
}

.chartWrap {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    padding: 0.6rem 0.4rem 0.4rem;
}

.withdrawHi {
    color: #c084fc;
}

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

.beProjWarn {
    color: #F6465D;
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

.chartModeBtn:hover:not(:disabled) {
    color: var(--white-87);
}

.chartModeBtn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}

.chartModeBtn.active {
    background: rgba(47, 155, 255, 0.18);
    color: #2f9bff;
}

.chartBox {
    width: 100%;
    height: clamp(340px, 54vh, 540px);
}

.chartControls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
}

.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
    margin-top: 0.75rem;
}
</style>
