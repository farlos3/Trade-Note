// Run: node src/utils/orderRules.test.mjs
import { orderError, changeError } from './orderRules.js'

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

// Pending entries: price on the right side of the market, stops judged from the entry.
const lim = { ...ok, type: 'limit', price: '3990', sl: '3980', tp: '4010' }
check('buy limit below market passes', orderError(lim, ctx) === null)
check('buy limit above market', /below the current price/.test(orderError({ ...lim, price: '4001' }, ctx)))
check('buy stop above market passes', orderError({ ...ok, type: 'stop', price: '4010', sl: '4000', tp: '4030' }, ctx) === null)
check('sell stop below market passes', orderError({ ...ok, side: 'sell', type: 'stop', price: '3990', sl: '4000', tp: '3970' }, ctx) === null)
check('sell limit below market', /above the current price/.test(orderError({ ...ok, side: 'sell', type: 'limit', price: '3990', sl: '4000' }, ctx)))
check('pending without price', /entry price/.test(orderError({ ...lim, price: '' }, ctx)))
check('pending SL judged from entry', /below/.test(orderError({ ...lim, sl: '3995' }, ctx)))
check('pending still needs a reason', /reason/.test(orderError({ ...lim, reason: '' }, ctx)))
check('unknown type', /type/.test(orderError({ ...ok, type: 'stoplimit' }, ctx)))

// Changes to what is already open.
const pos = { ticket: 7, side: 'buy', symbol: 'XAUUSD' }
const pend = { ticket: 8, side: 'buy', symbol: 'XAUUSD', kind: 'Buy limit' }
const t = { tick: ctx.tick }
check('modify position SL/TP passes', changeError({ action: 'modify', sl: '3990', tp: '4050' }, { ...t, target: pos }) === null)
check('modify position cannot drop SL', /stop loss/.test(changeError({ action: 'modify', sl: '', tp: '4050' }, { ...t, target: pos })))
check('modify position SL above bid', /below/.test(changeError({ action: 'modify', sl: '4001' }, { ...t, target: pos })))
check('modify pending passes', changeError({ action: 'modify', price: '3995', sl: '3985', tp: '' }, { ...t, target: pend }) === null)
check('modify pending to wrong side', /below the current price/.test(changeError({ action: 'modify', price: '4005', sl: '3985' }, { ...t, target: pend })))
check('cancel pending passes', changeError({ action: 'cancel' }, { ...t, target: pend }) === null)
check('cannot cancel a position', /Only pending/.test(changeError({ action: 'cancel' }, { ...t, target: pos })))
check('ticket not open', /no longer open/.test(changeError({ action: 'cancel' }, { ...t, target: null })))
check('stop limit only cancels', /only be cancelled/.test(changeError({ action: 'modify', price: '1', sl: '1' }, { ...t, target: { ...pend, kind: 'Buy stop limit' } })))

console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
process.exit(failures ? 1 : 0)
