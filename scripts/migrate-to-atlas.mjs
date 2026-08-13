#!/usr/bin/env node
/**
 * Copy the local MongoDB into Atlas (or any other MongoDB), then verify.
 *
 * Run INSIDE the app container, which already has the mongodb driver and can
 * reach both the local mongo service and the internet:
 *
 *   docker compose -f docker-compose-dev.yml exec -T tradenote \
 *     node scripts/migrate-to-atlas.mjs --to "mongodb+srv://user:pass@cluster.mongodb.net/tradenote"
 *
 * Flags:
 *   --to <uri>     TARGET connection string (required)
 *   --from <uri>   SOURCE (default: $MONGO_URI, i.e. the local container)
 *   --db <name>    database name (default: $TRADENOTE_DATABASE or "tradenote")
 *   --force        allow writing into a target that already has data
 *   --dry-run      report what would be copied, write nothing
 *
 * Safety rules, because this touches the only copy of a trading journal:
 *   - The SOURCE is opened read-only in effect: nothing is ever deleted there.
 *   - A target that already holds documents is REFUSED unless --force, so a
 *     second accidental run cannot duplicate or interleave records.
 *   - Every collection's document count is compared after the copy, and a
 *     mismatch is reported as a failure with a non-zero exit code.
 *   - _id values are preserved, so Parse pointers (_p_user, tradeId, ...) keep
 *     resolving. A copy that re-generated ids would silently orphan every note,
 *     tag and screenshot from its trade.
 */
import { MongoClient } from 'mongodb'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
    const i = args.indexOf(name)
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const TO = flag('--to')
const FROM = flag('--from', process.env.MONGO_URI)
const DB = flag('--db', process.env.TRADENOTE_DATABASE || 'tradenote')
const FORCE = has('--force')
const DRY = has('--dry-run')

const redact = (u) => (u || '').replace(/\/\/[^@/]*@/, '//<redacted>@')

if (!TO) {
    console.error('ERROR: --to <target uri> is required.')
    process.exit(64)
}
if (!FROM) {
    console.error('ERROR: no source URI (pass --from or set MONGO_URI).')
    process.exit(64)
}

const log = (m) => console.log(m)

const main = async () => {
    log(`source : ${redact(FROM)}`)
    log(`target : ${redact(TO)}`)
    log(`database: ${DB}${DRY ? '   [DRY RUN]' : ''}\n`)

    const src = new MongoClient(FROM, { serverSelectionTimeoutMS: 15000 })
    const dst = new MongoClient(TO, { serverSelectionTimeoutMS: 30000 })

    await src.connect()
    log('connected to source')
    await dst.connect()
    log('connected to target\n')

    const sdb = src.db(DB)
    const ddb = dst.db(DB)

    const collections = (await sdb.listCollections().toArray())
        .map((c) => c.name)
        // system.* is managed by the server itself and must not be hand-copied.
        .filter((n) => !n.startsWith('system.'))
        .sort()

    // Refuse to write into a target that already holds data: re-running this
    // would duplicate or half-overwrite a journal with no clean way back.
    let occupied = []
    for (const name of collections) {
        const n = await ddb.collection(name).countDocuments()
        if (n > 0) occupied.push(`${name}=${n}`)
    }
    if (occupied.length && !FORCE) {
        log('TARGET IS NOT EMPTY:')
        occupied.forEach((o) => log(`  ${o}`))
        log('\nRefusing to write. Re-run with --force only if you intend to merge into it.')
        await src.close(); await dst.close()
        process.exit(1)
    }

    let totalCopied = 0
    const results = []
    for (const name of collections) {
        const docs = await sdb.collection(name).find({}).toArray()
        if (!docs.length) {
            results.push({ name, src: 0, dst: 0, ok: true })
            log(`  ${name.padEnd(22)} empty, skipped`)
            continue
        }
        if (!DRY) {
            // ordered:false so one bad document cannot abort the whole batch, and
            // _id values are kept exactly as they are (see the header).
            await ddb.collection(name).insertMany(docs, { ordered: false })
        }
        const after = DRY ? docs.length : await ddb.collection(name).countDocuments()
        const ok = after === docs.length
        totalCopied += docs.length
        results.push({ name, src: docs.length, dst: after, ok })
        log(`  ${name.padEnd(22)} ${String(docs.length).padStart(6)} docs -> ${String(after).padStart(6)}  ${ok ? 'OK' : 'MISMATCH'}`)
    }

    const bad = results.filter((r) => !r.ok)
    log(`\n${totalCopied} document(s) across ${collections.length} collection(s).`)
    await src.close()
    await dst.close()

    if (bad.length) {
        log('VERIFICATION FAILED for: ' + bad.map((b) => b.name).join(', '))
        process.exit(1)
    }
    log(DRY ? 'Dry run complete — nothing was written.' : 'Verified: every collection matches.')
    if (!DRY) {
        log('\nNext: point MONGO_URI at the target in .env, then recreate the container')
        log('(docker compose -f docker-compose-dev.yml up -d  — "restart" does NOT reload .env).')
    }
}

main().catch((e) => {
    console.error(`\nFAILED: ${e.message}`)
    process.exit(1)
})
