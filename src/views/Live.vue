<script setup>
/**
 * Live MT5 workspace: live account state + order entry & position management
 * (mt5-sync/mt5_live.py -> POST /api/live -> SSE here, orders -> POST /api/orders).
 *
 * Combines live monitoring (balance, equity, floating P&L, open positions,
 * pending orders, ticks) with guarded order execution (setup + reason + SL
 * required, confirmation step, drawdown lock, inline SL/TP & cancel actions).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useTwoDecCurrencyFormat } from '../utils/utils'
import { usePipSize, useDefaultContractSize } from '../utils/addOrder'
import { useAuthHeaders } from '../utils/apiAuth'
import { useLiveSnapshots } from '../utils/journalStream'
import { useGetSetups } from '../utils/setups'
import { activeAccount } from '../utils/mt5Accounts'

const snapshot = ref(null)
const lastFrameAt = ref(null)
const now = ref(Date.now())
let stopLive = null
let clockTimer = null
let pollTimer = null

// A live feed that silently stops is worse than one that says so: after 15s with
// no frame the numbers on screen are history, not "live".
const STALE_AFTER_MS = 15000
const secondsSinceFrame = computed(() =>
    lastFrameAt.value ? Math.floor((now.value - lastFrameAt.value) / 1000) : null)
const isStale = computed(() =>
    !lastFrameAt.value || (now.value - lastFrameAt.value) > STALE_AFTER_MS)

const agentUp = ref(false)
const agentReason = ref(null)

const AGENT_POLL_MS = 5000
let lastAgentPollAt = 0
async function refreshAgentStatus() {
    try {
        const res = await fetch('/api/live', { headers: useAuthHeaders() })
        const j = await res.json()
        agentUp.value = !!(j && j.agent && j.agent.up)
        agentReason.value = (j && j.agent && j.agent.reason) || null
    } catch { /* leave the last known status rather than flapping to "down" */ }
}

const positions = computed(() => (snapshot.value && snapshot.value.positions) || [])
const floating = computed(() => (snapshot.value ? snapshot.value.profit : 0))

/* Sorted worst-first: a losing position is the one that needs attention first. */
const sortedPositions = computed(() =>
    [...positions.value].sort((a, b) => a.profit - b.profit))

const pending = computed(() => (snapshot.value && snapshot.value.pending) || [])
const sortedPending = computed(() =>
    [...pending.value].sort((a, b) => {
        const da = awayPips(a), db = awayPips(b)
        if (da === null) return 1
        if (db === null) return -1
        return da - db
    }))

function awayPips(o) {
    const cur = Number(o.priceCurrent) || 0
    const at = Number(o.priceOpen) || 0
    if (!cur || !at) return null
    return Math.abs(at - cur) / usePipSize(o.symbol)
}

const totalVolume = computed(() =>
    positions.value.reduce((s, p) => s + (Number(p.volume) || 0), 0))

const volumeBySide = computed(() => {
    let buy = 0, sell = 0
    for (const p of positions.value) {
        const v = Number(p.volume) || 0
        if (p.side === 'buy') buy += v
        else sell += v
    }
    return { buy, sell, net: buy - sell, hedged: buy > 0 && sell > 0 }
})

const lot = (v) => v.toFixed(2)

function pnlClass(v) {
    if (v > 0) return 'pos'
    if (v < 0) return 'neg'
    return ''
}

function movePips(p) {
    const d = (Number(p.priceCurrent) || 0) - (Number(p.priceOpen) || 0)
    const directional = p.side === 'sell' ? -d : d
    return directional / usePipSize(p.symbol)
}

function fmtPips(v) {
    const a = Math.abs(v)
    return a >= 10 ? v.toFixed(0) : v.toFixed(1)
}

/* ---- Order Ticket & Position Modification (merged from Trade) ---- */
const setups = ref([])
const form = ref({ symbol: '', side: 'buy', type: 'market', price: '', lot: '0.01', sl: '', tp: '', setup: '', reason: '' })
const confirming = ref(false)
const busy = ref(false)
const error = ref('')
const order = ref(null)   // { id, status, message, price }
const editing = ref(null) // { ticket, symbol, side, kind, volume, price, sl, tp, cancel }

