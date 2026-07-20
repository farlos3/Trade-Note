<script setup>
import FpDate from './FpDate.vue'
import { addDeposit, removeDeposit } from '../utils/planStore'

const props = defineProps({ plan: { type: Object, required: true } })
</script>

<template>
    <div class="depositsEditor">
        <div class="d-flex align-items-center justify-content-between mb-2">
            <span class="planLabel mb-0">Deposits — add cash whenever you actually put it in</span>
            <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="addDeposit(props.plan)">
                <i class="uil uil-plus me-1"></i>Add deposit
            </button>
        </div>

        <div v-if="!props.plan.deposits.length" class="hintLine mt-0 mb-0">No deposits added.</div>
        <div v-else class="depositRows">
            <div v-for="d in props.plan.deposits" :key="d.id" class="depositRow">
                <!--
                    flatpickr's altInput:true hides the original <input> (type=hidden)
                    and inserts a NEW visible <input> as its next sibling — so this
                    wrapper ends up with 2 real DOM children (one hidden), and a 3rd
                    (the icon). Isolating that pair in its own wrapper, and sizing
                    .depositRow's direct children by type/tag rather than :nth-child,
                    keeps the layout stable regardless of what flatpickr injects here.
                -->
                <div class="dateField">
                    <FpDate mode="date" v-model="d.date" placeholder="Select date" />
                    <i class="uil uil-calendar-alt dateIcon"></i>
                </div>
                <input type="number" min="0" step="10" placeholder="Amount" class="form-control form-control-sm"
                    v-model="d.amount" />
                <button type="button" class="btn btn-outline-danger btn-sm" title="Remove deposit"
                    v-on:click="removeDeposit(props.plan, d.id)">
                    <i class="uil uil-times"></i>
                </button>
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

.depositRows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 460px;
}

.depositRow {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}

/* Target by type/role, not DOM position — flatpickr mutates the date field's
   internal structure at runtime (see the comment in the template), which would
   silently break :nth-child-based sizing. */
.depositRow>.dateField {
    flex: 1.5;
    min-width: 0;
}

.depositRow>input[type='number'] {
    flex: 1;
    min-width: 0;
}

.depositRow>button {
    flex: 0 0 auto;
}

.dateField {
    position: relative;
}

.dateField :deep(input) {
    width: 100%;
    /* room for the calendar icon so typed text never overlaps it */
    padding-right: 1.9rem;
    font-size: 0.875rem;
}

.dateIcon {
    position: absolute;
    right: 0.65rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--white-60);
    font-size: 0.85rem;
    /* the input already handles the click; the icon is a visual cue only */
    pointer-events: none;
}
</style>
