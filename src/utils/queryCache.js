/**
 * Persistent cache for the one big read every tab shares: the user's `trades` day
 * documents.
 *
 * Every nav link is a plain <a href> full reload (see SideMenu.vue), so each tab
 * re-runs the same trades query from scratch -- the JS chunks are already warmed by
 * Nav.vue's prefetch, the DATA is what was still paid for on every navigation. The
 * range, the excluded fields and the (absent) account predicate are the same on every
 * tab, so one cached result serves all of them.
 *
 * Staleness is decided by a fingerprint of the class, not a TTL or a hand-placed
 * invalidate call: document count + newest updatedAt, two tiny queries that run in
 * parallel. Any writer moves it -- the MT5 sync, a CSV import, an Add Order save, a
 * delete from Imports, a restore from R2 -- including ones that never go through
 * this browser or the journal SSE, so there is no write path to forget. A day
 * rewritten with an older updatedAt and the same count would slip past it, but a
 * restore of the same snapshot also restores the same data.
 *
 * Best effort throughout: IndexedDB missing/blocked (private window), a failed
 * fingerprint, a corrupt entry -- each falls straight through to the plain query, so
 * the cache can make a page faster but never make it wrong or broken.
 */
import Parse from 'parse/dist/parse.min.js'

const DB_NAME = 'tradenote-cache'
const STORE = 'kv'

// L1 cache for the fingerprint: avoids paying two MongoDB round-trips (count +
// newest updatedAt) TWICE on every page load -- once for the Nav warm-up and
// once for the page's own useGetTrades call, which arrive within milliseconds of
// each other. 10 s is long enough to deduplicate that burst and short enough to
// never serve a stale fingerprint to a new trade that just arrived.
const FP_TTL_MS = 10_000
const FP_SESSION_KEY = 'tradenote-fp-cache'

let dbPromise = null
function db() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1)
            req.onupgradeneeded = () => req.result.createObjectStore(STORE)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
        dbPromise.catch(() => { dbPromise = null })   // let a later call retry
    }
    return dbPromise
}

async function idbGet(key) {
    const conn = await db()
    return new Promise((resolve, reject) => {
        const req = conn.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

async function idbSet(key, value) {
    const conn = await db()
    return new Promise((resolve, reject) => {
        const tx = conn.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

async function fingerprint() {
    // Check L1 (sessionStorage) before hitting MongoDB. The warm-up in Nav and
    // the page's own load race each other; without this they'd each pay two
    // Parse queries milliseconds apart for the identical result.
    try {
        const raw = sessionStorage.getItem(FP_SESSION_KEY)
        if (raw) {
            const { fp, ts } = JSON.parse(raw)
            if (Date.now() - ts < FP_TTL_MS) return fp
        }
    } catch { /* sessionStorage blocked (private mode) — fall through */ }

    const mine = () => new Parse.Query('trades').equalTo('user', Parse.User.current())
    const [count, newest] = await Promise.all([
        mine().count(),
        mine().descending('updatedAt').select('updatedAt').first(),
    ])
    const fp = `${count}:${newest ? newest.updatedAt.getTime() : 0}`

    try { sessionStorage.setItem(FP_SESSION_KEY, JSON.stringify({ fp, ts: Date.now() })) } catch { /* ignore */ }
    return fp
}

/**
 * query.find(), answered from IndexedDB when the class has not changed since the
 * result was stored. Returns plain JSON rows -- exactly what
 * JSON.parse(JSON.stringify(results)) gave the callers before -- so a hit and a miss
 * are interchangeable.
 *
 * `keyParts` must name everything that shapes the query besides the user (range,
 * limit): two different queries sharing a key would hand one the other's rows.
 */
export async function useCachedFind(query, keyParts) {
    let key = null
    let fp = null
    try {
        key = [Parse.User.current().id, ...keyParts].join('|')
        fp = await fingerprint()
        const hit = await idbGet(key)
        if (hit && hit.fp === fp && typeof hit.json === 'string') return JSON.parse(hit.json)
    } catch (e) {
        key = null   // not cacheable this time; still answer from the database
    }

    const json = JSON.stringify(await query.find())
    // Stored as a string, not the parsed rows: the caller goes on to mutate what it
    // is handed, and an object would only be cloned when the write actually runs.
    if (key && fp) idbSet(key, { fp, json }).catch(() => { /* best effort */ })
    return JSON.parse(json)
}
