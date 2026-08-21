/**
 * Mindset entries: the rules the trader wants to hold themselves to, in their own
 * words.
 *
 * Deliberately its own class rather than another sentinel in `notes`. Everything
 * in `notes` is keyed to a date and describes what happened on it -- a day, a
 * week, a trade. A mindset entry is the opposite: it is written once and is meant
 * to still apply months later. Filing it by date
 * alongside day notes would bury the standing ones under whatever was written most
 * recently, which is exactly the thing they exist to survive.
 *
 * `dateUnix` is when it was written, and it is also the order of the path: stage 1
 * is the first principle you set yourself. `status` tracks where each one stands --
 * 'todo', 'active' (the one being worked on now) or 'mastered'. It replaced a
 * boolean `pinned`, which could not express the middle state the whole path is
 * built around.
 */
import Parse from 'parse/dist/parse.min.js'

const CLASS = 'mindsets'
export const MINDSET_STATUSES = ['todo', 'active', 'mastered']

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
    // Anything unrecognised (or missing, on a row written before status existed)
    // reads as a stage not yet started, which is the safe default -- it never
    // claims progress that was not made.
    status: MINDSET_STATUSES.includes(r.get('status')) ? r.get('status') : 'todo',
    theme: r.get('theme') || '',
})

/** Every entry, OLDEST first -- the order of the path, stage 1 at the top. */
export async function useGetMindsets(limit = 500) {
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    query.equalTo('user', currentUserOrNull())
    query.ascending('dateUnix')
    query.limit(limit)
    const results = await query.find()
    return results.map(shape)
}

export async function useSaveMindset({ objectId, title, body, theme, status, dateUnix }) {
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
        obj.set('status', 'todo')
    }
    obj.set('title', (title || '').trim())
    obj.set('body', (body || '').trim())
    obj.set('theme', (theme || '').trim())
    if (status && MINDSET_STATUSES.includes(status)) obj.set('status', status)
    const saved = await obj.save()
    return shape(saved)
}

/** Move a stage along the path on its own, without a full edit round trip. */
export async function useSetMindsetStatus(objectId, status) {
    if (!MINDSET_STATUSES.includes(status)) return
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    const obj = await query.get(objectId)
    obj.set('status', status)
    await obj.save()
}

export async function useDeleteMindset(objectId) {
    const query = new Parse.Query(Parse.Object.extend(CLASS))
    const obj = await query.get(objectId)
    await obj.destroy()
}
