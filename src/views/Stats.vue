<script setup>
/**
 * Win-rate / net P&L broken down by Technique tag.
 *
 * Deliberately independent of Dashboard's `groups.tags`/`barChartNegativeTagGroups`
 * pipeline (src/utils/trades.js useGroupTrades, src/utils/utils.js
 * buildDashboardTagGroups): that path only attaches a trade's tags that are
 * CURRENTLY TICKED in the tag filter (trades.js's tag-merge loop is gated behind
 * `selectedTagsArray.includes(...)`), which answers "how did my selected tags do"
 * -- not "how did every technique do", which is what this page is for. So this
 * reads the unfiltered tag assignments and trades directly and does its own small
 * group-by instead.
 *
 * Feeds from the same account/date-range mount every other page uses
 * (useGetSelectedRange -> useApplyActiveAccount), so it already answers for
 * whichever MT5 account is active, same as Dashboard/History/Calendar.
 */
import { computed, onBeforeMount } from 'vue'
import NoData from '../components/NoData.vue'
import SpinnerLoadingPage from '../components/SpinnerLoadingPage.vue'
import { filteredTrades, tags, spinnerLoadingPage } from '../stores/globals'
import { useGetSelectedRange, useTwoDecCurrencyFormat } from '../utils/utils'
import { useGetFilteredTrades } from '../utils/trades'
import { useGetTags, useGetAvailableTags, useGetTagInfo } from '../utils/daily'

onBeforeMount(async () => {
    spinnerLoadingPage.value = true
    try {
        await useGetSelectedRange()
        await Promise.all([useGetTags(), useGetAvailableTags()])
        await useGetFilteredTrades()
    } catch (error) {
        console.error('could not load stats', error)
    } finally {
        spinnerLoadingPage.value = false
    }
})

/* One row per technique tag: trade count, win rate, net P&L.
 *
 * Only CLOSED trades count toward win/loss -- an open position has no realized
 * P&L yet, and folding it in either direction would misstate the rate. A trade
 * with no tag at all falls into "Untagged" rather than being silently dropped,
 * so the totals row always reconciles with what History shows for the same range. */
const rows = computed(() => {
    const buckets = new Map()
    const bucket = (id, name) => {
        if (!buckets.has(id)) buckets.set(id, { id, name, trades: 0, wins: 0, losses: 0, net: 0 })
        return buckets.get(id)
    }

    for (const day of filteredTrades) {
        for (const trade of (day.trades || [])) {
            if (trade.openPosition) continue
            const net = Number(trade.netProceeds) || 0
            const assignment = tags.find((t) => t.tradeId === trade.id)
            const tagIds = (assignment && assignment.tags && assignment.tags.length) ? assignment.tags : [null]
            for (const tagId of tagIds) {
                const info = tagId ? useGetTagInfo(tagId) : null
                const b = tagId
                    ? bucket(tagId, (info && info.tagName) || tagId)
                    : bucket('untagged', 'Untagged')
                b.trades += 1
                b.net += net
                if (net >= 0) b.wins += 1; else b.losses += 1
            }
        }
    }

    return [...buckets.values()]
        .map((b) => ({ ...b, winRate: b.trades ? (b.wins / b.trades) * 100 : 0 }))
        .sort((a, b) => b.net - a.net)
})

const totals = computed(() => rows.value.reduce((acc, r) => ({
    trades: acc.trades + r.trades,
    wins: acc.wins + r.wins,
    net: acc.net + r.net,
}), { trades: 0, wins: 0, net: 0 }))

const pnlClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '')
</script>

<template>
    <SpinnerLoadingPage />
    <div v-show="!spinnerLoadingPage" class="statsPage mt-2">
        <NoData v-if="!rows.length" />
        <table v-else class="table statsTable">
            <thead>
                <tr>
                    <th>Technique</th>
                    <th class="text-end">Trades</th>
                    <th class="text-end">Win rate</th>
                    <th class="text-end">Net P&amp;L</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="row in rows" :key="row.id">
                    <td>{{ row.name }}</td>
                    <td class="text-end">{{ row.trades }}</td>
                    <td class="text-end">{{ row.winRate.toFixed(0) }}%</td>
                    <td class="text-end" :class="pnlClass(row.net)">{{ useTwoDecCurrencyFormat(row.net) }}</td>
                </tr>
            </tbody>
            <tfoot>
                <tr class="statsTotalRow">
                    <td>Total</td>
                    <td class="text-end">{{ totals.trades }}</td>
                    <td class="text-end">{{ totals.trades ? ((totals.wins / totals.trades) * 100).toFixed(0) : 0 }}%</td>
                    <td class="text-end" :class="pnlClass(totals.net)">{{ useTwoDecCurrencyFormat(totals.net) }}</td>
                </tr>
            </tfoot>
        </table>
    </div>
</template>

<style scoped>
.statsTable th,
.statsTable td {
    vertical-align: middle;
}

.statsTotalRow td {
    font-weight: 600;
    border-top: 2px solid var(--border-subtle);
}

.pos { color: #00CA73; }
.neg { color: #ef4444; }
</style>
