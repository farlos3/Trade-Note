<script setup>
/**
 * Mindset -- the rules the trader writes for themselves, and the one place that
 * shows them without a trade attached.
 *
 * Everything else in the Journal is anchored to something that happened: a day, a
 * week, an entry. This is anchored to nothing, on purpose. A conviction is written
 * once and is supposed to still bind months later, so the page leads with what is
 * PINNED rather than with what is newest -- otherwise the rules you most need in
 * front of you get pushed down by whatever you happened to write last night.
 */
import { ref, computed, onBeforeMount, nextTick } from 'vue'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(utc)
dayjs.extend(timezone)

import { timeZoneTrade } from '../stores/globals'
import { useGetMindsets, useSaveMindset, useSetMindsetPinned, useDeleteMindset } from '../utils/mindset'

const entries = ref([])
const loaded = ref(false)
const saving = ref(false)
const busyId = ref(null)

/* Composer. One form for both writing and editing -- an edit loads the entry into
   it rather than turning a card into a form, so there is only ever one place text
   is typed and one code path that saves it. */
const editingId = ref(null)
const title = ref('')
const body = ref('')
const theme = ref('')
const bodyEl = ref(null)

const isEditing = computed(() => !!editingId.value)
const canSave = computed(() => !!body.value.trim() && !saving.value)

