/**
 * Attach the logged-in user's Parse session to calls on this app's own /api
 * routes, which require it (see requireAuth in index.mjs).
 *
 * Those routes serve live positions, balances and the whole daily P&L breakdown.
 * They used to be open, which is fine behind a LAN and not fine on a public URL.
 * The browser already holds a session from logging in; this just sends it.
 *
 * Only needed for the custom /api endpoints -- everything going through the Parse
 * SDK authenticates itself.
 */
import Parse from 'parse/dist/parse.min.js'

export function useSessionToken() {
    try {
        const user = Parse.User.current()
        return user ? user.getSessionToken() : null
    } catch {
        // Parse not initialised yet (a call made very early) -- treat as logged out
        // rather than throwing inside a request helper.
        return null
    }
}

/** Header form, for fetch() and axios. */
export function useAuthHeaders() {
    const token = useSessionToken()
    return token ? { 'X-Parse-Session-Token': token } : {}
}

/**
 * Query-string form. EventSource cannot set request headers at all, so the SSE
 * endpoints accept the token as a parameter instead -- the same bearer secret,
 * and hosting terminates TLS so it is not exposed on the wire.
 */
export function useAuthedUrl(url) {
    const token = useSessionToken()
    if (!token) return url
    return url + (url.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(token)
}
