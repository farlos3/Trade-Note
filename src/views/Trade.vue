<script setup>
/**
 * Place a market order from TradeNote. The order is only queued once a setup and a
 * reason are filled in; the host agent (mt5_live.py) sends it through MetaTrader 5
 * and reports back. Built mobile-first: one column, large touch targets.
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
const form = ref({ symbol: '', side: 'buy', lot: '0.01', sl: '', tp: '', setup: '', reason: '' })
const confirming = ref(false)
const busy = ref(false)
const error = ref('')
const order = ref(null)   // { id, status, message, price }
let stopLive = null
let pollTimer = null

const symbols = computed(() => Object.keys((snapshot.value && snapshot.value.ticks) || {}).sort())
const tick = computed(() => snapshot.value && snapshot.value.ticks ? snapshot.value.ticks[form.value.symbol] : null)
const price = computed(() => tick.value ? (form.value.side === 'buy' ? tick.value.ask : tick.value.bid) : null)
const terminalAccount = computed(() => snapshot.value && snapshot.value.login && snapshot.value.server
    ? `${snapshot.value.login}@${snapshot.value.server}` : null)
const accountMatches = computed(() => !!terminalAccount.value && terminalAccount.value === activeAccount.value)
const setupOptions = computed(() => setups.value.filter((s) => s.side === 'any' || s.side === form.value.side))

// Risk of this order in money and pips, so the size is decided with the cost in view.
const risk = computed(() => {
    const sl = Number(form.value.sl), lot = Number(form.value.lot)
    if (!price.value || !(sl > 0) || !(lot > 0)) return null
    const dist = Math.abs(price.value - sl)
    const money = dist * lot * useDefaultContractSize(form.value.symbol)
    const pips = dist / usePipSize(form.value.symbol)
    const rr = Number(form.value.tp) > 0 ? Math.abs(Number(form.value.tp) - price.value) / dist : null
    return { money, pips, rr }
})

const missing = computed(() => {
    const f = form.value
    const out = []
    if (!f.setup) out.push('setup')
    if (f.reason.trim().length < 10) out.push('reason (10+ characters)')
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

async function send() {
    busy.value = true
    error.value = ''
    try {
        const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { ...useAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...form.value, account: activeAccount.value, clientId: crypto.randomUUID() }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
        order.value = { id: j.id, status: j.status }
        confirming.value = false
        pollOrder()
    } catch (e) {
        error.value = e.message
        busy.value = false
    }
}

function pollOrder() {
    clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
        try {
            const res = await fetch(`/api/orders/${order.value.id}`, { headers: useAuthHeaders() })
            const j = await res.json()
            order.value = j
            if (['filled', 'rejected', 'expired'].includes(j.status)) {
                clearInterval(pollTimer)
                busy.value = false
                if (j.status === 'filled') form.value = { ...form.value, sl: '', tp: '', reason: '' }
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
                Review {{ form.side === 'buy' ? 'Buy' : 'Sell' }} {{ form.lot }} {{ form.symbol }}
            </button>
        </div>

        <!-- Second step on purpose: the order is real money. -->
        <div v-if="confirming" class="confirmBackdrop" v-on:click.self="confirming = false">
            <div class="confirmBox">
                <h5 class="mb-3">Send this order?</h5>
                <p class="mb-1"><strong>{{ form.side === 'buy' ? 'BUY' : 'SELL' }} {{ form.lot }} {{ form.symbol }}</strong> at market (~{{ fmt(price) }})</p>
                <p class="mb-1">SL {{ form.sl }} · TP {{ form.tp || '—' }}<span v-if="risk"> · risk {{ fmt(risk.money) }}</span></p>
                <p class="mb-1">Setup: {{ form.setup }}</p>
                <p class="mb-3 reasonEcho">{{ form.reason }}</p>
                <p class="txt-small text-muted">Account {{ activeAccount }}</p>
                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-outline-secondary flex-fill" v-on:click="confirming = false" :disabled="busy">Cancel</button>
                    <button type="button" class="btn flex-fill" :class="form.side === 'buy' ? 'btn-success' : 'btn-danger'"
                        v-on:click="send" :disabled="busy">{{ busy ? 'Sending…' : 'Send order' }}</button>
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

.statusBadge.filled { color: #00CA73; }
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
