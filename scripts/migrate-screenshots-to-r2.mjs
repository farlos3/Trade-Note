/****************************************************************************************
 * One-off migration: move existing base64 screenshots from MongoDB to Cloudflare R2.
 *
 * For every `screenshots` document that still holds originalBase64 / annotatedBase64,
 * it uploads the image(s) to R2 and rewrites the document to store originalUrl /
 * annotatedUrl / r2KeyOriginal / r2KeyAnnotated instead, then removes the base64 blobs.
 *
 * Reads the same env vars as the app (MONGO_URI, TRADENOTE_DATABASE, R2_*).
 *
 * Run it INSIDE the running container so it picks up the env:
 *   docker compose -f docker-compose-local.yml exec tradenote node scripts/migrate-screenshots-to-r2.mjs
 *
 * It is safe to re-run: documents already migrated (no base64) are skipped.
 ****************************************************************************************/
import { MongoClient } from 'mongodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'

const MONGO_URI = process.env.MONGO_URI
const DB_NAME = process.env.TRADENOTE_DATABASE
const r2Endpoint = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null)
const r2Bucket = process.env.R2_BUCKET
const r2PublicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

if (!MONGO_URI || !DB_NAME) {
    console.error('Missing MONGO_URI or TRADENOTE_DATABASE')
    process.exit(1)
}
if (!r2Endpoint || !r2Bucket || !r2PublicUrl || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('R2 is not fully configured (need R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL)')
    process.exit(1)
}

const s3 = new S3Client({
    region: 'auto',
    endpoint: r2Endpoint,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
})

async function uploadBase64(base64, keyHint) {
    if (!base64 || typeof base64 !== 'string') return null
    const match = base64.match(/^data:(.+);base64,(.*)$/)
    if (!match) return null
    const contentType = match[1]
    const buffer = Buffer.from(match[2], 'base64')
    const ext = (contentType.split('/')[1] || 'png').split('+')[0]
    const safeHint = (keyHint || 'img').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
    const key = `screenshots/${safeHint}-${randomUUID()}.${ext}`
    await s3.send(new PutObjectCommand({ Bucket: r2Bucket, Key: key, Body: buffer, ContentType: contentType }))
    return { url: `${r2PublicUrl}/${key}`, key }
}

const client = new MongoClient(MONGO_URI)

async function run() {
    await client.connect()
    const db = client.db(DB_NAME)
    const col = db.collection('screenshots')

    const filter = { $or: [{ originalBase64: { $exists: true, $ne: null } }, { annotatedBase64: { $exists: true, $ne: null } }] }
    const total = await col.countDocuments(filter)
    console.log(`Found ${total} screenshot document(s) with base64 to migrate`)

    const cursor = col.find(filter)
    let done = 0
    let failed = 0

    while (await cursor.hasNext()) {
        const doc = await cursor.next()
        try {
            const set = {}
            const unset = {}

            const orig = await uploadBase64(doc.originalBase64, 'orig_' + (doc.name || doc._id))
            if (orig) {
                set.originalUrl = orig.url
                set.r2KeyOriginal = orig.key
                unset.originalBase64 = ''
            }

            const annot = await uploadBase64(doc.annotatedBase64, 'annot_' + (doc.name || doc._id))
            if (annot) {
                set.annotatedUrl = annot.url
                set.r2KeyAnnotated = annot.key
                unset.annotatedBase64 = ''
            }

            if (Object.keys(set).length > 0) {
                const update = { $set: set }
                if (Object.keys(unset).length > 0) update.$unset = unset
                await col.updateOne({ _id: doc._id }, update)
                done++
                console.log(`  [${done}/${total}] migrated ${doc._id}`)
            } else {
                console.log(`  skipped ${doc._id} (no valid base64)`)
            }
        } catch (e) {
            failed++
            console.error(`  FAILED ${doc._id}: ${e.message}`)
        }
    }

    console.log(`\nDone. Migrated ${done}, failed ${failed}.`)
    await client.close()
}

run().catch((e) => { console.error(e); process.exit(1) })
