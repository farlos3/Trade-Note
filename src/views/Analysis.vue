<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import axios from 'axios'
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek.js'; dayjs.extend(isoWeek)
import FpDate from '../components/FpDate.vue'
import { timeZoneTrade } from '../stores/globals'
import { useAuthHeaders } from '../utils/apiAuth'

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

/* Calendar-aligned periods, not only rolling windows: "this week" as the week
   you are actually in is what a review question ("how am I doing this week?")
   means, and a rolling 7 days answers something else. Both kinds are offered.
   `custom` reads the two date inputs below. */
const PERIODS = [
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'This week' },
    { id: 'month', label: 'This month' },
    { id: '30d', label: '30 days' },
    { id: '90d', label: '90 days' },
    { id: 'all', label: 'All' },
    { id: 'custom', label: 'Custom' },
]
const customFrom = ref(localStorage.getItem('aiAnalysisFrom') || '')
const customTo = ref(localStorage.getItem('aiAnalysisTo') || '')
watch(customFrom, (v) => localStorage.setItem('aiAnalysisFrom', v || ''))
watch(customTo, (v) => localStorage.setItem('aiAnalysisTo', v || ''))

// Weeks start Monday here, matching the isoWeek grouping the rest of the app
// uses for its weekly buckets.
function rangeFor(p) {
    const tomorrow = () => dayjs().add(1, 'day').format('YYYY-MM-DD') // exclusive upper bound
    if (p === 'all') return { from: null, to: null }
    if (p === 'today') return { from: dayjs().format('YYYY-MM-DD'), to: tomorrow() }
    if (p === 'week') return { from: dayjs().startOf('isoWeek').format('YYYY-MM-DD'), to: tomorrow() }
    if (p === 'month') return { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: tomorrow() }
    if (p === 'custom') {
        // A half-filled custom range would silently analyse everything, so treat
        // a missing end as "up to today" and a missing start as "from the start".
        return {
            from: customFrom.value || null,
            to: customTo.value ? dayjs(customTo.value).add(1, 'day').format('YYYY-MM-DD') : tomorrow(),
        }
    }
    const days = p === '90d' ? 90 : 30
    return { from: dayjs().subtract(days, 'day').format('YYYY-MM-DD'), to: tomorrow() }
}

/* Cache key. For fixed periods the id is enough, but every custom range is a
   different question -- keying them all as "custom" would serve one range's
   answer for another. */
function cacheKeyFor(p) {
    if (p !== 'custom') return p
    const { from, to } = rangeFor(p)
    return `custom:${from || 'start'}:${to || 'now'}`
}

async function fetchFingerprint(from, to) {
    // tz matters here too: the server resolves YYYY-MM-DD in the trade timezone,
    // so omitting it would fingerprint a different range than the one analysed.
    const params = { tz: timeZoneTrade.value || 'UTC' }
    if (from) params.from = from
    if (to) params.to = to
    const res = await axios.get('/api/analysis/fingerprint', { params, headers: useAuthHeaders() })
    return res.data?.fingerprint || ''
}

