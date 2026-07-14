<script setup>
import { ref, computed } from 'vue'
import axios from 'axios'
import dayjs from 'dayjs'
import { timeZoneTrade } from '../stores/globals'

/* ============================================================
   SECTION 1 — Behavior analysis (from real trades via backend)
   ============================================================ */
const loading = ref(false)
const error = ref(null)
const data = ref(null)
const period = ref('30d')

const PERIODS = [
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
    { id: '90d', label: '90 days' },
    { id: 'all', label: 'All' },
]

function rangeFor(p) {
    if (p === 'all') return { from: null, to: null }
    const days = p === '7d' ? 7 : p === '90d' ? 90 : 30
    return {
        from: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
        to: dayjs().add(1, 'day').format('YYYY-MM-DD'), // exclusive upper bound = include today
    }
}

async function run() {
    loading.value = true
    error.value = null
    try {
        const { from, to } = rangeFor(period.value)
        const params = { tz: timeZoneTrade.value || 'UTC' }
        if (from) params.from = from
        if (to) params.to = to
        const res = await axios.get('/api/analysis/behavior', { params })
        data.value = res.data
    } catch (e) {
        error.value = e?.response?.data?.error || e.message
        data.value = null
    } finally {
        loading.value = false
    }
}

/* ---- formatting helpers ---- */
const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }))
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(1) + '%')
const pnlClass = (n) => (n == null ? '' : n > 0 ? 'greenTrade' : n < 0 ? 'redTrade' : '')

function flagCards(p) {
    if (!p) return []
    return [
        {
            key: 'revenge',
            title: 'Revenge trading',
            desc: `Re-entered within ${p.revengeTrading.windowMinutes} min of a loss`,
            bad: p.revengeTrading.count > 0,
            metric: `${p.revengeTrading.count}`,
            sub: p.revengeTrading.count ? `net ${fmt(p.revengeTrading.netPnL)} · win ${pct(p.revengeTrading.winRate)}` : 'none',
        },
        {
            key: 'overtrading',
            title: 'Overtrading',
            desc: `Days with abnormal trade count (median ${p.overtrading.medianTradesPerDay}/day, flag ≥ ${p.overtrading.flagThreshold})`,
            bad: p.overtrading.flaggedDays > 0,
            metric: `${p.overtrading.flaggedDays} days`,
            sub: p.overtrading.flaggedDays ? `net ${fmt(p.overtrading.netOnFlaggedDays)} on flagged days` : 'none',
        },
        {
            key: 'sizing',
            title: 'Sizing up after losses',
            desc: 'Avg position size after a loss vs after a win (tilt / martingale)',
            bad: p.positionSizingTilt.flag != null,
            metric: p.positionSizingTilt.ratio != null ? `${fmt(p.positionSizingTilt.ratio)}×` : '—',
            sub: `after loss ${fmt(p.positionSizingTilt.avgSizeAfterLoss, 3)} · after win ${fmt(p.positionSizingTilt.avgSizeAfterWin, 3)}`,
        },
        {
            key: 'holding',
            title: 'Holding losers longer',
            desc: 'Cutting winners early, letting losers run',
            bad: p.holdingTimeBias.flag != null,
            metric: p.holdingTimeBias.ratio != null ? `${fmt(p.holdingTimeBias.ratio)}×` : '—',
            sub: `loss ${fmt(p.holdingTimeBias.avgLoserHoldMinutes, 1)} min · win ${fmt(p.holdingTimeBias.avgWinnerHoldMinutes, 1)} min`,
        },
    ]
}

const topEntries = (obj, n = 6) => (obj ? Object.entries(obj).slice(0, n) : [])

/* ============================================================
   SECTION 2 — Trading-plan projection (compound %/day, weekdays only)
   ============================================================ */
const startBalance = ref(1000)
const dailyPct = ref(1)
const horizonMonths = ref(3)

const projection = computed(() => {
    const start = Number(startBalance.value)
    const r = Number(dailyPct.value) / 100
    const months = Math.max(1, Math.min(120, Math.floor(Number(horizonMonths.value) || 0)))
    if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(r)) return null

    const startDay = dayjs().startOf('day')
    const end = startDay.add(months, 'month')
    let bal = start
    let tradingDays = 0
    const monthly = []

    let cur = startDay.add(1, 'day') // project from tomorrow
    while (!cur.isAfter(end, 'day')) {
        const dow = cur.day() // 0 = Sun, 6 = Sat → skip weekends (market closed)
        if (dow !== 0 && dow !== 6) { bal *= 1 + r; tradingDays++ }
        const isMonthEnd = cur.date() === cur.daysInMonth()
        const isEnd = cur.isSame(end, 'day')
        if (isMonthEnd || isEnd) {
            monthly.push({
                date: cur.format('YYYY-MM-DD'),
                balance: bal,
                tradingDays,
                returnPct: (bal / start - 1) * 100,
            })
        }
        cur = cur.add(1, 'day')
    }
    // de-dupe if the horizon end coincides with a month end
    const seen = new Set()
    const rows = monthly.filter((m) => (seen.has(m.date) ? false : (seen.add(m.date), true)))

    return {
        tradingDays,
        finalBalance: bal,
        totalReturnPct: (bal / start - 1) * 100,
        profit: bal - start,
        monthly: rows,
    }
})
</script>

