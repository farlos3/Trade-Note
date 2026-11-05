#!/usr/bin/env node
/**
 * Claude bridge: lets the TradeNote backend (inside Docker) use YOUR Claude
 * subscription by running the official `claude` CLI on this machine.
 *
 *   TradeNote backend --HTTP--> this bridge --spawn--> `claude -p` --> your login
 *
 * Why a bridge: the app runs in a container that cannot see the host's `claude`
 * binary or its login, so something on the host has to run it. This is the same
 * shape as mt5-sync/mt5_live.py.
 *
 * What it is NOT: it never reads, copies or forwards your Claude credentials. It
 * starts the `claude` program exactly as you would in a terminal, and that program
 * authenticates itself. It runs with no tools, no MCP servers, no skills, no saved
 * session and only a scratch working directory, so a prompt cannot reach your files
 * or your other tools -- the model sees the text it is sent and nothing else.
 *
 * Endpoints (all JSON):
 *   GET  /health                no auth; { ok, busy, claude }
 *   POST /run       {system, prompt, model?}   -> { summary, model }
 *   POST /shutdown              stops the bridge (used by ./tradenote.sh stop)
 * /run and /shutdown need the shared secret in the x-bridge-secret header.
 *
 * Config (environment, or the repo's .env):
 *   CLAUDE_BRIDGE_SECRET   required; the backend sends the same value
 *   CLAUDE_BRIDGE_PORT     default 8788
 *   CLAUDE_BRIDGE_HOST     default 127.0.0.1 (loopback only)
 *   CLAUDE_BRIDGE_MODEL    default "sonnet". Always passed explicitly: with the
 *                          user's settings deliberately not loaded, the CLI would
 *                          otherwise fall back to its heaviest default model.
 *   CLAUDE_BIN             default "claude"
 *   CLAUDE_BRIDGE_TIMEOUT_MS  default 150000
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))

/** process.env first, then the repo's .env -- same precedence mcp-server uses. */
function readEnv(key) {
    if (process.env[key] != null && process.env[key] !== '') return process.env[key]
    const p = join(HERE, '..', '.env')
    if (!existsSync(p)) return ''
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const i = t.indexOf('=')
        if (i < 1 || t.slice(0, i).trim() !== key) continue
        let v = t.slice(i + 1).trim()
        if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1)
        return v
    }
    return ''
}

const SECRET = readEnv('CLAUDE_BRIDGE_SECRET')
const PORT = Number(readEnv('CLAUDE_BRIDGE_PORT')) || 8788
const HOST = readEnv('CLAUDE_BRIDGE_HOST') || '127.0.0.1'
const MODEL = readEnv('CLAUDE_BRIDGE_MODEL') || 'sonnet'
const CLAUDE_BIN = readEnv('CLAUDE_BIN') || 'claude'
const TIMEOUT_MS = Number(readEnv('CLAUDE_BRIDGE_TIMEOUT_MS')) || 150000
const MAX_BODY = 2 * 1024 * 1024
const MAX_QUEUE = 3

