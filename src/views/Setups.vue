<script setup>
/**
 * Setup page: the trader's collection of trade setups, one card each -- the
 * rules as a numbered checklist on the left, the pattern diagram on the right,
 * the same arrangement as the trader's own setup slides.
 *
 * Data lives in the `setups` class (see utils/setups.js). Editing is inline on
 * the card rather than in a modal: a setup is short, and seeing the card it is
 * about while changing it beats a popup that hides it.
 */
import { ref, reactive, onBeforeMount } from 'vue'
import { useGetSetups, useSaveSetup, useDeleteSetup, rulesToText, textToRules } from '../utils/setups'

const setups = ref([])
const loaded = ref(false)
const error = ref('')
const busy = ref(false)

const SIDES = [
    { id: 'any', label: 'Any' },
    { id: 'buy', label: 'Buy' },
    { id: 'sell', label: 'Sell' },
]
const sideLabel = (id) => (SIDES.find((s) => s.id === id) || SIDES[0]).label

async function load() {
    try {
        setups.value = await useGetSetups()
    } catch (e) {
        error.value = 'Could not load setups: ' + (e.message || e)
    } finally {
        loaded.value = true
    }
}
onBeforeMount(load)

/* ---- Editing: one card at a time; `editing.objectId` null means a new one. ---- */
const editing = ref(null)
const form = reactive({ name: '', side: 'any', rulesText: '', imageData: '', imagePreview: '', removeImage: false })

function startEdit(setup) {
    editing.value = setup ? { objectId: setup.objectId, order: setup.order } : { objectId: null, order: setups.value.length }
    form.name = setup ? setup.name : ''
    form.side = setup ? setup.side : 'any'
    form.rulesText = setup ? rulesToText(setup.rules) : ''
    form.imageData = ''
    form.imagePreview = setup ? setup.imageUrl : ''
    form.removeImage = false
}

function cancelEdit() {
    editing.value = null
}

function onImagePicked(event) {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
        form.imageData = reader.result
        form.imagePreview = reader.result
        form.removeImage = false
    }
    reader.readAsDataURL(file)
}

function clearImage() {
    form.imageData = ''
    form.imagePreview = ''
    form.removeImage = true
}

async function save() {
    if (!form.name.trim() || busy.value) return
    busy.value = true
    error.value = ''
    try {
        await useSaveSetup({
            objectId: editing.value.objectId,
            name: form.name,
            side: form.side,
            rules: textToRules(form.rulesText),
            order: editing.value.order,
            imageData: form.imageData || null,
            removeImage: form.removeImage,
        })
        editing.value = null
        await load()
    } catch (e) {
        error.value = 'Could not save: ' + (e.message || e)
    } finally {
        busy.value = false
    }
}

async function remove(setup) {
    if (busy.value || !window.confirm(`Delete the setup "${setup.name}"?`)) return
    busy.value = true
    try {
        await useDeleteSetup(setup)
        await load()
    } catch (e) {
        error.value = 'Could not delete: ' + (e.message || e)
    } finally {
        busy.value = false
    }
}
</script>

