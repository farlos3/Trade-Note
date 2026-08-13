/**
 * MT5 data source selection: local terminal vs MetaApi cloud.
 *
 *   MT5_SOURCE=local    (default) The Windows host agents own the connection:
 *                       mt5-sync/mt5_sync.py writes the journal, mt5_live.py
 *                       POSTs the live feed to /api/live. This process does
 *                       nothing -- it only receives what they push.
 *   MT5_SOURCE=metaapi  This process connects to MetaApi's cloud copy of the
 *                       terminal and produces the same live snapshot itself.
 *                       No Windows host, no MT5 running anywhere locally, which
 *                       is what makes deploying to a Linux box possible.
 *
 * Both paths end at the same in-memory snapshot the /api/live endpoints serve,
 * so the frontend cannot tell them apart and needs no branching.
 *
 * Nothing here writes to MongoDB: the live feed stays ephemeral in either mode
 * (see the /api/live block in index.mjs for why).
 */

const SOURCE = (process.env.MT5_SOURCE || 'local').trim().toLowerCase()

export const mt5Source = SOURCE
export const isMetaApiMode = SOURCE === 'metaapi'

/**
 * Start the MetaApi streaming connection.
 *
 * @param {(snapshot: object) => void} onSnapshot called whenever positions or
 *        account figures change; receives the same shape mt5_live.py POSTs.
 * @returns {Promise<{stop: () => Promise<void>}|null>} null when not in metaapi
 *          mode or when configuration is missing.
 */
export async function startMetaApiFeed(onSnapshot) {
    if (!isMetaApiMode) return null

    const token = process.env.METAAPI_ACCESS_TOKEN
    const accountId = process.env.METAAPI_ACCOUNT_ID
    if (!token || !accountId) {
        console.log(' -> MT5_SOURCE=metaapi but METAAPI_ACCESS_TOKEN / METAAPI_ACCOUNT_ID missing; live feed off.')
        return null
    }

    // Imported lazily so `local` mode never pays to load a large SDK it will not
    // use, and a missing/broken install cannot stop the server from booting.
    // The package's "import" condition points at its BROWSER bundle; /esm-node is
    // the Node build (see its package.json exports).
    let MetaApi
    try {
        const pkg = await import('metaapi.cloud-sdk/esm-node')
        MetaApi = pkg.default || pkg
    } catch (e) {
        console.log(` -> MetaApi SDK unavailable (${e.message}); live feed off.`)
        return null
    }

    const region = process.env.METAAPI_REGION || undefined
    const api = new MetaApi(token, region ? { region } : undefined)

    let connection = null
    let account = null

    const buildSnapshot = () => {
        if (!connection) return null
        const info = connection.terminalState.accountInformation
        if (!info) return null
        const raw = connection.terminalState.positions || []
        const positions = raw.map((p) => ({
            ticket: Number(p.id),
            symbol: p.symbol,
            // MetaApi spells these out where the native API used 0/1.
            side: p.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
            volume: p.volume,
            priceOpen: p.openPrice,
            priceCurrent: p.currentPrice,
            sl: p.stopLoss || 0,
            tp: p.takeProfit || 0,
            profit: p.profit || 0,
            swap: p.swap || 0,
            openTime: p.time ? Math.floor(new Date(p.time).getTime() / 1000) : null,
        }))
        const ticks = {}
        for (const sym of new Set(positions.map((p) => p.symbol))) {
            const price = connection.terminalState.price(sym)
            if (price) ticks[sym] = { bid: price.bid, ask: price.ask }
        }
        return {
            login: info.login,
            currency: info.currency,
            balance: info.balance,
            equity: info.equity,
            // MetaApi reports equity and balance but not floating P&L directly;
            // it is exactly the difference, and summing positions would drift
            // from the broker's own number on swap/commission.
            profit: Number((info.equity - info.balance).toFixed(2)),
            margin: info.margin,
            marginFree: info.freeMargin,
            positions,
            ticks,
            t: Math.floor(Date.now() / 1000),
        }
    }

    const emit = () => {
        const snap = buildSnapshot()
        if (snap) onSnapshot(snap)
    }

    console.log(`\nMETAAPI: connecting account ${accountId}`)
    account = await api.metatraderAccountApi.getAccount(accountId)

    // An UNDEPLOYED account has no cloud terminal running, so it can never stream.
    // Deploying is billable on MetaApi, so it is never done implicitly here -- say
    // what to do and stop.
    if (account.state === 'UNDEPLOYED' || account.state === 'DRAFT') {
        console.log(` -> Account is ${account.state}. Deploy it first (billable on MetaApi):`)
        console.log('    metaapi.cloud dashboard, or POST /users/current/accounts/<id>/deploy')
        return null
    }

    await account.waitConnected()
    connection = account.getStreamingConnection()
    await connection.connect()
    await connection.waitSynchronized()

    // terminalState is updated in place by the SDK as ticks arrive; poll it on a
    // short timer rather than emitting per tick, so a fast market cannot flood the
    // SSE clients with more frames than a UI can use.
    const timer = setInterval(emit, 1000)
    emit()

    console.log(` -> MetaApi streaming connected (${account.login} @ ${account.server})`)

    return {
        async stop() {
            clearInterval(timer)
            try { if (connection) await connection.close() } catch { /* shutting down */ }
        },
    }
}
