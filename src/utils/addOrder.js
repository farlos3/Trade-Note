/****************************************************************************************
 * MANUAL ORDER ENTRY
 * --------------------------------------------------------------------------------------
 * Lets a user add a single trade by hand (entry price, optional exit price, lot size)
 * via the +Add popup. Instead of duplicating the (very complex) trade-aggregation
 * pipeline, we build the same intermediate `tradesData` rows that the MetaTrader 5
 * importer produces (see useBrokerMetaTrader5 in brokers.js), turn them into trades with
 * useBuildManualTrades, then MERGE the result into the day's existing `trades` document
 * (recomputing blotter/pAndL). That way the manual trade lands in the same `trades`
 * class and shows up in Dashboard / Calendar / Daily like any import, even on a day that
 * already has trades.
 *
 * Screenshot and review note are saved as their own Parse objects, linked to the trade
 * with the SAME deterministic id the pipeline generates:
 *   tradeId = "t" + entryExecTimeUnix + "_" + symbol + "_forex_" + (long ? "B" : "SS")
 * Daily matches screenshots by `screenshot.name == trade.id` and notes by
 * `note.tradeId == trade.id`.
 ****************************************************************************************/
import { tradesData, selectedBroker, timeZoneTrade, spinnerLoadingPage, uploadMfePrices, currentUser, executions, trades, blotter, pAndL } from '../stores/globals.js'
import { useBuildManualTrades, useCreateBlotter, useCreatePnL } from './addTrades.js'
import { useGetTimeZone } from './utils.js'
import { useUploadImageToR2 } from './r2.js'

/* MODULES */
import Parse from 'parse/dist/parse.min.js'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(timezone)
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
dayjs.extend(customParseFormat)

/**
 * Per-asset-class contract and pip sizes.
 *
 * Both numbers used to be guessed per call site from a couple of `includes`
 * checks that only knew forex, gold and silver. Anything else -- an index, oil,
 * crypto -- fell through to the standard forex lot (100000 units, 0.0001 pip),
 * which is not merely imprecise: a 0.01-lot Nasdaq position priced at 29607.6
 * came out roughly seven orders of magnitude wrong in both the P&L preview and
 * the risk calculator, and its "move" read in hundreds of thousands of pips.
 *
 * The values below are read off the broker's own symbol specs
 * (MetaTrader5 `symbol_info`: trade_contract_size / trade_tick_size /
 * trade_tick_value), not assumed:
 *
 *   USA100/USA30/USA500/GER40/UK100/JP225   contract 1      tick 0.01
 *   XAUUSD                                  contract 100    tick 0.01
 *   XAGUSD                                  contract 1000   tick 0.001
 *   USOIL/UKOIL                             contract 100    tick 0.01
 *   BTCUSD/ETHUSD                           contract 1      tick 0.001
 *
 * `pip` is the unit the trader actually speaks in for that class -- index points
 * for an index, whole dollars for crypto, the fourth decimal for forex -- and is
 * chosen so `contractSize * pipSize` lands on the broker's own per-lot value of
 * one pip ($1 for every class here). That product is what the risk calculator in
 * Nav.vue divides by, so the two have to stay in step.
 *
 * ORDER MATTERS. The patterns are substrings, and several symbols satisfy more
 * than one: `#BTCXAUr` is crypto, not gold; `USOIL` contains "US" but is not an
 * index; `#BTCJPYr` is crypto, not a yen pair. Most specific class first.
 */
