/**
 * Post-entry reviews, read back.
 *
 * There used to be a gate here too: a queue fed by the live feed and by today's
 * synced trades, and a modal that popped up on any page the moment a new order
 * appeared, asking about the entry while it was still open. That has been removed
 * -- the interruption is no longer wanted -- so nothing in the app now writes to
 * the `entryChecklists` class.
 *
 * The rows already written stay, and stay readable: Diary's Entry reviews tab, the
 * badges on History's day cards, and the analysis endpoint all read them through
 * loadEntryChecklists below. Deleting the reader along with the prompt would have
 * thrown away answers the trader wrote about their own trades.
 */
import Parse from 'parse/dist/parse.min.js'

/** Parse throws if it has not been initialised yet; a loader must not care. */
function currentUserOrNull() {
    try {
        return Parse.User.current()
    } catch {
        return null
    }
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
