<script setup>
/**
 * Place an order from TradeNote (market, or a pending limit/stop), and change the
 * SL/TP of what is already open or cancel a pending order. A new entry is only
 * queued once a setup and a reason are filled in; the host agent (mt5_live.py)
 * sends it through MetaTrader 5 and reports back. Built mobile-first: one column,
 * large touch targets.
 * Server side: POST /api/orders (index.mjs), which re-checks everything here.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAuthHeaders } from '../utils/apiAuth'
import { useLiveSnapshots } from '../utils/journalStream'
import { useGetSetups } from '../utils/setups'
import { activeAccount } from '../utils/mt5Accounts'
import { usePipSize, useDefaultContractSize } from '../utils/addOrder'

const snapshot = ref(null)
const setups = ref([])
const form = ref({ symbol: '', side: 'buy', type: 'market', price: '', lot: '0.01', sl: '', tp: '', setup: '', reason: '' })
const confirming = ref(false)
const busy = ref(false)
const error = ref('')
const order = ref(null)   // { id, status, message, price }
const editing = ref(null) // a position/pending order being changed: { ticket, symbol, side, kind, price, sl, tp, cancel }
let stopLive = null
let pollTimer = null

const symbols = computed(() => Object.keys((snapshot.value && snapshot.value.ticks) || {}).sort())
const tick = computed(() => snapshot.value && snapshot.value.ticks ? snapshot.value.ticks[form.value.symbol] : null)
const price = computed(() => tick.value ? (form.value.side === 'buy' ? tick.value.ask : tick.value.bid) : null)
const isPending = computed(() => form.value.type !== 'market')
// Where the order enters: the live price for a market order, the typed price for a pending one.
const entry = computed(() => isPending.value ? (Number(form.value.price) > 0 ? Number(form.value.price) : null) : price.value)
const typeLabel = computed(() => `${form.value.side === 'buy' ? 'Buy' : 'Sell'}${isPending.value ? ' ' + form.value.type : ''}`)
const positions = computed(() => (snapshot.value && snapshot.value.positions) || [])
const pendingOrders = computed(() => (snapshot.value && snapshot.value.pending) || [])
const terminalAccount = computed(() => snapshot.value && snapshot.value.login && snapshot.value.server
    ? `${snapshot.value.login}@${snapshot.value.server}` : null)
const accountMatches = computed(() => !!terminalAccount.value && terminalAccount.value === activeAccount.value)
const setupOptions = computed(() => setups.value.filter((s) => s.side === 'any' || s.side === form.value.side))

// Risk of this order in money and pips, so the size is decided with the cost in view.
const risk = computed(() => {
    const sl = Number(form.value.sl), lot = Number(form.value.lot)
    if (!entry.value || !(sl > 0) || !(lot > 0)) return null
    const dist = Math.abs(entry.value - sl)
    const money = dist * lot * useDefaultContractSize(form.value.symbol)
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
const canReview = computed(() => !missing.value.length && accountMatches.value && price.value != null && !busy.value)

function onSnapshot(s) {
    if (!s) return
    snapshot.value = s
    if (!form.value.symbol) {
        const names = Object.keys(s.ticks || {})
        form.value.symbol = names.find((n) => /XAU/i.test(n)) || names[0] || ''
    }
}

// One endpoint for every request: open (the form), modify or cancel (the list).
async function submit(body) {
    busy.value = true
    error.value = ''
    try {
        const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { ...useAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, account: activeAccount.value, clientId: crypto.randomUUID() }),
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

const DONE = ['filled', 'placed', 'modified', 'cancelled', 'rejected', 'expired']

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
        if (j && j.snapshot && !j.stale) onSnapshot(j.snapshot)
    } catch { /* the stream fills it in */ }
    stopLive = useLiveSnapshots(onSnapshot)
    try { setups.value = await useGetSetups() } catch (e) { error.value = 'Could not load setups: ' + e.message }
})
onUnmounted(() => { if (stopLive) stopLive(); clearInterval(pollTimer) })

const stopLimit = (item) => /stop limit/i.test(item.kind || '')
const fmt = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '-' : Number(n).toFixed(d))
</script>

