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
import { ref, computed, onBeforeMount, onMounted, onUnmounted, nextTick } from 'vue'
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

/* A colour per theme, derived from its own name.
 *
 * Hashed rather than assigned, so a theme keeps the same colour forever without
 * anything being stored, and two people typing "risk" get the same one. Chosen
 * from a fixed set rather than a free hue, because an arbitrary hue lands on
 * navy or brown often enough to be unreadable on this background -- every entry
 * here is picked to carry on --black-bg-5.
 *
 * Case-folded and trimmed so "Risk", "risk " and "RISK" are one theme, matching
 * how the filter already compares them.
 */
const THEME_COLORS = [
    '#2f9bff', // blue
    '#34d399', // green
    '#f59e0b', // amber
    '#f472b6', // pink
    '#a78bfa', // violet
    '#22d3ee', // cyan
    '#fb923c', // orange
    '#a3e635', // lime
    '#e879f9', // fuchsia
]

const themeKey = (name) => (name || '').trim().toLowerCase()

function hashTheme(key) {
    let h = 0
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0
    return h
}

/* theme -> colour, assigned so that no two themes in use share one.
 *
 * A plain hash was not enough: eight themes into eight slots collide almost
 * always (the birthday problem), and in practice "risk" and "process" came out
 * the same lime, which defeats the point of colouring them at all. So each theme
 * still starts at its hashed slot -- keeping the colour stable and independent of
 * insertion order -- and only steps to the next free one if that slot is taken.
 *
 * Resolved in sorted order so the outcome depends on the SET of themes, not on
 * which card happened to render first. Past nine themes the palette is exhausted
 * and colours legitimately repeat; nine distinct labels is already more than this
 * page is meant to hold.
 */
const themeColorMap = computed(() => {
    const map = {}
    const taken = new Set()
    for (const name of themes.value) {
        const key = themeKey(name)
        const start = hashTheme(key) % THEME_COLORS.length
        let slot = start
        for (let i = 0; i < THEME_COLORS.length; i++) {
            const candidate = (start + i) % THEME_COLORS.length
            if (!taken.has(candidate)) { slot = candidate; break }
        }
        taken.add(slot)
        map[key] = THEME_COLORS[slot]
    }
    return map
})

function themeColor(name) {
    const key = themeKey(name)
    if (!key) return null
    // Falls back to the raw hash for a theme not in the current list -- e.g. one
    // being typed into the composer before it exists on any card yet.
    return themeColorMap.value[key] || THEME_COLORS[hashTheme(key) % THEME_COLORS.length]
}

// Same colour at low alpha for fills, so the chip tints without a second constant.
function themeTint(name, alpha = 0.14) {
    const c = themeColor(name)
    if (!c) return 'transparent'
    const n = parseInt(c.slice(1), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

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
    closeEntry()
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

/* Reading view.
 *
 * A card shows a clamped preview so the grid stays even -- one long principle
 * used to stretch its whole row -- and opening it is how you read the rest. It
 * also gives the row actions somewhere to live that a finger can reach: they used
 * to appear on hover only, which on a touch screen meant edit and delete were
 * simply unreachable.
 *
 * Kept in sync with the list rather than copied: `opened` is looked up by id on
 * every render, so pinning from inside the panel updates what the panel shows.
 */
const openId = ref(null)
const opened = computed(() => entries.value.find((e) => e.objectId === openId.value) || null)

function openEntry(entry) { openId.value = entry.objectId }
function closeEntry() {
    openId.value = null
    confirmingId.value = null   // never leave a delete half-armed behind a closed panel
}

function onKeydown(e) {
    if (e.key === 'Escape' && openId.value) closeEntry()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown)
    clearTimeout(confirmTimer)
})

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
        if (openId.value === entry.objectId) closeEntry()
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
                :style="{ color: themeColor(t), borderColor: themeTint(t, 0.45), background: filter === t ? themeTint(t, 0.22) : 'transparent' }"
                v-on:click="filter = t">{{ t }}</button>
        </div>

        <!-- PINNED -->
        <template v-if="pinned.length">
            <div class="sectionLabel"><i class="uil uil-bookmark-full me-1"></i>Holding myself to these</div>
            <div class="grid">
                <article v-for="e in pinned" :key="e.objectId" class="card pinned"
                    :style="e.theme ? { borderLeftColor: themeColor(e.theme) } : null"
                    role="button" tabindex="0" v-on:click="openEntry(e)"
                    v-on:keydown.enter.prevent="openEntry(e)" v-on:keydown.space.prevent="openEntry(e)">
                    <div class="cardTop">
                        <span v-if="e.theme" class="theme"
                            :style="{ color: themeColor(e.theme), background: themeTint(e.theme) }">{{ e.theme }}</span>
                        <span class="date">{{ dateLabel(e.dateUnix) }}</span>
                    </div>
                    <h3 v-if="e.title" class="cardTitle">{{ e.title }}</h3>
                    <p class="cardBody">{{ e.body }}</p>
                </article>
            </div>
        </template>

        <!-- THE REST -->
        <div v-if="rest.length" class="sectionLabel">
            <i class="uil uil-notes me-1"></i>{{ pinned.length ? 'Everything else' : 'Written down' }}
        </div>
        <div v-if="rest.length" class="grid">
            <article v-for="e in rest" :key="e.objectId" class="card"
                :style="e.theme ? { borderLeftColor: themeColor(e.theme) } : null"
                role="button" tabindex="0" v-on:click="openEntry(e)"
                v-on:keydown.enter.prevent="openEntry(e)" v-on:keydown.space.prevent="openEntry(e)">
                <div class="cardTop">
                    <span v-if="e.theme" class="theme"
                            :style="{ color: themeColor(e.theme), background: themeTint(e.theme) }">{{ e.theme }}</span>
                    <span class="date">{{ dateLabel(e.dateUnix) }}</span>
                </div>
                <h3 v-if="e.title" class="cardTitle">{{ e.title }}</h3>
                <p class="cardBody">{{ e.body }}</p>
            </article>
        </div>

        <!-- READING VIEW -->
        <div v-if="opened" class="overlay" v-on:click.self="closeEntry">
            <div class="panel" role="dialog" aria-modal="true"
                :style="opened.theme ? { borderTopColor: themeColor(opened.theme) } : null">
                <div class="panelTop">
                    <span v-if="opened.theme" class="theme"
                        :style="{ color: themeColor(opened.theme), background: themeTint(opened.theme) }">{{ opened.theme }}</span>
                    <span v-if="opened.pinned" class="pinnedTag">
                        <i class="uil uil-bookmark-full me-1"></i>Holding myself to this
                    </span>
                    <span class="date">{{ dateLabel(opened.dateUnix) }}</span>
                    <button type="button" class="iconBtn ms-2" title="Close" v-on:click="closeEntry">
                        <i class="uil uil-times"></i></button>
                </div>

                <h2 v-if="opened.title" class="panelTitle">{{ opened.title }}</h2>
                <p class="panelBody">{{ opened.body }}</p>

                <div class="panelActions">
                    <button type="button" class="panelBtn" :disabled="busyId === opened.objectId"
                        v-on:click="togglePin(opened)">
                        <i class="uil me-1" :class="opened.pinned ? 'uil-bookmark-full' : 'uil-bookmark'"></i>
                        {{ opened.pinned ? 'Unpin' : 'Pin to the top' }}
                    </button>
                    <button type="button" class="panelBtn" v-on:click="edit(opened)">
                        <i class="uil uil-edit-alt me-1"></i>Edit
                    </button>
                    <button type="button" class="panelBtn danger" :class="{ armed: confirmingId === opened.objectId }"
                        :disabled="busyId === opened.objectId" v-on:click="askDelete(opened)">
                        <i class="uil uil-trash-alt me-1"></i>
                        {{ confirmingId === opened.objectId ? 'Tap again to delete' : 'Delete' }}
                    </button>
                </div>
            </div>
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
    /* The left edge is what carries the theme colour (set inline per card), so it
       needs enough weight to read as a colour rather than a hairline. Cards with
       no theme keep the neutral border and simply look unlabelled. */
    border-left-width: 3px;
    border-radius: var(--radius);
    padding: 1rem 1.1rem 0.7rem;
    transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}

