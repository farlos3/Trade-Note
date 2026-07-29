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

/**
 * Connection string for this process.
 *
 * This module has two callers with different views of the network:
 *   - index.mjs, running INSIDE the app container, where `.env`'s
 *     `mongo:27017` (the compose service name) is exactly right;
 *   - the MCP server, launched on the HOST by Claude Desktop, where that
 *     hostname does not resolve and the database is on the published port.
 *
 * So the rewrite is conditional on where we actually are. `/.dockerenv` is
 * present in every container and absent on the host. Rewriting unconditionally
 * breaks the app's own /api/analysis endpoints, which is not obvious because the
 * failure surfaces later as "Topology is closed" rather than a connect error.
 *
 * MCP_MONGO_URI overrides everything (remote database, or a host-run server that
 * needs a different address).
 */
export function resolveMongoUri() {
  const override = readEnv('MCP_MONGO_URI')
  if (override) return override
  // When MONGO_URI is a real process env var, we're the app running INSIDE the
  // compose network (docker sets `environment: MONGO_URI`), where `mongo:27017`
  // is the correct, resolvable host -- use it verbatim. Only the standalone MCP
  // server on the host lacks it in process.env (it reads the app's .env file),
  // and there the compose hostname isn't resolvable, so rewrite to the published
  // localhost port. Rewriting unconditionally broke the app's /api/analysis/*.
  if (process.env.MONGO_URI) return process.env.MONGO_URI
  const uri = readEnv('MONGO_URI')
  if (!uri) throw new Error('MONGO_URI is not set (env or ../.env)')
  if (existsSync('/.dockerenv')) return uri
  return uri.replace(/@mongo:(\d+)/, '@localhost:$1').replace(/\/\/mongo:(\d+)/, '//localhost:$1')
}

async function getDb() {
  // Recover from a dropped connection (e.g. mongo restarted during a stop/start
  // cycle): a cached-but-dead client otherwise fails every later request with
  // "Topology is closed" until the whole app restarts.
  if (client) {
    try {
      await client.db().command({ ping: 1 })
      return client.db()
    } catch {
      try { await client.close() } catch { /* already gone */ }
      client = undefined
    }
  }
  // Assign only once connected: a failed connect must not leave a dead client
  // cached, or every later call reuses it and fails the same way.
  const c = new MongoClient(resolveMongoUri())
  await c.connect()
  client = c
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

/**
 * Cheap signature of the trade data in a range, used to decide whether a cached
 * analysis is still current. Changes whenever a day doc is (re)written -- adding
 * a brand-new day bumps the count; adding orders to an existing day re-writes
 * that day doc (import upserts), bumping its _updated_at. No heavy fields read.
 */
export async function fetchTradesFingerprint({ fromUnix, toUnix } = {}) {
  const db = await getDb()
  const q = { ...(await getUserFilter(db)) }
  if (fromUnix != null || toUnix != null) {
    q.dateUnix = {}
    if (fromUnix != null) q.dateUnix.$gte = fromUnix
    if (toUnix != null) q.dateUnix.$lt = toUnix
  }
  const coll = db.collection('trades')
  const count = await coll.countDocuments(q)
  const latest = await coll
    .find(q, { projection: { _updated_at: 1 } })
    .sort({ _updated_at: -1 })
    .limit(1)
    .toArray()
  const lastUpdate = latest[0]?._updated_at ? new Date(latest[0]._updated_at).getTime() : 0
  return { count, lastUpdate }
}

export async function closeDb() {
  if (client) { await client.close(); client = undefined }
}