const symbols = computed(() => Object.keys((snapshot.value && snapshot.value.ticks) || {}).sort())
// Pairs the user cares about: starred, listed first in the symbol picker. Per-browser only.
const favs = ref([])
try { favs.value = JSON.parse(localStorage.getItem('liveFavSymbols') || '[]') } catch (e) { /* storage blocked: no favourites */ }
const favFirst = computed(() => [...symbols.value.filter((s) => favs.value.includes(s)), ...symbols.value.filter((s) => !favs.value.includes(s))])
function toggleFav(sym) {
    favs.value = favs.value.includes(sym) ? favs.value.filter((s) => s !== sym) : [...favs.value, sym]
    try { localStorage.setItem('liveFavSymbols', JSON.stringify(favs.value)) } catch (e) { /* not persisted */ }
}
const tick = computed(() => snapshot.value && snapshot.value.ticks ? snapshot.value.ticks[form.value.symbol] : null)
const price = computed(() => tick.value ? (form.value.side === 'buy' ? tick.value.ask : tick.value.bid) : null)
const isPending = computed(() => form.value.type !== 'market')
const entry = computed(() => isPending.value ? (Number(form.value.price) > 0 ? Number(form.value.price) : null) : price.value)
const typeLabel = computed(() => `${form.value.side === 'buy' ? 'Buy' : 'Sell'}${isPending.value ? ' ' + form.value.type : ''}`)
const terminalAccount = computed(() => snapshot.value && snapshot.value.login && snapshot.value.server
    ? `${snapshot.value.login}@${snapshot.value.server}` : null)
const accountMatches = computed(() => !!terminalAccount.value && terminalAccount.value === activeAccount.value)
const selectedSetup = computed(() => setups.value.find((s) => s.name === form.value.setup) || null)
const setupOptions = computed(() => setups.value.filter((s) => s.side === 'any' || s.side === form.value.side))

const risk = computed(() => {
    const sl = Number(form.value.sl), lotNum = Number(form.value.lot)
    if (!entry.value || !(sl > 0) || !(lotNum > 0)) return null
    const dist = Math.abs(entry.value - sl)
    const money = dist * lotNum * useDefaultContractSize(form.value.symbol)
    const pips = dist / usePipSize(form.value.symbol)
    const rr = Number(form.value.tp) > 0 ? Math.abs(Number(form.value.tp) - entry.value) / dist : null
    return { money, pips, rr }
})

const missing = computed(() => {
    const f = form.value
    const out = []
    if (!f.setup) out.push('setup')
    if (f.reason.trim().length < 10) out.push('reason (10+ characters)')
    if (isPending.value && !(Number(f.price) > 0)) out.push('entry price')
    if (!(Number(f.sl) > 0)) out.push('stop loss')
    if (!(Number(f.lot) > 0)) out.push('lot')
    if (!f.symbol) out.push('symbol')
    return out
})

const lock = computed(() => (snapshot.value && snapshot.value.lock) || null)
const lockLeftMin = computed(() => lock.value && lock.value.until > now.value ? Math.ceil((lock.value.until - now.value) / 60000) : 0)
// crypto.randomUUID exists only in secure contexts (https/localhost); the VM is served over
// plain http, where it is undefined. getRandomValues works everywhere.
const newClientId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
const canReview = computed(() => !missing.value.length && accountMatches.value && price.value != null && !busy.value && !lockLeftMin.value)

const DONE = ['filled', 'placed', 'modified', 'cancelled', 'rejected', 'expired']
const stopLimit = (item) => /stop limit/i.test(item.kind || '')
const fmtNum = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '-' : Number(n).toFixed(d))

function applySnapshot(s) {
    if (!s) return
    snapshot.value = s
    lastFrameAt.value = Date.now()
    if (!form.value.symbol) {
        const names = Object.keys(s.ticks || {})
        form.value.symbol = names.find((n) => favs.value.includes(n)) || names.find((n) => /XAU/i.test(n)) || names[0] || ''
    }
}

async function submit(body) {
    busy.value = true
    error.value = ''
    try {
        const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { ...useAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, account: activeAccount.value, clientId: newClientId() }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
        order.value = { id: j.id, status: j.status }
        confirming.value = false
        editing.value = null
        pollOrder()
    } catch (e) {
        error.value = e.message
        busy.value = false
    }
}

