import { MongoClient } from 'mongodb'
import dayjs from 'dayjs'

const client = new MongoClient(process.env.MONGO_URI)
await client.connect()
const db = client.db(process.env.TRADENOTE_DATABASE)
const col = db.collection('trades')

const total = await col.countDocuments()
console.log('Total trades documents:', total)

const docs = await col.find({}).sort({ dateUnix: -1 }).limit(8).toArray()
for (const d of docs) {
    const accounts = new Set((d.trades || []).map(t => t.account))
    console.log(`  dateUnix ${d.dateUnix} (${dayjs.unix(d.dateUnix).format('YYYY-MM-DD')}) | trades: ${(d.trades || []).length} | accounts: ${[...accounts].join(',')} | openPositions: ${d.openPositions}`)
}

// distinct accounts across all trades
const all = await col.find({}).toArray()
const accSet = new Set()
all.forEach(d => (d.trades || []).forEach(t => accSet.add(t.account)))
console.log('Distinct accounts in trades:', [...accSet])

const user = await db.collection('_User').findOne({})
console.log('User.accounts:', JSON.stringify(user?.accounts))

await client.close()
process.exit(0)
