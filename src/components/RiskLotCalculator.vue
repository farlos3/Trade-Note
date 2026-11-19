<script setup>
import { reactive, computed, watch } from 'vue'
import { activePlan } from '../utils/planStore'
import { useScopedMt5Balance } from '../utils/mt5Accounts'
import {
    numOrNull, calculateRiskLot, suggestedPipDistances,
    pipSizeFor, pipValuePerLot, lotForDollars, floorLot, LOT_STEP, fmt, fmtCompact,
} from '../utils/planMath'

const STORAGE_KEY = 'tradenote_risk_calc_v1'
const SYMBOLS = ['XAUUSD', 'USA100', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'USOIL']
const PCT_PRESETS = [0.5, 1, 2, 3, 5]
const AMOUNT_PRESETS = [10, 25, 50, 100, 250]

function loadState() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY))
        if (raw && typeof raw === 'object') return raw
    } catch { /* ignore */ }
    return {}
}

const saved = loadState()
const mt5Balance = computed(() => useScopedMt5Balance())
const planStartBalance = computed(() => numOrNull(activePlan.value.startBalance))

const form = reactive({
    balance: saved.balance ?? (mt5Balance.value != null ? String(mt5Balance.value) : (activePlan.value.startBalance || '')),
    riskMode: saved.riskMode === 'amount' ? 'amount' : 'pct',
    riskPercent: saved.riskPercent ?? '1',
    riskAmount: saved.riskAmount ?? '',
    symbol: saved.symbol || activePlan.value.symbol || 'XAUUSD',
    slPips: saved.slPips ?? '',
    pipValueOverride: saved.pipValueOverride ?? '',
})

watch(form, (val) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...val }))
    } catch { /* ignore */ }
}, { deep: true })

// Auto-fill balance on first mount if still blank when MT5 account finishes loading
watch(mt5Balance, (bal) => {
    if ((form.balance === '' || form.balance == null) && Number.isFinite(bal) && bal > 0) {
        form.balance = String(Number(bal.toFixed(2)))
    }
})

const isAmountMode = computed(() => form.riskMode === 'amount')

const detectedPipSize = computed(() => pipSizeFor(form.symbol))
const detectedPipValue = computed(() => pipValuePerLot(form.symbol))
const effectivePipValue = computed(() => {
    const custom = numOrNull(form.pipValueOverride)
    return custom > 0 ? custom : detectedPipValue.value
})

const slPresets = computed(() => suggestedPipDistances(form.symbol))

const result = computed(() => calculateRiskLot({
    balance: numOrNull(form.balance),
    riskMode: form.riskMode,
    riskPercent: numOrNull(form.riskPercent),
    riskAmount: numOrNull(form.riskAmount),
    slPips: numOrNull(form.slPips),
    symbol: form.symbol,
    pipValueOverride: numOrNull(form.pipValueOverride),
}))

/* Quick comparison across common SL distances for the current risk limit */
const riskBudgetDollars = computed(() => {
    if (isAmountMode.value) {
        const a = numOrNull(form.riskAmount)
        return a > 0 ? a : null
    }
    const bal = numOrNull(form.balance)
    const pct = numOrNull(form.riskPercent)
    return bal > 0 && pct > 0 ? bal * (pct / 100) : null
})

const slComparisonRows = computed(() => {
    const dollars = riskBudgetDollars.value
    const perPip = effectivePipValue.value
    if (!(dollars > 0) || !(perPip > 0)) return []
    const bal = numOrNull(form.balance)
    return slPresets.value.map((sl) => {
        const exact = numOrNull(form.pipValueOverride) > 0
            ? dollars / (sl * perPip)
            : lotForDollars(dollars, sl, form.symbol)
        const lot = floorLot(exact)
        const belowMin = !(lot >= LOT_STEP)
        const actualRisk = belowMin ? null : lot * sl * perPip
        return {
            sl,
            lot,
            belowMin,
            actualRisk,
            actualRiskPct: actualRisk != null && bal > 0 ? (actualRisk / bal) * 100 : null,
        }
    })
})