function startEdit(item, cancel = false) {
    error.value = ''
    editing.value = {
        ticket: item.ticket, symbol: item.symbol, side: item.side, kind: item.kind || null, volume: item.volume,
        price: item.kind ? String(item.priceOpen) : '', sl: item.sl ? String(item.sl) : '', tp: item.tp ? String(item.tp) : '', cancel,
    }
}

function pollOrder() {
    clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
        try {
            const res = await fetch(`/api/orders/${order.value.id}`, { headers: useAuthHeaders() })
            const j = await res.json()
            order.value = j
            if (DONE.includes(j.status)) {
                clearInterval(pollTimer)
                busy.value = false
                if (j.status === 'filled' || j.status === 'placed') form.value = { ...form.value, price: '', sl: '', tp: '', reason: '' }
            }
        } catch { /* keep polling */ }
    }, 1000)
}

onMounted(async () => {
    try {
        const res = await fetch('/api/live', { headers: useAuthHeaders() })
        const j = await res.json()
        if (j && j.snapshot && !j.stale) applySnapshot(j.snapshot)
    } catch { /* the stream below is the real source */ }
    await refreshAgentStatus()
    stopLive = useLiveSnapshots(applySnapshot)
    clockTimer = setInterval(() => {
        now.value = Date.now()
        if (isStale.value && (now.value - lastAgentPollAt) >= AGENT_POLL_MS) {
            lastAgentPollAt = now.value
            refreshAgentStatus()
        }
    }, 1000)
    try { setups.value = await useGetSetups() } catch (e) { error.value = 'Could not load setups: ' + e.message }
})

onUnmounted(() => {
    if (stopLive) stopLive()
    if (clockTimer) clearInterval(clockTimer)
    clearInterval(pollTimer)
})
</script>