// Show whatever is cached for a period immediately, no request. Returns true if
// a cached result was displayed.
function showCachedFor(p) {
    const entry = loadCache()[cacheKeyFor(p)]
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
        const ck = cacheKeyFor(period.value)
        const entry = cache[ck]

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
        const res = await axios.get('/api/analysis/behavior', { params, headers: useAuthHeaders() })
        data.value = res.data
        cached.value = false
        lastUpdated.value = Date.now()
        cache[ck] = {
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

/* One sentence naming the exact window in play. Shown next to the button and
   repeated in the confirm, so an LLM call is never made on a range the user
   thinks is something else. */
const rangeSummary = computed(() => {
    const p = PERIODS.find((x) => x.id === period.value)
    const { from, to } = rangeFor(period.value)
    if (!from && !to) return `${p ? p.label : ''} · every trade on record`
    // `to` is the exclusive upper bound; show the last INCLUDED day instead.
    const lastDay = to ? dayjs(to).subtract(1, 'day').format('YYYY-MM-DD') : null
    if (from && lastDay && from === lastDay) return `${p ? p.label : ''} · ${from}`
    return `${p ? p.label : ''} · ${from || 'start'} to ${lastDay || 'today'}`
})

const updatedLabel = () => (lastUpdated.value ? dayjs(lastUpdated.value).format('MMM D, HH:mm') : '')

/* ---- LLM (Claude) analysis — triggered by the Analyze-behavior button ----
   Rule-based summary shows by default (free, instant). Clicking asks the server
   to have Claude write a richer analysis; the result is cached per period by the
   same fingerprint, so it only re-calls Claude when an order changes. Needs
   an ANTHROPIC_API_KEY or GEMINI_API_KEY on the server — without either the
   endpoint reports disabled and the rule-based summary stays. */
const aiSummary = ref('')
const aiLoading = ref(false)
const aiError = ref('')
const aiDisabled = ref(false)
const aiProvider = ref('')   // 'anthropic' | 'gemini', reported by the server
const AI_CACHE_KEY = 'aiLlmSummaryCache_v1'
const loadAiCache = () => { try { return JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}') } catch { return {} } }
const saveAiCache = (o) => { try { localStorage.setItem(AI_CACHE_KEY, JSON.stringify(o)) } catch { /* quota */ } }

function showCachedAiFor(p) {
    const c = loadAiCache()[cacheKeyFor(p)]
    aiSummary.value = c && c.summary ? c.summary : ''
    aiProvider.value = (c && c.provider) || ''
    aiError.value = ''
    aiDisabled.value = false
}

/* Themed confirm. window.confirm() renders a white OS dialog that ignores the
   dark theme entirely, and cannot be styled — so this is a small in-page modal
   resolved through a promise, keeping the `if (!confirmed) return` shape. */
const confirmOpen = ref(false)
let confirmResolve = null

function askConfirm() {
    confirmOpen.value = true
    return new Promise((resolve) => { confirmResolve = resolve })
}

function closeConfirm(ok) {
    confirmOpen.value = false
    if (confirmResolve) { confirmResolve(ok); confirmResolve = null }
}

// Escape cancels, matching the native dialog it replaces.
function onConfirmKey(e) {
    if (confirmOpen.value && e.key === 'Escape') closeConfirm(false)
}
onMounted(() => window.addEventListener('keydown', onConfirmKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onConfirmKey))

const confirmTradeCount = computed(() =>
    data.value && data.value.stats ? data.value.stats.trades : null)

async function runAI(force = false) {
    // Confirm first: this is a paid, per-token call, and the range it runs on is
    // not obvious from the button alone.
    if (!(await askConfirm())) return

    if (!data.value) await run(false)      // need the rule-based data (for the fingerprint)
    if (!data.value) return
    const fp = (data.value.meta && data.value.meta.fingerprint) || ''
    const cache = loadAiCache()
    const key = cacheKeyFor(period.value)
    aiError.value = ''
    aiDisabled.value = false
    if (!force && cache[key] && cache[key].fingerprint === fp && cache[key].summary) {
        aiSummary.value = cache[key].summary          // no new orders -> reuse
        // Restore the provider too, or the badge would claim whichever provider
        // happened to answer last instead of the one that wrote this summary.
        aiProvider.value = cache[key].provider || ''
        return
    }
    aiLoading.value = true
    try {
        const { from, to } = rangeFor(period.value)
        const params = { tz: timeZoneTrade.value || 'UTC' }
        if (from) params.from = from
        if (to) params.to = to
        const res = await axios.get('/api/analysis/ai-summary', { params, timeout: 120000, headers: useAuthHeaders() })
        if (res.data && res.data.disabled) { aiDisabled.value = true; aiSummary.value = ''; return }
        if (res.data && res.data.refused) { aiError.value = 'The model declined this request.'; return }
        aiSummary.value = (res.data && res.data.summary) || ''
        aiProvider.value = (res.data && res.data.provider) || ''
        cache[key] = { fingerprint: (res.data && res.data.fingerprint) || fp, summary: aiSummary.value, provider: aiProvider.value }
        saveAiCache(cache)
    } catch (e) {
        aiError.value = e?.response?.data?.error || e.message
    } finally {
        aiLoading.value = false
    }
}

/* ---- Export for "ask Claude yourself" (subscription, no API key) ----
   Bundles the computed data with a ready-to-use prompt so you can paste it into
   Claude Desktop / Code / claude.ai and get the analysis on your subscription. */
const copied = ref(false)
// The model is told to emit exactly these, each alone on a line, so they can be
// styled as headings without parsing Markdown.
const AI_HEADINGS = ['Verdict', 'Strengths', 'Watch-outs', 'Recommendations']
const PROVIDER_LABELS = { anthropic: 'Claude', gemini: 'Gemini' }
const aiProviderLabel = computed(() => PROVIDER_LABELS[aiProvider.value] || 'AI')

const CLAUDE_INSTRUCTION = 'You are a trading-performance coach. Analyze the trader\'s behavior from the computed statistics and behavioral flags below. Be concise, specific and actionable, in plain English. Ground every claim in the numbers — never invent data. Structure the reply as: a one-line verdict; Strengths; Watch-outs (revenge trading, overtrading, position-size tilt, holding-time bias, weak entry hours where relevant); and Recommendations. Use short bullet points.'

function claudePayload() {
    const d = data.value || {}
    return {
        instruction: CLAUDE_INSTRUCTION,
        range: d.range || null,
        timezone: d.timezone || null,
        data: { stats: d.stats || null, patterns: d.patterns || null, notes: d.notes || [] },
    }
}

function claudePasteText() {
    const p = claudePayload()
    const r = p.range || {}
    return `${p.instruction}\n\nHere is my trading data (${r.from || 'all'} to ${r.to || 'now'}, timezone ${p.timezone || 'UTC'}):\n\n\`\`\`json\n${JSON.stringify(p.data, null, 2)}\n\`\`\``
}

async function copyForClaude() {
    try {
        await navigator.clipboard.writeText(claudePasteText())
        copied.value = true
        setTimeout(() => (copied.value = false), 2000)
    } catch (e) {
        downloadForClaude()   // clipboard blocked (e.g. non-HTTPS) -> fall back to a file
    }
}

function downloadForClaude() {
    const blob = new Blob([JSON.stringify(claudePayload(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tradenote-behavior-${period.value}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}

onMounted(() => {
    showCachedFor(period.value)   // instant paint from cache
    showCachedAiFor(period.value) // and any cached AI analysis for this period
    run(false)                    // then validate / refresh if orders changed
})

watch(period, (p) => {
    if (!showCachedFor(p)) data.value = null
    showCachedAiFor(p)
    run(false)
})

// Editing a custom date changes the range without changing `period`, so the
// watcher above never fires -- the page would keep showing the previous range's
// numbers under the new dates.
watch([customFrom, customTo], () => {
    if (period.value !== 'custom') return
    if (!showCachedFor('custom')) data.value = null
    showCachedAiFor('custom')
    run(false)
})

/* ---- formatting helpers ---- */
const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }))
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(1) + '%')
const pnlClass = (n) => (n == null ? '' : n > 0 ? 'greenTrade' : n < 0 ? 'redTrade' : '')

/* Card copy per flag. `rule` states the exact test the backend applies, so the
   number on the card can be reconciled with why it did or didn't trip; the
   thresholds below are the ones hard-coded in mcp-server/analysis.mjs
   (findBehaviorPatterns) and must be kept in step with it. `why` says what the
   pattern costs, `action` what to do about it. */
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
            rule: `Counts every trade opened less than ${p.revengeTrading.windowMinutes} minutes after closing a losing one.`,
            why: 'Entries that fast are usually a reaction to the loss rather than a fresh setup, so they tend to win less often than your normal trades. Compare the win rate above with your overall win rate — if it is lower, these trades are costing you.',
            action: 'Set a fixed cool-down after a loss and only re-enter on a setup you wrote down beforehand.',
        },
        {
            key: 'overtrading',
            title: 'Overtrading',
            desc: `Days with abnormal trade count / total lots, or an oversized trade (lot ≥ ${fmt(p.overtrading.lotCap, 2)})`,
            bad: p.overtrading.flaggedDays > 0,
            metric: `${p.overtrading.flaggedDays} days`,
            sub: p.overtrading.flaggedDays ? `net ${fmt(p.overtrading.netOnFlaggedDays)} · ${p.overtrading.oversizedTrades} oversized trade(s)` : 'none',
            rule: `Flags a day when its trade count reaches ${p.overtrading.flagThreshold} (2× your median of ${p.overtrading.medianTradesPerDay}/day, or median + 3), OR its total lots reach ${fmt(p.overtrading.lotsThreshold, 2)} (2× your median of ${fmt(p.overtrading.medianLotsPerDay, 2)} lots/day), OR it contains a single trade with lot ≥ ${fmt(p.overtrading.lotCap, 2)} — a size bigger than your normal. Each flagged day notes which one tripped.`,
            why: 'The count/lots bars are your own medians, so they adapt to how you trade; the oversized-lot bar is a fixed size you consider too big. A day far above your norm — or one where you sized up past that lot — usually means chasing rather than waiting for setups.',
            action: 'Cap the number of trades and the total lots per day in advance, and keep single-trade lot at or below your normal size.',
        },
        {
            key: 'sizing',
            title: 'Sizing up after losses',
            desc: 'Avg position size after a loss vs after a win (tilt / martingale)',
            bad: p.positionSizingTilt.flag != null,
            metric: p.positionSizingTilt.ratio != null ? `${fmt(p.positionSizingTilt.ratio)}×` : '—',
            sub: `after loss ${fmt(p.positionSizingTilt.avgSizeAfterLoss, 3)} · after win ${fmt(p.positionSizingTilt.avgSizeAfterWin, 3)}`,
            rule: 'Compares average lot size on trades that follow a loss with those that follow a win. Trips above 1.25× — a quarter bigger after losing.',
            why: 'Doubling down to win it back is the fastest route to an outsized loss: risk grows exactly when your read on the market has just been proven wrong. A ratio near 1.00× means your size is independent of the last result, which is what you want.',
            action: 'Fix position size by account risk (a set % per trade), not by how the previous trade went.',
        },
        {
            key: 'holding',
            title: 'Holding losers longer',
            desc: 'Cutting winners early, letting losers run',
            bad: p.holdingTimeBias.flag != null,
            metric: p.holdingTimeBias.ratio != null ? `${fmt(p.holdingTimeBias.ratio)}×` : '—',
            sub: `loss ${fmt(p.holdingTimeBias.avgLoserHoldMinutes, 1)} min · win ${fmt(p.holdingTimeBias.avgWinnerHoldMinutes, 1)} min`,
            rule: 'Compares average holding time of losing trades with winning ones. Trips above 1.3× — losers held nearly a third longer.',
            why: 'This is the disposition effect: taking profit early feels safe while a loss stays "not real" until closed. It shrinks your winners and stretches your losers, which drags the profit factor down even when your win rate looks fine.',
            action: 'Decide the exit before entering — stop and target — and let those close the trade instead of deciding in the moment.',
        },
    ]
}