const ASSET_CLASSES = [
    { pipSize: 1, contractSize: 1, match: ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'DOGE', 'ADA', 'BNB'] },
    {
        pipSize: 1, contractSize: 1,
        match: ['USA100', 'US100', 'NAS', 'NDX', 'USTEC', 'USA30', 'US30', 'DJ30', 'USA500', 'US500',
            'SPX', 'GER40', 'DE40', 'DAX', 'UK100', 'FTSE', 'JP225', 'NIKKEI', 'NETH25', 'EU50',
            'STOXX', 'HK50', 'AUS200', 'FRA40', 'ESP35'],
    },
    { pipSize: 0.01, contractSize: 100, match: ['OIL', 'WTI', 'BRENT'] },
    { pipSize: 0.01, contractSize: 100, match: ['XAU'] },
    { pipSize: 0.001, contractSize: 1000, match: ['XAG'] },
    { pipSize: 0.01, contractSize: 100000, match: ['JPY'] },
]

// Standard forex lot: the fallback, and still correct for the majority of pairs.
const FOREX = { pipSize: 0.0001, contractSize: 100000 }

function assetClass(symbol) {
    if (!symbol) return FOREX
    const s = String(symbol).toUpperCase()
    return ASSET_CLASSES.find((c) => c.match.some((m) => s.includes(m))) || FOREX
}

/* Pip size used only for the informational "pips" display */
export function usePipSize(symbol) {
    return assetClass(symbol).pipSize
}

/* Units per 1.00 lot. Drives the P&L calculation, editable in the form. */
export function useDefaultContractSize(symbol) {
    return assetClass(symbol).contractSize
}

/**
 * Pure P&L calculation used both for the live preview and when building the rows.
 * gross = (exit - entry) * lot * contractSize * direction
 * net   = gross - commission
 */
export function useComputeForexPnL(order) {
    const dir = order.direction === 'short' ? -1 : 1
    const entry = parseFloat(order.entryPrice)
    const lot = parseFloat(order.lot)
    const cs = parseFloat(order.contractSize)
    const commission = parseFloat(order.commission) || 0
    const pipSize = order.pipSize ? parseFloat(order.pipSize) : usePipSize(order.symbol)

    const hasExit = order.exitPrice !== '' && order.exitPrice !== null && order.exitPrice !== undefined && !isNaN(parseFloat(order.exitPrice))
    let pips = null
    let gross = null
    let net = null

    if (hasExit && !isNaN(entry) && !isNaN(lot) && !isNaN(cs)) {
        const exit = parseFloat(order.exitPrice)
        pips = ((exit - entry) / pipSize) * dir
        gross = (exit - entry) * lot * cs * dir
        net = gross - commission
    }
    return { pips, gross, net, pipSize, hasExit, commission }
}

function buildRow(order) {
    /* Mirrors the intermediate object produced by useBrokerMetaTrader5 */
    return {
        Account: (order.account && order.account.trim()) || 'Manual',
        Currency: 'USD',
        Type: 'forex',
        SymbolOriginal: order.symbol,
        Symbol: order.symbol,
        Comm: '0',
        SEC: '0',
        TAF: '0',
        NSCC: '0',
        Nasdaq: '0',
        'ECN Remove': '0',
        'ECN Add': '0',
        'Gross Proceeds': '0',
        'Net Proceeds': '0',
        'Clr Broker': '',
        Liq: '',
        Note: order.note || ''
    }
}

async function saveOrderScreenshot({ name, symbol, side, dateUnix, base64, tz }) {
    console.log(' -> Saving manual order screenshot ' + name)
    const parseObject = Parse.Object.extend('screenshots')
    const object = new parseObject()
    object.set('user', Parse.User.current())
    object.set('name', name) // MUST equal trade.id so Daily links it to the trade
    object.set('symbol', symbol)
    object.set('side', side)

    // Store the image on Cloudflare R2 when configured, otherwise fall back to base64
    const up = await useUploadImageToR2(base64, 'order_' + name)
    if (up) {
        object.set('originalUrl', up.url)
        object.set('annotatedUrl', up.url)
        object.set('r2KeyOriginal', up.key)
        object.set('r2KeyAnnotated', up.key)
    } else {
        object.set('originalBase64', base64)
        object.set('annotatedBase64', base64)
    }
    object.set('markersOnly', true)
    object.set('date', new Date(dayjs.unix(dateUnix).tz(tz).format('YYYY-MM-DDTHH:mm:ss')))
    object.set('dateUnix', Number(dateUnix))
    object.set('dateUnixDay', dayjs(dateUnix * 1000).tz(tz).startOf('day').unix())
    object.setACL(new Parse.ACL(Parse.User.current()))
    await object.save()
}

