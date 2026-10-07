/**
 * Account profiles: which ONE account the whole app is about right now.
 *
 * Every page -- trades, statistics, balance, equity, notes -- answers for the
 * active account and nothing else. There is deliberately no "all accounts" mode:
 * two accounts' numbers added together describe a trader who does not exist, and
 * the behaviour patterns built on sequence (revenge trading, size tilt) are
 * actively wrong across accounts, because a loss on one and an entry on the other
 * minutes later is not a reaction to anything.
 *
 * IDENTITY is the account label as the trades themselves carry it --
 * `<login>@<server>`, plus `Manual` for hand-entered orders (see addOrder.js).
 * Not the bare login, because the label is what every stored trade is stamped
 * with. The one case this gets wrong: if a broker migrates an account to another
 * server the label changes, and the account's history then reads as two profiles.
 * The fix if that ever happens is to match on the `<login>@` prefix; it has not,
 * and guessing at it now would complicate every query for nothing.
 *
 * Two lists describe accounts and they are joined by that label:
 *
 *   currentUser.accounts     labels the importer registers from trades
 *                            (addTrades.js) -- an account that has traded.
 *   currentUser.mt5Accounts  pushed by the sync (POST /api/account): balance,
 *                            currency, dated cashFlows -- keyed by `login`.
 *
 * The switcher offers the UNION: a freshly funded account appears as soon as the
 * sync has seen it, before it has ever traded, and selecting it shows its balance
 * with an empty journal -- which is the truth, not a bug.
 *
 * The selection lives on the _User record, like statsProfiles -- NOT in
 * localStorage. Clearing site data is this app's own documented fix for a stuck
 * Parse session, and it must not silently change which account you are looking at.
 */
import { computed } from 'vue'
import Parse from 'parse/dist/parse.min.js'
import { currentUser, selectedAccounts } from '../stores/globals.js'

/** The trade-filter label for one mt5Accounts entry. */
export function useMt5AccountLabel(acc) {
    if (!acc) return ''
    return `${acc.login}@${acc.server}`
}

function tradedLabels() {
    const accounts = (currentUser.value && Array.isArray(currentUser.value.accounts))
        ? currentUser.value.accounts
        : []
    return accounts.map((a) => a && a.value).filter(Boolean)
}

function syncedAccounts() {
    return (currentUser.value && Array.isArray(currentUser.value.mt5Accounts))
        ? currentUser.value.mt5Accounts
        : []
}

/** Every account that can be selected, traded or merely funded. */
export const accountProfiles = computed(() => {
    const labels = [...tradedLabels()]
    for (const acc of syncedAccounts()) {
        const label = useMt5AccountLabel(acc)
        if (label && !labels.includes(label)) labels.push(label)
    }
    return labels
})

/**
 * The active account's label.
 *
 * Falls back when the stored value names an account that no longer exists (a
 * renamed label, a restored database) rather than leaving every page empty with
 * no way to tell why. The fallback prefers the most recently synced account,
 * which with one terminal switched between logins is the one actually being
 * traded -- but only as a DEFAULT: an explicit choice is never overridden, or the
 * profile would move under the trader every time they switched the terminal.
 */
export const activeAccount = computed(() => {
    const labels = accountProfiles.value
    if (!labels.length) return ''
    const stored = currentUser.value && currentUser.value.activeAccount
    if (stored && labels.includes(stored)) return stored

    /* Prefer an account that has actually TRADED.
     *
     * Ranking purely by "most recently synced" opened the app on a freshly funded
     * account with an empty journal while the account holding every trade sat one
     * click away -- the sync pushes a balance long before the first trade, so the
     * newest snapshot is routinely the emptiest account. */
    const traded = tradedLabels()
    const prefer = traded.length ? traded : labels
    let newest = null
    for (const acc of syncedAccounts()) {
        const label = useMt5AccountLabel(acc)
        if (!prefer.includes(label)) continue
        if (!newest || Number(acc.updatedAt || 0) > Number(newest.updatedAt || 0)) newest = acc
    }
    return newest ? useMt5AccountLabel(newest) : prefer[0]
})

/**
 * Persist the selection, the same way statsProfile.js does: set it on the CURRENT
 * user object and save that instance, so Parse's own cache of
 * Parse.User.current() carries the change through the full page reload every
 * caller performs next.
 */
export async function setActiveAccount(label) {
    if (!accountProfiles.value.includes(label)) return
    const user = Parse.User.current()
    if (!user) return
    user.set('activeAccount', label)
    await user.save()
    currentUser.value = JSON.parse(JSON.stringify(user))
}

/**
 * Point the trade filter at the active account.
 *
 * `selectedAccounts` is still the single place trades are filtered
 * (trades.js:158) -- this collapses the old multi-select to exactly one value
 * instead of replacing the mechanism. That matters: the filter used to live in
 * localStorage, so removing its UI while a browser still held an old value would
 * have filtered every page to zero with nothing left to fix it. Driving it from
 * the user record instead means the browser's copy can never disagree.
 *
 * Called from useGetSelectedRange (every page mount, before anything is
 * filtered), next to the stats-profile clamp, for the same reason.
 */
export function useApplyActiveAccount() {
    const label = activeAccount.value
    selectedAccounts.value = label ? [label] : []
}

/** The active account's synced snapshot, or null (e.g. while `Manual` is active). */
export function useActiveMt5Account() {
    const label = activeAccount.value
    return syncedAccounts().find((a) => useMt5AccountLabel(a) === label) || null
}

/** Kept as a list for the callers that iterate; it holds 0 or 1 account now. */
export function useScopedMt5Accounts() {
    const acc = useActiveMt5Account()
    return acc ? [acc] : []
}

/** Balance of the active account, or null when it has no synced snapshot. */
export function useScopedMt5Balance() {
    const acc = useActiveMt5Account()
    const balance = acc ? Number(acc.balance) : NaN
    return Number.isFinite(balance) ? balance : null
}

/** Dated deposits/withdrawals of the active account. */
export function useScopedMt5CashFlows() {
    const acc = useActiveMt5Account()
    return (acc && Array.isArray(acc.cashFlows)) ? acc.cashFlows : []
}
