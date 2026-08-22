<script setup>
/**
 * Recurring cost of running the operation, as a list rather than one figure.
 *
 * Same shape as PlanDepositsEditor, with one deliberate difference: a deposit is
 * dated because it happened once, whereas these repeat every month, so a row
 * carries a LABEL instead of a date. What you want to know later is not when the
 * hosting bill arrived but which line is worth cutting -- and "25" on its own
 * cannot tell you that.
 */
import { computed } from 'vue'
import { addFixedCost, removeFixedCost } from '../utils/planStore'

const props = defineProps({ plan: { type: Object, required: true } })

const rows = computed(() => Array.isArray(props.plan.fixedCosts) ? props.plan.fixedCosts : [])

const total = computed(() =>
    rows.value.reduce((sum, c) => {
        const n = Number(c.amount)
        return sum + (Number.isFinite(n) ? n : 0)
    }, 0)
)

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
</script>

<template>
    <div class="costsEditor">
        <div class="d-flex align-items-center justify-content-between mb-2">
            <span class="planLabel mb-0">Fixed cost — what running this costs every month</span>
            <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="addFixedCost(props.plan)">
                <i class="uil uil-plus me-1"></i>Add cost
            </button>
        </div>

        <div v-if="!rows.length" class="hintLine mt-0 mb-0">
            No running costs added. Hosting, the box MT5 sits on, data — anything that
            leaves every month whether or not you trade.
        </div>
        <div v-else class="costRows">
            <div v-for="c in rows" :key="c.id" class="costRow">
                <input type="text" maxlength="40" placeholder="What for (Render, VPS, data…)"
                    class="form-control form-control-sm labelField" v-model="c.label" />
                <input type="number" min="0" step="1" placeholder="Per month"
                    class="form-control form-control-sm" v-model="c.amount" />
                <button type="button" class="btn btn-outline-danger btn-sm" title="Remove cost"
                    v-on:click="removeFixedCost(props.plan, c.id)">
                    <i class="uil uil-times"></i>
                </button>
            </div>

            <!-- The sum is what every calculation on the page actually uses, so it is
                 shown here rather than left to be added up by eye. -->
            <div class="costTotal">
                <span>Total per month</span>
                <strong>{{ fmt(total) }}</strong>
            </div>
        </div>
    </div>
</template>

<style scoped>
.planLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
}

.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
}

.costRows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 460px;
}

.costRow {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}

/* Sized by role rather than position, matching PlanDepositsEditor -- the label
   gets the room the date field has there, so the two lists line up. */
.costRow>.labelField {
    flex: 1.5;
    min-width: 0;
}

.costRow>input[type='number'] {
    flex: 1;
    min-width: 0;
}

.costRow>button {
    flex: 0 0 auto;
}

.costTotal {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    max-width: 460px;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-subtle);
    font-size: 0.82rem;
    color: var(--white-60);
}

.costTotal strong {
    color: var(--white-87);
    font-variant-numeric: tabular-nums;
}
</style>