function useBalance(val) {
    if (val != null && Number.isFinite(Number(val)) && Number(val) > 0) {
        form.balance = String(Number(Number(val).toFixed(2)))
    }
}
</script>

<template>
    <div class="riskCalcWrap">
        <p class="txt-small text-muted mb-3">
            Calculate the exact lot size that caps your loss at your acceptable risk if Stop-Loss is hit.
            Lots are rounded down to the broker's <code>0.01</code> step so actual risk never exceeds your limit.
        </p>

        <!-- ==================== INPUTS ==================== -->
        <div class="planCard mb-3">
            <div class="calcGrid">
                <!-- Account Balance -->
                <div class="calcField">
                    <div class="fieldHead">
                        <label class="planLabel mb-0">Account balance ($)</label>
                    </div>
                    <input type="number" min="0" step="100" placeholder="e.g. 1000"
                        class="form-control form-control-sm" v-model="form.balance" />
                    <div class="presetRow mt-1" v-if="mt5Balance > 0 || planStartBalance > 0">
                        <button v-if="mt5Balance > 0" type="button" class="miniChip"
                            v-on:click="useBalance(mt5Balance)"
                            title="Fill from active MT5 account balance">
                            MT5: {{ fmtCompact(mt5Balance, 0) }}
                        </button>
                        <button v-if="planStartBalance > 0" type="button" class="miniChip"
                            v-on:click="useBalance(planStartBalance)"
                            title="Fill from active plan starting balance">
                            Plan: {{ fmtCompact(planStartBalance, 0) }}
                        </button>
                    </div>
                </div>

                <!-- Risk Tolerance -->
                <div class="calcField">
                    <div class="fieldHead">
                        <label class="planLabel mb-0">
                            {{ isAmountMode ? 'Max risk ($)' : 'Max risk (%)' }}
                        </label>
                        <div class="btn-group btn-group-xs modeSwitch" role="group" aria-label="Risk unit">
                            <button type="button" class="btn btn-xs"
                                v-bind:class="!isAmountMode ? 'btn-primary' : 'btn-outline-secondary'"
                                v-on:click="form.riskMode = 'pct'">%</button>
                            <button type="button" class="btn btn-xs"
                                v-bind:class="isAmountMode ? 'btn-primary' : 'btn-outline-secondary'"
                                v-on:click="form.riskMode = 'amount'">$</button>
                        </div>
                    </div>
                    <input v-if="!isAmountMode" type="number" min="0" step="0.25" placeholder="e.g. 1"
                        class="form-control form-control-sm" v-model="form.riskPercent" />
                    <input v-else type="number" min="0" step="5" placeholder="e.g. 20"
                        class="form-control form-control-sm" v-model="form.riskAmount" />
                    <div class="presetRow mt-1">
                        <template v-if="!isAmountMode">
                            <button v-for="p in PCT_PRESETS" :key="p" type="button"
                                class="miniChip"
                                v-bind:class="{ active: Number(form.riskPercent) === p }"
                                v-on:click="form.riskPercent = String(p)">{{ p }}%</button>
                        </template>
                        <template v-else>
                            <button v-for="a in AMOUNT_PRESETS" :key="a" type="button"
                                class="miniChip"
                                v-bind:class="{ active: Number(form.riskAmount) === a }"
                                v-on:click="form.riskAmount = String(a)">${{ a }}</button>
                        </template>
                    </div>
                </div>

                <!-- Symbol -->
                <div class="calcField">
                    <div class="fieldHead">
                        <label class="planLabel mb-0">Symbol</label>
                    </div>
                    <input type="text" placeholder="e.g. XAUUSD, USA100"
                        class="form-control form-control-sm" v-model="form.symbol" />
                    <div class="presetRow mt-1">
                        <button v-for="sym in SYMBOLS" :key="sym" type="button"
                            class="miniChip"
                            v-bind:class="{ active: (form.symbol || '').toUpperCase() === sym }"
                            v-on:click="form.symbol = sym">{{ sym }}</button>
                    </div>
                </div>

                <!-- Stop-Loss Distance -->
                <div class="calcField">
                    <div class="fieldHead">
                        <label class="planLabel mb-0">
                            Stop-loss ({{ detectedPipSize >= 1 ? 'points' : 'pips' }})
                        </label>
                    </div>
                    <input type="number" min="0" step="1" placeholder="e.g. 300"
                        class="form-control form-control-sm" v-model="form.slPips" />
                    <div class="presetRow mt-1">
                        <button v-for="d in slPresets" :key="d" type="button"
                            class="miniChip"
                            v-bind:class="{ active: Number(form.slPips) === d }"
                            v-on:click="form.slPips = String(d)">{{ d }}</button>
                    </div>
                </div>
            </div>

            <!-- Spec bar + optional custom pip value -->
            <div class="specBar mt-3">
                <span class="txt-small text-muted">
                    <i class="uil uil-sliders-v-alt me-1"></i>
                    <strong>{{ form.symbol || 'Symbol' }}</strong>:
                    1 {{ detectedPipSize >= 1 ? 'point' : 'pip' }} = <code>{{ detectedPipSize }}</code>
                    · <strong>${{ fmt(effectivePipValue, 2) }}</strong> / {{ detectedPipSize >= 1 ? 'pt' : 'pip' }} per 1.00 lot
                    <span v-if="riskBudgetDollars">
                        · Risk budget: <strong>${{ fmt(riskBudgetDollars, 2) }}</strong>
                        <span v-if="numOrNull(form.balance) > 0">
                            ({{ fmt((riskBudgetDollars / numOrNull(form.balance)) * 100, 2) }}%)
                        </span>
                    </span>
                </span>
                <div class="customPipWrap">
                    <label class="txt-x-small text-muted mb-0">Custom $/pip/lot (optional)</label>
                    <input type="number" min="0" step="0.1" :placeholder="fmt(detectedPipValue, 2)"
                        class="form-control form-control-sm customPipInput" v-model="form.pipValueOverride" />
                </div>
            </div>
        </div>

        <!-- ==================== RESULT HERO ==================== -->
        <div v-if="result" class="planCard mb-3">
            <div v-if="!result.belowMin" class="heroRow">
                <div class="heroMain">
                    <div class="statLabel">Recommended Lot Size</div>
                    <div class="heroLot">{{ fmt(result.flooredLot, 2) }} <span class="heroLotUnit">lot</span></div>
                    <div class="txt-small text-muted">
                        Exact: {{ fmt(result.exactLot, 4) }} lot (floored to 0.01 step)
                    </div>
                </div>
                <div class="statGrid flex-grow-1">
                    <div class="statTile">
                        <div class="statLabel">Max Risk Allowed</div>
                        <div class="statValue">${{ fmt(result.riskDollars, 2) }}</div>
                        <div class="statSub" v-if="result.riskPctOfBalance != null">
                            {{ fmt(result.riskPctOfBalance, 2) }}% of balance
                        </div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Actual Risk @ {{ fmt(result.flooredLot, 2) }}</div>
                        <div class="statValue greenTrade">${{ fmt(result.actualRiskDollars, 2) }}</div>
                        <div class="statSub" v-if="result.actualRiskPct != null">
                            {{ fmt(result.actualRiskPct, 2) }}% of balance
                        </div>
                    </div>
                    <div class="statTile">
                        <div class="statLabel">Stop-Loss Distance</div>
                        <div class="statValue">{{ fmt(result.slPips, 0) }}</div>
                        <div class="statSub">
                            {{ result.pipSize >= 1 ? 'points' : 'pips' }} ({{ fmt(result.slPips * result.pipSize, result.pipSize >= 1 ? 2 : 4) }} price move)
                        </div>
                    </div>
                </div>
            </div>

            <div v-else class="belowMinBox">
                <div class="redTrade fw-bold mb-1">
                    <i class="uil uil-exclamation-triangle me-1"></i>
                    Calculated size is {{ fmt(result.exactLot, 4) }} lot — below the 0.01 minimum lot.
                </div>
                <p class="txt-small text-muted mb-0">
                    At <strong>0.01 lot</strong> with {{ fmt(result.slPips, 0) }} {{ result.pipSize >= 1 ? 'points' : 'pips' }} SL,
                    you risk <strong>${{ fmt(result.minLotRiskDollars, 2) }}</strong>
                    <span v-if="result.minLotRiskPct != null"> ({{ fmt(result.minLotRiskPct, 2) }}% of balance)</span>.
                    To stay within your <strong>${{ fmt(result.riskDollars, 2) }}</strong> risk limit at 0.01 lot,
                    maximum SL is <strong>{{ fmt(result.maxSlAtMinLot, 0) }}</strong> {{ result.pipSize >= 1 ? 'points' : 'pips' }}.
                </p>
            </div>

            <!-- R:R Target Table -->
            <div class="mt-3">
                <div class="planCardTitle mb-2">
                    Take-Profit &amp; Reward by R:R
                    <span class="txt-small text-muted fw-normal ms-1">
                        (at {{ result.belowMin ? '0.01' : fmt(result.flooredLot, 2) }} lot)
                    </span>
                </div>
                <div class="tableScroll">
                    <table class="table table-sm breakTable mb-0">
                        <thead>
                            <tr>
                                <th>R:R</th>
                                <th class="text-end">TP ({{ result.pipSize >= 1 ? 'points' : 'pips' }})</th>
                                <th class="text-end">Expected Profit</th>
                                <th class="text-end" v-if="numOrNull(form.balance) > 0">Return %</th>
                                <th class="text-end" v-if="numOrNull(form.balance) > 0">New Balance</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in result.rrTable" :key="row.label">
                                <td class="fw-bold">{{ row.label }}</td>
                                <td class="text-end">{{ fmt(row.tpPips, 0) }}</td>
                                <td class="text-end greenTrade">+${{ fmt(row.profitDollars, 2) }}</td>
                                <td class="text-end greenTrade" v-if="numOrNull(form.balance) > 0">
                                    +{{ fmt(row.returnPct, 2) }}%
                                </td>
                                <td class="text-end fw-bold" v-if="numOrNull(form.balance) > 0">
                                    ${{ fmt(row.projectedBalance, 2) }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div v-else class="planCard mb-3">
            <div class="hintLine mt-0">
                <span v-if="!isAmountMode && !(numOrNull(form.balance) > 0)">
                    Enter your account balance, risk %, and stop-loss distance to calculate the lot size.
                </span>
                <span v-else>
                    Enter your acceptable risk and stop-loss distance above to calculate the recommended lot size.
                </span>
            </div>
        </div>

        <!-- ==================== QUICK SL TABLE ==================== -->
        <div v-if="slComparisonRows.length" class="planCard">
            <div class="planCardTitle mb-2">
                Lot Size Across SL Distances
                <span class="txt-small text-muted fw-normal ms-1">
                    for ${{ fmt(riskBudgetDollars, 2) }} max risk on {{ form.symbol || 'Symbol' }}
                </span>
            </div>
            <div class="tableScroll">
                <table class="table table-sm breakTable mb-0">
                    <thead>
                        <tr>
                            <th class="text-end">Stop-Loss ({{ detectedPipSize >= 1 ? 'points' : 'pips' }})</th>
                            <th class="text-end">Lot Size</th>
                            <th class="text-end">Actual Risk ($)</th>
                            <th class="text-end" v-if="numOrNull(form.balance) > 0">Actual Risk (%)</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="r in slComparisonRows" :key="r.sl"
                            v-bind:class="{ activeSlRow: Number(form.slPips) === r.sl }">
                            <td class="text-end">{{ fmt(r.sl, 0) }}</td>
                            <td class="text-end fw-bold lotCell">
                                <span v-if="!r.belowMin">{{ fmt(r.lot, 2) }}</span>
                                <span v-else class="text-muted">&lt; 0.01</span>
                            </td>
                            <td class="text-end">
                                <span v-if="!r.belowMin">${{ fmt(r.actualRisk, 2) }}</span>
                                <span v-else class="text-muted">below min lot</span>
                            </td>
                            <td class="text-end" v-if="numOrNull(form.balance) > 0">
                                <span v-if="!r.belowMin">{{ fmt(r.actualRiskPct, 2) }}%</span>
                                <span v-else class="text-muted">—</span>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</template>

<style scoped>
.calcGrid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.9rem;
    align-items: start;
}