const themes = computed(() => {
    const seen = new Map()
    for (const e of entries.value) {
        const t = (e.theme || '').trim()
        if (t) seen.set(t.toLowerCase(), t)
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
})

const filter = ref('')
const visible = computed(() =>
    filter.value ? entries.value.filter((e) => (e.theme || '').toLowerCase() === filter.value.toLowerCase())
        : entries.value
)
const pinned = computed(() => visible.value.filter((e) => e.pinned))
const rest = computed(() => visible.value.filter((e) => !e.pinned))

const dateLabel = (dateUnix) =>
    dayjs.unix(dateUnix).tz(timeZoneTrade.value || 'UTC').format('DD MMM YYYY')

async function reload() {
    try {
        entries.value = await useGetMindsets()
    } catch (e) {
        console.error('could not load mindset entries', e)
    }
}

function resetForm() {
    editingId.value = null
    title.value = ''
    body.value = ''
    theme.value = ''
}

async function submit() {
    if (!canSave.value) return
    saving.value = true
    try {
        await useSaveMindset({
            objectId: editingId.value,
            title: title.value,
            body: body.value,
            theme: theme.value,
        })
        // Re-read rather than splice the local list: pinned-then-newest ordering
        // lives in useGetMindsets, and duplicating it here is how the two drift.
        await reload()
        resetForm()
    } catch (e) {
        console.error('could not save the mindset entry', e)
    } finally {
        saving.value = false
    }
}

async function edit(entry) {
    editingId.value = entry.objectId
    title.value = entry.title
    body.value = entry.body
    theme.value = entry.theme
    await nextTick()
    if (bodyEl.value) {
        bodyEl.value.focus()
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }
}

async function togglePin(entry) {
    busyId.value = entry.objectId
    try {
        await useSetMindsetPinned(entry.objectId, !entry.pinned)
        await reload()
    } catch (e) {
        console.error('could not change the pin', e)
    } finally {
        busyId.value = null
    }
}

/* Two-step delete rather than a confirm dialog: the second click is the
   confirmation, and it cannot be dismissed by reflex the way a modal can be. */
const confirmingId = ref(null)
let confirmTimer = null
function askDelete(entry) {
    clearTimeout(confirmTimer)
    if (confirmingId.value === entry.objectId) return remove(entry)
    confirmingId.value = entry.objectId
    confirmTimer = setTimeout(() => { confirmingId.value = null }, 4000)
}
async function remove(entry) {
    confirmingId.value = null
    busyId.value = entry.objectId
    try {
        await useDeleteMindset(entry.objectId)
        if (editingId.value === entry.objectId) resetForm()
        await reload()
    } catch (e) {
        console.error('could not delete the mindset entry', e)
    } finally {
        busyId.value = null
    }
}

onBeforeMount(async () => {
    await reload()
    loaded.value = true
})
</script>

<template>
    <div class="mindsetPage">
        <!-- COMPOSER -->
        <section class="composer" :class="{ editing: isEditing }">
            <div class="composerHead">
                <span class="composerTitle">
                    <i class="uil me-2" :class="isEditing ? 'uil-edit' : 'uil-brain'"></i>
                    {{ isEditing ? 'Editing a principle' : 'Write a principle' }}
                </span>
                <button v-if="isEditing" type="button" class="linkBtn" v-on:click="resetForm">Cancel</button>
            </div>

            <input v-model="title" type="text" class="composerInput" maxlength="120"
                placeholder="Name it — “Cut the loser before it becomes a story”" />

            <textarea ref="bodyEl" v-model="body" rows="4" class="composerBody"
                placeholder="What is the rule, and what does breaking it actually cost you?"></textarea>

            <div class="composerFoot">
                <input v-model="theme" type="text" class="themeInput" maxlength="24" list="mindsetThemes"
                    placeholder="Theme (risk, patience, ego…)" />
                <datalist id="mindsetThemes">
                    <option v-for="t in themes" :key="t" :value="t"></option>
                </datalist>
                <button type="button" class="primaryBtn" :disabled="!canSave" v-on:click="submit">
                    <span v-if="saving" class="spinner-border spinner-border-sm me-2" role="status"></span>
                    {{ isEditing ? 'Save changes' : 'Add principle' }}
                </button>
            </div>
        </section>

        <!-- THEME FILTER -->
        <div v-if="themes.length" class="filterRow">
            <button type="button" class="chip" :class="{ on: filter === '' }" v-on:click="filter = ''">All</button>
            <button v-for="t in themes" :key="t" type="button" class="chip" :class="{ on: filter === t }"
                v-on:click="filter = t">{{ t }}</button>
        </div>

        <!-- PINNED -->
        <template v-if="pinned.length">
            <div class="sectionLabel"><i class="uil uil-thumbtack me-1"></i>Holding myself to these</div>
            <div class="grid">
                <article v-for="e in pinned" :key="e.objectId" class="card pinned">
                    <div class="cardTop">
                        <span v-if="e.theme" class="theme">{{ e.theme }}</span>
                        <span class="date">{{ dateLabel(e.dateUnix) }}</span>
                    </div>
                    <h3 v-if="e.title" class="cardTitle">{{ e.title }}</h3>
                    <p class="cardBody">{{ e.body }}</p>
                    <div class="cardActions">
                        <button type="button" class="iconBtn on" :disabled="busyId === e.objectId"
                            title="Unpin" v-on:click="togglePin(e)"><i class="uil uil-thumbtack"></i></button>
                        <button type="button" class="iconBtn" title="Edit" v-on:click="edit(e)">
                            <i class="uil uil-edit-alt"></i></button>
                        <button type="button" class="iconBtn danger" :class="{ armed: confirmingId === e.objectId }"
                            :disabled="busyId === e.objectId" v-on:click="askDelete(e)">
                            <i class="uil uil-trash-alt"></i>
                            <span v-if="confirmingId === e.objectId" class="ms-1">Sure?</span>
                        </button>
                    </div>
                </article>
            </div>
        </template>

        <!-- THE REST -->
        <div v-if="rest.length" class="sectionLabel">
            <i class="uil uil-notes me-1"></i>{{ pinned.length ? 'Everything else' : 'Written down' }}
        </div>
        <div v-if="rest.length" class="grid">
            <article v-for="e in rest" :key="e.objectId" class="card">
                <div class="cardTop">
                    <span v-if="e.theme" class="theme">{{ e.theme }}</span>
                    <span class="date">{{ dateLabel(e.dateUnix) }}</span>
                </div>
                <h3 v-if="e.title" class="cardTitle">{{ e.title }}</h3>
                <p class="cardBody">{{ e.body }}</p>
                <div class="cardActions">
                    <button type="button" class="iconBtn" :disabled="busyId === e.objectId"
                        title="Pin to the top" v-on:click="togglePin(e)"><i class="uil uil-thumbtack"></i></button>
                    <button type="button" class="iconBtn" title="Edit" v-on:click="edit(e)">
                        <i class="uil uil-edit-alt"></i></button>
                    <button type="button" class="iconBtn danger" :class="{ armed: confirmingId === e.objectId }"
                        :disabled="busyId === e.objectId" v-on:click="askDelete(e)">
                        <i class="uil uil-trash-alt"></i>
                        <span v-if="confirmingId === e.objectId" class="ms-1">Sure?</span>
                    </button>
                </div>
            </article>
        </div>

        <!-- EMPTY -->
        <div v-if="loaded && !entries.length" class="empty">
            <i class="uil uil-brain emptyIcon"></i>
            <div class="emptyTitle">Nothing written down yet</div>
            <p class="emptyBody">
                The rules you keep having to relearn are the ones worth writing here. Pin the
                ones you are actively holding yourself to and they stay at the top.
            </p>
        </div>
    </div>
</template>

<style scoped>
/* No page-level cap: 68rem stopped the composer well short of the right edge and
   left a band of empty screen beside it. WeeklyPlan already fills its column, so
   this matches the rest of the Journal rather than being the one page that does
   not. The reading measures that DO need a limit are set on the elements
   themselves, below. */
.mindsetPage {
    padding-bottom: 2.5rem;
}

/* ---- composer ---- */
.composer {
    background:
        radial-gradient(120% 140% at 0% 0%, rgba(47, 155, 255, 0.10), transparent 60%),
        var(--black-bg-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 1.1rem 1.2rem;
    margin-bottom: 1.5rem;
    transition: border-color 0.15s ease;
}

/* An edit in progress has to look different from a blank composer, or you cannot
   tell whether Save will create a second copy or change the one you clicked. */
.composer.editing {
    border-color: rgba(47, 155, 255, 0.5);
}

.composerHead {
    display: flex;
    align-items: center;
    margin-bottom: 0.8rem;
}

.composerTitle {
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--white-87);
}

.linkBtn {
    margin-left: auto;
    background: none;
    border: 0;
    font-size: 0.76rem;
    color: var(--white-60);
}

.linkBtn:hover { color: var(--white-87); }

.composerInput,
.composerBody,
.themeInput {
    width: 100%;
    background: var(--black-bg-7);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--white-87);
    padding: 0.55rem 0.7rem;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.composerInput:focus,
.composerBody:focus,
.themeInput:focus {
    border-color: var(--accent);
    background: var(--black-bg-5);
}

.composerInput {
    font-weight: 600;
    margin-bottom: 0.5rem;
}

.composerBody {
    line-height: 1.6;
    resize: vertical;
    min-height: 5.5rem;
}

.composerFoot {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
}

.themeInput {
    width: auto;
    flex: 1 1 12rem;
    font-size: 0.82rem;
    padding: 0.4rem 0.6rem;
}

.primaryBtn {
    margin-left: auto;
    background: var(--accent);
    border: 0;
    border-radius: var(--radius-sm);
    color: #08111c;
    font-size: 0.84rem;
    font-weight: 600;
    padding: 0.45rem 1.1rem;
    transition: filter 0.15s ease, opacity 0.15s ease;
}

.primaryBtn:hover:not(:disabled) { filter: brightness(1.1); }
.primaryBtn:disabled { opacity: 0.4; }

/* ---- filter ---- */
.filterRow {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-bottom: 1.1rem;
}

.chip {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    color: var(--white-60);
    font-size: 0.75rem;
    padding: 0.18rem 0.7rem;
    transition: all 0.15s ease;
}

.chip:hover { border-color: var(--border-strong); color: var(--white-87); }
.chip.on {
    background: var(--accent-soft);
    border-color: rgba(47, 155, 255, 0.45);
    color: var(--accent);
}

/* ---- cards ---- */
.sectionLabel {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--white-60);
    margin: 0 0 0.7rem;
}

