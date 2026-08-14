<script setup>
/**
 * Live MT5 state: open positions and equity, streamed from the host agent
 * (mt5-sync/mt5_live.py -> POST /api/live -> SSE here).
 *
 * Everything on this page is EPHEMERAL -- it is never read from MongoDB and never
 * written there. The journal pages answer "what happened"; this one answers "what
 * is happening", and the moment the agent stops the honest answer is "I don't
 * know", which is why staleness is shown loudly rather than freezing on the last
 * good numbers and looking live.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import dayjs from 'dayjs'
import { useTwoDecCurrencyFormat } from '../utils/utils'
import { usePipSize } from '../utils/addOrder'
import { useAuthHeaders, useAuthedUrl } from '../utils/apiAuth'

const snapshot = ref(null)
const connected = ref(false)
const lastFrameAt = ref(null)
const now = ref(Date.now())
let source = null
let clockTimer = null

// A live feed that silently stops is worse than one that says so: after 15s with
// no frame the numbers on screen are history, not "live".
const STALE_AFTER_MS = 15000
const secondsSinceFrame = computed(() =>
    lastFrameAt.value ? Math.floor((now.value - lastFrameAt.value) / 1000) : null)
const isStale = computed(() =>
    !lastFrameAt.value || (now.value - lastFrameAt.value) > STALE_AFTER_MS)

const positions = computed(() => (snapshot.value && snapshot.value.positions) || [])
const floating = computed(() => (snapshot.value ? snapshot.value.profit : 0))

/* Sorted worst-first: a losing position is the one that needs attention, and
   scanning down from the top should hit it before anything else. */
const sortedPositions = computed(() =>
    [...positions.value].sort((a, b) => a.profit - b.profit))

const totalVolume = computed(() =>
    positions.value.reduce((s, p) => s + (Number(p.volume) || 0), 0))

/* Exposure split by side. Total lot alone hides the shape of the book: 0.10 all
   one way and 0.05-up/0.05-down are the same number but completely different
   risk, so buy and sell are tracked separately and `net` shows what is actually
   exposed once the two offset. */
const volumeBySide = computed(() => {
    let buy = 0, sell = 0
    for (const p of positions.value) {
        const v = Number(p.volume) || 0
        if (p.side === 'buy') buy += v
        else sell += v
    }
    return { buy, sell, net: buy - sell, hedged: buy > 0 && sell > 0 }
})

// Lots come in 0.01 steps, so 2dp is exact -- no rounding to explain away.
const lot = (v) => v.toFixed(2)

function pnlClass(v) {
    if (v > 0) return 'pos'
    if (v < 0) return 'neg'
    return ''
}

/* Distance from entry IN PIPS, signed in the direction that is good for the
   position -- so a sell that has fallen reads positive, same as a buy that has
   risen. Shown in pips rather than raw price because that is the unit stops and
   targets are actually thought in: on gold a 2.90 price move is 290 pips, and
   "290" is the number you compare against your SL distance.
   usePipSize is the app's own table (gold 0.01, JPY pairs 0.01, the rest 0.0001),
   reused here so this agrees with the P&L maths elsewhere instead of hardcoding
   a divisor that would be wrong on any other symbol. */
function movePips(p) {
    const d = (Number(p.priceCurrent) || 0) - (Number(p.priceOpen) || 0)
    const directional = p.side === 'sell' ? -d : d
    return directional / usePipSize(p.symbol)
}

// Whole pips read cleanest, but a sub-pip move must not collapse to a bare "0".
function fmtPips(v) {
    const a = Math.abs(v)
    return a >= 10 ? v.toFixed(0) : v.toFixed(1)
}

function applySnapshot(s) {
    if (!s) return
    snapshot.value = s
    lastFrameAt.value = Date.now()
}

function connect() {
    source = new EventSource(useAuthedUrl('/api/live/stream'))
    source.onopen = () => { connected.value = true }
    source.onmessage = (e) => {
        connected.value = true
        try { applySnapshot(JSON.parse(e.data)) } catch { /* ignore a partial frame */ }
    }
    // EventSource reconnects on its own; just reflect the gap in the UI meanwhile.
    source.onerror = () => { connected.value = false }
}

onMounted(async () => {
    // Paint immediately from the stored snapshot instead of waiting up to a second
    // for the stream's first frame.
    try {
        const res = await fetch('/api/live', { headers: useAuthHeaders() })
        const j = await res.json()
        if (j && j.snapshot && !j.stale) applySnapshot(j.snapshot)
    } catch { /* the stream below is the real source */ }
    connect()
    clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
    if (source) source.close()
    if (clockTimer) clearInterval(clockTimer)
})
</script>

<template>
    <div class="row mt-2">
        <div class="col-12">

            <!-- Connection state, always visible: this page is only trustworthy
                 while the feed is actually flowing. -->
            <div class="liveBar mb-3">
                <span class="liveDot" v-bind:class="{ on: connected && !isStale }"></span>
                <span v-if="connected && !isStale" class="liveLabel">Live</span>
                <span v-else-if="snapshot" class="liveLabelStale">
                    Stale — no update for {{ secondsSinceFrame }}s. Is the live agent running?
                </span>
                <span v-else class="liveLabelStale">
                    Waiting for the live agent (mt5-sync/mt5_live.py) — start it, or run ./start.sh
                </span>
                <span v-if="snapshot" class="liveMeta ms-auto">
                    MT5 #{{ snapshot.login }} · {{ snapshot.currency }}
                </span>
            </div>

            <div v-if="snapshot">
                <!-- Balance vs equity is the whole point: banked money vs money
                     still on the table. -->
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
                        <!-- Only meaningful when both sides are open; otherwise net
                             just repeats the total above. -->
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
                                    <!-- MT5 reports "no stop" as 0.0, which must not render as a
                                         price of zero. -->
                                    <td class="num muted">{{ p.sl ? p.sl : '—' }}</td>
                                    <td class="num muted">{{ p.tp ? p.tp : '—' }}</td>
                                    <td class="num strong" v-bind:class="pnlClass(p.profit)">
                                        {{ p.profit >= 0 ? '+' : '' }}{{ useTwoDecCurrencyFormat(p.profit) }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div v-if="Object.keys(snapshot.ticks || {}).length" class="tickLine">
                        <span v-for="(t, sym) in snapshot.ticks" :key="sym" class="tickItem">
                            {{ sym }} <span class="muted">bid</span> {{ t.bid }}
                            <span class="muted">ask</span> {{ t.ask }}
                        </span>
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

/* Only the connected dot pulses — a frozen page should never look alive. */
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
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
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

/* Same green/red as the side tags in the table, so the two read as one language. */
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

/* De-emphasised so the number reads first and the unit just qualifies it. */
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

.tickLine {
    margin-top: 0.75rem;
    padding-top: 0.6rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
}

.tickItem { margin-right: 1.25rem; }
</style>
