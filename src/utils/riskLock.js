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
