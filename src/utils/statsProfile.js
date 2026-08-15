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
 * Stored in localStorage next to the other view preferences (see planStore.js for
 * the same pattern). It is a lens on the data, not data itself -- nothing here
 * changes a single trade, so it never needs to reach the database.
 */
import { reactive, computed } from 'vue'
import dayjs from 'dayjs'

const KEY = 'tradenote_stats_profiles_v1'

// `startUnix: null` means no floor at all -- the whole history.
const ALL_TIME = { id: 'all', name: 'All time', startUnix: null }

function load() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY))
        if (raw && Array.isArray(raw.profiles) && raw.profiles.length) {
            // "All time" is guaranteed to exist so there is always a way back to
            // the unfiltered view, even if the stored list was hand-edited.
            const profiles = raw.profiles.some((p) => p.id === 'all')
                ? raw.profiles
                : [ALL_TIME, ...raw.profiles]
            return { profiles, activeId: raw.activeId || 'all' }
        }
    } catch { /* corrupt or absent -- fall through to the default */ }
    return { profiles: [ALL_TIME], activeId: 'all' }
}

const state = reactive(load())

function persist() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ profiles: state.profiles, activeId: state.activeId }))
    } catch { /* storage unavailable (private mode / quota) -- still works in-session */ }
}

export const statsProfiles = computed(() => state.profiles)

export const activeStatsProfile = computed(() =>
    state.profiles.find((p) => p.id === state.activeId) || state.profiles[0])

/** Unix seconds the active profile starts at, or null for all-time. */
export const profileStartUnix = computed(() => {
    const p = activeStatsProfile.value
    return p && p.startUnix ? Number(p.startUnix) : null
})

export function setActiveStatsProfile(id) {
    if (!state.profiles.some((p) => p.id === id)) return
    state.activeId = id
    persist()
}

export function addStatsProfile(name, startUnix) {
    const p = {
        id: 'p' + Date.now().toString(36),
        name: (name || '').trim() || 'Untitled',
        startUnix: startUnix ? Number(startUnix) : null,
    }
    state.profiles.push(p)
    state.activeId = p.id
    persist()
    return p
}

export function removeStatsProfile(id) {
    if (id === 'all') return          // the way back to the full history
    const i = state.profiles.findIndex((p) => p.id === id)
    if (i === -1) return
    state.profiles.splice(i, 1)
    if (state.activeId === id) state.activeId = 'all'
    persist()
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
    const end = isAllSentinel ? dayjs().add(1, 'day').unix() : Number(range.end)

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
