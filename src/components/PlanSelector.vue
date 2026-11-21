<script setup>
import { ref, nextTick } from 'vue'
import { plans, activePlanId, activePlan, createPlan, renamePlan, deletePlan } from '../utils/planStore'

const renaming = ref(false)
const nameDraft = ref('')
const renameInput = ref(null)

async function startRename() {
    nameDraft.value = activePlan.value.name
    renaming.value = true
    await nextTick()
    renameInput.value?.focus()
}

function commitRename() {
    if (!renaming.value) return
    renamePlan(activePlan.value.id, nameDraft.value)
    renaming.value = false
}

function onDelete() {
    if (plans.value.length <= 1) return
    if (confirm(`Delete "${activePlan.value.name}"? This can't be undone.`)) {
        deletePlan(activePlan.value.id)
    }
}
</script>

<template>
    <div class="planSelector d-flex flex-wrap align-items-center gap-2 mb-3">
        <!-- Plans as tabs, pushed to the right; the plan actions stay on the left. -->
        <div class="planTabs ms-auto order-last" role="tablist" aria-label="Plans">
            <button v-for="p in plans" :key="p.id" type="button" role="tab"
                :aria-selected="p.id === activePlanId" :class="['planTab', { active: p.id === activePlanId }]"
                v-on:click="activePlanId = p.id">#{{ p.id }} — {{ p.name }}</button>
        </div>

        <input v-if="renaming" ref="renameInput" type="text" class="form-control form-control-sm renameInput"
            v-model="nameDraft" v-on:keyup.enter="commitRename" v-on:keyup.esc="renaming = false"
            v-on:blur="commitRename" />
        <button v-else type="button" class="btn btn-outline-secondary btn-sm" title="Rename plan"
            v-on:click="startRename">
            <i class="uil uil-edit-alt"></i>
        </button>

        <button type="button" class="btn btn-outline-secondary btn-sm" title="New plan" v-on:click="createPlan">
            <i class="uil uil-plus me-1"></i>New plan
        </button>

        <button type="button" class="btn btn-outline-secondary btn-sm" title="Delete plan"
            :disabled="plans.length <= 1" v-on:click="onDelete">
            <i class="uil uil-trash-alt"></i>
        </button>
    </div>
</template>

<style scoped>
.renameInput {
    max-width: 160px;
}

.planTabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    justify-content: flex-end;
}

.planTab {
    padding: 0.25rem 0.75rem;
    font-size: 0.8rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.5rem;
    background: var(--black-bg-7);
    color: var(--white-60);
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}

.planTab:hover {
    color: var(--white-87);
    background: var(--surface-hover);
}

.planTab.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
}
</style>