@media (max-width: 992px) {
    .calcGrid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 576px) {
    .calcGrid {
        grid-template-columns: 1fr;
    }
}

.calcField {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.fieldHead {
    min-height: 26px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    margin-bottom: 0.35rem;
}

.planCard {
    border: 1px solid rgba(255, 255, 255, 0.06);
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 0.6rem;
    padding: 0.9rem 1rem;
}

.planCardTitle {
    font-weight: 700;
}

.planLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    display: block;
    line-height: 1.2;
}

.presetRow {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}

.miniChip {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--white-60);
    border-radius: 0.35rem;
    padding: 0.12rem 0.45rem;
    font-size: 0.72rem;
    line-height: 1.3;
    cursor: pointer;
    transition: all 0.12s ease;
}

.miniChip:hover {
    color: var(--white-87);
    border-color: rgba(255, 255, 255, 0.28);
}

.miniChip.active {
    background-color: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
}

.modeSwitch .btn-xs {
    padding: 0.1rem 0.48rem;
    font-size: 0.72rem;
    line-height: 1.2;
    background-color: var(--black-bg-7);
    border-color: var(--border-strong);
    color: var(--white-60);
}

.modeSwitch .btn-xs.btn-primary {
    background-color: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
}

.specBar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 0.65rem;
}