const topEntries = (obj, n = 6) => (obj ? Object.entries(obj).slice(0, n) : [])

const money = (n) => (n == null ? '—' : (n >= 0 ? '+$' : '-$') + fmt(Math.abs(n)))

/* Template-generated behavior summary — turns the computed stats + flags into a
   short written read-out with recommendations. Rule-based, so it runs client-side
   with no API call or key (unlike an LLM summary). Re-derives whenever `data`
   changes, so clicking "Analyze behavior" refreshes it for free. */
const narrative = computed(() => {
    if (!data.value || !data.value.stats || !data.value.stats.trades) return null
    const s = data.value.stats
    const p = data.value.patterns || {}

    let verdict, tone
    if (s.netPnL > 0 && s.profitFactor >= 1.5) {
        verdict = `Clear edge — net ${money(s.netPnL)}, Profit Factor ${fmt(s.profitFactor)}`
        tone = 'pos'
    } else if (s.netPnL > 0) {
        verdict = `Net positive (${money(s.netPnL)}) but not strong yet — Profit Factor ${fmt(s.profitFactor)}`
        tone = 'neu'
    } else {
        verdict = `Still net negative (${money(s.netPnL)}) — plug the leaks before sizing up`
        tone = 'neg'
    }

    const overview = `${s.trades} trades · Win ${pct(s.winRate)} · Net ${money(s.netPnL)} · PF ${fmt(s.profitFactor)} · Expectancy ${money(s.expectancy)}/trade`

    const wd = Object.entries(s.byWeekday || {}).sort((a, b) => a[1].net - b[1].net)
    const hr = Object.entries(s.byEntryHour || {}).sort((a, b) => a[1].net - b[1].net)
    const bestWd = wd.length ? wd[wd.length - 1] : null
    const worstHr = hr.length ? hr[0] : null

    const strengths = []
    if (s.avgWin > s.avgLoss) strengths.push(`Good win/loss control — avg win ${money(s.avgWin)} beats avg loss -$${fmt(s.avgLoss)}`)
    if (s.profitFactor >= 1.5) strengths.push(`Profit Factor ${fmt(s.profitFactor)} — every $1 risked returns $${fmt(s.profitFactor)}`)
    if (s.expectancy > 0) strengths.push(`Positive expectancy ${money(s.expectancy)}/trade — disciplined volume compounds`)
    if (bestWd && bestWd[1].net > 0) strengths.push(`Best weekday: ${bestWd[0]} (${money(bestWd[1].net)}, win ${pct(bestWd[1].winRate)})`)

    const flags = []
    if (p.overtrading && p.overtrading.flaggedDays > 0) {
        const d = (p.overtrading.days && p.overtrading.days[0]) || null
        let detail = `${p.overtrading.flaggedDays} day(s)`
        if (d) {
            const r = d.reason || ''
            const bits = []
            if (r.includes('count')) bits.push(`${d.trades} trades`)
            if (r.includes('lots')) bits.push(`${fmt(d.volume, 2)} lots`)
            if (r.includes('oversized')) bits.push(`${d.oversizedTrades} oversized (lot ≥ ${fmt(p.overtrading.lotCap, 2)})`)
            detail = `${d.date}: ${bits.join(', ')}`
        }
        flags.push(`Overtrading — ${detail} (norm ~${p.overtrading.medianTradesPerDay} trades / ${fmt(p.overtrading.medianLotsPerDay, 2)} lots per day; oversized ≥ ${fmt(p.overtrading.lotCap, 2)} lot)`)
    }
    if (p.positionSizingTilt && p.positionSizingTilt.flag) {
        flags.push(`Sizing up after losses ${fmt(p.positionSizingTilt.ratio)}× — martingale / revenge tendency`)
    }
    if (p.holdingTimeBias && p.holdingTimeBias.flag) {
        flags.push(`Holding losers longer than winners ${fmt(p.holdingTimeBias.ratio)}× (${fmt(p.holdingTimeBias.avgLoserHoldMinutes, 0)} vs ${fmt(p.holdingTimeBias.avgWinnerHoldMinutes, 0)} min) — cutting winners early, letting losers run`)
    }
    if (p.revengeTrading && p.revengeTrading.count > 0) {
        const won = p.revengeTrading.winRate >= 0.99
        flags.push(`Revenge trades: ${p.revengeTrading.count} (re-entered within ${p.revengeTrading.windowMinutes} min of a loss)${won ? ' — profitable this time, but a risky habit' : ''}`)
    }
    if (worstHr && worstHr[1].net < 0) flags.push(`Worst entry hour: ${worstHr[0]} (${money(worstHr[1].net)})`)

    const recs = []
    if (p.overtrading && p.overtrading.flaggedDays > 0) recs.push('Set a max trades-per-day cap in advance; stop when you hit it')
    if (p.positionSizingTilt && p.positionSizingTilt.flag) recs.push('Fix lot size by account risk %, not by the last result')
    if (p.holdingTimeBias && p.holdingTimeBias.flag) recs.push('Set TP/SL before entry and let them close the trade — let winners run, cut losers fast')
    if (p.revengeTrading && p.revengeTrading.count > 0) recs.push('Add a cool-down after a loss; only re-enter on a pre-planned setup')
    if (bestWd && worstHr) recs.push(`Lean into strong windows (${bestWd[0]}), reduce size in weak ones (${worstHr[0]})`)
    if (!recs.length) recs.push('Behavior metrics look healthy — keep the discipline')

    return { verdict, tone, overview, strengths, flags, recs }
})
</script>

