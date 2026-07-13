/**
 * MongoDB access for the TradeNote MCP server. Reads the Parse `trades`
 * collection (one document per trading day) and the `notes` collection.
 * Read-only — nothing here writes to the database.
 */
import { MongoClient } from 'mongodb'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Read a key from the environment, falling back to ./.env then ../.env. */
export function readEnv(key) {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key]
  for (const p of [join(HERE, '.env'), join(HERE, '..', '.env')]) {
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 1) continue
      if (t.slice(0, i).trim() === key) {
        let v = t.slice(i + 1).trim()
        if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
          v = v.slice(1, -1)
        }
        return v
      }
    }
  }
  return undefined
}

let client
let userFilterCache

async function getDb() {
  if (!client) {
    const uri = readEnv('MONGO_URI')
    if (!uri) throw new Error('MONGO_URI is not set (env or ../.env)')
    client = new MongoClient(uri)
    await client.connect()
  }
  return client.db()
}

/**
 * Optional user scoping. Set TRADENOTE_USER to a username/email to restrict
 * analysis to that account; otherwise all trades in the DB are analyzed
 * (fine for a single-user journal). Parse stores the pointer as `_p_user`.
 */
async function getUserFilter(db) {
  if (userFilterCache !== undefined) return userFilterCache
  const who = readEnv('TRADENOTE_USER')
  if (!who) return (userFilterCache = {})
  const user = await db.collection('_User').findOne({
    $or: [{ username: who }, { email: who }],
  })
  if (!user) throw new Error(`TRADENOTE_USER "${who}" not found in _User`)
  userFilterCache = { _p_user: '_User$' + user._id }
  return userFilterCache
}

const HEAVY = { executions: 0, blotter: 0, pAndL: 0 }

/** Fetch day documents whose dateUnix falls in [fromUnix, toUnix). */
export async function fetchDayDocs({ fromUnix, toUnix } = {}) {
  const db = await getDb()
  const q = { ...(await getUserFilter(db)) }
  if (fromUnix != null || toUnix != null) {
    q.dateUnix = {}
    if (fromUnix != null) q.dateUnix.$gte = fromUnix
    if (toUnix != null) q.dateUnix.$lt = toUnix
  }
  return db.collection('trades')
    .find(q, { projection: HEAVY })
    .sort({ dateUnix: 1 })
    .toArray()
}

/** Fetch journal notes (reason / review note) in a dateUnix range. */
export async function fetchNotes({ fromUnix, toUnix } = {}) {
  const db = await getDb()
  const q = { ...(await getUserFilter(db)) }
  if (fromUnix != null || toUnix != null) {
    q.dateUnix = {}
    if (fromUnix != null) q.dateUnix.$gte = fromUnix
    if (toUnix != null) q.dateUnix.$lt = toUnix
  }
  return db.collection('notes')
    .find(q, { projection: { note: 1, reason: 1, tradeId: 1, dateUnix: 1 } })
    .sort({ dateUnix: 1 })
    .toArray()
}

export async function closeDb() {
  if (client) { await client.close(); client = undefined }
}
