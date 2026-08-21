/**
 * Mindset entries: the rules the trader wants to hold themselves to, in their own
 * words.
 *
 * Deliberately its own class rather than another sentinel in `notes`. Everything
 * in `notes` is keyed to a date and describes what happened on it -- a day, a
 * week, a trade. A mindset entry is the opposite: it is written once and is meant
 * to still apply months later, which is why it can be pinned. Filing it by date
 * alongside day notes would bury the standing ones under whatever was written most
 * recently, which is exactly the thing they exist to survive.
 *
 * `dateUnix` is kept anyway, as when it was written -- useful for reading the
 * order in which convictions arrived, and for the AI analysis to quote them.
 */
import Parse from 'parse/dist/parse.min.js'

const CLASS = 'mindsets'

function currentUserOrNull() {
    try {
        return Parse.User.current()
    } catch {
        return null
    }
}

const shape = (r) => ({
    objectId: r.id,
    dateUnix: r.get('dateUnix') || 0,
    title: r.get('title') || '',
    body: r.get('body') || '',
    pinned: !!r.get('pinned'),
    theme: r.get('theme') || '',
})

/** Every entry. Pinned first, then newest -- the order the page renders in. */
export async function useGetMindsets(limit = 500) {
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    query.equalTo('user', currentUserOrNull())
    query.descending('dateUnix')
    query.limit(limit)
    const results = await query.find()
    return results
        .map(shape)
        .sort((a, b) => (b.pinned - a.pinned) || (b.dateUnix - a.dateUnix))
}

export async function useSaveMindset({ objectId, title, body, theme, pinned, dateUnix }) {
    const parseObject = Parse.Object.extend(CLASS)
    let obj
    if (objectId) {
        const query = new Parse.Query(parseObject)
        obj = await query.get(objectId)
    } else {
        obj = new parseObject()
        obj.set('user', currentUserOrNull())
        obj.set('dateUnix', Number(dateUnix) || Math.floor(Date.now() / 1000))
        obj.setACL(new Parse.ACL(currentUserOrNull()))
    }
    obj.set('title', (title || '').trim())
    obj.set('body', (body || '').trim())
    obj.set('theme', (theme || '').trim())
    if (pinned !== undefined) obj.set('pinned', !!pinned)
    const saved = await obj.save()
    return shape(saved)
}

/** Pin/unpin on its own, so the list can toggle without a full edit round trip. */
export async function useSetMindsetPinned(objectId, pinned) {
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    const obj = await query.get(objectId)
    obj.set('pinned', !!pinned)
    await obj.save()
}

export async function useDeleteMindset(objectId) {
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    const obj = await query.get(objectId)
    await obj.destroy()
}
