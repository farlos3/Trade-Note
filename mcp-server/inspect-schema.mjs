#!/usr/bin/env node
/**
 * One-off helper: connect to the TradeNote MongoDB Atlas database and print the
 * shape of the `trades` collection so we can map MCP tools to real fields.
 * Run: node inspect-schema.mjs
 */
import { MongoClient } from 'mongodb'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function readEnv(key) {
  if (process.env[key]) return process.env[key]
  for (const p of [join(HERE, '.env'), join(HERE, '..', '.env')]) {
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 1) continue
      if (t.slice(0, i).trim() === key) return t.slice(i + 1).trim()
    }
  }
  return undefined
}

const uri = readEnv('MONGO_URI')
if (!uri) { console.error('MONGO_URI not found in env or ../.env'); process.exit(1) }

const client = new MongoClient(uri)
try {
  await client.connect()
  const db = client.db()
  console.log('DB:', db.databaseName)

  const collections = (await db.listCollections().toArray()).map(c => c.name)
  console.log('Collections:', collections.join(', '))

  const trades = db.collection('trades')
  const count = await trades.countDocuments()
  console.log('\ntrades documents (days):', count)

  const doc = await trades.findOne({}, { sort: { dateUnix: -1 } })
  if (!doc) { console.log('No trade documents found.'); process.exit(0) }

  console.log('\n--- day document top-level keys ---')
  console.log(Object.keys(doc).join(', '))

  const arr = doc.trades
  console.log('\ndoc.trades is array:', Array.isArray(arr), '| length:', Array.isArray(arr) ? arr.length : 'n/a')
  if (Array.isArray(arr) && arr.length) {
    console.log('\n--- one nested trade: keys ---')
    console.log(Object.keys(arr[0]).join(', '))
    console.log('\n--- one nested trade: sample values ---')
    const t = arr[0]
    const pick = ['id', 'symbol', 'strategy', 'side', 'type', 'entryTime', 'exitTime',
      'entryPrice', 'exitPrice', 'buyQuantity', 'sellQuantity', 'quantity',
      'grossProceeds', 'netProceeds', 'commission', 'grossSharePL', 'netSharePL',
      'mfe', 'mae', 'account', 'strategyId', 'satisfaction', 'pips']
    for (const k of pick) if (k in t) console.log(`  ${k}:`, JSON.stringify(t[k]))
  }

  console.log('\n--- day-level aggregate keys (non-array, non-heavy) ---')
  for (const [k, v] of Object.entries(doc)) {
    if (Array.isArray(v)) continue
    if (['executions', 'blotter', 'pAndL'].includes(k)) continue
    console.log(`  ${k}:`, typeof v === 'object' ? '[object]' : JSON.stringify(v))
  }

  // How is the user stored? (pointer vs _p_user)
  console.log('\n--- user linkage ---')
  for (const k of Object.keys(doc)) if (/user/i.test(k)) console.log(`  ${k}:`, JSON.stringify(doc[k]))
} finally {
  await client.close()
}
