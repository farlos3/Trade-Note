import express from 'express';
import compression from 'compression';
import { ParseServer } from 'parse-server'
//var ParseDashboard = require('parse-dashboard');
import ParseNode from 'parse/node.js'
import path from 'path'
import fs from 'fs'
import axios from 'axios'
import * as Vite from 'vite'
import { MongoClient } from "mongodb"
import Proxy from 'http-proxy'
import { useImportTrades, useGetExistingTradesArray, useUploadTrades } from './src/utils/addTrades.js';
import { currentUser, uploadMfePrices } from './src/stores/globals.js';
import { useGetTimeZone } from './src/utils/utils.js';
import { fetchDayDocs, fetchNotes, fetchTradesFingerprint } from './mcp-server/db.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { flattenTrades, computeStats, findBehaviorPatterns, computeDailyBreakdown } from './mcp-server/analysis.mjs';
import Stripe from 'stripe';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

/* CLOUDFLARE R2 (S3-compatible) image storage */
let r2Client = null
const r2Endpoint = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null)
const r2Bucket = process.env.R2_BUCKET
const r2PublicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
const r2Enabled = !!(r2Endpoint && r2Bucket && r2PublicUrl && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
if (r2Enabled) {
    r2Client = new S3Client({
        region: 'auto',
        endpoint: r2Endpoint,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    })
    console.log("\nCLOUDFLARE R2 enabled -> " + r2PublicUrl)
} else {
    console.log("\nCLOUDFLARE R2 not configured -> screenshots will be stored as base64 in MongoDB")
}


/* STRIPE VAR */
let stripeSk //secret key
let stripePk // public key
let stripePriceId
let stripeTrialPeriod

if (process.env.STRIPE_SK) {
    stripeSk = new Stripe(process.env.STRIPE_SK);
    stripePk = process.env.STRIPE_PK
    stripePriceId = process.env.STRIPE_PRICE_ID
    stripeTrialPeriod = process.env.STRIPE_TRIAL_PERIOD
}

/* END STRIPE */

let databaseURI

if (process.env.MONGO_URI) {
    databaseURI = process.env.MONGO_URI
} else if (process.env.MONGO_ATLAS) {
    databaseURI = "mongodb+srv://" + process.env.MONGO_USER + ":" + process.env.MONGO_PASSWORD + "@" + process.env.MONGO_URL + "/" + process.env.TRADENOTE_DATABASE + "?authSource=admin"
} else {
    databaseURI = "mongodb://" + process.env.MONGO_USER + ":" + process.env.MONGO_PASSWORD + "@" + process.env.MONGO_URL + ":" + process.env.MONGO_PORT + "/" + process.env.TRADENOTE_DATABASE + "?authSource=admin"
}

console.log("\nCONNECTING TO MONGODB")
let hiddenDatabaseURI = databaseURI.replace(/:\/\/[^@]*@/, "://***@")
console.log(' -> Database URI ' + hiddenDatabaseURI)

let tradenoteDatabase = process.env.TRADENOTE_DATABASE

var app = express();
// Gzip every response, including the dev-mode Vite proxy's (it pipes into the same
// res.write/res.end this middleware patches). Vite's dev server sends module code
// completely uncompressed -- e.g. echarts alone is a 2.6MB transfer on every full
// page load that imports it (Dashboard.vue, PlanVsActual.vue), since this app
// reloads the document on every nav instead of routing client-side.
app.use(compression());
app.use(express.json({ limit: '30mb' }));

const port = process.env.TRADENOTE_PORT;
const PROXY_PORT = 39482;

// SERVER

let server = null

export let allowRegister = false


/**************************** APIs ****************************/

const setupApiRoutes = (app) => {

    app.post("/api/parseAppId", (req, res) => {
        //console.log("\nAPI : post APP ID")
        //console.log(process.env.APP_ID)
        res.send(process.env.APP_ID)
    });

    app.post("/api/registerPage", (req, res) => {
        //console.log("\nAPI : post APP ID")
        //console.log(" REGISTER_OFF "+process.env.REGISTER_OFF)
        res.send(process.env.REGISTER_OFF)
    });

    app.post("/api/posthog", (req, res) => {
        //console.log("\nAPI : posthog")
        if (process.env.ANALYTICS_OFF) {
            res.send("off")
        } else {
            res.send("phc_FxkjH1O898jKu0yiELC3aWKda3vGov7waGN0weU5kw0")
        }
    });


    /**********************************************
     * CLOUD / STRIPE
     **********************************************/

    app.post("/api/checkCloudPayment", async (req, res) => {
        // Used for checking if can access add*, in case it's a paying user
        let currentUser = req.body.currentUser
        //console.log(" currentUser "+JSON.stringify(currentUser))
        //console.log(" current user " + JSON.stringify(req.body.currentUser))
        if (process.env.STRIPE_SK) {
            //console.log("\nAPI : checkCloudPayment")
            // Check if user is stripe customer

            // Check if user has paying customer 
            if (currentUser.hasOwnProperty("paymentService") && currentUser.paymentService.hasOwnProperty("subscriptionId")) {
                /// if yes, let inn, status 200
                const activeSubscription = ['active', 'trialing', 'past_due']
                const subscription = await stripeSk.subscriptions.retrieve(currentUser.paymentService.subscriptionId)
                if (activeSubscription.includes(subscription.status)) {
                    console.log(" -> User has valid subscription.");
                    res.status(200).send('OK');
                } else {
                    console.log(" -> User has invalid subscription.");
                    res.status(403).send('Forbidden');
                }

            }

            /// If not, check if user is within trial period
            else {

                // Convert createdAt to a Date object
                const createdAtDate = new Date(currentUser.createdAt);

                // Get the current time
                const currentDate = new Date();

                // Calculate the time difference in milliseconds
                const timeDifference = currentDate - createdAtDate;

                // Convert the time difference to days
                const differenceInDays = timeDifference / (1000 * 60 * 60 * 24); // Milliseconds to days

                //// if older, redirect to stripe / status 403
                if (differenceInDays > stripeTrialPeriod) {
                    console.log(" -> User is past trial period.");
                    res.status(403).send('Forbidden');
                }

                //// else, let inn, status 200
                else {
                    console.log(" -> User is within trial period.");
                    res.status(200).send('OK');
                }
            }




        } else {
            res.status(200).send('OK');
        }
    });

    app.post('/api/create-checkout-session', async (req, res) => {
        
        let return_url
        if (process.env.NODE_ENV == 'dev') {
            return_url = `http://localhost:${port}/checkoutSuccess?session_id={CHECKOUT_SESSION_ID}`
        }else{
            return_url = `https://app.tradenote.co/checkoutSuccess?session_id={CHECKOUT_SESSION_ID}`
        }

        //console.log(" -> return_url : "+return_url)
        const session = await stripeSk.checkout.sessions.create({
            ui_mode: 'embedded',
            line_items: [
                {
                    // Provide the exact Price ID (for example, pr_1234) of the product you want to sell
                    price: stripePriceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            return_url: return_url,
            automatic_tax: { enabled: true },
        });

        res.send({ clientSecret: session.client_secret });
    });

    app.get('/api/getStripePk', async (req, res) => {
        res.status(200).send(stripePk);
    })
    
    app.get('/api/session-status', async (req, res) => {
        try {
            console.log("Getting session status");
            const session = await stripeSk.checkout.sessions.retrieve(req.query.session_id);

            //console.log("Session retrieved:", JSON.stringify(session));

            res.send({
                session: session,
                status: session.status,
                customer_email: session.customer_details.email,
                customer_id: session.customer
            });
        } catch (error) {
            console.error("Error retrieving session:", error.message);
            res.status(500).send({ error: error.message });
        }
    });

    /******************* END CLOUD ****************************/

    app.get('/api/dockerVersion', async (req, res) => {
            console.log("Getting Docker Version");
            await axios.get("https://hub.docker.com/v2/namespaces/eleventrading/repositories/tradenote/tags")
            .then((response) => {
                //console.log(" -> data " + JSON.stringify(response.data))
                res.status(200).send(response.data);
            })
            .catch((error) => {
                res.status(500).send({ error: error.message });
            })
            .finally(function () {
                // always executed
            })
    });

    /**********************************************
     * AUTO-LOGIN
     * Single-user convenience. Logs in server-side with the seeded credentials
     * and hands the browser only a session token — the password never leaves
     * the server. Disabled unless TRADENOTE_AUTO_LOGIN is true.
     **********************************************/
    app.get('/api/autoLogin', async (req, res) => {
        const enabled = String(process.env.TRADENOTE_AUTO_LOGIN || '').toLowerCase() === 'true'
        const username = (process.env.TRADENOTE_USER || '').trim()
        const password = process.env.TRADENOTE_PASSWORD || ''
        if (!enabled || !username || !password) return res.status(200).json({ enabled: false })

        try {
            const user = await ParseNode.User.logIn(username, password)
            res.status(200).json({ enabled: true, sessionToken: user.getSessionToken() })
        } catch (error) {
            console.log(' -> Auto-login failed: ' + error.message)
            res.status(200).json({ enabled: false, error: error.message })
        }
    });

    /**********************************************
     * TRADING-BEHAVIOR ANALYSIS (deterministic; reuses mcp-server/analysis.mjs)
     * GET /api/analysis/behavior?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Asia/Bangkok
     **********************************************/
    const isoToUnix = (s) => {
        if (!s) return undefined
        const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s)
        return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
    }

    // Claude (LLM) analysis is optional: only enabled when ANTHROPIC_API_KEY is
    // set. The SDK reads the key from the environment automatically. Model is
    // overridable via ANALYSIS_MODEL (e.g. a cheaper model for lower cost).
    const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
    const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-5'

    app.get('/api/analysis/behavior', async (req, res) => {
        try {
            const tz = req.query.tz || process.env.TRADENOTE_TZ || 'UTC'
            const fromUnix = isoToUnix(req.query.from)
            const toUnix = isoToUnix(req.query.to)
            const days = await fetchDayDocs({ fromUnix, toUnix })
            const trades = flattenTrades(days)
            const stats = computeStats(trades, tz)
            const patterns = findBehaviorPatterns(trades, { revengeWindowMinutes: 15, tz, overtradeLotCap: Number(process.env.OVERTRADE_LOT_CAP) || 0.1 })

            // Fingerprint of the underlying data (day count + most recent write),
            // so the client can cache this result and skip re-running until an
            // order actually changes. Matches /api/analysis/fingerprint.
            const fpCount = days.length
            const fpLastUpdate = days.reduce((m, d) => Math.max(m, d._updated_at ? new Date(d._updated_at).getTime() : 0), 0)
            const fingerprint = `${fpCount}:${fpLastUpdate}`

            // Recent journal notes so the user can eyeball behavior vs. commentary
            let notes = []
            try {
                const raw = await fetchNotes({ fromUnix, toUnix })
                notes = raw
                    .filter(n => (n.reason && n.reason.trim()) || (n.note && n.note.trim()))
                    .slice(-15)
                    .reverse()
                    .map(n => ({
                        date: n.dateUnix ? new Date(n.dateUnix * 1000).toLocaleDateString('en-CA', { timeZone: tz }) : null,
                        reason: n.reason || null,
                        note: n.note || null,
                    }))
            } catch (e) { /* notes are optional */ }

            res.status(200).json({
                range: { from: req.query.from || null, to: req.query.to || null },
                timezone: tz,
                meta: { fingerprint },
                stats,
                patterns,
                daily: computeDailyBreakdown(trades, tz), // per-day P&L: plan target vs reality
                notes,
            })
        } catch (error) {
            console.error(' -> Behavior analysis error', error)
            res.status(500).send({ error: String(error?.message || error) })
        }
    });

    /**********************************************
     * GET /api/analysis/fingerprint?from=&to=
     * Cheap signature of the trade data so the client can reuse a cached
     * analysis until an order changes. Returns { fingerprint: "count:lastUpdate" }.
     **********************************************/
    app.get('/api/analysis/fingerprint', async (req, res) => {
        try {
            const fromUnix = isoToUnix(req.query.from)
            const toUnix = isoToUnix(req.query.to)
            const fp = await fetchTradesFingerprint({ fromUnix, toUnix })
            res.status(200).json({ fingerprint: `${fp.count}:${fp.lastUpdate}` })
        } catch (error) {
            console.error(' -> Fingerprint error', error)
            res.status(500).send({ error: String(error?.message || error) })
        }
    });

    /**********************************************
     * GET /api/analysis/ai-summary?from=&to=&tz=
     * Claude (LLM) reads the same computed stats + behavioral flags and writes a
     * natural-language analysis. Optional: disabled (200 {disabled:true}) when
     * ANTHROPIC_API_KEY isn't set, so the client falls back to its rule-based
     * summary. Returns { summary, fingerprint } on success.
     **********************************************/
    app.get('/api/analysis/ai-summary', async (req, res) => {
        try {
            if (!anthropic) {
                return res.status(200).json({ disabled: true, reason: 'ANTHROPIC_API_KEY is not set on the server' })
            }
            const tz = req.query.tz || process.env.TRADENOTE_TZ || 'UTC'
            const fromUnix = isoToUnix(req.query.from)
            const toUnix = isoToUnix(req.query.to)
            const days = await fetchDayDocs({ fromUnix, toUnix })
            const trades = flattenTrades(days)
            const stats = computeStats(trades, tz)
            const patterns = findBehaviorPatterns(trades, { revengeWindowMinutes: 15, tz, overtradeLotCap: Number(process.env.OVERTRADE_LOT_CAP) || 0.1 })

            const fpCount = days.length
            const fpLastUpdate = days.reduce((m, d) => Math.max(m, d._updated_at ? new Date(d._updated_at).getTime() : 0), 0)
            const fingerprint = `${fpCount}:${fpLastUpdate}`

            if (!stats.trades) {
                return res.status(200).json({ summary: 'No trades in the selected period — nothing to analyze yet.', fingerprint })
            }

            let notes = []
            try {
                const raw = await fetchNotes({ fromUnix, toUnix })
                notes = raw
                    .filter(n => (n.reason && n.reason.trim()) || (n.note && n.note.trim()))
                    .slice(-15).reverse()
                    .map(n => ({ date: n.dateUnix ? new Date(n.dateUnix * 1000).toISOString().slice(0, 10) : null, reason: n.reason || null, note: n.note || null }))
            } catch (e) { /* notes optional */ }

            const payload = { range: { from: req.query.from || null, to: req.query.to || null }, timezone: tz, stats, patterns, notes }
            const system = 'You are a trading-performance coach. Analyze the trader\'s behavior from the computed statistics and behavioral flags provided as JSON. Be concise, specific and actionable, in plain English. Ground every claim in the numbers given — never invent data. Structure the reply as: a one-line verdict; Strengths; Watch-outs (revenge trading, overtrading, position-size tilt, holding-time bias, weak entry hours where relevant); and Recommendations. Use short bullet points. Do not restate the raw JSON.'

            const msg = await anthropic.messages.create({
                model: ANALYSIS_MODEL,
                max_tokens: 16000,
                output_config: { effort: 'medium' },
                system,
                messages: [{ role: 'user', content: `Here is my trading data. Write the behavior analysis.\n\n${JSON.stringify(payload, null, 2)}` }],
            })

            if (msg.stop_reason === 'refusal') {
                return res.status(200).json({ summary: null, refused: true, fingerprint })
            }
            const summary = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
            res.status(200).json({ summary, fingerprint, model: msg.model })
        } catch (error) {
            console.error(' -> AI summary error', error)
            res.status(500).send({ error: String(error?.message || error) })
        }
    });

    /**********************************************
     * CLOUDFLARE R2 IMAGE STORAGE
     **********************************************/
    const bigJson = express.json({ limit: '30mb' })

    // Upload a base64 data URL to R2, return its public URL + object key.
    app.post("/api/uploadImage", bigJson, async (req, res) => {
        if (!r2Enabled) {
            // Let the client know R2 isn't configured so it can fall back to base64
            return res.status(200).send({ disabled: true })
        }
        try {
            const { base64, keyHint } = req.body
            if (!base64 || typeof base64 !== 'string') {
                return res.status(400).send({ error: 'Missing base64' })
            }
            const match = base64.match(/^data:(.+);base64,(.*)$/)
            if (!match) {
                return res.status(400).send({ error: 'Invalid base64 data URL' })
            }
            const contentType = match[1]
            const buffer = Buffer.from(match[2], 'base64')
            const ext = (contentType.split('/')[1] || 'png').split('+')[0]
            const safeHint = (keyHint || 'img').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
            const key = `screenshots/${safeHint}-${randomUUID()}.${ext}`

            await r2Client.send(new PutObjectCommand({
                Bucket: r2Bucket,
                Key: key,
                Body: buffer,
                ContentType: contentType
            }))

            res.status(200).send({ url: `${r2PublicUrl}/${key}`, key })
        } catch (error) {
            console.error("Error uploading to R2:", error.message)
            res.status(500).send({ error: error.message })
        }
    })

    // Delete an object from R2 by key.
    app.post("/api/deleteImage", express.json(), async (req, res) => {
        if (!r2Enabled) return res.status(200).send({ disabled: true })
        try {
            const { key } = req.body
            if (!key) return res.status(400).send({ error: 'Missing key' })
            await r2Client.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: key }))
            res.status(200).send({ ok: true })
        } catch (error) {
            console.error("Error deleting from R2:", error.message)
            res.status(500).send({ error: error.message })
        }
    })

    app.post("/api/updateSchemas", async (req, res) => {

        if (!process.env.STRIPE_SK || process.env.UPSERT_SCHEMA) {
            console.log("\nAPI : post update schema")

            let rawdata = fs.readFileSync('requiredClasses.json');
            let schemasJson = JSON.parse(rawdata);
            //console.log("schemasJson "+JSON.stringify(schemasJson))

            let existingSchema = []
            const getExistingSchema = await ParseNode.Schema.all()
            //console.log(" -> Get existing schema " + JSON.stringify(getExistingSchema))

            /* 1- Rename legacy names in mongoDB */
            const renameMongoDb = (param1, param2) => {
                return new Promise(async (resolve, reject) => {
                    console.log(" -> Renaming class " + param1 + " to " + param2)
                    MongoClient.connect(databaseURI).then(async (client) => {
                        console.log("  --> Connected to MongoDB")
                        const connect = client.db(tradenoteDatabase);
                        const allCollections = await connect.listCollections().toArray()
                        //console.log("allCollections "+JSON.stringify(allCollections))
                        let collectionExists = allCollections.filter(obj => obj.name == param1)
                        //console.log("  --> collectionExists "+collectionExists.length)
                        if (collectionExists.length > 0) {
                            const collection = connect.collection(param1);
                            collection.rename(param2).then(() => {
                                console.log(" -> Renamed class successfully");
                                resolve()
                            })
                        } else {
                            console.log(" -> Collection doesn't exist.")
                            resolve()
                        }

                    }).catch((err) => {
                        console.log(" -> Error renaming MongoDB class: " + err.Message);
                        reject()
                    })
                })
            }

            for (let i = 0; i < getExistingSchema.length; i++) {
                //console.log("Class name " + getExistingSchema[i].className)

                //we check for classes/collections that need to be renamed
                if (getExistingSchema[i].className == "setupsEntries" || getExistingSchema[i].className == "journals") {
                    let oldName = getExistingSchema[i].className
                    let newName

                    if (getExistingSchema[i].className == "setupsEntries") newName = "screenshots"
                    if (getExistingSchema[i].className == "journals") newName = "diaries"
                    if (getExistingSchema[i].className == "patternsMistakes") newName = "setups"

                    await renameMongoDb(oldName, newName)
                } else {
                    existingSchema.push(getExistingSchema[i].className)
                }
            }
            //console.log(" -> Existing Schema " + existingSchema)

            /* 2- Update or save new schemas in mongoDB */
            const updateSaveSchema = (param1, param2, param3) => {
                return new Promise((resolve, reject) => {
                    const mySchema = new ParseNode.Schema(param1);
                    if (param2[param3].type === "String") mySchema.addString(param3)
                    if (param2[param3].type === "Number") mySchema.addNumber(param3)
                    if (param2[param3].type === "Boolean") mySchema.addBoolean(param3)
                    if (param2[param3].type === "Date") mySchema.addDate(param3)
                    if (param2[param3].type === "File") mySchema.addFile(param3)
                    if (param2[param3].type === "GeoPoint") mySchema.addGeoPoint(param3)
                    if (param2[param3].type === "Polygon") mySchema.addPolygon(param3)
                    if (param2[param3].type === "Array") mySchema.addArray(param3)
                    if (param2[param3].type === "Object") mySchema.addObject(param3)
                    if (param2[param3].type === "Pointer") mySchema.addPointer(param3, param2[param3].targetClass)
                    if (param2[param3].type === "Relation") mySchema.addRelation(param3, param2[param3].targetClass)

                    //console.log("existing schema "+existingSchema)
                    //console.log("includes ? "+existingSchema.includes(className))

                    //If ParseNode (existing) schema includes the class name from required classes then update (just in case). Else add, and then add that class to existing schema array
                    if (existingSchema.includes(param1)) {
                        mySchema.update().then((result) => {
                            console.log("  --> Updating field " + param3)
                            //console.log(" -> Updated schema " + JSON.stringify(result))
                            resolve()
                        })
                    } else {
                        mySchema.save().then((result) => {
                            //console.log(" -> Save new schema " + JSON.stringify(result))
                            console.log("  --> Saving field " + param3)
                            existingSchema.push(param1) // Once saved, we update for the rest of the fields, so we need to push to existingSchema
                            //console.log(" -> Existing Schema " + existingSchema)
                            resolve()
                        })
                    }
                })
            }

            for (let i = 0; i < schemasJson.length; i++) {
                //console.log("el " + schemasJson[i].className)
                let className = schemasJson[i].className
                console.log(" -> Upsert class/collection " + className + " in ParseNode Schema")
                let obj = schemasJson[i].fields
                for (const key of Object.keys(obj)) {
                    //console.log(key, obj[key]);
                    if (key != "objectId" && key != "updatedAt" && key != "createdAt" && key != "ACL") {
                        //console.log(" -> Key " + key)
                        await updateSaveSchema(className, obj, key)
                    }

                }
            }

            res.send({ "existingSchema": existingSchema })
        } else {
            res.status(200).send('OK');
        }

    })

    

    
    app.use(express.json({ limit: '30mb' }));

    let allUsers
    const getAllUsers = async () => {
        console.log(" -> Getting all users")
        return new Promise(async (resolve, reject) => {
            const parseObject = ParseNode.Object.extend("_User");
            const query = new ParseNode.Query(parseObject);
            const results = await query.find({ useMasterKey: true });
            allUsers = JSON.parse(JSON.stringify(results))
            resolve()
        })
    }

    const validateApiKey = async (req, res, next) => {
        await getAllUsers()
        const targetKey = req.headers['api-key'] || req.query['api-key'];
        //console.log(" -> target Key " + targetKey)

        const checkIPKey = (allUsers, targetKey) => {
            for (const user of Object.values(allUsers)) {
                if (user.hasOwnProperty("apis")) {
                    const index = user.apis.findIndex(obj => obj.key === targetKey);
                    if (index !== -1) {
                        currentUser.value = user
                        return true;
                    }
                }

            }
            return -1; // Return -1 if not found
        }

        // Usage example
        const hasIPKey = checkIPKey(allUsers, targetKey);

        if (hasIPKey) {
            console.log(" -> Valid api key found :)")
            next();
        } else {
            console.log(" -> Invalid api key")
            return res.status(401).send({ error: 'Invalid API key' });
        }
    }

    app.post('/api/trades', validateApiKey, async (req, res) => {
        const data = req.body;
        try {
            if (data && !data.data.length > 0) {
                res.status(200).send(" -> No trades to import");
            }
            else {

                uploadMfePrices.value = data.uploadMfePrices

                //console.log(" uploadMfePrices "+uploadMfePrices.value)
                // Call the function from addTrades.js

                await useGetTimeZone()
                await useGetExistingTradesArray("api", ParseNode)
                await useImportTrades(data.data, "api", data.selectedBroker, ParseNode)
                await useUploadTrades("api", ParseNode)

                res.status(200).send(" -> Saved Trades to ParseNode DB");
            }
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: 'Error creating executions' });
        }
    });

    /**********************************************
     * ACCOUNT SNAPSHOT (MT5 balance / deposit / withdrawal)
     * The sync posts the live account figures here each run; stored on the user
     * as `mt5Accounts` (array, upserted by login) so the Dashboard can show
     * broker, account number, balance, deposits and withdrawals.
     **********************************************/
    app.post('/api/account', validateApiKey, async (req, res) => {
        try {
            const b = req.body || {}
            const query = new ParseNode.Query(ParseNode.User)
            query.equalTo('objectId', currentUser.value.objectId)
            const user = await query.first({ useMasterKey: true })
            if (!user) return res.status(404).send({ error: 'user not found' })

            let arr = user.get('mt5Accounts')
            if (!Array.isArray(arr)) arr = []
            const rec = {
                login: b.login,
                server: b.server,
                currency: b.currency,
                balance: Number(b.balance) || 0,
                deposit: Number(b.deposit) || 0,
                withdrawal: Number(b.withdrawal) || 0,
                // Dated deposits/withdrawals so the equity curve can drop on the
                // day money left the account (each: {t: unix, amount, type}).
                cashFlows: Array.isArray(b.cashFlows) ? b.cashFlows : [],
                updatedAt: Date.now(),
            }
            const idx = arr.findIndex(a => String(a.login) === String(b.login))
            if (idx >= 0) arr[idx] = rec; else arr.push(rec)
            user.set('mt5Accounts', arr)
            await user.save(null, { useMasterKey: true })
            res.status(200).send({ ok: true })
        } catch (error) {
            console.error('account update error', error.message);
            res.status(500).send({ error: error.message });
        }
    });

    app.post('/api/databento', async (req, res) => {
        //console.log(" calling databento")
        const data = req.body;
        //console.log(" data "+JSON.stringify(data))
        try {
            const username = data.username;
            const password = '';


            let config = {
                method: 'post',
                maxBodyLength: Infinity,
                url: "https://hist.databento.com/v0/timeseries.get_range",
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
                },
                data: data
            };

            let responseBack
            axios.request(config)
                .then((response) => {
                    //console.log("\n -> Resp " + response.data)
                    responseBack = response.data
                    res.status(200).send(responseBack);
                })
                .catch((error) => {
                    console.log(error);
                    res.status(500).send({ error: error });
                });

        } catch (error) {
            console.error(error);
            res.status(500).send({ error: error });
        }
    })
};