<template>
    <div class="analysisPage p-3">
        <!-- Themed replacement for window.confirm(), which renders an unstyled
             white OS dialog. Teleported to body so page stacking contexts can't
             trap it behind a card. -->
        <Teleport to="body">
            <div v-if="confirmOpen" class="cfmBackdrop" v-on:click.self="closeConfirm(false)">
                <div class="cfmCard" role="dialog" aria-modal="true" aria-labelledby="cfmTitle">
                    <div class="cfmHead" id="cfmTitle">
                        <i class="uil uil-brain me-2"></i>Run the AI analysis?
                    </div>
                    <div class="cfmBody">
                        <div class="cfmRow">
                            <span class="cfmKey">Range</span>
                            <span class="cfmVal">{{ rangeSummary }}</span>
                        </div>
                        <div class="cfmRow" v-if="confirmTradeCount != null">
                            <span class="cfmKey">Trades</span>
                            <span class="cfmVal">{{ confirmTradeCount }}</span>
                        </div>
                        <p class="cfmNote mb-0">
                            This sends your computed stats and journal notes to the model. Billed per token.
                        </p>
                    </div>
                    <div class="cfmFoot">
                        <button type="button" class="btn btn-outline-secondary btn-sm"
                            v-on:click="closeConfirm(false)">Cancel</button>
                        <button type="button" class="btn btn-success btn-sm" autofocus
                            v-on:click="closeConfirm(true)">Analyze</button>
                    </div>
                </div>
            </div>
        </Teleport>

        <!-- Row 1: what to analyse, and the button that does it — the actions stay
             together on one line. Row 2 carries the resolved window and freshness,
             which are read-outs rather than controls. -->
        <div class="d-flex flex-wrap align-items-center gap-2">
            <div class="btn-group" role="group">
                <button v-for="p in PERIODS" :key="p.id" type="button"
                    v-bind:class="['btn', 'btn-sm', period === p.id ? 'btn-primary' : 'btn-outline-secondary']"
                    v-on:click="period = p.id">{{ p.label }}</button>
            </div>
            <!-- Only rendered for the custom period, so the row stays compact for
                 the one-click ranges that cover most reviews. -->
            <div v-if="period === 'custom'" class="customRange">
                <span class="rangeLabel">From</span>
                <FpDate mode="date" v-model="customFrom" placeholder="start" />
                <span class="rangeLabel">to</span>
                <FpDate mode="date" v-model="customTo" placeholder="today" />
                <button v-if="customFrom || customTo" type="button" class="btn btn-link btn-sm rangeClear"
                    v-on:click="customFrom = ''; customTo = ''" title="Clear the custom range">clear</button>
            </div>
            <div class="ms-auto d-flex align-items-center gap-2">
                <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="run(true)"
                    :disabled="loading" title="Refresh data (rule-based)">
                    <i class="uil uil-sync"></i>
                </button>
                <button type="button" class="btn btn-success btn-sm" v-on:click="runAI(false)"
                    :disabled="aiLoading || loading" title="Ask the model to write the analysis (billed per token)">
                    <span v-if="aiLoading" class="spinner-border spinner-border-sm me-2" role="status"></span>
                    <i v-else class="uil uil-brain me-1"></i>Analyze behavior
                </button>
            </div>
        </div>

        <div class="d-flex flex-wrap align-items-center gap-2 mb-3 toolbarMeta">
            <span class="rangeSummary" title="The analysis uses exactly this window">
                <i class="uil uil-calendar-alt me-1"></i>{{ rangeSummary }}
            </span>
            <span v-if="lastUpdated" class="ms-auto txt-small text-secondary">
                <i v-if="cached" class="uil uil-check-circle me-1"></i>{{ cached ? 'Cached' : 'Updated' }} · {{
                    updatedLabel() }}
            </span>
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
                    <details class="flagMore">
                        <summary>What this means</summary>
                        <p class="flagNote"><span class="flagNoteLabel">How it is measured</span>{{ c.rule }}</p>
                        <p class="flagNote"><span class="flagNoteLabel">Why it matters</span>{{ c.why }}</p>
                        <p class="flagNote mb-0"><span class="flagNoteLabel">What to do</span>{{ c.action }}</p>
                    </details>
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

            <!-- Behavior summary, placed above the notes: it is the conclusion the
                 page exists to deliver, so it should not sit below the raw journal
                 entries. Rule-based read-out always; Claude's LLM analysis on top once
                 "Analyze behavior" is clicked. -->
            <div v-if="narrative" class="behaviorSummary mt-3">
                <div class="d-flex align-items-center mb-2">
                    <i class="uil uil-robot me-2" style="font-size:1.15rem;"></i>
                    <span class="bsTitle">Behavior summary</span>
                    <span class="bsBadge ms-2">{{ aiSummary ? 'AI · ' + aiProviderLabel : 'rule-based' }}</span>
                </div>

                <!-- Claude (LLM) analysis -->
                <div v-if="aiLoading" class="bsAiState mb-3">
                    <span class="spinner-border spinner-border-sm me-2" role="status"></span>Analyzing…
                </div>
                <div v-else-if="aiSummary" class="bsAi mb-3">
                    <template v-for="(line, i) in aiSummary.split('\n')" :key="i">
                        <div v-if="AI_HEADINGS.includes(line.trim())" class="bsAiHead">{{ line }}</div>
                        <div v-else>{{ line }}</div>
                    </template>
                </div>
                <div v-if="aiDisabled" class="bsHint mb-3">
                    AI analysis needs <code>ANTHROPIC_API_KEY</code> or <code>GEMINI_API_KEY</code> set on the server
                    (billed per token, separate from any Claude or Gemini subscription). The rule-based summary below
                    always works for free.
                </div>
                <div v-if="aiError" class="bsHint bsHintErr mb-3">{{ aiError }}</div>

                <!-- Rule-based read-out (always shown) -->
                <div v-bind:class="['bsVerdict', 'bs-' + narrative.tone]">{{ narrative.verdict }}</div>
                <div class="bsOverview">{{ narrative.overview }}</div>
                <div v-if="narrative.strengths.length" class="bsBlock">
                    <div class="bsHead bsPos">Strengths</div>
                    <ul class="bsList">
                        <li v-for="(x, i) in narrative.strengths" :key="'s' + i">{{ x }}</li>
                    </ul>
                </div>
                <div v-if="narrative.flags.length" class="bsBlock">
                    <div class="bsHead bsFlag">Watch-outs</div>
                    <ul class="bsList">
                        <li v-for="(x, i) in narrative.flags" :key="'f' + i">{{ x }}</li>
                    </ul>
                </div>
                <div class="bsBlock">
                    <div class="bsHead bsRec">Recommendations</div>
                    <ul class="bsList">
                        <li v-for="(x, i) in narrative.recs" :key="'r' + i">{{ x }}</li>
                    </ul>
                </div>

                <!-- Ask Claude yourself: export prompt + data to paste into Claude
                     Desktop / Code / claude.ai (uses your subscription, no API key). -->
                <div class="bsExport">
                    <div class="txt-small text-secondary mb-2">
                        <i class="uil uil-comment-alt-lines me-1"></i>Ask Claude yourself (uses your subscription — free):
                        copy the prompt + data below and paste it into Claude Desktop / Code / claude.ai.
                    </div>
                    <button type="button" class="btn btn-outline-primary btn-sm me-2" v-on:click="copyForClaude()">
                        <i class="uil uil-copy me-1"></i>{{ copied ? 'Copied!' : 'Copy prompt + data' }}
                    </button>
                    <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="downloadForClaude()">
                        <i class="uil uil-download-alt me-1"></i>Download JSON
                    </button>
                </div>
            </div>

            <!-- mt-4: the summary above is a bordered card, so the notes need their
                 own breathing room now that they follow it rather than a table. -->
            <div v-if="data.notes && data.notes.length" class="mt-4">
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