<template>
    <div class="setupsPage p-3">
        <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
            <p class="txt-small text-muted mb-0">
                Your trade setups — the rules to check before an entry, next to the pattern they come from.
            </p>
            <button type="button" class="btn btn-outline-primary btn-sm" v-on:click="startEdit(null)"
                :disabled="editing && !editing.objectId">
                <i class="uil uil-plus me-1"></i>Add setup
            </button>
        </div>

        <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

        <!-- New setup editor sits on top so it's in view when "Add setup" is pressed. -->
        <div v-if="editing && !editing.objectId" class="setupCard mb-3">
            <div class="setupEditor">
                <div class="editorFields">
                    <label class="setupLabel">Name</label>
                    <input class="form-control form-control-sm mb-2" v-model="form.name" placeholder="e.g. Liquidity Sweep (Buy)" />
                    <label class="setupLabel">Side</label>
                    <select class="form-select form-select-sm mb-2" v-model="form.side">
                        <option v-for="s in SIDES" :key="s.id" :value="s.id">{{ s.label }}</option>
                    </select>
                    <label class="setupLabel">Rules — one per line; indent or start with "- " for a sub-point</label>
                    <textarea class="form-control form-control-sm mb-2" rows="8" v-model="form.rulesText"
                        placeholder="Bias Trend&#10;Wait for build base&#10;  - Demand line&#10;TP/SL more than 1.5"></textarea>
                    <label class="setupLabel">Diagram</label>
                    <input type="file" accept="image/*" class="form-control form-control-sm" v-on:change="onImagePicked" />
                </div>
                <div class="editorPreview">
                    <img v-if="form.imagePreview" :src="form.imagePreview" class="setupImage" alt="diagram preview" />
                    <div v-else class="noImage">No diagram</div>
                </div>
            </div>
            <div class="d-flex justify-content-end gap-2 mt-2">
                <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="cancelEdit">Cancel</button>
                <button type="button" class="btn btn-success btn-sm" v-on:click="save" :disabled="!form.name.trim() || busy">
                    {{ busy ? 'Saving…' : 'Save setup' }}</button>
            </div>
        </div>

        <div v-if="loaded && !setups.length && !editing" class="hintLine">
            No setups yet — add your first one with <strong>Add setup</strong>.
        </div>

        <div v-for="(setup, index) in setups" :key="setup.objectId" class="setupCard mb-3">
            <!-- ---- Editing this card ---- -->
            <template v-if="editing && editing.objectId === setup.objectId">
                <div class="setupEditor">
                    <div class="editorFields">
                        <label class="setupLabel">Name</label>
                        <input class="form-control form-control-sm mb-2" v-model="form.name" />
                        <label class="setupLabel">Side</label>
                        <select class="form-select form-select-sm mb-2" v-model="form.side">
                            <option v-for="s in SIDES" :key="s.id" :value="s.id">{{ s.label }}</option>
                        </select>
                        <label class="setupLabel">Rules — one per line; indent or start with "- " for a sub-point</label>
                        <textarea class="form-control form-control-sm mb-2" rows="9" v-model="form.rulesText"></textarea>
                        <label class="setupLabel">Diagram</label>
                        <div class="d-flex gap-2 align-items-center">
                            <input type="file" accept="image/*" class="form-control form-control-sm" v-on:change="onImagePicked" />
                            <button v-if="form.imagePreview" type="button" class="btn btn-link btn-sm text-danger p-0"
                                v-on:click="clearImage">Remove</button>
                        </div>
                    </div>
                    <div class="editorPreview">
                        <img v-if="form.imagePreview" :src="form.imagePreview" class="setupImage" alt="diagram preview" />
                        <div v-else class="noImage">No diagram</div>
                    </div>
                </div>
                <div class="d-flex justify-content-end gap-2 mt-2">
                    <button type="button" class="btn btn-outline-secondary btn-sm" v-on:click="cancelEdit">Cancel</button>
                    <button type="button" class="btn btn-success btn-sm" v-on:click="save" :disabled="!form.name.trim() || busy">
                        {{ busy ? 'Saving…' : 'Save setup' }}</button>
                </div>
            </template>

            <!-- ---- Reading it ---- -->
            <template v-else>
                <div class="setupHead">
                    <span class="setupNum">{{ index + 1 }}</span>
                    <span class="setupName">{{ setup.name }}</span>
                    <span v-if="setup.side !== 'any'" class="sideBadge" v-bind:class="'side-' + setup.side">{{ sideLabel(setup.side) }}</span>
                    <span class="ms-auto setupActions">
                        <i class="uil uil-edit-alt pointerClass" title="Edit" v-on:click="startEdit(setup)"></i>
                        <i class="uil uil-trash-alt pointerClass ms-2" title="Delete" v-on:click="remove(setup)"></i>
                    </span>
                </div>
                <div class="setupBody" v-bind:class="{ withImage: setup.imageUrl }">
                    <ol class="setupRules">
                        <li v-for="(rule, i) in setup.rules" :key="i">
                            {{ rule.text }}
                            <ol v-if="rule.sub && rule.sub.length" type="a" class="setupSub">
                                <li v-for="(sub, j) in rule.sub" :key="j">{{ sub }}</li>
                            </ol>
                        </li>
                    </ol>
                    <a v-if="setup.imageUrl" :href="setup.imageUrl" target="_blank" rel="noopener" class="setupImageLink"
                        title="Open full size">
                        <img :src="setup.imageUrl" :alt="setup.name + ' diagram'" class="setupImage" loading="lazy" />
                    </a>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.setupCard {
    border: 1px solid rgba(255, 255, 255, 0.06);
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 0.6rem;
    padding: 0.9rem 1rem;
}

.setupHead {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
}

.setupNum {
    font-size: 0.75rem;
    color: var(--white-60);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    min-width: 1.6rem;
    text-align: center;
    padding: 0.05rem 0.4rem;
}

.setupName {
    font-weight: 700;
    font-size: 1.05rem;
}

.sideBadge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    border: 1px solid currentColor;
}

.side-buy { color: #00CA73; }
.side-sell { color: #ef4444; }

.setupActions {
    color: var(--white-60);
}

/* Rules left, diagram right -- the layout of the setup slides themselves.
   Stacks on narrow screens, diagram first being less useful than the rules. */
.setupBody {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
}

@media (min-width: 992px) {
    .setupBody.withImage {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
}

.setupRules {
    margin: 0;
    padding-left: 1.3rem;
    line-height: 1.7;
}

.setupSub {
    padding-left: 1.2rem;
    color: var(--white-60);
}

.setupImageLink {
    display: block;
}

.setupImage {
    display: block;
    width: 100%;
    max-height: 22rem;
    object-fit: contain;
    background: #000;
    border-radius: 0.5rem;
    border: 1px solid var(--border-subtle);
}

.setupEditor {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
}

@media (min-width: 992px) {
    .setupEditor {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
}

.setupLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin-bottom: 0.2rem;
    display: block;
}

.noImage {
    height: 100%;
    min-height: 8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--white-60);
    border: 1px dashed var(--border-subtle);
    border-radius: 0.5rem;
}

.hintLine {
    font-size: 0.85rem;
    color: var(--white-60);
}
</style>
