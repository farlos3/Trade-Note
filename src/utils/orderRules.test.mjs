// Run: node src/utils/orderRules.test.mjs
import { orderError } from './orderRules.js'

let failures = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++ }

const ctx = { allowedAccounts: ['1@S'], setupNames: ['Trend Follow'], lotCap: 0.1, tick: { bid: 4000, ask: 4000.3 } }
const ok = { account: '1@S', symbol: 'XAUUSD', side: 'buy', lot: '0.01', sl: '3990', tp: '4020', setup: 'Trend Follow', reason: 'Break of structure + retest' }

check('valid buy passes', orderError(ok, ctx) === null)
check('valid sell passes', orderError({ ...ok, side: 'sell', sl: '4010', tp: '3980' }, ctx) === null)
check('TP is optional', orderError({ ...ok, tp: '' }, ctx) === null)
check('account not allowed', /not allowed/.test(orderError({ ...ok, account: '2@S' }, ctx)))
check('no stop loss', /stop loss/.test(orderError({ ...ok, sl: '' }, ctx)))
check('lot over cap', /at most 0.1/.test(orderError({ ...ok, lot: '0.5' }, ctx)))
check('lot zero', /Lot/.test(orderError({ ...ok, lot: '0' }, ctx)))
check('unknown setup', /setups/.test(orderError({ ...ok, setup: 'Own Predict' }, ctx)))
check('reason too short', /reason/.test(orderError({ ...ok, reason: 'feels up' }, ctx)))
check('reason of spaces', /reason/.test(orderError({ ...ok, reason: '            ' }, ctx)))
check('buy with SL above price', /below/.test(orderError({ ...ok, sl: '4005' }, ctx)))
check('buy with TP below price', /below/.test(orderError({ ...ok, tp: '3999' }, ctx)))
check('sell with SL below price', /above/.test(orderError({ ...ok, side: 'sell', sl: '3990', tp: '3980' }, ctx)))
check('no live price', /price/.test(orderError(ok, { ...ctx, tick: null })))
check('bad side', /Side/.test(orderError({ ...ok, side: 'long' }, ctx)))
check('symbol injection', /symbol/.test(orderError({ ...ok, symbol: 'XAU USD;' }, ctx)))

console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
process.exit(failures ? 1 : 0)
