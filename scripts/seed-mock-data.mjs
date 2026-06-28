/****************************************************************************************
 * Seed mock XAUUSD trades so you can preview the layout with real-looking data.
 *
 * It builds broker-style rows and runs them through the SAME pipeline the app/API use
 * (useImportTrades + useUploadTrades with the master key), so the resulting `trades`
 * documents are structurally identical to a real import.
 *
 * Run INSIDE the running dev container:
 *   docker compose -f docker-compose-dev.yml exec tradenote node scripts/seed-mock-data.mjs [count] [monthsBack]
 *
 * Default: 35 trades per month across the last 3 months (incl. current).
 * Re-running adds more trades (existing days are skipped by the pipeline).
 ****************************************************************************************/
import ParseNode from 'parse/node.js'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(timezone)
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
dayjs.extend(customParseFormat)

import { tradesData, currentUser, uploadMfePrices, timeZoneTrade, selectedBroker } from '../src/stores/globals.js'
import { useImportTrades, useUploadTrades, useGetExistingTradesArray } from '../src/utils/addTrades.js'

const COUNT = parseInt(process.argv[2]) || 35       // trades per month
const MONTHS_BACK = parseInt(process.argv[3]) || 3  // how many months to spread across (incl. current)
const SYMBOL = 'XAUUSD'
const CONTRACT_SIZE = 100 // XAUUSD: 100 oz per lot

ParseNode.initialize(process.env.APP_ID)
ParseNode.serverURL = `http://localhost:${process.env.TRADENOTE_PORT || 8080}/parse`
ParseNode.masterKey = process.env.MASTER_KEY

const rand = (min, max) => Math.random() * (max - min) + min
const randInt = (min, max) => Math.floor(rand(min, max + 1))

function buildRow(extra) {
    return Object.assign({
        Account: 'Mock',
        Currency: 'USD',
        Type: 'forex',
        Symbol: SYMBOL,
        SymbolOriginal: SYMBOL,
        Comm: '0', SEC: '0', TAF: '0', NSCC: '0', Nasdaq: '0',
        'ECN Remove': '0', 'ECN Add': '0',
        'Gross Proceeds': '0', 'Net Proceeds': '0',
        'Clr Broker': '', Liq: '', Note: ''
    }, extra)
}

async function run() {
    // 1. Load the user (single-user self-hosted instance)
    const userQuery = new ParseNode.Query(ParseNode.User)
    const user = await userQuery.first({ useMasterKey: true })
    if (!user) {
        console.error('No user found. Register a user first at /register.')
        process.exit(1)
    }
    currentUser.value = JSON.parse(JSON.stringify(user))
    const account = (currentUser.value.accounts && currentUser.value.accounts[0] && currentUser.value.accounts[0].value) || 'Mock'
    timeZoneTrade.value = currentUser.value.timeZone || 'America/New_York'
    uploadMfePrices.value = false
    selectedBroker.value = 'manual'
    console.log(`Seeding ${COUNT} ${SYMBOL} trades/month over ${MONTHS_BACK} month(s) for user ${currentUser.value.username} (account "${account}", tz ${timeZoneTrade.value})`)

    // 2. Build random trade rows spread across the last MONTHS_BACK months
    const today = dayjs().tz(timeZoneTrade.value)
    tradesData.length = 0

    for (let m = 0; m < MONTHS_BACK; m++) {
        const monthStart = today.subtract(m, 'month').startOf('month')
        // For the current month only go up to today; past months use the full month
        const lastDay = (m === 0) ? today.date() : monthStart.daysInMonth()

        for (let i = 0; i < COUNT; i++) {
            const day = monthStart.add(randInt(0, lastDay - 1), 'day')
            const td = day.format('MM/DD/YYYY')
        const isLong = Math.random() > 0.4
        const lot = parseFloat(rand(0.1, 2).toFixed(2))
        const entry = parseFloat(rand(2280, 2420).toFixed(2))
        const win = Math.random() > 0.42 // ~58% win rate
        const move = parseFloat(rand(0.5, 18).toFixed(2)) * (win ? 1 : -1)
        const exit = isLong ? entry + move : entry - move
        const dir = isLong ? 1 : -1
        const gross = parseFloat(((exit - entry) * lot * CONTRACT_SIZE * dir).toFixed(2))
        const commission = parseFloat(rand(0, 4).toFixed(2))

        const entryHour = randInt(1, 18)
        const exitHour = Math.min(entryHour + randInt(0, 4), 22)
        const entryClock = `${String(entryHour).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`
        const exitClock = `${String(exitHour).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`

        tradesData.push(buildRow({
            Account: account,
            Side: isLong ? 'B' : 'SS',
            'T/D': td, 'S/D': td,
            Qty: String(lot),
            Price: String(entry.toFixed(2)),
            'Exec Time': entryClock,
            'Gross Proceeds': '0',
            'Net Proceeds': '0'
        }))
        tradesData.push(buildRow({
            Account: account,
            Side: isLong ? 'S' : 'BC',
            'T/D': td, 'S/D': td,
            Qty: String(lot),
            Price: String(exit.toFixed(2)),
            'Exec Time': exitClock,
            Comm: String(commission),
            'Gross Proceeds': String(gross),
            'Net Proceeds': String(parseFloat((gross - commission).toFixed(2)))
        }))
        }
    }

    // 3. Run the real pipeline
    await useGetExistingTradesArray('api', ParseNode)
    await useImportTrades(null, 'api', 'manual', ParseNode)
    await useUploadTrades('api', ParseNode)

    console.log('\nDone. Open the Dashboard / Daily / Calendar to see the mock data.')
    console.log(`If nothing shows, open Filters and make sure the "${account}" account is selected.`)
    process.exit(0)
}

run().catch((e) => { console.error(e); process.exit(1) })
