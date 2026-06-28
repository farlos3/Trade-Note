/****************************************************************************************
 * Removes the seeded mock data: deletes all `trades` documents.
 * (The mock seed only creates `trades` docs; screenshots/notes are untouched.)
 *
 * Run INSIDE the running dev container:
 *   docker compose -f docker-compose-dev.yml exec tradenote node scripts/clear-mock-data.mjs
 ****************************************************************************************/
import { MongoClient } from 'mongodb'

const client = new MongoClient(process.env.MONGO_URI)
await client.connect()
const db = client.db(process.env.TRADENOTE_DATABASE)

const res = await db.collection('trades').deleteMany({})
console.log(`Deleted ${res.deletedCount} trades document(s).`)

await client.close()
process.exit(0)
