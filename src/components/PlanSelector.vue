<script setup>
import { ref, nextTick } from 'vue'
import { plans, activePlanId, activePlan, createPlan, renamePlan, deletePlan } from '../utils/planStore'

/* Bootstrap's own dropdown-menu/dropdown-item (already dark-themed app-wide,
   see Nav.vue) — not a native <select>, whose default styling clashes with
   this app's inputs. */

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
        <div class="dropdown">
            <button class="btn btn-outline-secondary btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown"
                aria-expanded="false">
                <i class="uil uil-list-ul me-1"></i>#{{ activePlan.id }} — {{ activePlan.name }}
            </button>
            <ul class="dropdown-menu">
                <li v-for="p in plans" :key="p.id">
                    <a class="dropdown-item" v-bind:class="{ active: p.id === activePlanId }" href="#"
                        v-on:click.prevent="activePlanId = p.id">#{{ p.id }} — {{ p.name }}</a>
                </li>
            </ul>
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
</style>
