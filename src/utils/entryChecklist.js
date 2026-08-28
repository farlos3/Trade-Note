/**
 * Post-entry review: the moment a new order is seen -- an open position on Live
 * that has no checklist yet, or a trade that just synced into History -- it goes
 * into a shared queue and the modal (mounted once in DashboardLayout) pops up for
 * it. One queue serves both pages because the same trade can be seen first by
 * either one, depending on whether Live happened to be open when it filled.
 *
 * Answers are saved to their own class (`entryChecklists`), keyed by `tradeId` --
 * the MT5 position id, which is the one identifier that is the same value whether
 * the trade is read from the live feed (`positions[].ticket`) or from a synced
 * trade (`trade.positionId`), so a checklist started on Live is recognised later
 * on History and never asked twice.
 */
import { reactive, computed } from 'vue'
import Parse from 'parse/dist/parse.min.js'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(utc)
dayjs.extend(timezone)
import { timeZoneTrade } from '../stores/globals.js'
import { useAuthHeaders } from './apiAuth'
import { useLiveSnapshots } from './journalStream.js'

/**
 * Only today's trades are ever offered for review.
 *
 * Start of the trading day in the TRADE timezone, not UTC -- day documents are
 * keyed to trade-tz midnight, and using UTC here would pull in part of yesterday
 * (or drop part of this morning) depending on the offset.
 *
 * The bound is a day rather than a rolling window because the review is meant to
 * be done while the trade is fresh. Anything older is water under the bridge: it
 * cannot be honestly recalled, and a queue of stale trades only teaches you to
 * click through the popup, which defeats the whole thing.
 */
export function checklistCutoffUnix() {
    return dayjs().tz(timeZoneTrade.value || 'UTC').startOf('day').unix()
}

const pending = reactive([])   // [{ tradeId, dateUnix, symbol, side, entryPrice, tp, sl }]
const queuedIds = new Set()    // tradeIds currently sitting in `pending`

let checklistedIds = null      // Set of tradeIds already answered, loaded once per session
let loadingChecklistedIds = null

/** Trade ids that already have a saved checklist. Cached for the session; every
 *  page that offers trades awaits this first so a trip back to an already-checked
 *  trade never re-queues it. */
export async function useLoadChecklistedIds() {
    if (checklistedIds) return checklistedIds
    if (loadingChecklistedIds) return loadingChecklistedIds
    loadingChecklistedIds = (async () => {
        const ids = new Set()
        try {
            const query = new Parse.Query(Parse.Object.extend('entryChecklists'))
            query.equalTo('user', Parse.User.current())
            query.select('tradeId')
            query.limit(5000)
            const results = await query.find()
            results.forEach((r) => ids.add(r.get('tradeId')))
        } catch (e) {
            console.error('could not load checklisted trade ids', e)
        }
        checklistedIds = ids
        return ids
    })()
    return loadingChecklistedIds
}

/**
 * Every saved review, newest entry first.
 *
 * Until this existed the class was write-only: the answers went in and the only
 * thing ever read back was `tradeId`, to avoid asking twice. Which meant the
 * questions were being answered into a hole -- and a trading journal whose whole
 * argument is "notice your own patterns" has to be able to show you the answers
 * next to each other.
 */
export async function loadEntryChecklists(limit = 500) {
    const query = new Parse.Query(Parse.Object.extend('entryChecklists'))
    query.equalTo('user', currentUserOrNull())
    query.descending('dateUnix')
    query.limit(limit)
    const results = await query.find()
    return results.map((r) => ({
        objectId: r.id,
        tradeId: r.get('tradeId'),
        dateUnix: r.get('dateUnix') || 0,
        symbol: r.get('symbol') || '',
        side: r.get('side') || '',
        lot: r.get('lot') || 0,
        hasTp: !!r.get('hasTp'),
        hasSl: !!r.get('hasSl'),
        tpPrice: r.get('tpPrice') || 0,
        slPrice: r.get('slPrice') || 0,
        tpPips: r.get('tpPips') || 0,
        slPips: r.get('slPips') || 0,
        tpSlAcceptable: !!r.get('tpSlAcceptable'),
        positionQuality: r.get('positionQuality') || '',
        entryEmotion: r.get('entryEmotion') || '',
        entryReasoning: r.get('entryReasoning') || '',
        logicValid: !!r.get('logicValid'),
        oversized: !!r.get('oversized'),
        revengeScore: r.get('revengeScore') || 0,
    }))
}

/** Queue a trade for review. No-ops if it is already answered or already queued. */
export function offerEntryChecklist(trade) {
    if (!trade || !trade.tradeId) return
    if (queuedIds.has(trade.tradeId)) return
    if (checklistedIds && checklistedIds.has(trade.tradeId)) return
    queuedIds.add(trade.tradeId)
    pending.push(trade)
}

export const currentEntryChecklist = computed(() => pending[0] || null)