<template>
    <div class="livePage mt-2">
        <!-- Connection state, always visible -->
        <div class="liveBar mb-3">
            <span class="liveDot" v-bind:class="{ on: !isStale }"></span>
            <span v-if="!isStale" class="liveLabel">Live</span>
            <span v-else-if="agentUp && agentReason" class="liveLabelStale">
                {{ agentReason }}
                <span v-if="snapshot"> Showing the last reading, {{ secondsSinceFrame }}s old.</span>
            </span>
            <span v-else-if="snapshot" class="liveLabelStale">
                Stale — no update for {{ secondsSinceFrame }}s.
            </span>
            <span v-else class="liveLabelStale">
                Waiting for the live agent (mt5-sync/mt5_live.py) — start it, or run ./tradenote.sh start
            </span>
            <span v-if="snapshot" class="liveMeta ms-auto">
                MT5 #{{ snapshot.login }} · {{ snapshot.currency }}
            </span>
        </div>

        <div class="row g-3">
            <!-- ============ LEFT / MAIN: LIVE STATE & POSITIONS ============ -->
            <div class="col-12 col-xl-8">
                <div v-if="snapshot">
                    <div class="liveTiles mb-3">
                        <div class="liveTile">
                            <div class="tileLabel">Balance</div>
                            <div class="tileValue">{{ useTwoDecCurrencyFormat(snapshot.balance) }}</div>
                            <div class="tileSub">closed trades only</div>
                        </div>
                        <div class="liveTile">
                            <div class="tileLabel">Equity</div>
                            <div class="tileValue" v-bind:class="pnlClass(snapshot.equity - snapshot.balance)">
                                {{ useTwoDecCurrencyFormat(snapshot.equity) }}
                            </div>
                            <div class="tileSub">balance + floating</div>
                        </div>
                        <div class="liveTile">
                            <div class="tileLabel">Floating P&amp;L</div>
                            <div class="tileValue" v-bind:class="pnlClass(floating)">
                                {{ floating >= 0 ? '+' : '' }}{{ useTwoDecCurrencyFormat(floating) }}
                            </div>
                            <div class="tileSub">{{ positions.length }} open position(s)</div>
                        </div>
                        <div class="liveTile">
                            <div class="tileLabel">Open lots</div>
                            <div class="tileValue">{{ lot(totalVolume) }}</div>
                            <div class="tileSub lotSplit">
                                <span class="lotBuy">BUY {{ lot(volumeBySide.buy) }}</span>
                                <span class="lotSep">·</span>
                                <span class="lotSell">SELL {{ lot(volumeBySide.sell) }}</span>
                            </div>
                            <div v-if="volumeBySide.hedged" class="tileSub">
                                net {{ volumeBySide.net > 0 ? 'long' : volumeBySide.net < 0 ? 'short' : 'flat' }}
                                {{ lot(Math.abs(volumeBySide.net)) }}
                            </div>
                        </div>
                        <div class="liveTile">
                            <div class="tileLabel">Free margin</div>
                            <div class="tileValue">{{ useTwoDecCurrencyFormat(snapshot.marginFree) }}</div>
                            <div class="tileSub">used {{ useTwoDecCurrencyFormat(snapshot.margin) }}</div>
                        </div>
                    </div>

                    <div class="dailyCard">
                        <h6 class="mb-3">Open positions</h6>

                        <div v-if="!positions.length" class="emptyLine">
                            No open positions — everything is closed.
                        </div>

                        <div v-else class="tableWrap">
                            <table class="table liveTable mb-0">
                                <thead>
                                    <tr>
                                        <th>Symbol</th>
                                        <th>Side</th>
                                        <th class="num">Vol</th>
                                        <th class="num">Entry</th>
                                        <th class="num">Now</th>
                                        <th class="num">Move</th>
                                        <th class="num">SL</th>
                                        <th class="num">TP</th>
                                        <th class="num">P&amp;L</th>
                                        <th class="num">Manage</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="p in sortedPositions" :key="p.ticket">
                                        <td>{{ p.symbol }}</td>
                                        <td>
                                            <span class="sideTag" v-bind:class="p.side">{{ p.side.toUpperCase() }}</span>
                                        </td>
                                        <td class="num">{{ p.volume }}</td>
                                        <td class="num">{{ p.priceOpen }}</td>
                                        <td class="num strong">{{ p.priceCurrent }}</td>
                                        <td class="num" v-bind:class="pnlClass(movePips(p))">
                                            {{ movePips(p) >= 0 ? '+' : '' }}{{ fmtPips(movePips(p)) }}
                                            <span class="unit">pips</span>
                                        </td>
                                        <td class="num muted">{{ p.sl ? p.sl : '—' }}</td>
                                        <td class="num muted">{{ p.tp ? p.tp : '—' }}</td>
                                        <td class="num strong" v-bind:class="pnlClass(p.profit)">
                                            {{ p.profit >= 0 ? '+' : '' }}{{ useTwoDecCurrencyFormat(p.profit) }}
                                        </td>
                                        <td class="num">
                                            <button type="button" class="btn btn-outline-secondary btn-sm py-0 px-2"
                                                :disabled="busy || !accountMatches"
                                                :title="accountMatches ? 'Modify SL / TP' : 'Select matching MT5 account to modify'"
                                                v-on:click="startEdit(p)">SL/TP</button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div v-if="pending.length" class="dailyCard mt-3">
                        <h6 class="mb-3">Pending orders <span class="muted pendingCount">{{ pending.length }}</span></h6>
                        <div class="tableWrap">
                            <table class="table liveTable mb-0">
                                <thead>
                                    <tr>
                                        <th>Symbol</th>
                                        <th>Type</th>
                                        <th class="num">Vol</th>
                                        <th class="num">Price</th>
                                        <th class="num">Now</th>
                                        <th class="num">Away</th>
                                        <th class="num">SL</th>
                                        <th class="num">TP</th>
                                        <th class="num">Manage</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="o in sortedPending" :key="o.ticket">
                                        <td>{{ o.symbol }}</td>
                                        <td><span class="sideTag" v-bind:class="o.side">{{ o.kind }}</span></td>
                                        <td class="num">{{ o.volume }}</td>
                                        <td class="num strong">{{ o.priceOpen }}</td>
                                        <td class="num muted">{{ o.priceCurrent || '—' }}</td>
                                        <td class="num">
                                            {{ awayPips(o) === null ? '—' : fmtPips(awayPips(o)) }}
                                            <span v-if="awayPips(o) !== null" class="unit">pips</span>
                                        </td>
                                        <td class="num muted">{{ o.sl ? o.sl : '—' }}</td>
                                        <td class="num muted">{{ o.tp ? o.tp : '—' }}</td>
                                        <td class="num">
                                            <div class="d-inline-flex gap-1">
                                                <button v-if="!stopLimit(o)" type="button"
                                                    class="btn btn-outline-secondary btn-sm py-0 px-2"
                                                    :disabled="busy || !accountMatches" v-on:click="startEdit(o)">Edit</button>
                                                <button type="button" class="btn btn-outline-danger btn-sm py-0 px-2"
                                                    :disabled="busy || !accountMatches" v-on:click="startEdit(o, true)">Cancel</button>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div v-else class="dailyCard">
                    <p class="emptyLine mb-0">
                        Nothing received yet. The live feed comes from the Windows host, not the
                        container — MetaTrader 5 must be open and
                        <code>mt5-sync/mt5_live.py</code> running.
                    </p>
                </div>
            </div>

            <!-- ============ RIGHT: ORDER TICKET (TRADE) ============ -->
            <div class="col-12 col-xl-4">
                <div class="tradeCard">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <h6 class="mb-0 tradeTitle">Place Order</h6>
                        <span v-if="lock && !lockLeftMin" class="txt-small muted">
                            DD {{ fmtNum(lock.ddPct, 1) }}% · lock {{ lock.limitPct }}%
                        </span>
                    </div>

                    <div v-if="!snapshot" class="alert alert-warning py-2 txt-small">
                        Waiting for MetaTrader 5… The live agent must be running to trade.
                    </div>
                    <div v-else-if="!accountMatches" class="alert alert-danger py-2 txt-small">
                        Terminal is on <strong>{{ terminalAccount }}</strong>, but top-bar account is
                        <strong>{{ activeAccount || 'none' }}</strong>. Match them before trading.
                    </div>
                    <div v-if="lockLeftMin" class="alert alert-danger py-2 txt-small">
                        <strong>Trading locked for {{ lockLeftMin }} more min.</strong>
                        Equity is {{ fmtNum(lock.ddPct, 1) }}% below peak ({{ fmtNum(lock.peak) }}); limit {{ lock.limitPct }}%.
                        New entries are blocked; you can still change SL/TP or cancel pending orders.
                    </div>

                    <label class="tLabel">Symbol</label>
                    <div class="d-flex gap-2">
                        <select class="form-select" v-model="form.symbol">
                            <option v-if="!symbols.length" value="" disabled>
                                {{ snapshot ? 'No symbols — add some to MT5 Market Watch' : 'Waiting for MT5…' }}</option>
                            <option v-for="s in favFirst" :key="s" :value="s" :class="{ fav: favs.includes(s) }">
                                {{ favs.includes(s) ? '★ ' : '' }}{{ s }}</option>
                        </select>
                        <button type="button" :class="['favBtn', { on: favs.includes(form.symbol) }]" :disabled="!form.symbol"
                            :title="favs.includes(form.symbol) ? 'Remove from favourites' : 'Mark as favourite'"
                            v-on:click="toggleFav(form.symbol)">★</button>
                    </div>

                    <div class="sideToggle mt-3" role="group" aria-label="Side">
                        <button type="button" :class="['sideBtn', 'buy', { active: form.side === 'buy' }]" v-on:click="form.side = 'buy'">
                            Buy <span class="px">{{ tick ? fmtNum(tick.ask, 2) : '' }}</span></button>
                        <button type="button" :class="['sideBtn', 'sell', { active: form.side === 'sell' }]" v-on:click="form.side = 'sell'">
                            Sell <span class="px">{{ tick ? fmtNum(tick.bid, 2) : '' }}</span></button>
                    </div>

                    <div class="typeToggle mt-2" role="group" aria-label="Order type">
                        <button v-for="t in ['market', 'limit', 'stop']" :key="t" type="button"
                            :class="['typeBtn', { active: form.type === t }]" v-on:click="form.type = t">{{ t }}</button>
                    </div>
                    <div v-if="isPending" class="mt-2">
                        <label class="tLabel">Entry price * <span class="tHint">({{ form.side === 'buy' ? (form.type === 'limit' ? 'below' : 'above') : (form.type === 'limit' ? 'above' : 'below') }} {{ fmtNum(price) }})</span></label>
                        <input class="form-control" type="number" inputmode="decimal" step="any" v-model="form.price" />
                    </div>

                    <div class="grid3 mt-3">
                        <div>
                            <label class="tLabel">Lot</label>
                            <input class="form-control" type="number" inputmode="decimal" step="0.01" min="0.01" v-model="form.lot" />
                        </div>
                        <div>
                            <label class="tLabel">Stop loss *</label>
                            <input class="form-control" type="number" inputmode="decimal" step="0.01" v-model="form.sl" />
                        </div>
                        <div>
                            <label class="tLabel">Take profit</label>
                            <input class="form-control" type="number" inputmode="decimal" step="0.01" v-model="form.tp" />
                        </div>
                    </div>
                    <div v-if="risk" class="riskLine">
                        Risk <strong>{{ fmtNum(risk.money) }}</strong> · {{ fmtNum(risk.pips, 0) }} pips<span v-if="risk.rr != null"> · RR 1:{{ fmtNum(risk.rr, 2) }}</span>
                    </div>

                    <label class="tLabel mt-3">Setup *</label>
                    <select class="form-select" v-model="form.setup">
                        <option value="" disabled>Choose the setup you are trading</option>
                        <option v-for="s in setupOptions" :key="s.objectId" :value="s.name">{{ s.name }}</option>
                    </select>

                    <label class="tLabel mt-3">Reason *</label>
                    <textarea class="form-control" rows="2" v-model="form.reason"
                        placeholder="What do you see? Which rules of the setup are met?"></textarea>

                    <p v-if="missing.length" class="hint mt-2 mb-0">Still needed: {{ missing.join(', ') }}</p>
                    <div v-if="error" class="alert alert-danger py-2 mt-3 mb-0">{{ error }}</div>

                    <button type="button" class="btn btn-sm w-100 mt-3" :class="form.side === 'buy' ? 'btn-success' : 'btn-danger'"
                        :disabled="!canReview" v-on:click="confirming = true">
                        Review {{ typeLabel }} {{ form.lot }} {{ form.symbol }}
                    </button>
                </div>

                <!-- Rules of the chosen setup, so they are in view while writing the reason. -->
                <div v-if="selectedSetup" class="tradeCard mt-3">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <strong class="tradeTitle">{{ selectedSetup.name }} · rules</strong>
                        <a v-if="selectedSetup.imageUrl" :href="selectedSetup.imageUrl" target="_blank" rel="noopener"
                            class="txt-small"><i class="uil uil-image me-1"></i>View image</a>
                    </div>
                    <ol v-if="selectedSetup.rules && selectedSetup.rules.length" class="setupRules txt-small mb-0">
                        <li v-for="(rule, i) in selectedSetup.rules" :key="i">
                            {{ rule.text }}
                            <ol v-if="rule.sub && rule.sub.length" type="a">
                                <li v-for="(sub, j) in rule.sub" :key="j">{{ sub }}</li>
                            </ol>
                        </li>
                    </ol>
                    <p v-else class="txt-small muted mb-0">This setup has no rules written yet.</p>
                </div>

                <div v-if="order" class="tradeCard mt-3" aria-live="polite">
                    <div class="d-flex justify-content-between align-items-center">
                        <strong>Order</strong>
                        <span :class="['statusBadge', order.status]">{{ order.status }}</span>
                    </div>
                    <p v-if="order.message" class="mt-2 mb-0">{{ order.message }}</p>
                </div>
            </div>
        </div>

        <!-- Confirm new order modal -->
        <div v-if="confirming" class="confirmBackdrop" v-on:click.self="confirming = false">
            <div class="confirmBox">
                <h5 class="mb-3">Send this order?</h5>
                <p class="mb-1"><strong>{{ typeLabel.toUpperCase() }} {{ form.lot }} {{ form.symbol }}</strong>
                    <span v-if="isPending"> at {{ form.price }}</span><span v-else> at market (~{{ fmtNum(price) }})</span></p>
                <p class="mb-1">SL {{ form.sl }} · TP {{ form.tp || '—' }}<span v-if="risk"> · risk {{ fmtNum(risk.money) }}</span></p>
                <p class="mb-1">Setup: {{ form.setup }}</p>
                <p class="mb-3 reasonEcho">{{ form.reason }}</p>
                <p class="txt-small text-muted">Account {{ activeAccount }}</p>
                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-outline-secondary flex-fill" v-on:click="confirming = false" :disabled="busy">Cancel</button>
                    <button type="button" class="btn flex-fill" :class="form.side === 'buy' ? 'btn-success' : 'btn-danger'"
                        v-on:click="submit(form)" :disabled="busy">{{ busy ? 'Sending…' : 'Send order' }}</button>
                </div>
            </div>
        </div>

        <!-- Edit SL/TP or Cancel pending order modal -->
        <div v-if="editing" class="confirmBackdrop" v-on:click.self="editing = null">
            <div class="confirmBox">
                <h5 class="mb-3">{{ editing.cancel ? 'Cancel this order?' : editing.kind ? 'Edit pending order' : 'Change SL / TP' }}</h5>
                <p class="mb-3"><strong>{{ editing.kind || editing.side.toUpperCase() }} {{ editing.volume }} {{ editing.symbol }}</strong>
                    <span class="text-muted"> #{{ editing.ticket }}</span></p>
                <div v-if="!editing.cancel" :class="[editing.kind ? 'grid3' : 'grid2', 'mb-3']">
                    <div v-if="editing.kind">
                        <label class="tLabel">Entry price</label>
                        <input class="form-control" type="number" inputmode="decimal" step="any" v-model="editing.price" />
                    </div>
                    <div>
                        <label class="tLabel">Stop loss *</label>
                        <input class="form-control" type="number" inputmode="decimal" step="any" v-model="editing.sl" />
                    </div>
                    <div>
                        <label class="tLabel">Take profit</label>
                        <input class="form-control" type="number" inputmode="decimal" step="any" v-model="editing.tp" />
                    </div>
                </div>
                <div v-if="error" class="alert alert-danger py-2 mb-3">{{ error }}</div>
                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-outline-secondary flex-fill" v-on:click="editing = null" :disabled="busy">Back</button>
                    <button v-if="editing.cancel" type="button" class="btn btn-danger flex-fill" :disabled="busy"
                        v-on:click="submit({ action: 'cancel', ticket: editing.ticket })">{{ busy ? 'Sending…' : 'Cancel order' }}</button>
                    <button v-else type="button" class="btn btn-primary flex-fill" :disabled="busy || !(Number(editing.sl) > 0)"
                        v-on:click="submit({ action: 'modify', ticket: editing.ticket, price: editing.price, sl: editing.sl, tp: editing.tp })">
                        {{ busy ? 'Sending…' : 'Save' }}</button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.liveBar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.85rem;
    border-radius: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 0.85rem;
}

