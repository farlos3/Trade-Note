<script setup>
/**
 * Lot sizing for one day's target: given the $ the day should make, what lot
 * does that over a pip distance? Shared by Trading Plan (sized on the plan's
 * starting balance) and Plan vs Actual (sized on the balance you actually have
 * now) -- one block, so the two pages can never size the same plan two ways.
 *
 * The pip distance lives on the plan (`plan.targetPips`), the same field both
 * pages' tables size their per-day lots at. Blank means "show me the options",
 * not "no sizing".
 *
 * Lots are floored to the broker's 0.01 step (see floorLot): the % of the
 * account is a ceiling, and rounding up would size past it.
 */
import { computed } from 'vue'
import {
    numOrNull, pipValuePerLot, lotForDollars, floorLot, LOT_STEP, suggestedPipDistances,
    pipsRealismVerdict, fmt, toneClass,
} from '../utils/planMath'

const props = defineProps({
    plan: { type: Object, required: true },
    // The day's target in $ -- the caller decides which balance it is based on.
    dollars: { type: Number, default: null },
    // What `dollars` is, in words, e.g. "10.00% of 100".
    basis: { type: String, default: '' },
})

const sizing = computed(() => {
    const dollars = props.dollars
    if (!(dollars > 0)) return null
    const symbol = props.plan.symbol
    const perPipPerLot = pipValuePerLot(symbol)
    const row = (pips) => {
        const exact = lotForDollars(dollars, pips, symbol)
        const lot = floorLot(exact)
        const belowMin = !(lot >= LOT_STEP)
        return {
            pips,
            exact,
            lot,
            belowMin,
            // What the rounded-down lot actually makes over this distance --
            // shown so the rounding is visible rather than implied.
            dollars: belowMin ? null : lot * pips * perPipPerLot,
            ...pipsRealismVerdict(pips),
        }
    }
    const pips = numOrNull(props.plan.targetPips)
    return {
        dollars,
        perPipPerLot,
        // The furthest distance the 0.01 minimum lot can cover for this target;
        // beyond it the lot needed drops below what a broker will open.
        maxPipsAtMinLot: perPipPerLot > 0 ? dollars / (LOT_STEP * perPipPerLot) : null,
        single: pips > 0 ? row(pips) : null,
        options: pips > 0 ? [] : suggestedPipDistances(symbol).map(row),
    }
})
</script>

<template>
    <div class="sizingBlock" v-if="sizing">
        <div class="sizingHead mb-2">
            <span class="txt-small">
                <i class="uil uil-calculator me-1"></i>Lot size for
                <strong>{{ fmt(sizing.dollars) }}</strong>
                <span v-if="basis">({{ basis }})</span>
                on <strong>{{ plan.symbol || 'symbol' }}</strong> — enter a pip distance, or leave it
                blank to see the options.
            </span>
            <div class="sizingInput">
                <label class="sizingLabel">Pips</label>
                <input type="number" min="0" step="1" placeholder="optional, e.g. 1000"
                    class="form-control form-control-sm" v-model="plan.targetPips" />
            </div>
        </div>

        <!-- One distance given: the lot for it. -->
        <div v-if="sizing.single" class="sizingResult">
            <template v-if="!sizing.single.belowMin">
                <span class="sizingLot">{{ fmt(sizing.single.lot, 2) }} lot</span>
                over {{ fmt(sizing.single.pips, 0) }} pips ≈ {{ fmt(sizing.single.dollars) }}
                <span class="text-muted">(exact {{ fmt(sizing.single.exact, 4) }}, rounded down to the 0.01 step)</span>
                <div class="txt-small mt-1" v-bind:class="toneClass(sizing.single.tone)">
                    <i class="uil uil-info-circle me-1"></i>{{ fmt(sizing.single.pips, 0) }} pips — {{ sizing.single.verdict }}
                </div>
            </template>
            <span v-else class="redTrade">
                {{ fmt(sizing.single.pips, 0) }} pips needs {{ fmt(sizing.single.exact, 4) }} lot — below the
                0.01 minimum. At 0.01 lot this target is reached within
                {{ fmt(sizing.maxPipsAtMinLot, 0) }} pips.
            </span>
        </div>

        <!-- No distance: lay out the choices. -->
        <div v-else class="sizingTable">
            <table class="table table-sm mb-0">
                <thead>
                    <tr>
                        <th class="text-end">Pips</th>
                        <th class="text-end">Lot</th>
                        <th class="text-end">≈ $ at that lot</th>
                        <th>Distance</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="o in sizing.options" :key="o.pips">
                        <td class="text-end">{{ fmt(o.pips, 0) }}</td>
                        <td class="text-end fw-bold">
                            <span v-if="!o.belowMin">{{ fmt(o.lot, 2) }}</span>
                            <span v-else class="text-muted">&lt; 0.01</span>
                        </td>
                        <td class="text-end">
                            <span v-if="!o.belowMin">{{ fmt(o.dollars) }}</span>
                            <span v-else class="text-muted">below min lot</span>
                        </td>
                        <td v-bind:class="toneClass(o.tone)" class="txt-small">{{ o.verdict }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <p class="txt-small text-muted mt-2 mb-0">
            Lot = target ÷ (pips × {{ fmt(sizing.perPipPerLot, 2) }} per pip per 1.00 lot), rounded down so it
            never exceeds the target.
            <!-- Page-specific: where this target's balance comes from and where the
                 per-day lots are listed. -->
            <slot />
        </p>
    </div>
</template>

<style scoped>
/* Same separator as the tier editor it sits under on Trading Plan. */
.sizingBlock {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 0.6rem;
}

.sizingHead {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 0.75rem;
}

.sizingInput {
    min-width: 170px;
}

.sizingLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin-bottom: 0;
    display: block;
}

.sizingResult {
    font-size: 0.9rem;
    padding: 0.5rem 0.7rem;
    background-color: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
}

.sizingLot {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--accent);
    margin-right: 0.3rem;
}

.sizingTable {
    font-size: 0.85rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.4rem;
}

/* amber: "aggressive" verdicts sit between the app's green/red (toneClass) */
.warnTrade {
    color: #e0a800;
}
</style>
