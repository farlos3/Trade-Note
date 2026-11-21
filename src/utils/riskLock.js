/**
 * Drawdown lock: when equity falls LOCK_PCT% below its peak, trading is blocked
 * for LOCK_MS. Pure, so `node src/utils/riskLock.test.mjs` pins it without a server.
 *
 * One lock per drawdown: after the hour is up the trader may trade again even if
 * equity is still down; the lock re-arms once drawdown is back under LOCK_PCT
 * (otherwise a deep drawdown would mean a permanent lock, not "1 hour").
 */
export const LOCK_PCT = 30
export const LOCK_MS = 60 * 60 * 1000

/**
 * Loss-streak cooldown: the last STREAK_LOSSES closed trades all lost -> no new
 * entries until STREAK_LOCK_MS after the last one closed. Stateless: it is a pure
 * function of the trade history, so it cannot be dodged by a restart, and it ends
 * by itself (a further loss after the break makes a fresh streak of the last two).
 * trades: [{ exitTime (unix s), net }] closed trades only, any order. Returns ms
 * epoch the lock ends, 0 when there is none (or it already ended: caller compares).
 */
export const STREAK_LOSSES = 2
export const STREAK_LOCK_MS = 90 * 60 * 1000

export function streakLockUntil(trades) {
    const last = [...(trades || [])].sort((a, b) => a.exitTime - b.exitTime).slice(-STREAK_LOSSES)
    if (last.length < STREAK_LOSSES || !last.every((t) => t.net < 0)) return 0
    return last[last.length - 1].exitTime * 1000 + STREAK_LOCK_MS
}

// state: { peak, armed, lockedUntil } (all optional) -> next state + ddPct
export function nextLockState(state, equity, now) {
    const s = state || {}
    const eq = Number(equity)
    if (!(eq > 0)) return { peak: s.peak || 0, armed: s.armed !== false, lockedUntil: s.lockedUntil || 0, ddPct: 0 }
    const peak = Math.max(s.peak || 0, eq)
    const ddPct = ((peak - eq) / peak) * 100
    let armed = s.armed !== false
    let lockedUntil = s.lockedUntil || 0
    if (ddPct < LOCK_PCT) armed = true
    else if (armed && now >= lockedUntil) { lockedUntil = now + LOCK_MS; armed = false }
    return { peak, armed, lockedUntil, ddPct }
}