/* auto-fit so one principle fills the row and eight tile neatly, without a
   hard-coded column count that leaves an empty track at either extreme. */
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
    gap: 0.85rem;
    margin-bottom: 1.8rem;
}

.card {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--black-bg-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 1rem 1.1rem 0.7rem;
    transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}

.card:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    background: var(--black-bg-7);
}

/* A pinned card is a rule in force, so it reads as one: brighter edge and a
   coloured spine down the side rather than a badge you have to look for. */
.card.pinned {
    border-color: rgba(47, 155, 255, 0.35);
    background:
        linear-gradient(90deg, rgba(47, 155, 255, 0.09), transparent 45%),
        var(--black-bg-5);
}

.card.pinned::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.9rem;
    bottom: 0.9rem;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
}

.cardTop {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
}

.theme {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.08rem 0.45rem;
    border-radius: 999px;
}

.date {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--white-38);
    font-variant-numeric: tabular-nums;
}

.cardTitle {
    font-size: 0.95rem;
    font-weight: 650;
    line-height: 1.35;
    color: var(--white-87);
    margin: 0 0 0.35rem;
}

.cardBody {
    font-size: 0.86rem;
    line-height: 1.6;
    color: var(--white-60);
    white-space: pre-wrap;
    margin: 0;
    flex: 1;
}

/* Actions stay out of the way until the card is hovered -- they are maintenance,
   not the content, and eight cards each showing three buttons is noise. */
.cardActions {
    display: flex;
    gap: 0.15rem;
    margin-top: 0.7rem;
    opacity: 0;
    transition: opacity 0.15s ease;
}

.card:hover .cardActions,
.cardActions:focus-within { opacity: 1; }

.iconBtn {
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--white-38);
    font-size: 0.9rem;
    padding: 0.2rem 0.45rem;
    display: inline-flex;
    align-items: center;
    transition: color 0.15s ease, background 0.15s ease;
}

.iconBtn:hover { color: var(--white-87); background: var(--surface-hover); }
.iconBtn.on { color: var(--accent); }
.iconBtn.danger:hover { color: var(--red-color); }

/* Armed = one more click deletes. Stays visible even without hover, so the state
   cannot be lost by the pointer drifting off the card mid-decision. */
.iconBtn.danger.armed {
    color: var(--red-color);
    background: rgba(246, 70, 93, 0.12);
    font-size: 0.75rem;
}

/* ---- empty ---- */
.empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--white-60);
}

.emptyIcon {
    font-size: 2.2rem;
    color: var(--white-38);
}

.emptyTitle {
    font-size: 1rem;
    font-weight: 600;
    color: var(--white-87);
    margin-top: 0.6rem;
}

.emptyBody {
    font-size: 0.86rem;
    line-height: 1.6;
    max-width: 30rem;
    margin: 0.4rem auto 0;
}
</style>