.liveDot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #6b7280;
    flex: 0 0 auto;
}

.liveDot.on {
    background: #00CA73;
    animation: livePulse 1.6s ease-in-out infinite;
}

@keyframes livePulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0, 202, 115, 0.5); }
    50% { opacity: 0.75; box-shadow: 0 0 0 5px rgba(0, 202, 115, 0); }
}

.liveLabel { color: #00CA73; font-weight: 700; }
.liveLabelStale { color: #f59e0b; }
.liveMeta { color: var(--white-60); font-size: 0.8rem; }

.liveTiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.75rem;
}

.liveTile {
    padding: 0.85rem 1rem;
    border-radius: 0.6rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
}

.tileLabel {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
}

.tileValue {
    font-size: 1.35rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    margin-top: 0.15rem;
}

.tileSub { font-size: 0.75rem; color: var(--white-60); }

.lotSplit { font-variant-numeric: tabular-nums; }
.lotBuy { color: #00CA73; font-weight: 600; }
.lotSell { color: #F6465D; font-weight: 600; }
.lotSep { opacity: 0.4; margin: 0 0.3rem; }

.tableWrap { overflow-x: auto; }

.liveTable th {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--white-60);
    font-weight: 600;
    white-space: nowrap;
}

.liveTable td {
    font-size: 0.88rem;
    vertical-align: middle;
    white-space: nowrap;
}

.liveTable .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
}

.liveTable .strong { font-weight: 700; }
.muted { color: var(--white-60); }

.sideTag {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
}

.unit {
    font-size: 0.72rem;
    opacity: 0.55;
    margin-left: 0.15rem;
}

.sideTag.buy { color: #00CA73; background: rgba(0, 202, 115, 0.12); }
.sideTag.sell { color: #F6465D; background: rgba(246, 70, 93, 0.12); }

.pos { color: #00CA73; }
.neg { color: #F6465D; }

.emptyLine { color: var(--white-60); font-size: 0.9rem; }

.favBtn {
    flex: none;
    width: 2.2rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.5rem;
    background: transparent;
    color: var(--white-60);
}

.favBtn.on { color: #f5b301; border-color: #f5b301; background: rgba(245, 179, 1, 0.12); }
.tradeCard option.fav { color: #f5b301; }

.pendingCount {
    font-size: 0.78rem;
    font-weight: 400;
}

/* ---- Order ticket ---- */
.tradeCard {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 0.75rem;
    padding: 0.75rem;
}

/* The ticket is a secondary panel next to the positions, so it is kept compact
   and quiet: small controls, tinted (not solid) side buttons, tighter spacing. */
.tradeTitle {
    font-size: 0.9rem;
    font-weight: 600;
}

.tradeCard .mt-3 {
    margin-top: 0.6rem !important;
}

.tLabel {
    display: block;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin-bottom: 0.25rem;
}

.tradeCard .form-control,
.tradeCard .form-select,
.confirmBox .form-control {
    min-height: 2.55rem;
    font-size: 1rem;   /* 16px: stops iOS zooming into the field */
}

/* Compact fields on desktop only -- phones keep 16px so iOS does not zoom. */
@media (min-width: 768px) {
    .tradeCard .form-control,
    .tradeCard .form-select {
        min-height: 2rem;
        padding-top: 0.25rem;
        padding-bottom: 0.25rem;
        font-size: 0.85rem;
    }
}

.sideToggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
}

.sideBtn {
    min-height: 2.4rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: transparent;
    color: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    line-height: 1.2;
}

.sideBtn .px {
    display: block;
    font-weight: 400;
    font-size: 0.75rem;
    opacity: 0.85;
}

.sideBtn.buy.active { background: rgba(0, 202, 115, 0.16); border-color: #00CA73; color: #00CA73; }
.sideBtn.sell.active { background: rgba(246, 70, 93, 0.16); border-color: #F6465D; color: #F6465D; }

.typeToggle {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.35rem;
}

.typeBtn {
    min-height: 1.9rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: transparent;
    color: inherit;
    font-size: 0.8rem;
    text-transform: capitalize;
}

.typeBtn.active { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.35); font-weight: 600; }

.setupRules {
    padding-left: 1.1rem;
    color: var(--white-87);
}

.setupRules ol {
    margin-top: 0.15rem;
    color: var(--white-60);
}

.tHint { text-transform: none; letter-spacing: 0; }

.grid2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
}

.grid3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
}

.riskLine {
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: var(--white-60);
}

.hint {
    font-size: 0.8rem;
    color: #f59e0b;
}

.confirmBackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 2000;
    padding: 1rem;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
}

.confirmBox {
    width: 100%;
    max-width: 480px;
    background: #1b1f2a;
    border-radius: 0.9rem;
    padding: 1.25rem;
}

.reasonEcho {
    white-space: pre-wrap;
    color: var(--white-60);
}

.statusBadge {
    font-size: 0.8rem;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    border: 1px solid currentColor;
    text-transform: uppercase;
}

.statusBadge.filled, .statusBadge.placed, .statusBadge.modified, .statusBadge.cancelled { color: #00CA73; }
.statusBadge.rejected, .statusBadge.expired { color: #F6465D; }
.statusBadge.queued, .statusBadge.dispatched { color: #f59e0b; }

@media (min-width: 768px) {
    .confirmBackdrop { align-items: center; }
}

@media (max-width: 420px) {
    .grid3 { grid-template-columns: 1fr 1fr; }
    .grid3 > div:first-child { grid-column: span 2; }
}
</style>
