<script setup>
import { ref, onMounted, watch } from 'vue'
import axios from 'axios'
import dayjs from 'dayjs'
import { timeZoneTrade } from '../stores/globals'

/* Behavior analysis from real trades, via the backend. Result is cached per
   period in localStorage and only re-fetched when the underlying trade data
   changes -- detected via a cheap fingerprint (day count + last write). So no
   new order = reuse cache instead of re-running the analysis. */
const loading = ref(false)
const error = ref(null)
const data = ref(null)
const period = ref('30d')
const cached = ref(false)      // current result served from cache (no new orders)
const lastUpdated = ref(null)  // when the shown result was actually fetched

const CACHE_KEY = 'aiAnalysisCache_v1'

function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') } catch { return {} }
}
function saveCache(obj) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)) } catch { /* quota / disabled */ }
}

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

async function fetchFingerprint(from, to) {
    const params = {}
    if (from) params.from = from
    if (to) params.to = to
    const res = await axios.get('/api/analysis/fingerprint', { params })
    return res.data?.fingerprint || ''
}

// Show whatever is cached for a period immediately, no request. Returns true if
// a cached result was displayed.
function showCachedFor(p) {
    const entry = loadCache()[p]
    if (entry && entry.data) {
        data.value = entry.data
        cached.value = true
        lastUpdated.value = entry.savedAt || null
        return true
    }
    return false
}

/* force=true always re-fetches (manual refresh). Otherwise reuse the cache when
   the data fingerprint is unchanged (no new orders since it was built). */
async function run(force = false) {
    loading.value = true
    error.value = null
    try {
        const { from, to } = rangeFor(period.value)
        const cache = loadCache()
        const entry = cache[period.value]

        let fp = ''
        try { fp = await fetchFingerprint(from, to) } catch { fp = '' }

        if (!force && entry && entry.data && fp && entry.fingerprint === fp) {
            data.value = entry.data              // no new orders -> reuse cache
            cached.value = true
            lastUpdated.value = entry.savedAt || null
            return
        }

        const params = { tz: timeZoneTrade.value || 'UTC' }
        if (from) params.from = from
        if (to) params.to = to
        const res = await axios.get('/api/analysis/behavior', { params })
        data.value = res.data
        cached.value = false
        lastUpdated.value = Date.now()
        cache[period.value] = {
            fingerprint: res.data?.meta?.fingerprint || fp,
            data: res.data,
            savedAt: lastUpdated.value,
        }
        saveCache(cache)
    } catch (e) {
        error.value = e?.response?.data?.error || e.message
        // Keep any already-shown cached data visible on error.
    } finally {
        loading.value = false
    }
}

const updatedLabel = () => (lastUpdated.value ? dayjs(lastUpdated.value).format('MMM D, HH:mm') : '')

onMounted(() => {
    showCachedFor(period.value)   // instant paint from cache
    run(false)                    // then validate / refresh if orders changed
})

watch(period, (p) => {
    if (!showCachedFor(p)) data.value = null
    run(false)
})

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
</script>

<template>
    <div class="analysisPage p-3">
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
            <div class="btn-group" role="group">
                <button v-for="p in PERIODS" :key="p.id" type="button"
                    v-bind:class="['btn', 'btn-sm', period === p.id ? 'btn-primary' : 'btn-outline-secondary']"
                    v-on:click="period = p.id">{{ p.label }}</button>
            </div>
            <div class="ms-auto d-flex align-items-center gap-2">
                <span v-if="lastUpdated" class="txt-small text-secondary">
                    <i v-if="cached" class="uil uil-check-circle me-1"></i>{{ cached ? 'Cached' : 'Updated' }} · {{
                        updatedLabel() }}
                </span>
                <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="run(true)"
                    :disabled="loading" title="Force refresh (ignore cache)">
                    <i class="uil uil-sync"></i>
                </button>
                <button type="button" class="btn btn-success btn-sm" v-on:click="run(false)" :disabled="loading">
                    <span v-if="loading" class="spinner-border spinner-border-sm me-2" role="status"></span>
                    <i v-else class="uil uil-brain me-1"></i>Analyze behavior
                </button>
            </div>
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
</style>
