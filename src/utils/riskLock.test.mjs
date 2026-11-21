// Run: node src/utils/riskLock.test.mjs
import { nextLockState, LOCK_MS, streakLockUntil, STREAK_LOCK_MS } from './riskLock.js'
let failures = 0
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failures++ }
const T = 1_000_000

let s = nextLockState(null, 100, T)
check('first frame sets the peak, no lock', s.peak === 100 && s.lockedUntil === 0)
s = nextLockState(s, 150, T + 1)
check('peak follows equity up', s.peak === 150)
s = nextLockState(s, 106, T + 2)
check('29.3% down: no lock', s.lockedUntil === 0)
s = nextLockState(s, 105, T + 3)
check('30% down: locked for one hour', s.lockedUntil === T + 3 + LOCK_MS)
const until = s.lockedUntil
s = nextLockState(s, 90, T + 4)
check('deeper loss does not extend the lock', s.lockedUntil === until)
s = nextLockState(s, 90, until + 1)
check('after the hour, same drawdown does not re-lock', s.lockedUntil === until && s.armed === false)
s = nextLockState(s, 120, until + 2)
check('recovery under 30% re-arms', s.armed === true)
s = nextLockState(s, 100, until + 3)
check('a new peak-relative 30% fall locks again', s.lockedUntil === until + 3 + LOCK_MS)
check('equity 0 (bad frame) changes nothing', nextLockState({ peak: 100 }, 0, T).peak === 100)
const L = (exitTime, net) => ({ exitTime, net })
check('streak: one loss is no lock', streakLockUntil([L(100, -5)]) === 0)
check('streak: two losses lock 90 min from the last close', streakLockUntil([L(200, -1), L(100, -5)]) === 200_000 + STREAK_LOCK_MS)
check('streak: a win in between breaks it', streakLockUntil([L(100, -5), L(200, 3), L(300, -1)]) === 0)
check('streak: only the last two count', streakLockUntil([L(50, 9), L(100, -5), L(200, -1)]) === 200_000 + STREAK_LOCK_MS)
check('streak: breakeven is not a loss', streakLockUntil([L(100, -5), L(200, 0)]) === 0)
console.log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0)