/* Collapsed by default: the grid stays scannable, and the full reasoning is one
   click away on the card it belongs to. */
.flagMore {
    margin-top: 0.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    padding-top: 0.45rem;
}

.flagMore > summary {
    font-size: 0.72rem;
    font-weight: 600;
    opacity: 0.7;
    cursor: pointer;
    list-style: none;
}

.flagMore > summary::-webkit-details-marker {
    display: none;
}

.flagMore > summary::before {
    content: '▸ ';
    display: inline-block;
    transition: transform 0.15s ease;
}

.flagMore[open] > summary::before {
    content: '▾ ';
}

.flagMore > summary:hover {
    opacity: 1;
}

.flagNote {
    font-size: 0.72rem;
    line-height: 1.5;
    opacity: 0.75;
    margin: 0.5rem 0 0;
}

/* Behavior summary card */
.behaviorSummary {
    border: 1px solid rgba(120, 130, 255, 0.35);
    background: rgba(120, 130, 255, 0.06);
    border-radius: 0.7rem;
    padding: 0.9rem 1rem;
}

.bsTitle {
    font-weight: 700;
}

.bsVerdict {
    font-weight: 700;
    font-size: 1.02rem;
    line-height: 1.4;
}

.bs-pos {
    color: #22c55e;
}

