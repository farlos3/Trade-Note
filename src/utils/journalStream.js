/**
 * Journal change notifications: "the trade data in the database just moved".
 *
 * Replaces per-page 60s polling. The pages that had a timer re-fetched everything
 * once a minute whether or not anything had changed (and most pages had no timer
 * at all, so a synced trade stayed invisible until a manual reload). Now the
 * backend pushes a `journal` event the moment a sync writes, and only the pages
 * currently open react.
 *
 * ONE EventSource is shared by every subscriber on the page. Each view opening its
 * own would mean several connections per tab, and browsers cap concurrent
 * connections per origin (6 on HTTP/1.1) -- enough open views would starve the
 * app's own API calls.
 *
 * Falls back to polling /api/journal/version when EventSource is unavailable or
 * the stream cannot stay up, so a page is never left silently stale.
 */
import { useAuthHeaders, useAuthedUrl } from './apiAuth.js'
const POLL_MS = 15000

let source = null
let pollTimer = null
let lastVersion = null
const subscribers = new Set()
/* Live MT5 frames travel down the SAME stream as the journal events, as the
   default (unnamed) message. Handing them out from here rather than opening a
   second EventSource keeps the one-connection rule above -- and callers that need
   to react the instant a position appears no longer have to poll for it. */
const liveSubscribers = new Set()

function notify(version) {
    // The first version we ever see is a baseline, not a change -- firing on it
    // would make every page double-load its data immediately after mounting.
    if (lastVersion === null) {
        lastVersion = version
        return
    }
    if (version === lastVersion) return
    lastVersion = version
    for (const fn of subscribers) {
        try { fn(version) } catch (e) { console.error('journal subscriber failed', e) }
    }
}

async function pollOnce() {
    try {
        const res = await fetch('/api/journal/version', { cache: 'no-store', headers: useAuthHeaders() })
        const j = await res.json()
        if (j && typeof j.version === 'number') notify(j.version)
    } catch { /* offline; the next tick retries */ }
}

function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(pollOnce, POLL_MS)
    pollOnce()
}

function stopPolling() {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
}

function connect() {
    if (source || typeof window === 'undefined') return
    if (typeof window.EventSource === 'undefined') {
        startPolling()
        return
    }
    source = new EventSource(useAuthedUrl('/api/live/stream'))
    source.onmessage = (e) => {
        if (!liveSubscribers.size) return
        let snap
        try { snap = JSON.parse(e.data) } catch { return }   // partial frame
        for (const fn of liveSubscribers) {
            try { fn(snap) } catch (err) { console.error('live subscriber failed', err) }
        }
    }
    source.addEventListener('journal', (e) => {
        stopPolling()   // the stream is alive; no need to also poll
        try {
            const d = JSON.parse(e.data)
            if (d && typeof d.version === 'number') notify(d.version)
        } catch { /* ignore a partial frame */ }
    })
    // EventSource retries on its own, but that can take a while; poll meanwhile so
    // a dropped stream degrades to "slightly delayed" rather than "frozen".
    source.onerror = () => { startPolling() }
}

function teardown() {
    if (source) { source.close(); source = null }
    stopPolling()
    lastVersion = null
}

/**
 * Run `fn` whenever the journal changes. Returns an unsubscribe function — call it
 * in onUnmounted, or the callback keeps firing (and re-fetching) for a page that
 * is no longer on screen.
 */
export function useJournalUpdates(fn) {
    subscribers.add(fn)
    connect()
    return () => {
        subscribers.delete(fn)
        if (subscribers.size === 0 && liveSubscribers.size === 0) teardown()
    }
}

/**
 * Run `fn` with every live MT5 snapshot the agent posts (about once a second).
 * Same shared connection and same unsubscribe contract as useJournalUpdates.
 *
 * Nothing arrives while the agent is down -- silence means "no feed", not "no
 * positions", so a caller that must act on absence needs its own fallback.
 */
export function useLiveSnapshots(fn) {
    liveSubscribers.add(fn)
    connect()
    return () => {
        liveSubscribers.delete(fn)
        if (subscribers.size === 0 && liveSubscribers.size === 0) teardown()
    }
}
