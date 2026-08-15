/**
 * Stats profiles: a named point in time that every statistic is measured from.
 *
 * The use case is a fresh start. After blowing an account and refunding it, the
 * old trades are still history worth keeping, but they poison every number you
 * actually want to watch -- win rate, expectancy, the equity curve. Deleting them
 * is the wrong fix. A profile instead says "measure from here", so the same
 * database can answer both "how am I doing since the reset" and "how have I done
 * overall" by switching one dropdown.
 *
 * A profile is a FLOOR on the date range, never a replacement for it: the page's
 * own period picker still narrows further inside the profile. Picking "last 7
 * days" under a profile that starts today shows the part of those 7 days that the
 * profile covers, not 7 days of pre-reset history.
 *
 * Stored on the _User record (statsProfiles / activeStatsProfileId), the same
 * place tags/apis/mt5Accounts already live -- NOT in localStorage. It used to be
 * localStorage, which meant "clear site data" (the standard fix for a stuck Parse
 * session, used earlier in this app's own history) silently deleted every profile
 * along with it. A database field survives that, survives a different browser,
 * and survives moving the app to another machine.
 */
import { computed } from 'vue'
import Parse from 'parse/dist/parse.min.js'
import { currentUser } from '../stores/globals.js'

// Always present, never persisted itself (see persist() below) -- the way back
// to the full history that can't be deleted or corrupted out of existence.
const ALL_TIME = { id: 'all', name: 'All time', startUnix: null }

export const statsProfiles = computed(() => {
    const stored = (currentUser.value && Array.isArray(currentUser.value.statsProfiles))
        ? currentUser.value.statsProfiles
        : []
    return [ALL_TIME, ...stored.filter((p) => p && p.id !== 'all')]
})

export const activeStatsProfile = computed(() => {
    const activeId = (currentUser.value && currentUser.value.activeStatsProfileId) || 'all'
    return statsProfiles.value.find((p) => p.id === activeId) || statsProfiles.value[0]
})

/** Unix seconds the active profile starts at, or null for all-time. */
export const profileStartUnix = computed(() => {
    const p = activeStatsProfile.value
    return p && p.startUnix ? Number(p.startUnix) : null
})

/**
 * Write profiles + the active selection to the CURRENT user object (not a
 * separately-queried copy) and save it. Parse's JS SDK persists its own local
 * cache of Parse.User.current() after a successful save on that same instance,
 * so a page that full-reloads right after this (every call site here does)
 * picks the change up without a fresh network fetch.
 */
async function persist(profiles, activeId) {
    const user = Parse.User.current()
    if (!user) return   // Nav.vue only renders on authenticated pages; defensive only
    user.set('statsProfiles', profiles.filter((p) => p.id !== 'all'))
    user.set('activeStatsProfileId', activeId)
    await user.save()
    currentUser.value = JSON.parse(JSON.stringify(user))
}

export async function setActiveStatsProfile(id) {
    if (!statsProfiles.value.some((p) => p.id === id)) return
    await persist(statsProfiles.value, id)
}

export async function addStatsProfile(name, startUnix) {
    const p = {
        id: 'p' + Date.now().toString(36),
        name: (name || '').trim() || 'Untitled',
        startUnix: startUnix ? Number(startUnix) : null,
    }
    await persist([...statsProfiles.value, p], p.id)
    return p
}

export async function removeStatsProfile(id) {
    if (id === 'all') return          // the way back to the full history
    if (!statsProfiles.value.some((p) => p.id === id)) return
    const next = statsProfiles.value.filter((p) => p.id !== id)
    const activeId = activeStatsProfile.value.id === id ? 'all' : activeStatsProfile.value.id
    await persist(next, activeId)
}

/**
 * Raise a range's start to the profile's, leaving the end alone.
 *
 * Max, not replace: the page's own filter must still be able to narrow inside the
 * profile. Returning the range untouched when there is no floor keeps every call
 * site free of null checks.
 */
export function clampRangeToProfile(range) {
    const floor = profileStartUnix.value
    if (!floor || !range) return range

    // {start:0, end:0} is this app's sentinel for "All time, no date bound at
    // all" (see useGetTrades / useGetPeriods) -- NOT the literal instant 1970.
    // Raising start to the floor while leaving end at 0 turns it into
    // "dateUnix >= floor AND dateUnix < 0", which no document can ever satisfy,
    // so a profile silently zeroed every page still on the "All" period. It needs
    // an explicit end, not the sentinel's implicit "none".
    const isAllSentinel = Number(range.start) === 0 && Number(range.end) === 0
    const end = isAllSentinel ? Math.floor(Date.now() / 1000) + 86400 : Number(range.end)

    let start = Math.max(Number(range.start) || 0, floor)
    // Never let the floor push start PAST end. A window that ends before the
    // profile begins legitimately contains nothing, but expressing that as
    // start > end is an inverted range, and the queries downstream are written
    // for start <= end -- so collapse it to an empty-but-valid window instead.
    if (Number.isFinite(end) && start > end) start = end
    return { ...range, start, end }
}

/** Same clamp for the analysis endpoints, which take ISO dates rather than unix. */
export function clampFromDate(fromIso, tzFormat) {
    const floor = profileStartUnix.value
    if (!floor) return fromIso
    const floorIso = tzFormat(floor)
    if (!fromIso) return floorIso
    return fromIso > floorIso ? fromIso : floorIso
}