.bs-neu {
    color: #eab308;
}

.bs-neg {
    color: #ef4444;
}

.bsOverview {
    font-size: 0.8rem;
    opacity: 0.7;
    margin: 0.2rem 0 0.8rem;
}

.bsBlock {
    margin-bottom: 0.6rem;
}

.bsBlock:last-child {
    margin-bottom: 0;
}

.bsHead {
    font-weight: 700;
    font-size: 0.82rem;
    margin-bottom: 0.25rem;
}

.bsPos {
    color: #22c55e;
}

.bsFlag {
    color: #f59e0b;
}

.bsRec {
    color: #60a5fa;
}

.bsList {
    margin: 0;
    padding-left: 1.15rem;
}

.bsList li {
    font-size: 0.85rem;
    line-height: 1.55;
    margin-bottom: 0.2rem;
}

.bsBadge {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.1rem 0.45rem;
    border-radius: 0.5rem;
    background: rgba(120, 130, 255, 0.18);
    color: #a5b4fc;
}

.bsAiState {
    font-size: 0.85rem;
    opacity: 0.75;
}

/* FpDate renders a bare .form-control, which is width:100% -- inside a flex
   toolbar that made each field stretch across the row. Pin them to a date-sized
   width so the custom range reads as one compact control group. */
.customRange {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: nowrap;
}

