/**
 * Rules an order placed from TradeNote must pass before it is queued for MT5
 * (POST /api/orders in index.mjs). Pure, so `node src/utils/orderRules.test.mjs`
 * can pin them without a server. Returns an error message, or null when valid.
 */
export function orderError(b, { allowedAccounts, setupNames, lotCap, tick }) {
    if (!allowedAccounts.includes(b.account)) return 'This account is not allowed to sync/trade (Settings).'
    if (!/^[A-Za-z0-9._#-]{1,20}$/.test(String(b.symbol || ''))) return 'Invalid symbol.'
    if (b.side !== 'buy' && b.side !== 'sell') return 'Side must be buy or sell.'
    const lot = Number(b.lot), sl = Number(b.sl), tp = b.tp === '' || b.tp == null ? null : Number(b.tp)
    if (!(lot > 0) || lot > lotCap) return `Lot must be above 0 and at most ${lotCap}.`
    if (!(sl > 0)) return 'A stop loss is required.'
    if (tp != null && !(tp > 0)) return 'Invalid take profit.'
    if (!setupNames.includes(String(b.setup || ''))) return 'Choose one of your setups.'
    if (String(b.reason || '').trim().length < 10) return 'Write the reason for this entry (at least 10 characters).'
    if (!tick) return 'No live price for this symbol; is it in MT5 Market Watch?'
    const px = b.side === 'buy' ? Number(tick.ask) : Number(tick.bid)
    if (b.side === 'buy' && !(sl < px && (tp == null || tp > px))) return `For a buy, SL must be below and TP above the price (${px}).`
    if (b.side === 'sell' && !(sl > px && (tp == null || tp < px))) return `For a sell, SL must be above and TP below the price (${px}).`
    return null
}