/* How many are waiting. With the history fallback a backlog is now possible (a
   spell with the live feed down leaves every trade of that period unreviewed), and
   a gate that reappears with no sense of how many are left reads as broken rather
   than as a queue. */
export const entryChecklistQueueLength = computed(() => pending.length)

/**
 * Watch for new orders from ANY page.
 *
 * The queue used to be fed only by Live.vue and Daily.vue, so a fill that landed
 * while the trader was on the Dashboard, the Calendar or anywhere else was simply
 * never offered -- and since the point is to review an entry while it is still
 * open, "only if you happened to be on the right page" is close to not working at
 * all. The modal has always been mounted in DashboardLayout, i.e. on every page;
 * only the trigger was missing. This supplies it.
 *
 * Polls rather than holding an EventSource: every nav in this app is a full page
 * reload, so a stream would be torn down and re-established constantly, and
 * /api/live only serves an in-memory snapshot. Live.vue keeps its own SSE feed for
 * the per-second numbers -- offerEntryChecklist dedups by tradeId, so the two
 * sources cannot double-queue the same position.
 */
const OPEN_POSITION_POLL_MS = 20000
let watchTimer = null
let stopLiveFrames = null

/**
 * Open positions from the live feed, or null when the feed is not usable.
 *
 * GET /api/live answers `{ stale, snapshot }` -- an envelope, not the snapshot
 * itself, and the server has already decided whether the feed counts as live (see
 * liveIsStale in index.mjs). Reading `stale` rather than re-deriving it from a
 * timestamp here keeps one definition of "the feed is down" instead of two that
 * can drift apart.
 */
async function liveOpenPositions() {
    const res = await fetch('/api/live', { headers: useAuthHeaders() })
    if (!res.ok) return null
    const body = await res.json()
    if (!body || body.stale || !body.snapshot) return null
    return openPositionsFrom(body.snapshot)
}

/**
 * Reviewable positions out of one snapshot, whether it arrived by fetch or down
 * the stream.
 *
 * Same day bound as the history side: a position opened days ago and still
 * running is not something to be asked about now -- the entry it would review
 * happened in a session that is already over.
 */
function openPositionsFrom(snapshot) {
    const cutoff = checklistCutoffUnix()
    return (snapshot.positions || [])
        .filter((p) => !p.openTime || p.openTime >= cutoff)
        .map(useLivePositionAsEntry)
}

/**
 * One MT5 open position, in the shape the queue and the modal read.
 *
 * The feed and the checklist name the same things differently -- `ticket` vs
 * `tradeId`, `priceOpen` vs `entryPrice`, `volume` vs `lot` -- so a raw position
 * handed to offerEntryChecklist is dropped on its first line for having no
 * `tradeId`, silently. That is exactly what the page-wide watcher was doing, so
 * outside Live.vue (which happened to map the fields inline) nothing was ever
 * queued at all.
 *
 * `tp`/`sl` are carried through so the modal can prefill the stops the order
 * already has: MT5 reports "no stop" as the price 0.0, which is falsy, so an
 * unset stop stays unticked without a special case here.
 */
export function useLivePositionAsEntry(p) {
    return {
        tradeId: String(p.ticket),
        dateUnix: p.openTime,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.priceOpen,
        tp: p.tp,
        sl: p.sl,
        lot: p.volume,
    }
}

/**
 * Stops the agent has seen today, {tradeId: {sl, tp}}.
 *
 * Read even when the feed is stale: these are a record of what the stops WERE,
 * not a live reading, so an old snapshot is still the right answer for a trade
 * that has since closed. Empty when the agent has never run, which is the one
 * case nothing can recover -- MT5 keeps post-entry stops only while the position
 * is open.
 */
async function recentStops() {
    try {
        const res = await fetch('/api/live', { headers: useAuthHeaders() })
        if (!res.ok) return {}
        const body = await res.json()
        return (body && body.snapshot && body.snapshot.stops) || {}
    } catch {
        return {}
    }
}

/**
 * Today's trades that were never reviewed.
 *
 * The fallback for a dead live feed. A trade seen only after it closed cannot be
 * reviewed while it is running, but the questions that matter afterwards -- why
 * you entered, how you felt, whether the size was right -- are the same ones, and
 * an unanswered entry is worth catching late in the same day rather than not at
 * all. See checklistCutoffUnix for why it stops at the day boundary.
 */
