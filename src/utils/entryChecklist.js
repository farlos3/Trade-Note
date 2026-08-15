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

/** Queue a trade for review. No-ops if it is already answered or already queued. */
export function offerEntryChecklist(trade) {
    if (!trade || !trade.tradeId) return
    if (queuedIds.has(trade.tradeId)) return
    if (checklistedIds && checklistedIds.has(trade.tradeId)) return
    queuedIds.add(trade.tradeId)
    pending.push(trade)
}

export const currentEntryChecklist = computed(() => pending[0] || null)

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
