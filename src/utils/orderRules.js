/**
 * Rules an order sent from TradeNote must pass before it is queued for MT5
 * (POST /api/orders in index.mjs). Pure, so `node src/utils/orderRules.test.mjs`
 * can pin them without a server. Each returns an error message, or null when valid.
 */

const optionalNum = (v) => (v === '' || v == null ? null : Number(v))

// Where a pending entry must sit relative to the market, per side and type.
const PENDING_SIDE = { 'buy:limit': 'below', 'buy:stop': 'above', 'sell:limit': 'above', 'sell:stop': 'below' }

function pendingPriceError(side, type, px, tick) {
    if (!(px > 0)) return 'Enter the entry price for a pending order.'
    const mkt = side === 'buy' ? Number(tick.ask) : Number(tick.bid)
    const where = PENDING_SIDE[`${side}:${type}`]
    if (where === 'below' ? !(px < mkt) : !(px > mkt)) return `A ${side} ${type} must be ${where} the current price (${mkt}).`
    return null
}

function stopsError(side, px, sl, tp) {
    if (!(sl > 0)) return 'A stop loss is required.'
    if (tp != null && !(tp > 0)) return 'Invalid take profit.'
    if (side === 'buy' && !(sl < px && (tp == null || tp > px))) return `For a buy, SL must be below and TP above the price (${px}).`
    if (side === 'sell' && !(sl > px && (tp == null || tp < px))) return `For a sell, SL must be above and TP below the price (${px}).`
    return null
}

// A new entry: market, or a pending limit/stop. Setup + reason are mandatory.
export function orderError(b, { allowedAccounts, setupNames, lotCap, tick }) {
    if (!allowedAccounts.includes(b.account)) return 'This account is not allowed to sync/trade (Settings).'
    if (!/^[A-Za-z0-9._#-]{1,20}$/.test(String(b.symbol || ''))) return 'Invalid symbol.'
    if (b.side !== 'buy' && b.side !== 'sell') return 'Side must be buy or sell.'
    const type = b.type || 'market'
    if (!['market', 'limit', 'stop'].includes(type)) return 'Order type must be market, limit or stop.'
    const lot = Number(b.lot), sl = Number(b.sl), tp = optionalNum(b.tp)
    if (!(lot > 0) || lot > lotCap) return `Lot must be above 0 and at most ${lotCap}.`
    if (!(sl > 0)) return 'A stop loss is required.'
    if (tp != null && !(tp > 0)) return 'Invalid take profit.'
    if (!setupNames.includes(String(b.setup || ''))) return 'Choose one of your setups.'
    if (String(b.reason || '').trim().length < 10) return 'Write the reason for this entry (at least 10 characters).'
    if (!tick) return 'No live price for this symbol; is it in MT5 Market Watch?'
    let px = b.side === 'buy' ? Number(tick.ask) : Number(tick.bid)
    if (type !== 'market') {
        px = Number(b.price)
        const err = pendingPriceError(b.side, type, px, tick)
        if (err) return err
    }
    return stopsError(b.side, px, sl, tp)
}

/* A change to something already in the terminal. `target` is that position or
   pending order as the live snapshot reports it (pending ones carry `kind`), so a
   ticket that is not open on this account right now never gets this far. */
export function changeError(b, { target, tick }) {
    if (!target) return 'That position or order is no longer open.'
    const pendingType = target.kind ? (/stop limit/i.test(target.kind) ? 'stoplimit' : /limit/i.test(target.kind) ? 'limit' : 'stop') : null
    if (b.action === 'cancel') return pendingType ? null : 'Only pending orders can be cancelled here.'
    if (b.action !== 'modify') return 'Unknown action.'
    if (pendingType === 'stoplimit') return 'Stop-limit orders can only be cancelled here.'
    if (!tick) return 'No live price for this symbol; is it in MT5 Market Watch?'
    const sl = Number(b.sl), tp = optionalNum(b.tp)
    if (pendingType) {
        const px = Number(b.price)
        return pendingPriceError(target.side, pendingType, px, tick) || stopsError(target.side, px, sl, tp)
    }
    // An open position: stops are judged against the price it would close at.
    return stopsError(target.side, target.side === 'buy' ? Number(tick.bid) : Number(tick.ask), sl, tp)
}