const log = (msg) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`)

if (!SECRET) {
    console.error('CLAUDE_BRIDGE_SECRET is not set (put it in .env). Refusing to start without one: the bridge runs a model on your subscription.')
    process.exit(1)
}

const sameSecret = (given) => {
    const a = Buffer.from(String(given || ''))
    const b = Buffer.from(SECRET)
    return a.length === b.length && timingSafeEqual(a, b)
}

/* One call at a time. `claude -p` calls are slow and heavy, concurrent ones would
   only fight over the same subscription limits, and a short queue is enough for a
   page that has a confirm dialog in front of it. */
let running = 0
let waiting = 0
let tail = Promise.resolve()
function enqueue(task) {
    waiting++
    const run = tail.then(async () => { waiting--; running++; try { return await task() } finally { running-- } })
    tail = run.catch(() => {})
    return run
}

/** Run one prompt. Resolves { summary, model } or rejects with { status, message }. */
function runClaude({ system, prompt, model }) {
    // The system prompt goes through a file, not argv: it is several KB of
    // multi-line text, and quoting that for a shell differs between cmd.exe and a
    // POSIX shell. The user prompt goes through stdin for the same reason.
    const dir = mkdtempSync(join(tmpdir(), 'tradenote-claude-'))
    const sysFile = join(dir, 'system.txt')
    writeFileSync(sysFile, system, 'utf8')
    // On Windows the child runs through cmd.exe (see spawn below), which does its own
    // quoting: an empty argument vanishes and a path with a space splits in two.
    // The first matters most -- `--tools ""` losing its value makes `--tools` swallow
    // the NEXT flag as a tool name, silently turning tools back on. So both are quoted
    // by hand there. (Not exercised in the test suite: it needs a Windows machine.)
    const win = process.platform === 'win32'
    const quote = (v) => (win ? `"${v}"` : v)
    const args = [
        '-p',
        '--output-format', 'json',
        '--model', model || MODEL,
        '--system-prompt-file', quote(sysFile),
        // Everything below exists to make the call a pure text-in, text-out one.
        '--tools', quote(''),
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--setting-sources', 'project',   // not user: no hooks, memory or custom style leaks in
    ]
    return new Promise((resolve, reject) => {
        const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } }
        let child
        try {
            // .cmd/.bat shims on Windows cannot be spawned without a shell; the
            // arguments above are plain tokens, so that is safe there.
            child = spawn(CLAUDE_BIN, args, { cwd: dir, windowsHide: true, shell: process.platform === 'win32' })
        } catch (e) {
            cleanup()
            return reject({ status: 503, message: `Could not start "${CLAUDE_BIN}": ${e.message}` })
        }
        let out = ''
        let err = ''
        let settled = false
        const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); fn(value) }
        const timer = setTimeout(() => {
            child.kill()
            done(reject, { status: 504, message: `claude did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.` })
        }, TIMEOUT_MS)
        child.stdout.on('data', (d) => { out += d })
        child.stderr.on('data', (d) => { err += d })
        child.on('error', (e) => done(reject, {
            status: 503,
            message: e.code === 'ENOENT'
                ? `The "${CLAUDE_BIN}" command was not found on this machine. Install Claude Code and run "claude" once to log in.`
                : `Could not run "${CLAUDE_BIN}": ${e.message}`,
        }))
        child.on('close', (code) => {
            let j = null
            try { j = JSON.parse(out) } catch { /* not JSON: handled below */ }
            if (!j) {
                return done(reject, { status: 502, message: `claude exited ${code} without a usable reply. ${(err || out).trim().slice(0, 300)}` })
            }
            if (j.is_error) {
                // The CLI puts its own explanation in `result`, e.g. "Not logged in".
                return done(reject, { status: 502, message: `claude reported an error: ${String(j.result || j.subtype || 'unknown').slice(0, 300)}` })
            }
            const summary = String(j.result || '').trim()
            if (!summary) return done(reject, { status: 502, message: 'claude returned an empty reply.' })
            // Report the model that actually did the work. The CLI also spends a
            // little on a small helper model, so prefer the heavier of the two.
            const used = Object.entries(j.modelUsage || {})
                .sort((a, b) => ((b[1].outputTokens || 0) - (a[1].outputTokens || 0)))[0]
            done(resolve, { summary, model: used ? used[0] : (model || MODEL) })
        })
        child.stdin.on('error', () => { /* child exited early; 'close' reports why */ })
        child.stdin.end(prompt, 'utf8')
    })
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
            size += c.length
            if (size > MAX_BODY) { reject({ status: 413, message: 'Request too large.' }); req.destroy(); return }
            chunks.push(c)
        })
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
            catch { reject({ status: 400, message: 'Body must be JSON.' }) }
        })
        req.on('error', () => reject({ status: 400, message: 'Could not read the request.' }))
    })
}

const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || '').split('?')[0]
        if (req.method === 'GET' && url === '/health') {
            return send(res, 200, { ok: true, busy: running > 0, queued: waiting, claude: CLAUDE_BIN, model: MODEL })
        }
        if (req.method !== 'POST' || (url !== '/run' && url !== '/shutdown')) {
            return send(res, 404, { error: 'Not found.' })
        }
        if (!sameSecret(req.headers['x-bridge-secret'])) {
            return send(res, 401, { error: 'Wrong or missing bridge secret.' })
        }
        if (url === '/shutdown') {
            send(res, 200, { ok: true })
            log('Shutdown requested.')
            return setTimeout(() => process.exit(0), 100)
        }
        const body = await readJsonBody(req)
        if (typeof body.system !== 'string' || !body.system.trim() || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            return send(res, 400, { error: 'Both "system" and "prompt" must be non-empty strings.' })
        }
        // The model name is placed on a command line, so only model-name characters
        // are accepted -- a shell metacharacter here must never reach cmd.exe.
        if (body.model != null && !(typeof body.model === 'string' && /^[A-Za-z0-9._:\-\[\]]{1,80}$/.test(body.model))) {
            return send(res, 400, { error: '"model" must be a plain model name.' })
        }
        if (waiting >= MAX_QUEUE) {
            return send(res, 429, { error: 'The bridge is busy. Try again in a moment.' })
        }
        const t0 = Date.now()
        const out = await enqueue(() => runClaude({ system: body.system, prompt: body.prompt, model: typeof body.model === 'string' && body.model ? body.model : undefined }))
        log(`Answered in ${((Date.now() - t0) / 1000).toFixed(1)}s (${out.model}).`)
        send(res, 200, out)
    } catch (e) {
        if (e && e.status) {
            log(`Request failed: ${e.message}`)
            return send(res, e.status, { error: e.message })
        }
        log(`Unexpected error: ${e && e.stack ? e.stack : e}`)
        send(res, 500, { error: 'Unexpected bridge error.' })
    }
})

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. If that is another bridge, it is already running -- nothing to do.`)
        process.exit(2)
    }
    console.error(`Bridge error: ${e.message}`)
    process.exit(1)
})

server.listen(PORT, HOST, () => {
    log(`Claude bridge listening on http://${HOST}:${PORT} (model ${MODEL}, binary "${CLAUDE_BIN}").`)
})