/**************************** END APIs ****************************/

const startIndex = async () => {

    const startServer = async () => {
        console.log("\nSTARTING NODEJS SERVER")
        return new Promise(async (resolve, reject) => {
            server = app.listen(port, function () {
                console.log(' -> TradeNote server started on http://localhost:' + port)
            });
            resolve(server)
        })
    }

    const runServer = async () => {
        console.log("\nRUNNING SERVER");
    
        return new Promise(async (resolve, reject) => {
            if (process.env.NODE_ENV == 'dev') {
                // Set up proxy for development environment
                const proxy = new Proxy.createProxyServer({
                    target: { host: 'localhost', port: PROXY_PORT },
                });

                // http-proxy emits 'error' on a failed connection (e.g. the brief window
                // before Vite's own listener is up, or if Vite restarts). An EventEmitter
                // with no 'error' listener throws on that event by default, which crashes
                // this whole process -- Express, Parse Server, the Mongo connection, all of
                // it -- for what should just be "tell the browser to retry". Handle it.
                proxy.on('error', (err, req, res) => {
                    console.error(' -> Vite dev proxy error: ' + err.message)
                    if (res && !res.headersSent && typeof res.writeHead === 'function') {
                        res.writeHead(502, { 'Content-Type': 'text/plain' })
                        res.end('Dev server is starting, please retry in a moment.')
                    }
                });

                // Middleware to handle API routes first (do not pass to Vite)
                app.use('/api/*', (req, res, next) => {
                    // Handle API routes here
                    //console.log("Handling API route:", req.url);
                    next(); // Continue processing the request for /api/* routes
                });
    
                // Set up API routes for dev mode as well
                setupApiRoutes(app);
    
                // Proxy all other routes (non-API) to Vite
                app.use((req, res, next) => {
                    if (req.url.startsWith('/api/')) {
                        return next(); // Let the /api/* routes be handled by the previous middleware
                    }
                    proxy.web(req, res); // Proxy all other routes to Vite
                });
    
                // Start Vite dev server.
                // usePolling is required for HMR to work through a Docker bind mount on
                // Windows/WSL2, where native file-change events don't propagate.
                const vite = await Vite.createServer({
                    server: {
                        port: PROXY_PORT,
                        watch: { usePolling: true, interval: 300 }
                    }
                });
                vite.listen();
                // Proxy websocket upgrades (Vite HMR) so the browser hot-reloads on edits
                if (server) {
                    server.on('upgrade', (req, socket, head) => {
                        if (!req.url.startsWith('/api/') && !req.url.startsWith('/parse')) {
                            proxy.ws(req, socket, head);
                        }
                    });
                }
                console.log(" -> Running vite dev server");
                resolve();
            } else {
                // In production, handle API routes normally
                app.use('/api/*', express.json(), (req, res, next) => {
                    //console.log(`Received API request: ${req.method} ${req.url}`);
                    next(); // Pass control to specific API handlers
                });
    
                // Set up API routes for production
                setupApiRoutes(app);
    
                // Everything under /assets is content-hashed by Vite (e.g.
                // vendor-echarts-Ch0r4Mt-.js), so a given URL's bytes can never
                // change -- a new build emits a new filename. Serve it immutable
                // for a year. Without this express.static defaults to max-age=0,
                // which makes the browser revalidate the whole ~800KB payload on
                // every navigation; since this app full-reloads the document on
                // each nav, that was a round-trip per asset, every single time.
                app.use('/assets', express.static(path.resolve('dist', 'assets'), {
                    immutable: true,
                    maxAge: '1y',
                }));

                // Everything else in dist (favicon, etc.) with default caching.
                app.use(express.static('dist'));

                // Fallback for SPA. index.html must NOT be cached: it is the only
                // file whose name is stable, and it is what points at the newest
                // hashed asset names -- caching it would pin the browser to an old
                // build's assets after a rebuild.
                app.get('*', (req, res) => {
                    res.setHeader('Cache-Control', 'no-cache');
                    res.sendFile(path.resolve('dist', 'index.html'));
                });
                console.log(" -> Running prod server");
                resolve();
            }
        });
    };
    

    const setupParseServer = async () => {
        console.log("\nSTARTING PARSE SERVER")
        return new Promise(async (resolve, reject) => {
            const serv = new ParseServer({
                databaseURI: databaseURI,
                appId: process.env.APP_ID,
                masterKey: process.env.MASTER_KEY,
                port: port,
                masterKeyIps: ['0.0.0.0/0', '::/0'],
                allowClientClassCreation: false,
                allowExpiredAuthDataToken: false
            });

            // EXPRESS USE
            await serv.start().then(() => {
                app.use('/parse', serv.app);
                console.log(" -> ParseNode server started")
                resolve()
            })
        })
    }

    await startServer()
    await setupParseServer()
    await runServer()

    /*var parseDashboard = new ParseDashboard({
        "apps": [{
            "serverURL": "/parse",
            "appId": process.env.APP_ID,
            "masterKey": process.env.MASTER_KEY,
            "appName": "TradeNote"
        }],
        "trustProxy": true
    });*/



    if (process.env.PARSE_DASHBOARD) app.use('/parseDashboard', parseDashboard)

    //INIT
    //console.log("\nInitializing ParseNode")
    ParseNode.initialize(process.env.APP_ID)
    ParseNode.serverURL = "http://localhost:" + port + "/parse"
    ParseNode.masterKey = process.env.MASTER_KEY

    await seedLoginUser()
}