/* Makes sure the order's account exists on the user and is selected, otherwise the
   dashboard account filter would hide the new trade. Mirrors checkTradeAccounts. */
async function ensureManualAccount(accountValue) {
    const user = Parse.User.current()
    let accounts = user.get('accounts') || []
    if (!accounts.find(a => a.value === accountValue)) {
        accounts = accounts.concat([{ value: accountValue, label: accountValue }])
        user.set('accounts', accounts)
        await user.save()
        if (currentUser.value) currentUser.value.accounts = accounts
    }
    let selected = []
    const raw = localStorage.getItem('selectedAccounts')
    if (raw) selected = raw.includes(',') ? raw.split(',') : [raw]
    if (!selected.includes(accountValue)) {
        selected.push(accountValue)
        localStorage.setItem('selectedAccounts', selected.join(','))
    }
}

/* Merge the freshly built trades for one day into its existing day document (or create
   a new one), recomputing blotter/pAndL for the merged set. */
async function upsertDay(dayUnix, tz) {
    const newExecs = executions[dayUnix] || []
    const newTrades = trades[dayUnix] || []
    if (newTrades.length === 0 && newExecs.length === 0) return

    const parseObject = Parse.Object.extend('trades')
    const query = new Parse.Query(parseObject)
    query.equalTo('dateUnix', Number(dayUnix))
    const existing = await query.first()

    if (existing) {
        console.log(' -> Merging manual order into existing day ' + dayUnix)
        const mergedExecs = (existing.get('executions') || []).concat(newExecs)
        const mergedTrades = (existing.get('trades') || []).concat(newTrades)
        // Feed the merged set back into the globals so blotter/pAndL recompute on the full day
        executions[dayUnix] = mergedExecs
        trades[dayUnix] = mergedTrades
        await useCreateBlotter()
        await useCreatePnL()
        existing.set('executions', mergedExecs)
        existing.set('trades', mergedTrades)
        existing.set('blotter', blotter[dayUnix])
        existing.set('pAndL', pAndL[dayUnix])
        existing.set('openPositions', mergedTrades.some(t => t.openPosition))
        await existing.save()
    } else {
        console.log(' -> Creating new day document ' + dayUnix)
        await useCreateBlotter()
        await useCreatePnL()
        const object = new parseObject()
        object.set('user', Parse.User.current())
        object.set('date', new Date(dayjs.unix(dayUnix).format('YYYY-MM-DD')))
        object.set('dateUnix', Number(dayUnix))
        object.set('executions', executions[dayUnix])
        object.set('trades', trades[dayUnix])
        object.set('blotter', blotter[dayUnix])
        object.set('pAndL', pAndL[dayUnix])
        object.set('openPositions', (trades[dayUnix] || []).some(t => t.openPosition))
        object.setACL(new Parse.ACL(Parse.User.current()))
        await object.save()
    }
}

async function saveOrderNote({ tradeId, dateUnix, note, reason }) {
    console.log(' -> Saving manual order note for ' + tradeId)
    const parseObject = Parse.Object.extend('notes')
    const object = new parseObject()
    object.set('user', Parse.User.current())
    object.set('note', note || '')
    object.set('reason', reason || '')
    object.set('dateUnix', Number(dateUnix))
    object.set('tradeId', tradeId) // MUST equal trade.id so Daily links the note
    object.setACL(new Parse.ACL(Parse.User.current()))
    await object.save()
}