<template>
    <div class="tradePage p-3">
        <div v-if="!snapshot" class="alert alert-warning">Waiting for MetaTrader 5… The live agent must be running.</div>
        <div v-else-if="!accountMatches" class="alert alert-danger">
            The terminal is logged into <strong>{{ terminalAccount }}</strong>, but the account selected in the top bar is
            <strong>{{ activeAccount || 'none' }}</strong>. Switch one of them so they match before trading.
        </div>

        <div class="tradeCard">
            <label class="tLabel">Symbol</label>
            <select class="form-select" v-model="form.symbol">
                <option v-for="s in symbols" :key="s" :value="s">{{ s }}</option>
            </select>

            <div class="sideToggle mt-3" role="group" aria-label="Side">
                <button type="button" :class="['sideBtn', 'buy', { active: form.side === 'buy' }]" v-on:click="form.side = 'buy'">
                    Buy <span class="px">{{ tick ? fmt(tick.ask, 2) : '' }}</span></button>
                <button type="button" :class="['sideBtn', 'sell', { active: form.side === 'sell' }]" v-on:click="form.side = 'sell'">
                    Sell <span class="px">{{ tick ? fmt(tick.bid, 2) : '' }}</span></button>
            </div>

            <div class="typeToggle mt-2" role="group" aria-label="Order type">
                <button v-for="t in ['market', 'limit', 'stop']" :key="t" type="button"
                    :class="['typeBtn', { active: form.type === t }]" v-on:click="form.type = t">{{ t }}</button>
            </div>
            <div v-if="isPending" class="mt-2">
                <label class="tLabel">Entry price * <span class="tHint">({{ form.side === 'buy' ? (form.type === 'limit' ? 'below' : 'above') : (form.type === 'limit' ? 'above' : 'below') }} {{ fmt(price) }})</span></label>
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
                Risk <strong>{{ fmt(risk.money) }}</strong> · {{ fmt(risk.pips, 0) }} pips<span v-if="risk.rr != null"> · RR 1:{{ fmt(risk.rr, 2) }}</span>
            </div>

            <label class="tLabel mt-3">Setup *</label>
            <select class="form-select" v-model="form.setup">
                <option value="" disabled>Choose the setup you are trading</option>
                <option v-for="s in setupOptions" :key="s.objectId" :value="s.name">{{ s.name }}</option>
            </select>

            <label class="tLabel mt-3">Reason *</label>
            <textarea class="form-control" rows="3" v-model="form.reason"
                placeholder="What do you see? Which rules of the setup are met?"></textarea>

            <p v-if="missing.length" class="hint mt-2 mb-0">Still needed: {{ missing.join(', ') }}</p>
            <div v-if="error" class="alert alert-danger py-2 mt-3 mb-0">{{ error }}</div>

            <button type="button" class="btn btn-lg w-100 mt-3" :class="form.side === 'buy' ? 'btn-success' : 'btn-danger'"
                :disabled="!canReview" v-on:click="confirming = true">
                Review {{ typeLabel }} {{ form.lot }} {{ form.symbol }}
            </button>
        </div>

        <!-- Second step on purpose: the order is real money. -->
        <div v-if="confirming" class="confirmBackdrop" v-on:click.self="confirming = false">
            <div class="confirmBox">
                <h5 class="mb-3">Send this order?</h5>
                <p class="mb-1"><strong>{{ typeLabel.toUpperCase() }} {{ form.lot }} {{ form.symbol }}</strong>
                    <span v-if="isPending"> at {{ form.price }}</span><span v-else> at market (~{{ fmt(price) }})</span></p>
                <p class="mb-1">SL {{ form.sl }} · TP {{ form.tp || '—' }}<span v-if="risk"> · risk {{ fmt(risk.money) }}</span></p>
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

        <div v-if="positions.length || pendingOrders.length" class="tradeCard mt-3">
            <strong>Open in MT5</strong>
            <div v-for="p in positions" :key="'p' + p.ticket" class="openRow">
                <div class="openInfo">
                    <span :class="p.side === 'buy' ? 'text-success' : 'text-danger'">{{ p.side.toUpperCase() }}</span>
                    {{ p.volume }} {{ p.symbol }} @ {{ p.priceOpen }}
                    <div class="openSub">SL {{ p.sl || '—' }} · TP {{ p.tp || '—' }} ·
                        <span :class="p.profit >= 0 ? 'text-success' : 'text-danger'">{{ fmt(p.profit) }}</span></div>
                </div>
                <button type="button" class="btn btn-outline-secondary btn-sm rowBtn" :disabled="busy || !accountMatches"
                    v-on:click="startEdit(p)">SL/TP</button>
            </div>
            <div v-for="o in pendingOrders" :key="'o' + o.ticket" class="openRow">
                <div class="openInfo">
                    <span :class="o.side === 'buy' ? 'text-success' : 'text-danger'">{{ o.kind }}</span>
                    {{ o.volume }} {{ o.symbol }} @ {{ o.priceOpen }}
                    <div class="openSub">SL {{ o.sl || '—' }} · TP {{ o.tp || '—' }} · pending</div>
                </div>
                <div class="d-flex gap-1">
                    <button v-if="!stopLimit(o)" type="button" class="btn btn-outline-secondary btn-sm rowBtn"
                        :disabled="busy || !accountMatches" v-on:click="startEdit(o)">Edit</button>
                    <button type="button" class="btn btn-outline-danger btn-sm rowBtn" :disabled="busy || !accountMatches"
                        v-on:click="startEdit(o, true)">Cancel</button>
                </div>
            </div>
        </div>

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

        <div v-if="order" class="tradeCard mt-3" aria-live="polite">
            <div class="d-flex justify-content-between align-items-center">
                <strong>Order</strong>
                <span :class="['statusBadge', order.status]">{{ order.status }}</span>
            </div>
            <p v-if="order.message" class="mt-2 mb-0">{{ order.message }}</p>
        </div>
    </div>
</template>

<style scoped>
.tradePage {
    max-width: 560px;
    margin: 0 auto;
}

.tradeCard {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 0.75rem;
    padding: 1rem;
}

.tLabel {
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin-bottom: 0.25rem;
}

.tradePage .form-control,
.tradePage .form-select {
    min-height: 2.75rem;
    font-size: 1rem;   /* 16px: stops iOS zooming into the field */
}

.sideToggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
}

.sideBtn {
    min-height: 3.25rem;
    border-radius: 0.6rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: transparent;
    color: inherit;
    font-weight: 700;
    font-size: 1.05rem;
}

.sideBtn .px {
    display: block;
    font-weight: 400;
    font-size: 0.85rem;
    opacity: 0.85;
}

.sideBtn.buy.active { background: #00CA73; border-color: #00CA73; color: #04110a; }
.sideBtn.sell.active { background: #F6465D; border-color: #F6465D; color: #1a0508; }

.typeToggle {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.35rem;
}

.typeBtn {
    min-height: 2.5rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: transparent;
    color: inherit;
    text-transform: capitalize;
}

.typeBtn.active { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.35); font-weight: 600; }

.tHint { text-transform: none; letter-spacing: 0; }

.openRow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    margin-top: 0.6rem;
}

.openInfo { min-width: 0; font-size: 0.9rem; }
.openSub { font-size: 0.8rem; color: var(--white-60); }
.rowBtn { min-height: 2.5rem; min-width: 3.5rem; }

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
