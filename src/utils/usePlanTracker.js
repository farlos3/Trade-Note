/**
 * Shared composable connecting History (Parse `trades` day documents) with the
 * active per-trade Trading Plan (`planStore.js`).
 *
 * Used by both Trading Plan (Plan.vue) and History (Daily.vue) so both pages
 * read the exact same closed-trade list, step numbers (#1, #2...), milestone
 * progress, and skip/exclude list without duplicating query or matching logic.
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import Parse from 'parse/dist/parse.min.js'
import { currentUser, queryLimit, timeZoneTrade } from '../stores/globals.js'
import { activeAccount } from './mt5Accounts.js'
import {
    activePlan, toggleTradeExcluded, excludeTradeIds,
    mergeTradesInPlan, unmergeTradeGroup,
} from './planStore.js'
import { numOrNull, buildTradeProjection, trackTradesAgainstPlan } from './planMath.js'
import { useCachedFind } from './queryCache.js'
import { useJournalUpdates } from './journalStream.js'

const dayDocs = ref([])
const loading = ref(false)
const loaded = ref(false)
let inFlight = null

export async function refreshPlanTrackerTrades() {
    if (inFlight) return inFlight
    if (!Parse.User.current()) return
    loading.value = true
    inFlight = (async () => {
        try {
            const limit = Number(queryLimit.value) || 10000
            const query = new Parse.Query(Parse.Object.extend('trades'))
            query.equalTo('user', Parse.User.current())
            query.exclude('executions', 'blotter', 'pAndL')
            query.ascending('dateUnix')
            query.limit(limit)
            const results = await useCachedFind(query, [0, 0, limit])
            dayDocs.value = Array.isArray(results) ? results : []
            loaded.value = true
        } catch (e) {
            console.error(' -> Plan tracker failed to load trades', e)
        } finally {
            loading.value = false
            inFlight = null
        }
    })()
    return inFlight
}

export function usePlanTracker() {
    const start = computed(() => numOrNull(activePlan.value.startBalance))
    const goal = computed(() => numOrNull(activePlan.value.goalBalance))
    const horizonTrades = computed(() => {
        const n = numOrNull(activePlan.value.horizonTrades)
        return n != null && n >= 1 ? Math.min(Math.floor(n), 2000) : null
    })
    const isAmountMode = computed(() => activePlan.value.tradeTargetMode === 'amount')
    const tradePct = computed(() => numOrNull(activePlan.value.tradePct))
    const tradeAmount = computed(() => numOrNull(activePlan.value.tradeAmount))
    const tiers = computed(() => activePlan.value.tradeTiers || [])
    const hasTiers = computed(() =>
        tiers.value.some((t) => t && t.pct !== '' && t.pct != null && Number.isFinite(Number(t.pct))),
    )
    const hasAnyTarget = computed(() =>
        isAmountMode.value ? tradeAmount.value > 0 : (tradePct.value > 0 || hasTiers.value),
    )

    const projection = computed(() => {
        if (!(start.value > 0) || !hasAnyTarget.value) return null
        return buildTradeProjection({
            start: start.value,
            pctPerTrade: tradePct.value == null ? 0 : tradePct.value,
            tradeAmount: isAmountMode.value ? tradeAmount.value : null,
            numTrades: horizonTrades.value,
            goalBalance: goal.value,
            tiers: isAmountMode.value ? [] : tiers.value,
        })
    })

    const tracker = computed(() => trackTradesAgainstPlan({
        startBalance: start.value,
        goalBalance: goal.value,
        startDate: activePlan.value.startDate,
        pctPerTrade: tradePct.value == null ? 0 : tradePct.value,
        tradeAmount: isAmountMode.value ? tradeAmount.value : null,
        tiers: isAmountMode.value ? [] : tiers.value,
        horizonTrades: horizonTrades.value,
        dayDocs: dayDocs.value,
        account: activeAccount.value,
        excludedTradeIds: activePlan.value.excludedTradeIds || [],
        tradeGroups: activePlan.value.tradeGroups || [],
        projection: projection.value,
        tz: timeZoneTrade.value || 'UTC',
    }))

    let unsub = null
    onMounted(() => {
        refreshPlanTrackerTrades()
        unsub = useJournalUpdates(() => refreshPlanTrackerTrades())
    })
    onBeforeUnmount(() => {
        if (unsub) unsub()
    })

    watch(() => currentUser.value?.objectId, (id) => {
        if (id && !loaded.value) refreshPlanTrackerTrades()
    })

    function toggleSkipTrade(tradeId) {
        toggleTradeExcluded(activePlan.value, tradeId)
    }

    function skipTrades(tradeIds) {
        excludeTradeIds(activePlan.value, tradeIds)
    }

    function mergeTrades(tradeIds) {
        mergeTradesInPlan(activePlan.value, tradeIds)
    }

    function unmergeTrades(memberIds) {
        unmergeTradeGroup(activePlan.value, memberIds)
    }

    return {
        plan: activePlan,
        projection,
        tracker,
        loading,
        loaded,
        refresh: refreshPlanTrackerTrades,
        toggleSkipTrade,
        skipTrades,
        mergeTrades,
        unmergeTrades,
    }
}