<template>
    <div class="analysisPage p-3">
        <!-- ===================== SECTION 1: BEHAVIOR ===================== -->
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
            <div class="btn-group" role="group">
                <button v-for="p in PERIODS" :key="p.id" type="button"
                    v-bind:class="['btn', 'btn-sm', period === p.id ? 'btn-primary' : 'btn-outline-secondary']"
                    v-on:click="period = p.id">{{ p.label }}</button>
            </div>
            <button type="button" class="btn btn-success btn-sm ms-auto" v-on:click="run" :disabled="loading">
                <span v-if="loading" class="spinner-border spinner-border-sm me-2" role="status"></span>
                <i v-else class="uil uil-brain me-1"></i>Analyze behavior
            </button>
        </div>

        <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

        <div v-if="!data && !loading && !error" class="emptyState text-center p-5">
            <i class="uil uil-chart-pie-alt d-block mb-2" style="font-size: 2.5rem; opacity: 0.5;"></i>
            Pick a period and click <strong>Analyze behavior</strong> to see your stats and behavioral flags.
        </div>

        <template v-if="data">
            <div class="statGrid mb-3">
                <div class="statTile">
                    <div class="statLabel">Total trades</div>
                    <div class="statValue">{{ data.stats.trades }}</div>
                    <div class="statSub">W {{ data.stats.wins }} · L {{ data.stats.losses }}</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Win rate</div>
                    <div class="statValue">{{ pct(data.stats.winRate) }}</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Net P&amp;L</div>
                    <div class="statValue" v-bind:class="pnlClass(data.stats.netPnL)">{{ fmt(data.stats.netPnL) }}</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Profit factor</div>
                    <div class="statValue" v-bind:class="data.stats.profitFactor >= 1 ? 'greenTrade' : 'redTrade'">{{
                        fmt(data.stats.profitFactor) }}</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Expectancy / trade</div>
                    <div class="statValue" v-bind:class="pnlClass(data.stats.expectancy)">{{ fmt(data.stats.expectancy) }}
                    </div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Avg win / loss</div>
                    <div class="statValue"><span class="greenTrade">{{ fmt(data.stats.avgWin) }}</span> /
                        <span class="redTrade">{{ fmt(data.stats.avgLoss) }}</span>
                    </div>
                </div>
            </div>

            <h6 class="sectionTitle">Behavioral flags</h6>
            <div v-if="data.stats.trades === 0" class="text-muted mb-3">No trades in this period.</div>
            <div v-else class="flagGrid mb-4">
                <div v-for="c in flagCards(data.patterns)" :key="c.key"
                    v-bind:class="['flagCard', c.bad ? 'flagBad' : 'flagOk']">
                    <div class="d-flex justify-content-between align-items-start">
                        <span class="flagTitle">{{ c.title }}</span>
                        <span v-bind:class="['badge', c.bad ? 'bg-danger' : 'bg-success']">{{ c.bad ? 'Found' : 'OK' }}</span>
                    </div>
                    <div class="flagMetric">{{ c.metric }}</div>
                    <div class="flagSub">{{ c.sub }}</div>
                    <div class="flagDesc">{{ c.desc }}</div>
                </div>
            </div>

            <div class="row g-3 mb-4" v-if="data.stats.trades > 0">
                <div class="col-md-6">
                    <h6 class="sectionTitle">By symbol</h6>
                    <table class="table table-sm breakTable">
                        <thead><tr><th>Symbol</th><th class="text-end">Trades</th><th class="text-end">Win</th><th class="text-end">Net</th></tr></thead>
                        <tbody>
                            <tr v-for="[k, v] in topEntries(data.stats.bySymbol)" :key="k">
                                <td>{{ k }}</td>
                                <td class="text-end">{{ v.count }}</td>
                                <td class="text-end">{{ pct(v.winRate) }}</td>
                                <td class="text-end" v-bind:class="pnlClass(v.net)">{{ fmt(v.net) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="col-md-6">
                    <h6 class="sectionTitle">By weekday</h6>
                    <table class="table table-sm breakTable">
                        <thead><tr><th>Day</th><th class="text-end">Trades</th><th class="text-end">Win</th><th class="text-end">Net</th></tr></thead>
                        <tbody>
                            <tr v-for="[k, v] in topEntries(data.stats.byWeekday)" :key="k">
                                <td>{{ k }}</td>
                                <td class="text-end">{{ v.count }}</td>
                                <td class="text-end">{{ pct(v.winRate) }}</td>
                                <td class="text-end" v-bind:class="pnlClass(v.net)">{{ fmt(v.net) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div v-if="data.notes && data.notes.length">
                <h6 class="sectionTitle">Your recent notes / reasons</h6>
                <div v-for="(n, i) in data.notes" :key="i" class="noteRow">
                    <span class="noteDate">{{ n.date }}</span>
                    <span v-if="n.reason" class="noteReason">Reason: {{ n.reason }}</span>
                    <span v-if="n.note" class="noteText">{{ n.note }}</span>
                </div>
                <p class="txt-small text-muted mt-2">
                    <i class="uil uil-robot me-1"></i>Want AI to interpret these against your behavior? Ask via Claude Desktop (MCP: <code>get_journal_notes</code>).
                </p>
            </div>
        </template>

        <!-- ===================== SECTION 2: PLAN PROJECTION ===================== -->
        <hr class="my-4" style="opacity: 0.1;" />
        <h6 class="sectionTitle"><i class="uil uil-calculator-alt me-1"></i>Trading plan projection</h6>
        <p class="txt-small text-muted mb-3">
            Compounds a fixed daily target on trading days only — weekends (market closed) are skipped.
        </p>

        <div class="planInputs mb-3">
            <div>
                <label class="planLabel">Starting balance</label>
                <input type="number" min="0" step="100" class="form-control form-control-sm" v-model="startBalance" />
            </div>
            <div>
                <label class="planLabel">Target % per day</label>
                <input type="number" step="0.1" class="form-control form-control-sm" v-model="dailyPct" />
            </div>
            <div>
                <label class="planLabel">Horizon (months)</label>
                <input type="number" min="1" max="120" step="1" class="form-control form-control-sm" v-model="horizonMonths" />
            </div>
        </div>

        <template v-if="projection">
            <div class="statGrid mb-3">
                <div class="statTile">
                    <div class="statLabel">Trading days</div>
                    <div class="statValue">{{ projection.tradingDays }}</div>
                    <div class="statSub">Mon–Fri only</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Projected balance</div>
                    <div class="statValue greenTrade">{{ fmt(projection.finalBalance) }}</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Total profit</div>
                    <div class="statValue" v-bind:class="pnlClass(projection.profit)">{{ fmt(projection.profit) }}</div>
                </div>
                <div class="statTile">
                    <div class="statLabel">Total return</div>
                    <div class="statValue greenTrade">{{ fmt(projection.totalReturnPct) }}%</div>
                </div>
            </div>

            <table class="table table-sm breakTable">
                <thead><tr><th>Month end</th><th class="text-end">Trading days</th><th class="text-end">Balance</th><th class="text-end">Return</th></tr></thead>
                <tbody>
                    <tr v-for="m in projection.monthly" :key="m.date">
                        <td>{{ m.date }}</td>
                        <td class="text-end">{{ m.tradingDays }}</td>
                        <td class="text-end">{{ fmt(m.balance) }}</td>
                        <td class="text-end greenTrade">{{ fmt(m.returnPct) }}%</td>
                    </tr>
                </tbody>
            </table>
            <p class="txt-small text-muted">
                <i class="uil uil-info-circle me-1"></i>Hypothetical: assumes a constant daily return with full compounding. Real results vary — use it to set targets, not as a guarantee.
            </p>
        </template>
        <div v-else class="text-muted txt-small">Enter a positive balance and a numeric daily %.</div>
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

.sectionTitle {
    font-weight: 700;
    margin-bottom: 0.6rem;
}

.flagGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.75rem;
}

.flagCard {
    border-radius: 0.6rem;
    padding: 0.8rem 0.9rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background-color: rgba(255, 255, 255, 0.03);
}

.flagCard.flagBad {
    border-color: rgba(220, 53, 69, 0.45);
    background-color: rgba(220, 53, 69, 0.08);
}

.flagTitle {
    font-weight: 600;
}

.flagMetric {
    font-size: 1.5rem;
    font-weight: 700;
    margin-top: 0.35rem;
}

.flagSub {
    font-size: 0.78rem;
    opacity: 0.75;
}

.flagDesc {
    font-size: 0.72rem;
    opacity: 0.55;
    margin-top: 0.35rem;
}

.breakTable {
    font-size: 0.85rem;
}

.emptyState {
    opacity: 0.7;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 0.6rem;
}

.noteRow {
    padding: 0.4rem 0.1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 0.85rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.noteDate {
    opacity: 0.55;
    min-width: 5.5rem;
}

.noteReason {
    font-weight: 600;
}

.noteText {
    opacity: 0.85;
}

.planInputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.75rem;
    max-width: 640px;
}

.planLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin-bottom: 0.2rem;
    display: block;
}
</style>