.card {
    cursor: pointer;
    text-align: left;
}

.card:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    background: var(--black-bg-7);
}

/* Keyboard users get the same affordance as the pointer, since the card is a
   button now rather than a passive tile. */
.card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

/* A pinned card is a rule in force, so it reads as one: brighter edge and a
   coloured spine down the side rather than a badge you have to look for. */
/* Pinned is a STATE, theme is a category, and they sit on the same card -- so the
   pinned wash is neutral rather than blue. A blue tint under an orange or pink
   theme edge read as a third colour that meant nothing. */
.card.pinned {
    border-color: var(--border-strong);
    background:
        linear-gradient(90deg, rgba(255, 255, 255, 0.055), transparent 45%),
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

/* colour and background come from themeColor()/themeTint() inline; these are the
   fallback for anything that somehow renders without one. */
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
    /* A preview, not the whole thing. One long principle used to stretch its
       entire row and leave the others short; the full text is one tap away. */
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
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

/* ---- reading view ---- */
.overlay {
    position: fixed;
    inset: 0;
    z-index: 1060;   /* above Bootstrap's own modals, which sit at 1055 */
    background: rgba(6, 8, 12, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem 1rem;
    overflow-y: auto;
}

.panel {
    width: min(38rem, 100%);
    max-height: calc(100vh - 3rem);
    overflow-y: auto;
    background: var(--black-bg-5);
    border: 1px solid var(--border-strong);
    /* The theme colour moves to the top edge here: a left spine reads as a list
       marker, and this is no longer in a list. */
    border-top: 3px solid var(--accent);
    border-radius: var(--radius);
    padding: 1.2rem 1.4rem 1rem;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}

.panelTop {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
}

.pinnedTag {
    font-size: 0.68rem;
    color: var(--white-60);
}

.panelTop .date { margin-left: auto; }

.panelTitle {
    font-size: 1.15rem;
    font-weight: 650;
    line-height: 1.35;
    color: var(--white-87);
    margin: 0 0 0.6rem;
}

.panelBody {
    font-size: 0.95rem;
    line-height: 1.75;
    color: var(--white-87);
    white-space: pre-wrap;
    margin: 0;
}

.panelActions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-top: 1.2rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--border-subtle);
}

.panelBtn {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--white-60);
    font-size: 0.8rem;
    padding: 0.4rem 0.8rem;
    transition: all 0.15s ease;
}

.panelBtn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--white-87); }
.panelBtn:disabled { opacity: 0.5; }
.panelBtn.danger:hover:not(:disabled) { color: var(--red-color); border-color: rgba(246, 70, 93, 0.5); }

.panelBtn.danger.armed {
    color: var(--red-color);
    border-color: rgba(246, 70, 93, 0.6);
    background: rgba(246, 70, 93, 0.12);
}

/* Full-width targets on a finger, and the panel meets the bottom of the screen
   rather than floating with a strip of backdrop under it. */
@media (pointer: coarse) {
    .panelBtn { flex: 1 1 auto; justify-content: center; min-height: 44px; }
    .overlay { align-items: flex-end; padding: 0; }
    .panel { max-height: 88vh; border-radius: var(--radius) var(--radius) 0 0; }
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
