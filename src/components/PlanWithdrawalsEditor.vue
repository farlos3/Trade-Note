<script setup>
import FpDate from './FpDate.vue'
import { addWithdrawal, removeWithdrawal } from '../utils/planStore'

const props = defineProps({ plan: { type: Object, required: true } })
</script>

<template>
    <div class="withdrawalsEditor">
        <div class="d-flex align-items-center justify-content-between mb-2">
            <span class="planLabel mb-0">Withdrawals — money taken out along the way</span>
            <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="addWithdrawal(props.plan)">
                <i class="uil uil-plus me-1"></i>Add withdrawal
            </button>
        </div>

        <div v-if="!props.plan.withdrawals || !props.plan.withdrawals.length" class="hintLine mt-0 mb-0">
            No withdrawals added.
        </div>
        <div v-else class="withdrawalRows">
            <div v-for="w in props.plan.withdrawals" :key="w.id" class="withdrawalRow">
                <div class="dateField">
                    <FpDate mode="date" v-model="w.date" placeholder="Select date" />
                    <i class="uil uil-calendar-alt dateIcon"></i>
                </div>
                <input type="number" min="0" step="10" placeholder="Amount" class="form-control form-control-sm amountField"
                    v-model="w.amount" />
                <input type="text" placeholder="Note — what for? (e.g. rent, profit take)"
                    class="form-control form-control-sm noteField" v-model="w.note" />
                <button type="button" class="btn btn-outline-danger btn-sm" title="Remove withdrawal"
                    v-on:click="removeWithdrawal(props.plan, w.id)">
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

.withdrawalRows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 640px;
}

.withdrawalRow {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
}

.withdrawalRow>.dateField {
    flex: 1.2;
    min-width: 130px;
}

.withdrawalRow>.amountField {
    flex: 1;
    min-width: 90px;
}

.withdrawalRow>.noteField {
    flex: 2;
    min-width: 160px;
}

.withdrawalRow>button {
    flex: 0 0 auto;
}

.dateField {
    position: relative;
}

.dateField :deep(input) {
    width: 100%;
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
    pointer-events: none;
}
</style>
