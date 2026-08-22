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
import { fetchDayDocs, fetchNotes, fetchTradesFingerprint, fetchDiaries, fetchEntryReviews } from './mcp-server/db.mjs';
import Anthropic from '@anthropic-ai/sdk';
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import dayjsTimezone from 'dayjs/plugin/timezone.js';
dayjs.extend(dayjsUtc); dayjs.extend(dayjsTimezone);
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

    // Defined FIRST: Express evaluates middleware references when a route is
    // REGISTERED, not when it is called, so a const declared further down the
    // function is still in its temporal dead zone for every route above it
    // ("Cannot access 'requireAuth' before initialization" at boot).
    /**
     * Gate for the endpoints that hand out real account data: open positions,
     * balances, the daily P&L breakdown, the journal notes. They had no auth at
     * all, which is survivable on a LAN and unacceptable the moment this is
     * hosted -- anyone with the URL could read the whole journal.
     *
     * Accepts EITHER credential, because two very different callers use these:
     *   - the MT5 host agents, which already carry an `api-key`
     *   - the browser, which has a Parse session from logging in
     *
     * EventSource cannot set request headers, so the SSE stream also accepts the
     * session token as a query parameter. It is the same bearer secret either
     * way; hosting terminates TLS, which is what keeps it off the wire.
     */
    const requireAuth = async (req, res, next) => {
        if (req.headers['api-key'] || req.query['api-key']) {
            return validateApiKey(req, res, next)
        }
        const token = req.headers['x-parse-session-token'] || req.query.session
        if (token) {
            try {
                const q = new ParseNode.Query(ParseNode.Session)
                q.equalTo('sessionToken', token)
                q.include('user')
                const session = await q.first({ useMasterKey: true })
                if (session) {
                    const user = session.get('user')
                    // Downstream handlers read currentUser (fetchNotes scopes its
                    // query by it), so it has to be populated here as well.
                    if (user) {
                        currentUser.value = JSON.parse(JSON.stringify(user))
                        // Scope data reads to whoever actually logged in, rather
                        // than to TRADENOTE_USER (see getUserFilter in db.mjs).
                        req.tradenoteUserId = user.id
                    }
                    return next()
                }
            } catch (e) {
                console.log(` -> session lookup failed: ${e.message}`)
            }
        }
        return res.status(401).send({ error: 'unauthorized' })
    }


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
     * TRADING-BEHAVIOR ANALYSIS (deterministic; reuses mcp-server/analysis.mjs)
     * GET /api/analysis/behavior?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Asia/Bangkok
     **********************************************/
    /* A bare YYYY-MM-DD must be read as midnight in the TRADE timezone, because
     * that is what a day document's dateUnix is (see CLAUDE.md: day docs bucket by
     * trade tz, not UTC). Parsing it as UTC midnight shifted every boundary by the
     * tz offset -- 7 hours for Asia/Bangkok -- so `from` landed 7 hours after the
     * day actually started and excluded that whole day. Single-day ranges returned
     * nothing at all; wider ranges silently dropped their first day. */
    const isoToUnix = (s, tz = 'UTC') => {
        if (!s) return undefined
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            const d = dayjs.tz(s, tz)
            return d.isValid() ? d.unix() : undefined
        }
        const ms = Date.parse(s)
        return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
    }

    /* LLM analysis is optional and provider-agnostic.
     *
     * Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or both. With both present,
     * AI_PROVIDER (anthropic|gemini) picks the winner; otherwise whichever key
     * exists is used. No key at all leaves the feature disabled and the client
     * keeps its free rule-based summary.
     *
     * Gemini goes over plain REST rather than @google/genai on purpose: axios is
     * already a dependency, and adding one means rebuilding the image AND
     * recreating the container's anonymous node_modules volume, which is a known
     * footgun in this project (see start.sh's ERR_MODULE_NOT_FOUND recovery).
     */
    const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
    const geminiKey = process.env.GEMINI_API_KEY || null

    const AI_PROVIDER = (() => {
        const want = (process.env.AI_PROVIDER || '').toLowerCase()
        if (want === 'anthropic') return anthropic ? 'anthropic' : null
        if (want === 'gemini') return geminiKey ? 'gemini' : null
        if (anthropic) return 'anthropic'
        if (geminiKey) return 'gemini'
        return null
    })()

    // Default model per provider; ANALYSIS_MODEL overrides either.
    // Gemini defaults to the cheapest tier (flash-lite), and to the floating
    // "-latest" alias rather than a pinned version: Google retires pinned models
    // for new keys ("no longer available to new users"), which is exactly how a
    // hard-coded gemini-2.5-flash broke here. The alias tracks the current model.
    const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL
        || (AI_PROVIDER === 'gemini' ? 'gemini-flash-lite-latest' : 'claude-opus-5')

    if (AI_PROVIDER) {
        console.log(`\nAI ANALYSIS enabled -> ${AI_PROVIDER} (${ANALYSIS_MODEL})`)
    } else {
        console.log("\nAI ANALYSIS not configured -> set ANTHROPIC_API_KEY or GEMINI_API_KEY (rule-based summary still works)")
    }

    /**
     * One call, whichever provider is configured. Returns
     * { summary, model, refused } so the route stays provider-agnostic.
     */
    const runAnalysisModel = async (system, userText) => {
        if (AI_PROVIDER === 'anthropic') {
            const msg = await anthropic.messages.create({
                model: ANALYSIS_MODEL,
                max_tokens: 16000,
                output_config: { effort: 'medium' },
                system,
                messages: [{ role: 'user', content: userText }],
            })
            if (msg.stop_reason === 'refusal') return { summary: null, refused: true, model: msg.model }
            const summary = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
            return { summary, model: msg.model }
        }

        // Gemini: the system prompt is its own top-level field, not a message.
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ANALYSIS_MODEL)}:generateContent`
        const { data } = await axios.post(url, {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: { maxOutputTokens: 8192, temperature: 0.4 },
        }, {
            headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
            timeout: 120000,
        })
        const cand = (data.candidates || [])[0]
        // SAFETY / RECITATION means the model declined; surface it the same way a
        // Claude refusal is surfaced instead of returning a confusing empty string.
        if (cand && cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
            return { summary: null, refused: true, model: ANALYSIS_MODEL }
        }
        const summary = ((cand && cand.content && cand.content.parts) || [])
            .map(p => p.text).filter(Boolean).join('\n').trim()
        return { summary, model: ANALYSIS_MODEL }
    }

    /**
     * Split the journal into the two things it actually contains, because they
     * are different evidence and get used differently:
     *
     *   notes          per-day / per-trade commentary -- what it felt like AT the
     *                  time, written in the heat of it.
     *   weeklyReviews  the week summary plus the reflection written afterwards --
     *                  what the trader concluded once the week was over.
     *
     * Previously everything was flattened into one list keyed only by date, with
     * `tradeId` dropped, so a weekly review was indistinguishable from a passing
     * remark about a single trade -- and the reflection was never fetched at all.
     * Worse, the combined list was truncated to the last 15 entries, so day notes
     * could push the weekly reviews out entirely.
     */
    const shapeJournal = (raw, tz, limit = 15) => {
        const dateOf = (n) => (n.dateUnix
            ? new Date(n.dateUnix * 1000).toLocaleDateString('en-CA', { timeZone: tz })
            : null)
        const hasText = (v) => !!(v && String(v).trim())

        const weeklyReviews = raw
            .filter((n) => n.tradeId === 'week' && (hasText(n.note) || hasText(n.reflection)))
            .sort((a, b) => (b.dateUnix || 0) - (a.dateUnix || 0))
            .slice(0, limit)
            .map((n) => ({
                weekStarting: dateOf(n),
                summary: n.note || null,
                reflection: n.reflection || null,
                // Whether the trader actually closed the loop on that week.
                reviewed: !!n.checkRead,
                reflectionWritten: !!n.checkReflected,
            }))

        const notes = raw
            .filter((n) => n.tradeId !== 'week' && (hasText(n.note) || hasText(n.reason)))
            .slice(-limit)
            .reverse()
            .map((n) => ({
                date: dateOf(n),
                scope: n.tradeId === 'day' ? 'day' : 'trade',
                reason: n.reason || null,
                note: n.note || null,
            }))

        return { notes, weeklyReviews }
    }

    /* Diary entries, as plain text.
     *
     * Stored as Quill HTML. Handed to a model verbatim, the tags are noise it has
     * to spend attention parsing, and <br>/</p> boundaries carry the line breaks
     * that make a diary readable -- so those become newlines rather than being
     * stripped to a single run-on paragraph. */
    const htmlToText = (html) => String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

    const shapeDiaries = (raw, tz, limit = 15) => raw
        .filter((d) => htmlToText(d.diary))
        .sort((a, b) => (b.dateUnix || 0) - (a.dateUnix || 0))
        .slice(0, limit)
        .map((d) => ({
            date: d.dateUnix ? new Date(d.dateUnix * 1000).toLocaleDateString('en-CA', { timeZone: tz }) : null,
            entry: htmlToText(d.diary),
        }))

    /* Entry reviews, trimmed to what a coach would actually use.
     *
     * Deliberately not the raw rows: prices and pip distances are already in the
     * trade statistics, and repeating them here would spend context re-stating
     * numbers the model has. What is unique to this record is the trader's own
     * judgement at the moment of entry, so that is what survives. */
    const shapeEntryReviews = (raw, tz, limit = 40) => raw
        .sort((a, b) => (b.dateUnix || 0) - (a.dateUnix || 0))
        .slice(0, limit)
        .map((r) => ({
            date: r.dateUnix ? new Date(r.dateUnix * 1000).toLocaleDateString('en-CA', { timeZone: tz }) : null,
            symbol: r.symbol || null,
            side: r.side || null,
            lot: r.lot ?? null,
            hasStopLoss: !!r.hasSl,
            hasTakeProfit: !!r.hasTp,
            stopsAcceptable: !!r.tpSlAcceptable,
            positionQuality: r.positionQuality || null,
            oversized: !!r.oversized,
            logicStillValid: !!r.logicValid,
            emotion: r.entryEmotion || null,
            // 1 = no urge, 10 = desperate to win it back.
            revengeUrge: r.revengeScore ?? null,
            reasoning: r.entryReasoning || null,
        }))

    app.get('/api/analysis/behavior', requireAuth, async (req, res) => {
        try {
            const tz = req.query.tz || process.env.TRADENOTE_TZ || 'UTC'
            const fromUnix = isoToUnix(req.query.from, tz)
            const toUnix = isoToUnix(req.query.to, tz)
            const days = await fetchDayDocs({ fromUnix, toUnix, userId: req.tradenoteUserId })
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
            let weeklyReviews = []
            try {
                const raw = await fetchNotes({ fromUnix, toUnix, userId: req.tradenoteUserId })
                const shaped = shapeJournal(raw, tz)
                notes = shaped.notes
                weeklyReviews = shaped.weeklyReviews
            } catch (e) { /* notes are optional */ }

            let diaries = []
            let entryReviews = []
            try {
                diaries = shapeDiaries(await fetchDiaries({ fromUnix, toUnix, userId: req.tradenoteUserId }), tz)
            } catch (e) { /* the diaries collection may not exist yet */ }
            try {
                entryReviews = shapeEntryReviews(await fetchEntryReviews({ fromUnix, toUnix, userId: req.tradenoteUserId }), tz)
            } catch (e) { /* optional, same */ }

            res.status(200).json({
                range: { from: req.query.from || null, to: req.query.to || null },
                timezone: tz,
                meta: { fingerprint },
                stats,
                patterns,
                daily: computeDailyBreakdown(trades, tz), // per-day P&L: plan target vs reality
                notes,
                weeklyReviews,
                diaries,
                entryReviews,
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
    app.get('/api/analysis/fingerprint', requireAuth, async (req, res) => {
        try {
            // Same tz resolution as the analysis routes, or the fingerprint would
            // cover a different set of days than the result it is meant to guard,
            // and the cache would go stale (or refresh) at the wrong moments.
            const tz = req.query.tz || process.env.TRADENOTE_TZ || 'UTC'
            const fromUnix = isoToUnix(req.query.from, tz)
            const toUnix = isoToUnix(req.query.to, tz)
            const fp = await fetchTradesFingerprint({ fromUnix, toUnix, userId: req.tradenoteUserId })
            res.status(200).json({ fingerprint: `${fp.count}:${fp.lastUpdate}` })
        } catch (error) {
            console.error(' -> Fingerprint error', error)
            res.status(500).send({ error: String(error?.message || error) })
        }
    });

    /**********************************************
     * GET /api/analysis/ai-summary?from=&to=&tz=
     * The configured LLM (Claude or Gemini) reads the same computed stats +
     * behavioral flags and writes a
     * natural-language analysis. Optional: disabled (200 {disabled:true}) when
     * no provider key is set, so the client falls back to its rule-based summary.
     * Returns { summary, fingerprint, model, provider } on success.
     **********************************************/
    app.get('/api/analysis/ai-summary', requireAuth, async (req, res) => {
        try {
            if (!AI_PROVIDER) {
                // An explicit AI_PROVIDER whose key is missing is reported as
                // exactly that, rather than "no key" -- otherwise the one case
                // where a key IS present reads as though none were.
                const want = (process.env.AI_PROVIDER || '').toLowerCase()
                const reason = want
                    ? `AI_PROVIDER=${want} but its key is not set on the server`
                    : 'No AI key on the server — set ANTHROPIC_API_KEY or GEMINI_API_KEY'
                return res.status(200).json({ disabled: true, reason })
            }
            const tz = req.query.tz || process.env.TRADENOTE_TZ || 'UTC'
            const fromUnix = isoToUnix(req.query.from, tz)
            const toUnix = isoToUnix(req.query.to, tz)
            const days = await fetchDayDocs({ fromUnix, toUnix, userId: req.tradenoteUserId })
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
            let weeklyReviews = []
            try {
                const raw = await fetchNotes({ fromUnix, toUnix, userId: req.tradenoteUserId })
                // Dates are formatted in the TRADE timezone, not UTC: toISOString()
                // would label a Bangkok-evening note with the previous day, so the
                // model would tie a reflection to the wrong trading day.
                const shaped = shapeJournal(raw, tz)
                notes = shaped.notes
                weeklyReviews = shaped.weeklyReviews
            } catch (e) { /* notes optional */ }

            let diaries = []
            let entryReviews = []
            try {
                diaries = shapeDiaries(await fetchDiaries({ fromUnix, toUnix, userId: req.tradenoteUserId }), tz)
            } catch (e) { /* the diaries collection may not exist yet */ }
            try {
                entryReviews = shapeEntryReviews(await fetchEntryReviews({ fromUnix, toUnix, userId: req.tradenoteUserId }), tz)
            } catch (e) { /* optional, same */ }

            const payload = { range: { from: req.query.from || null, to: req.query.to || null }, timezone: tz, stats, patterns, notes, weeklyReviews, diaries, entryReviews }
            // Plain text, not Markdown: the card renders this with white-space
            // pre-wrap and no Markdown parser, so asterisks would show literally
            // (they did). Notes are called out explicitly -- they were already in
            // the payload but nothing told the model to use them.
            const system = [
                'You are a trading-performance coach. Analyse the trader\'s behaviour from the JSON provided:',
                'computed statistics, behavioural flags, the trader\'s own journal notes, and their weekly reviews.',
                '',
                'Ground every claim in the numbers or the notes given. Never invent data. Be concise, specific and actionable.',
                'Where the notes describe how a day felt, connect that to what the numbers actually did -- agreement and',
                'contradiction are both worth saying out loud.',
                '',
                'weeklyReviews carries, per week: `summary` (what the trader recorded about that week) and `reflection`',
                '(what they concluded afterwards). Treat these as the trader\'s own stated intentions, and check them against',
                'the following weeks\' numbers: a lesson written down but not reflected in later behaviour is the single most',
                'useful thing you can point out. Say plainly which resolutions were kept and which were not.',
                'reflectionWritten=false means a week was never reviewed at all -- worth naming if it is a pattern.',
                'notes carries `scope`: "day" is a whole-day entry, "trade" is about one position.',
                '',
                'diaries are the trader\'s long-form write-ups for a day, in their own words and often not in English.',
                'Read them for intent and state of mind, and answer in English regardless of what language they are in.',
                '',
                'entryReviews is the strongest evidence here, because unlike everything else it was recorded AT THE',
                'MOMENT OF ENTRY rather than afterwards, so it is not coloured by knowing how the trade turned out.',
                'Per entry: whether a stop and target were set, whether the trader judged the stops acceptable, whether',
                'they called the position good or bad, whether they judged it oversized, whether the logic still held,',
                'the emotion felt, revengeUrge from 1 (no urge) to 10 (desperate to win it back), and their reasoning.',
                'Use it to separate bad luck from bad process: an entry the trader themselves marked "bad position" or',
                'oversized, or took at a high revengeUrge, is a decision problem no matter what the P&L did. Losses on',
                'entries they judged good are a different problem entirely, and should not be lumped in with them.',
                'Where their own self-assessment disagrees with the outcome in either direction, say so.',
                '',
                'FORMAT: plain text only. No Markdown. Do not use asterisks, underscores, backticks or hash marks anywhere.',
                'Reply using EXACTLY this skeleton, keeping all four headings, each alone on its line, spelled exactly:',
                '',
                'Verdict',
                '<one sentence>',
                '',
                'Strengths',
                '- <point>',
                '- <point>',
                '',
                'Watch-outs',
                '- <point>',
                '- <point>',
                '',
                'Recommendations',
                '- <point>',
                '- <point>',
                '',
                'Every bullet must sit under one of those headings. Do not merge the sections into a single list.',
                'Cover revenge trading, overtrading, position-size tilt, holding-time bias and weak entry hours where the data supports it.',
                'Do not restate the raw JSON.',
                ].join('\n')

            const userText = `Here is my trading data. Write the behavior analysis.\n\n${JSON.stringify(payload, null, 2)}`
            const out = await runAnalysisModel(system, userText)
            if (out.refused) {
                return res.status(200).json({ summary: null, refused: true, fingerprint })
            }
            res.status(200).json({ summary: out.summary, fingerprint, model: out.model, provider: AI_PROVIDER })
        } catch (error) {
            // Providers put the useful part in the response body; the bare axios
            // message ("Request failed with status code 400") says nothing about
            // an invalid key, which is the most likely cause here.
            const apiMsg = error?.response?.data?.error?.message
                || error?.response?.data?.error
                || error?.error?.message
            const status = error?.response?.status || error?.status
            let msg = String(apiMsg || error?.message || error)
            if (status === 400 || status === 401 || status === 403) {
                msg += ` (${AI_PROVIDER} rejected the request — check the API key`
                    + (AI_PROVIDER === 'gemini' ? '; Gemini keys from aistudio.google.com start with "AIza"' : '')
                    + ')'
            }
            console.error(' -> AI summary error', status || '', msg)
            res.status(500).send({ error: msg })
        }
    });

    /**********************************************
     * POST /api/analysis/week-reflection  { weekStart, tz }
     * Diary's week card: checks the reflection the trader actually wrote for
     * ONE week against that week's own numbers, and PERSISTS the verdict onto
     * that week's `notes` record (aiAnalysis / aiAnalysisAt) so it survives a
     * reload instead of being re-run every time the card is opened.
     * weekStart is the ISO-week start (Monday) in unix seconds, trade tz --
     * the same value Diary.vue already computes via weekStartOf().
     **********************************************/
    app.post('/api/analysis/week-reflection', requireAuth, async (req, res) => {
        try {
            if (!AI_PROVIDER) {
                const want = (process.env.AI_PROVIDER || '').toLowerCase()
                const reason = want
                    ? `AI_PROVIDER=${want} but its key is not set on the server`
                    : 'No AI key on the server — set ANTHROPIC_API_KEY or GEMINI_API_KEY'
                return res.status(200).json({ disabled: true, reason })
            }
            const weekStart = Number(req.body.weekStart)
            if (!Number.isFinite(weekStart)) {
                return res.status(400).send({ error: 'weekStart (unix seconds) is required' })
            }
            const tz = req.body.tz || process.env.TRADENOTE_TZ || 'UTC'
            const weekEnd = weekStart + 7 * 86400

            // The week's own note is both the source of the reflection and the
            // record the verdict gets written back onto -- fetch it with the
            // master key since this route only has the session's user id, not a
            // browser-side Parse.User.current() session to query as.
            const noteQuery = new ParseNode.Query(ParseNode.Object.extend('notes'))
            noteQuery.equalTo('user', { __type: 'Pointer', className: '_User', objectId: currentUser.value.objectId })
            noteQuery.equalTo('tradeId', 'week')
            noteQuery.equalTo('dateUnix', weekStart)
            const weekNote = await noteQuery.first({ useMasterKey: true })
            const reflection = ((weekNote && weekNote.get('reflection')) || '').trim()
            if (!reflection) {
                return res.status(400).send({ error: 'Write a reflection for this week before analyzing it.' })
            }

            const days = await fetchDayDocs({ fromUnix: weekStart, toUnix: weekEnd, userId: req.tradenoteUserId })
            const trades = flattenTrades(days)
            const stats = computeStats(trades, tz)
            const patterns = findBehaviorPatterns(trades, { revengeWindowMinutes: 15, tz, overtradeLotCap: Number(process.env.OVERTRADE_LOT_CAP) || 0.1 })

            if (!stats.trades) {
                return res.status(200).json({ summary: 'No trades landed this week — nothing to check the reflection against.' })
            }

            const weekStarting = new Date(weekStart * 1000).toLocaleDateString('en-CA', { timeZone: tz })
            const payload = { weekStarting, stats, patterns, reflection, summary: (weekNote.get('note') || null) }

            const system = [
                'You are a trading-performance coach reviewing ONE week for a trader you already coach.',
                'You are given that week\'s computed statistics, behavioural flags, and the reflection the trader wrote',
                'about it afterwards ("reflection" in the JSON -- their own words, written after the week closed).',
                '',
                'Your job is to check the reflection against what the numbers actually show. Ground every claim in the',
                'numbers given, never invent data, and say plainly where the reflection holds up and where it does not --',
                'a reflection that ignores or contradicts what the data shows is the single most useful thing to call out.',
                'Be concise, specific and direct.',
                '',
                'FORMAT: plain text only. No Markdown. Do not use asterisks, underscores, backticks or hash marks anywhere.',
                'Reply using EXACTLY this skeleton, keeping all three headings, each alone on its line, spelled exactly:',
                '',
                'Verdict',
                '<one or two sentences on how well the reflection matches reality>',
                '',
                'What the reflection got right',
                '- <point>',
                '',
                'What it missed',
                '- <point>',
                '- <point>',
                '',
                'Every bullet must sit under one of those headings. Do not restate the raw JSON.',
            ].join('\n')
            const userText = `Here is one week of my trading data and the reflection I wrote about it afterwards. Check it against reality.\n\n${JSON.stringify(payload, null, 2)}`

            const out = await runAnalysisModel(system, userText)
            if (out.refused || !out.summary) {
                return res.status(200).json({ summary: null, refused: true })
            }

            weekNote.set('aiAnalysis', out.summary)
            weekNote.set('aiAnalysisAt', new Date())
            await weekNote.save(null, { useMasterKey: true })

            res.status(200).json({ summary: out.summary, analyzedAt: weekNote.get('aiAnalysisAt'), model: out.model, provider: AI_PROVIDER })
        } catch (error) {
            const apiMsg = error?.response?.data?.error?.message
                || error?.response?.data?.error
                || error?.error?.message
            const status = error?.response?.status || error?.status
            let msg = String(apiMsg || error?.message || error)
            if (status === 400 || status === 401 || status === 403) {
                msg += ` (${AI_PROVIDER} rejected the request — check the API key`
                    + (AI_PROVIDER === 'gemini' ? '; Gemini keys from aistudio.google.com start with "AIza"' : '')
                    + ')'
            }
            console.error(' -> Week reflection analysis error', status || '', msg)
            res.status(500).send({ error: msg })
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

    /* Result of the last successful schema provisioning in THIS process.
     *
     * The login page calls /api/updateSchemas before every sign-in, and it walks
     * all 13 classes and every one of their fields -- 218 round trips. Against a
     * Mongo container next door that was invisible; against Atlas each hop costs
     * ~50ms, so signing in stalled for ~15 seconds redoing work the server had
     * already done at boot.
     *
     * Cached per process rather than persisted, deliberately: a deploy that
     * changes requiredClasses.json starts a new process, so the next login
     * provisions the new fields exactly as before. SCHEMA_CACHE=off forces
     * every call through.
     */
    let schemaCache = null

    app.post("/api/updateSchemas", async (req, res) => {
        if (schemaCache && String(process.env.SCHEMA_CACHE || '').toLowerCase() !== 'off') {
            return res.send(schemaCache)
        }


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

            schemaCache = { "existingSchema": existingSchema }
            res.send(schemaCache)
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

                // Tell every open page the journal moved, so they re-fetch now
                // instead of on their next timer tick.
                bumpJournal('trades imported')

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
    /**********************************************
     * LIVE MT5 STATE (open positions / equity)
     *
     * Deliberately IN-MEMORY ONLY -- never written to MongoDB. This is a tick-rate
     * feed (~1/s): persisting it would add millions of rows a week to describe a
     * state that is worthless one second later, and the durable record of what
     * happened is already the per-minute journal sync. If the process restarts the
     * feed simply repopulates on the agent's next push.
     *
     * The MetaTrader5 Python package binds to the terminal's DLL, so it only runs
     * on the Windows host -- never inside this container. mt5-sync/mt5_live.py is
     * that host agent; it POSTs here and the browser reads the result over SSE, so
     * a phone on the same network sees the same feed without touching MT5 itself.
     **********************************************/
    let liveSnapshot = null            // newest payload from the host agent
    const liveClients = new Set()      // connected SSE responses

    const liveIsStale = () => !liveSnapshot || (Date.now() - liveSnapshot.receivedAt) > 15000

    /* Journal change notifications ride the SAME stream as the live snapshot, as a
       NAMED SSE event -- one connection per browser serves both, and Live.vue's
       unnamed `onmessage` handler never sees these.
       Why push at all: the journal pages used to poll on a 60s timer (and most
       pages never refreshed at all), so a trade could sit invisible for a minute
       after it was already in the database. Pages now re-fetch the moment the
       version moves, which is as soon as the sync finishes writing. */
    let journalVersion = 0
    let journalUpdatedAt = null

    const sendEvent = (client, name, payload) => {
        try {
            client.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
            if (typeof client.flush === 'function') client.flush()
        } catch { /* dropped on 'close' */ }
    }

    const bumpJournal = (reason) => {
        journalVersion += 1
        journalUpdatedAt = Date.now()
        const payload = { version: journalVersion, updatedAt: journalUpdatedAt, reason: reason || null }
        for (const client of liveClients) sendEvent(client, 'journal', payload)
        console.log(` -> Journal v${journalVersion} (${reason || 'changed'}) -> ${liveClients.size} listener(s)`)
    }

    // Polling fallback for anything that cannot hold an EventSource open.
    app.get('/api/journal/version', requireAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        res.send({ version: journalVersion, updatedAt: journalUpdatedAt })
    })

    /**********************************************
     * CONNECTIONS STATUS (Settings page)
     *
     * Reports what this server is wired to -- MT5 live feed, database, R2 -- so
     * the Settings page can answer "is it connected?" without anyone SSHing in to
     * read .env.
     *
     * READ-ONLY, and every secret is reduced to a boolean or a redacted host.
     * The Mongo URI is never returned as-is: it carries the database password,
     * which has no business reaching a browser, and anything sent here would also
     * land in the R2 database backups.
     *
     * Configuration stays in .env on purpose. Writing these from the UI would mean
     * storing those same credentials in MongoDB (readable back by the logged-in
     * user, and copied into every backup), which is strictly worse than a file on
     * the host that never leaves it.
     **********************************************/
    const redactMongoHost = (uri) => {
        if (!uri) return null
        try {
            // Strip any user:pass@ before parsing, then keep only the host.
            const noCreds = uri.replace(/\/\/[^@/]*@/, '//')
            const m = noCreds.match(/^mongodb(\+srv)?:\/\/([^/?]+)/i)
            return m ? m[2] : null
        } catch { return null }
    }

    app.get('/api/connections', requireAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        const mongoHost = redactMongoHost(databaseURI)
        const snap = liveSnapshot
        res.send({
            mt5: {
                // In local mode the proof of life is the host agent's last POST.
                liveFeed: snap
                    ? { connected: !liveIsStale(), ageSeconds: Math.floor((Date.now() - snap.receivedAt) / 1000), positions: snap.positions.length, login: snap.login }
                    : { connected: false, ageSeconds: null, positions: 0, login: null },
            },
            database: {
                host: mongoHost,
                name: tradenoteDatabase,
                // mongodb+srv:// is what Atlas hands out; a bare host:port is local.
                isAtlas: !!(databaseURI && /mongodb\+srv:\/\//i.test(databaseURI)),
            },
            storage: { r2Enabled, publicUrl: r2PublicUrl || null },
            journal: { version: journalVersion, updatedAt: journalUpdatedAt },
        })
    })

    const applyLiveSnapshot = (b) => {
        liveSnapshot = {
            login: b.login ?? null,
            currency: b.currency ?? 'USD',
            balance: Number(b.balance) || 0,
            equity: Number(b.equity) || 0,
            profit: Number(b.profit) || 0,      // floating P&L of open positions
            margin: Number(b.margin) || 0,
            marginFree: Number(b.marginFree) || 0,
            positions: Array.isArray(b.positions) ? b.positions : [],
            ticks: b.ticks && typeof b.ticks === 'object' ? b.ticks : {},
            agentTime: Number(b.t) || null,
            receivedAt: Date.now(),
        }
        const frame = `data: ${JSON.stringify(liveSnapshot)}\n\n`
        for (const client of liveClients) {
            try {
                client.write(frame)
                // compression() buffers by default, which would hold SSE frames
                // until the buffer fills -- flush so each tick leaves immediately.
                if (typeof client.flush === 'function') client.flush()
            } catch { /* dropped below on 'close' */ }
        }
    }

    app.post('/api/live', validateApiKey, (req, res) => {
        applyLiveSnapshot(req.body || {})
        res.send({ ok: true, clients: liveClients.size })
    })

    // Plain snapshot, for a first paint before the stream delivers its first frame
    // (and as a fallback anywhere EventSource is unavailable).
    app.get('/api/live', requireAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        res.send({ stale: liveIsStale(), snapshot: liveSnapshot })
    })

    app.get('/api/live/stream', requireAuth, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()

        liveClients.add(res)
        if (liveSnapshot) res.write(`data: ${JSON.stringify(liveSnapshot)}\n\n`)
        // Baseline so a page that connects late can tell whether it missed a bump
        // while it was away (tab backgrounded, laptop asleep, brief disconnect).
        sendEvent(res, 'journal', { version: journalVersion, updatedAt: journalUpdatedAt, reason: 'hello' })

        // Comment frames keep proxies and idle-socket timeouts from closing a quiet
        // stream (a closed market pushes nothing for hours).
        const beat = setInterval(() => {
            try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush() } catch { /* closing */ }
        }, 20000)

        req.on('close', () => {
            clearInterval(beat)
            liveClients.delete(res)
        })
    })

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

    console.log(`\nMT5 SOURCE: local (host agents push to /api/live)`)
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