async function unreviewedRecentTrades() {
    const cutoff = checklistCutoffUnix()
    // Stops the agent recorded for today's trades, closed ones included. The
    // journal itself has never carried SL/TP -- the broker export has no such
    // column -- so without this a trade reviewed after it closed showed both
    // stops blank, as if none had been set.
    const stops = await recentStops()
    const query = new Parse.Query(Parse.Object.extend('trades'))
    query.equalTo('user', currentUserOrNull())
    // The day doc IS keyed to this cutoff (trade-tz midnight), so an exact match
    // would do -- >= is kept only so a trade filed under a later key is not lost.
    query.greaterThanOrEqualTo('dateUnix', cutoff)
    query.descending('dateUnix')
    query.limit(3)
    const days = await query.find()
    const out = []
    for (const day of days) {
        for (const t of (day.get('trades') || [])) {
            if (!t.positionId || !t.entryTime || t.entryTime < cutoff) continue
            const id = String(t.positionId)
            const stop = stops[id] || {}
            out.push({
                tradeId: id,
                dateUnix: t.entryTime,
                symbol: t.symbol,
                side: t.strategy,            // 'long' | 'short'
                entryPrice: t.entryPrice,
                // 0 is MT5's "no stop"; null keeps that reading as unset rather
                // than as a price of zero.
                tp: stop.tp || null,
                sl: stop.sl || null,
                lot: Math.max(t.buyQuantity || 0, t.sellQuantity || 0),
            })
        }
    }
    return out
}

/** Parse throws if it has not been initialised yet; a watcher must not care. */
function currentUserOrNull() {
    try {
        return Parse.User.current()
    } catch {
        return null
    }
}

export function startEntryChecklistWatch() {
    if (watchTimer) return

    /* The stream is what makes this prompt at the ENTRY rather than after it.
     *
     * The 20s poll below still runs, but as the floor: on its own it meant a fill
     * could sit unasked for most of a minute, and with the agent down it never
     * fired at all -- the watcher fell through to history, which only learns of a
     * trade once the sync writes it, i.e. after the position has already closed.
     * That is the wrong end of the trade to be asking about. Frames arrive about
     * once a second, so a new position is offered essentially as it opens.
     *
     * The ids have to be loaded before anything is offered, or every position in
     * the very first frame looks unanswered. */
    let idsReady = false
    useLoadChecklistedIds().then(() => { idsReady = true })
    stopLiveFrames = useLiveSnapshots((snap) => {
        if (!idsReady || !currentUserOrNull()) return
        openPositionsFrom(snap).forEach(offerEntryChecklist)
    })

    const tick = async () => {
        if (!currentUserOrNull()) return
        try {
            // Ids first: without them every open position looks unanswered and
            // would be re-queued on every page load.
            await useLoadChecklistedIds()

            // Live is preferred -- reviewing an entry while it is still open is the
            // whole point of doing this at entry rather than afterwards.
            const live = await liveOpenPositions()
            if (live && live.length) {
                live.forEach(offerEntryChecklist)
                return
            }

            // Nothing to review live, for one of two reasons, and BOTH need history:
            // the feed is down (null), or it is up and flat (empty). The second case
            // is not automatically "nothing happened" -- a trade opened and closed
            // inside one poll interval leaves the feed flat at both ends, and would
            // otherwise never be offered by anything. Re-offering a trade that WAS
            // caught live is harmless: the live ticket and the synced positionId are
            // the same value, so it dedups on tradeId.
            const recent = await unreviewedRecentTrades()
            recent.forEach(offerEntryChecklist)
        } catch { /* feed down or logged out -- next tick tries again */ }
    }
    tick()
    watchTimer = setInterval(tick, OPEN_POSITION_POLL_MS)
}

export function stopEntryChecklistWatch() {
    clearInterval(watchTimer)
    watchTimer = null
    if (stopLiveFrames) { stopLiveFrames(); stopLiveFrames = null }
}

export async function saveEntryChecklist(trade, answers) {
    const parseObject = Parse.Object.extend('entryChecklists')
    const object = new parseObject()
    object.set('user', Parse.User.current())
    object.set('tradeId', trade.tradeId)
    object.set('dateUnix', trade.dateUnix || 0)
    object.set('symbol', trade.symbol || '')
    object.set('side', trade.side || '')
    object.set('lot', trade.lot != null ? Number(trade.lot) : 0)
    object.set('hasTp', !!answers.hasTp)
    object.set('hasSl', !!answers.hasSl)
    object.set('tpPrice', answers.hasTp ? (Number(answers.tpPrice) || 0) : 0)
    object.set('slPrice', answers.hasSl ? (Number(answers.slPrice) || 0) : 0)
    object.set('tpPips', Number.isFinite(answers.tpPips) ? answers.tpPips : 0)
    object.set('slPips', Number.isFinite(answers.slPips) ? answers.slPips : 0)
    object.set('tpSlAcceptable', !!answers.tpSlAcceptable)
    object.set('positionQuality', answers.positionQuality || '')
    object.set('entryEmotion', answers.entryEmotion || '')
    object.set('entryReasoning', answers.entryReasoning || '')
    object.set('logicValid', !!answers.logicValid)
    object.set('oversized', !!answers.oversized)
    object.set('revengeScore', Number(answers.revengeScore) || 0)
    object.setACL(new Parse.ACL(Parse.User.current()))
    await object.save()

    if (checklistedIds) checklistedIds.add(trade.tradeId)
    queuedIds.delete(trade.tradeId)
    const idx = pending.findIndex((p) => p.tradeId === trade.tradeId)
    if (idx !== -1) pending.splice(idx, 1)
}
