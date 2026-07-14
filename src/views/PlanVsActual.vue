<script setup>
import { ref, computed } from 'vue'
import axios from 'axios'
import dayjs from 'dayjs'
import { timeZoneTrade } from '../stores/globals'
import { startBalance, horizonMonths, dailyPct } from '../utils/planSettings'
import { numOrNull, buildProjection, fmt, pnlClass } from '../utils/planMath'

/* Your plan's inputs are shared with the Trading Plan page (and remembered),
   so editing them here updates both. */
const start = computed(() => numOrNull(startBalance.value))
const months = computed(() => {
    const n = numOrNull(horizonMonths.value)
    return n != null && n >= 1 && n <= 120 ? Math.floor(n) : null
})
const target = computed(() => numOrNull(dailyPct.value))

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

/** Same horizon, but compounding at the rate you actually achieved. */
const actualProjection = computed(() =>
    actual.value?.pctPerDay != null && start.value > 0 && months.value
        ? buildProjection(start.value, actual.value.pctPerDay, months.value)
        : null,
)

/** The plan's own projection, for a side-by-side comparison. */
const targetProjection = computed(() =>
    start.value > 0 && months.value && target.value != null
        ? buildProjection(start.value, target.value, months.value)
        : null,
)
</script>

<template>
    <div class="planPage p-3">
        <p class="txt-small text-muted mb-3">
            Compares what you actually traded against the plan you set on
            <a href="/plan">Trading Plan</a>. These inputs are shared with that page.
        </p>

        <!-- Plan inputs (shared with /plan) -->
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
            <div>
                <label class="planLabel">Target % per day</label>
                <input type="number" step="0.1" placeholder="e.g. 1" class="form-control form-control-sm"
                    v-model="dailyPct" />
            </div>
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

                <p v-if="actualProjection" class="goalLine mb-0">
                    At your actual pace, {{ fmt(start, 0) }} becomes
                    <strong v-bind:class="pnlClass(actualProjection.profit)">{{ fmt(actualProjection.finalBalance) }}</strong>
                    in {{ months }} month(s)
                    (<span v-bind:class="pnlClass(actualProjection.totalReturnPct)">{{ fmt(actualProjection.totalReturnPct) }}%</span>)<span
                        v-if="targetProjection"> — vs <strong>{{ fmt(targetProjection.finalBalance) }}</strong> if you hit your
                        {{ fmt(target, 2) }}%/day target</span>.
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

.hintLine {
    font-size: 0.85rem;
    opacity: 0.6;
    margin-top: 0.75rem;
}
</style>