/**
 * Single-user convenience: keep one login in sync with TRADENOTE_USER /
 * TRADENOTE_PASSWORD from the environment. Creates the account on first boot;
 * on later boots, only resets the password if it actually changed in .env.
 * Skipped entirely when either variable is unset.
 *
 * Parse Server's revokeSessionOnPasswordReset defaults to true — resetting the
 * password revokes every existing session for that user. Doing that on every
 * boot (even when the password hadn't changed) logged out any already-open
 * browser tab out from under itself on each restart, which showed up as every
 * page hanging on "Invalid session token". Logging in first to check whether
 * the current password still works avoids the needless reset.
 *
 * Never throws: a seeding problem must not stop the server from starting.
 */
async function seedLoginUser() {
    const username = (process.env.TRADENOTE_USER || '').trim()
    const password = process.env.TRADENOTE_PASSWORD || ''
    if (!username || !password) return

    console.log("\nSEEDING LOGIN USER")
    try {
        const query = new ParseNode.Query(ParseNode.User)
        query.equalTo("username", username)
        const existing = await query.first({ useMasterKey: true })

        if (!existing) {
            const user = new ParseNode.User()
            user.set("username", username)
            user.set("email", username.includes('@') ? username : `${username}@tradenote.local`)
            user.set("password", password)
            await user.signUp(null, { useMasterKey: true })
            console.log(` -> Created user ${username}`)
            return
        }

        try {
            await ParseNode.User.logIn(username, password)
            console.log(` -> Password for ${username} unchanged, leaving existing sessions intact`)
        } catch (loginError) {
            existing.set("password", password)
            await existing.save(null, { useMasterKey: true })
            console.log(` -> Password for ${username} changed in .env, reset (existing sessions revoked)`)
        }
    } catch (e) {
        console.log(` -> Could not seed login user: ${e.message}`)
    }
}

startIndex()
