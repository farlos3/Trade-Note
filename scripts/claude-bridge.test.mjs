#!/usr/bin/env node
/**
 * Integration test for claude-bridge.mjs, against a FAKE `claude` binary -- no
 * subscription is used and no network is touched. The fake echoes back what it was
 * given, so the test can assert the isolation flags and the stdin/system-file
 * plumbing, and can be told to fail, hang or answer with garbage.
 *
 * Run: node scripts/claude-bridge.test.mjs   (POSIX only: the fake is a shebang script)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') { console.log('SKIP  fake CLI is a shebang script; run on macOS/Linux'); process.exit(0) }

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, 'claude-bridge.mjs')
let failures = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++ }

const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
const FAKE = join(dir, 'fake-claude')
writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE || 'ok'
let input = ''
process.stdin.on('data', (d) => input += d)
process.stdin.on('end', () => {
  const sysPath = args[args.indexOf('--system-prompt-file') + 1]
  const system = sysPath ? fs.readFileSync(sysPath, 'utf8') : ''
  const t0 = Date.now()
  const reply = (obj) => process.stdout.write(JSON.stringify(obj))
  if (mode === 'error') return reply({ type: 'result', is_error: true, result: 'Not logged in - run /login' })
  if (mode === 'garbage') return process.stdout.write('this is not json')
  const wait = mode === 'hang' ? 60000 : mode === 'slow' ? 400 : 0
  setTimeout(() => reply({
    type: 'result', is_error: false,
    result: JSON.stringify({ system, prompt: input, args, t0, t1: Date.now() }),
    modelUsage: { 'claude-haiku-4-5': { outputTokens: 4 }, 'claude-sonnet-5-5': { outputTokens: 900 } },
  }), wait)
})
`)
chmodSync(FAKE, 0o755)

const SECRET = 'test-secret-123'
let nextPort = 19000 + Math.floor(Math.random() * 500)
const started = []

async function startBridge(extraEnv = {}) {
  const port = nextPort++
  const p = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, CLAUDE_BRIDGE_SECRET: SECRET, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BIN: FAKE, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(p)
  let err = ''; p.stderr.on('data', (d) => err += d)
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { port, p, err: () => err } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('bridge did not start: ' + err)
}
const call = (port, path, { method = 'POST', secret = SECRET, body } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(secret ? { 'x-bridge-secret': secret } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))

try {
  // --- startup safety ---
  const noSecret = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, CLAUDE_BRIDGE_SECRET: '', CLAUDE_BRIDGE_PORT: String(nextPort++) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The repo's own .env may legitimately carry a secret, so only assert when none is found.
  const code = await new Promise((r) => { noSecret.on('close', r); setTimeout(() => { noSecret.kill(); r('running') }, 1500) })
  check('refuses to start without a secret (or a .env that provides one)', code === 1 || code === 'running')

  const b = await startBridge()
  const body = { system: 'SYSTEM LINE 1\nLINE 2 ที่มีภาษาไทย', prompt: 'the prompt text' }

  // --- auth + validation ---
  check('health needs no secret and reports ok', (await call(b.port, '/health', { method: 'GET', secret: '' })).json?.ok === true)
  check('run without a secret -> 401', (await call(b.port, '/run', { secret: '', body })).status === 401)
  check('run with the wrong secret -> 401', (await call(b.port, '/run', { secret: 'nope', body })).status === 401)
  check('run with a missing prompt -> 400', (await call(b.port, '/run', { body: { system: 'x' } })).status === 400)
  check('a model name with shell metacharacters -> 400',
    (await call(b.port, '/run', { body: { system: 'x', prompt: 'y', model: 'sonnet & calc' } })).status === 400)
  check('unknown route -> 404', (await call(b.port, '/etc/passwd', { method: 'GET' })).status === 404)

  // --- the happy path and what the CLI was actually given ---
  const ok = await call(b.port, '/run', { body })
  check('run -> 200', ok.status === 200)
  const echoed = ok.status === 200 ? JSON.parse(ok.json.summary) : {}
  check('system prompt reaches the CLI intact (multi-line, Thai) via the file', echoed.system === body.system)
  check('user prompt reaches the CLI on stdin', echoed.prompt === body.prompt)
  const a = echoed.args || []
  check('runs headless with JSON output', a.includes('-p') && a[a.indexOf('--output-format') + 1] === 'json')
  check('tools are disabled', a[a.indexOf('--tools') + 1] === '')
  check('MCP, skills, session and user settings are all cut off',
    a.includes('--strict-mcp-config') && a.includes('--disable-slash-commands') && a.includes('--no-session-persistence') &&
    a[a.indexOf('--setting-sources') + 1] === 'project')
  check('model is always passed explicitly, default sonnet', a[a.indexOf('--model') + 1] === 'sonnet')
  check('reports the model that did the work, not the helper', ok.json?.model === 'claude-sonnet-5-5')
  const custom = await call(b.port, '/run', { body: { ...body, model: 'opus' } })
  check('a requested model overrides the default', JSON.parse(custom.json.summary).args.includes('opus'))

  // --- failures surface with a reason, not a hang ---
  const bErr = await startBridge({ FAKE_MODE: 'error' })
  const e1 = await call(bErr.port, '/run', { body })
  check('CLI error -> 502 carrying the CLI\'s own explanation', e1.status === 502 && /Not logged in/.test(e1.json.error))
  const bGar = await startBridge({ FAKE_MODE: 'garbage' })
  check('non-JSON output -> 502', (await call(bGar.port, '/run', { body })).status === 502)
  const bHang = await startBridge({ FAKE_MODE: 'hang', CLAUDE_BRIDGE_TIMEOUT_MS: '600' })
  const t0 = Date.now()
  const h = await call(bHang.port, '/run', { body })
  check('a hung CLI is killed and reported as 504 on time', h.status === 504 && Date.now() - t0 < 5000)
  const bMissing = await startBridge({ CLAUDE_BIN: join(dir, 'does-not-exist') })
  const m = await call(bMissing.port, '/run', { body })
  check('missing binary -> 503 with an install hint', m.status === 503 && /not found/i.test(m.json.error))

  // --- one at a time, and a bounded queue ---
  const bSlow = await startBridge({ FAKE_MODE: 'slow' })
  const two = await Promise.all([call(bSlow.port, '/run', { body }), call(bSlow.port, '/run', { body })])
  const [r1, r2] = two.map((r) => JSON.parse(r.json.summary)).sort((x, y) => x.t0 - y.t0)
  check('two simultaneous calls run one after the other, never overlapping', r2.t0 >= r1.t1 - 5)
  const burst = await Promise.all(Array.from({ length: 6 }, () => call(bSlow.port, '/run', { body })))
  check('a burst past the queue limit is turned away with 429, the rest answered',
    burst.some((r) => r.status === 429) && burst.some((r) => r.status === 200))

  // --- shutdown ---
  check('shutdown without the secret is refused', (await call(b.port, '/shutdown', { secret: '' })).status === 401)
  await call(b.port, '/shutdown')
  await new Promise((r) => setTimeout(r, 400))
  const alive = await fetch(`http://127.0.0.1:${b.port}/health`).then(() => true, () => false)
  check('shutdown with the secret stops the process', alive === false)
} catch (e) {
  console.log('FAIL  test crashed:', e && e.message ? e.message : e)
  failures++
} finally {
  for (const p of started) p.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