.customRange :deep(input) {
    width: 8.5rem;
    min-width: 8.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    height: auto;
}

.rangeClear {
    padding: 0 0.25rem;
    font-size: 0.75rem;
    text-decoration: none;
    opacity: 0.7;
}

.rangeSummary {
    font-size: 0.75rem;
    color: var(--white-60);
    white-space: nowrap;
}

.toolbarMeta {
    margin-top: 0.4rem;
    min-height: 1.2rem;
}

/* Confirm modal. Teleported to body, so these rules are NOT scoped-safe by
   default -- hence the :global() wrappers. */
:global(.cfmBackdrop) {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
}

:global(.cfmCard) {
    width: min(420px, 100%);
    background: var(--black-bg-7, #1b1f2a);
    border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.14));
    border-radius: 0.7rem;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
    overflow: hidden;
}

:global(.cfmHead) {
    padding: 0.85rem 1rem;
    font-weight: 700;
    color: var(--white-87, rgba(237, 240, 247, 0.92));
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.07));
}

:global(.cfmBody) {
    padding: 0.85rem 1rem;
}

:global(.cfmRow) {
    display: flex;
    gap: 0.75rem;
    font-size: 0.85rem;
    margin-bottom: 0.35rem;
}

:global(.cfmKey) {
    min-width: 4.5rem;
    color: var(--white-60, rgba(237, 240, 247, 0.6));
}