.customPipWrap {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    white-space: nowrap;
}

.customPipInput {
    width: 96px;
}

.heroRow {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: stretch;
}

.heroMain {
    min-width: 210px;
    padding: 0.75rem 1rem;
    border-radius: 0.6rem;
    background-color: var(--accent-soft);
    border: 1px solid var(--accent);
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.heroLot {
    font-size: 2rem;
    font-weight: 800;
    color: var(--accent);
    line-height: 1.15;
    margin: 0.15rem 0;
}

.heroLotUnit {
    font-size: 1rem;
    font-weight: 600;
    opacity: 0.85;
}

.statGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
    gap: 0.75rem;
}

.statTile {
    background-color: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
    min-width: 0;
}

.statLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
}

.statValue {
    font-size: 1.35rem;
    font-weight: 700;
    margin-top: 0.15rem;
    overflow-wrap: anywhere;
}

.statSub {
    font-size: 0.72rem;
    opacity: 0.6;
}

.belowMinBox {
    padding: 0.75rem 0.9rem;
    border-radius: 0.5rem;
    background-color: rgba(246, 70, 93, 0.08);
    border: 1px solid rgba(246, 70, 93, 0.25);
}

.tableScroll {
    max-height: 360px;
    overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.4rem;
}

.tableScroll thead th {
    position: sticky;
    top: 0;
    background-color: #1b1f2a;
    z-index: 1;
}

.breakTable {
    font-size: 0.85rem;
}

.lotCell {
    color: var(--accent);
}

.activeSlRow {
    background-color: rgba(47, 155, 255, 0.1);
}

.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
}
</style>