/**
 * Main entry point called from the +Add popup.
 * On success it redirects to /dashboard so the new trade shows up.
 */
export async function useAddManualOrder(order) {
    console.log('\nADDING MANUAL ORDER')
    spinnerLoadingPage.value = true

    if (!timeZoneTrade.value) await useGetTimeZone()
    const tz = timeZoneTrade.value

    const isLong = order.direction !== 'short'
    const { gross, net, hasExit, commission } = useComputeForexPnL(order)

    /* ---- Entry date / time ---- */
    const entryDay = dayjs.tz(order.entryDate, tz)
    const entryTD = entryDay.format('MM/DD/YYYY')
    const entryClock = entryDay.format('HH:mm:ss')
    // Same computation createTempExecutions uses, so we can predict the trade id
    const entryExecTime = dayjs.tz(entryDay.format('YYYY-MM-DD') + ' ' + entryClock, tz).unix()

    /* ---- Build intermediate rows (entry + optional exit) ---- */
    tradesData.length = 0

    const entryRow = buildRow(order)
    entryRow.Side = isLong ? 'B' : 'SS'
    entryRow['T/D'] = entryTD
    entryRow['S/D'] = entryTD
    entryRow.Qty = String(order.lot)
    entryRow.Price = String(order.entryPrice)
    entryRow['Exec Time'] = entryClock
    entryRow['Gross Proceeds'] = '0'
    if (!hasExit) {
        // Open position: keep commission here so it isn't lost
        entryRow.Comm = String(commission)
        entryRow['Net Proceeds'] = String(-commission)
    }
    tradesData.push(entryRow)

    if (hasExit) {
        // Force the exit onto the entry day so entry+exit group into ONE closed trade
        // (TradeNote groups executions by trade-day). Exit clock time is kept as entered.
        const exitDay = order.exitDate ? dayjs.tz(order.exitDate, tz) : entryDay
        const exitRow = buildRow(order)
        exitRow.Side = isLong ? 'S' : 'BC'
        exitRow['T/D'] = entryTD
        exitRow['S/D'] = entryTD
        exitRow.Qty = String(order.lot)
        exitRow.Price = String(order.exitPrice)
        exitRow['Exec Time'] = exitDay.format('HH:mm:ss')
        exitRow['Gross Proceeds'] = String(gross)
        exitRow.Comm = String(commission)
        exitRow['Net Proceeds'] = String(net)
        tradesData.push(exitRow)
    }

    /* ---- Deterministic trade id (matches createTrades) ---- */
    const symbolForId = order.symbol.replace('.', '_')
    const tradeId = 't' + entryExecTime + '_' + symbolForId + '_forex_' + (isLong ? 'B' : 'SS')

    /* ---- Build trades in memory then merge into the day document(s) ---- */
    uploadMfePrices.value = false
    selectedBroker.value = 'manual'
    // Start from a clean slate so we only operate on this order's day(s)
    for (const k in executions) delete executions[k]
    for (const k in trades) delete trades[k]
    for (const k in blotter) delete blotter[k]
    for (const k in pAndL) delete pAndL[k]

    await useBuildManualTrades()

    await ensureManualAccount((order.account && order.account.trim()) || 'Manual')

    for (const dayUnix of Object.keys(executions)) {
        await upsertDay(dayUnix, tz)
    }

    /* ---- Save screenshot + note ---- */
    if (order.screenshotBase64) {
        await saveOrderScreenshot({
            name: tradeId,
            symbol: symbolForId,
            side: entryRow.Side,
            dateUnix: entryExecTime,
            base64: order.screenshotBase64,
            tz
        })
    }
    if ((order.note && order.note.trim()) || (order.reason && order.reason.trim())) {
        await saveOrderNote({ tradeId, dateUnix: entryExecTime, note: order.note, reason: order.reason })
    }

    /* ---- Done: reload into the dashboard so the new trade shows up ---- */
    window.location.href = '/dashboard'
}