:global(.cfmVal) {
    color: var(--white-87, rgba(237, 240, 247, 0.92));
    font-weight: 600;
}

:global(.cfmNote) {
    margin-top: 0.6rem;
    font-size: 0.78rem;
    color: var(--white-60, rgba(237, 240, 247, 0.6));
    line-height: 1.5;
}

:global(.cfmFoot) {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.07));
}

.rangeLabel {
    font-size: 0.75rem;
    opacity: 0.6;
}

.bsAiHead {
    font-weight: 700;
    margin-top: 0.7rem;
    margin-bottom: 0.1rem;
    letter-spacing: 0.02em;
}

.bsAiHead:first-child {
    margin-top: 0;
}

.bsAi {
    white-space: pre-wrap;
    font-size: 0.88rem;
    line-height: 1.6;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.bsHint {
    font-size: 0.8rem;
    line-height: 1.5;
    opacity: 0.85;
    background: rgba(234, 179, 8, 0.08);
    border: 1px solid rgba(234, 179, 8, 0.3);
    border-radius: 0.5rem;
    padding: 0.5rem 0.7rem;
}

.bsHintErr {
    background: rgba(220, 53, 69, 0.08);
    border-color: rgba(220, 53, 69, 0.35);
}

.bsExport {
    margin-top: 0.9rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.flagNoteLabel {
    display: block;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.62rem;
    opacity: 0.65;
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
