<script setup>
/**
 * Mindset -- the rules the trader sets themselves, walked as a path.
 *
 * Everything else in the Journal is anchored to something that happened: a day, a
 * week, an entry. A conviction is the opposite -- written once, meant to still
 * bind months later. So this is not a feed. It is a route you are partway along,
 * oldest principle first, each one a stage that is either not started, the one you
 * are working on now, or mastered.
 *
 * Why a path and not a list: a list answers "what did I write", which is the least
 * interesting question here. A path answers "where am I", and it makes the two
 * things that actually matter impossible to miss -- how far you have come, and the
 * single stage you are supposed to be holding yourself to right now.
 *
 * Node positions are computed here, in JS, rather than left to layout: the trail
 * is an SVG drawn through the SAME coordinates the nodes are placed at, so the
 * line cannot drift away from the circles it is supposed to connect.
 */
import { ref, computed, onBeforeMount, onMounted, onUnmounted, nextTick } from 'vue'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(utc)
dayjs.extend(timezone)

import { timeZoneTrade } from '../stores/globals'
import { useGetMindsets, useSaveMindset, useSetMindsetStatus, useDeleteMindset } from '../utils/mindset'

const entries = ref([])
const loaded = ref(false)
const saving = ref(false)
const busyId = ref(null)

/* ---- path geometry ----------------------------------------------------------
   A gentle serpentine: x follows a sine of the index so the trail leans left and
   right without ever doubling back. Period 6 gives a long, readable curve rather
   than a zigzag. */
const STEP_Y = 118          // vertical gap between stages
const AMPLITUDE = 88        // how far a stage leans from the centre line
const PAD_TOP = 56
const PAD_BOTTOM = 72

const trackEl = ref(null)
const trackWidth = ref(560)

// The lean is clamped to whatever width is actually available, so a narrow window
// tucks the path into a column instead of pushing nodes off the side.
const amplitude = computed(() => Math.min(AMPLITUDE, Math.max(0, trackWidth.value / 2 - 74)))
const centreX = computed(() => trackWidth.value / 2)

const nodes = computed(() => entries.value.map((e, i) => ({
    entry: e,
    index: i,
    x: centreX.value + Math.sin((i * Math.PI) / 3) * amplitude.value,
    y: PAD_TOP + i * STEP_Y,
})))

const trackHeight = computed(() =>
    entries.value.length ? PAD_TOP + (entries.value.length - 1) * STEP_Y + PAD_BOTTOM : 0
)

/* The trail, as one smooth path through the node centres. Cubic segments with
   vertical control handles: the curve leaves each node straight down and arrives
   straight down, which is what makes it read as a road rather than a zigzag. */
const trailPath = computed(() => {
    const pts = nodes.value
    if (pts.length < 2) return ''
    let d = `M ${pts[0].x} ${pts[0].y}`
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        const dy = (b.y - a.y) / 2
        d += ` C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`
    }
    return d
})

// How much of the trail is behind you: drawn as a second, brighter path clipped to
// the stages already mastered.
const walkedPath = computed(() => {
    const upto = nodes.value.filter((n) => n.entry.status === 'mastered').length
    const pts = nodes.value.slice(0, Math.max(upto, 0))
    if (pts.length < 2) return ''
    let d = `M ${pts[0].x} ${pts[0].y}`
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        const dy = (b.y - a.y) / 2
        d += ` C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`
    }
    return d
})

function measure() {
    if (trackEl.value) trackWidth.value = trackEl.value.clientWidth || 560
}
let ro = null
onMounted(() => {
    measure()
    // ResizeObserver rather than a window listener: the sidebar collapsing changes
    // this column's width without the window resizing at all.
    if (typeof ResizeObserver !== 'undefined' && trackEl.value) {
        ro = new ResizeObserver(measure)
        ro.observe(trackEl.value)
    } else {
        window.addEventListener('resize', measure)
    }
})
onUnmounted(() => {
    if (ro) ro.disconnect()
    else window.removeEventListener('resize', measure)
    clearTimeout(confirmTimer)
})

/* ---- progress ---- */
const masteredCount = computed(() => entries.value.filter((e) => e.status === 'mastered').length)
const activeEntry = computed(() => entries.value.find((e) => e.status === 'active') || null)
const progressPct = computed(() =>
    entries.value.length ? Math.round((masteredCount.value / entries.value.length) * 100) : 0
)

const dateLabel = (dateUnix) =>
    dayjs.unix(dateUnix).tz(timeZoneTrade.value || 'UTC').format('DD MMM YYYY')

/* ---- selection ---- */
const selectedId = ref(null)
const selected = computed(() => nodes.value.find((n) => n.entry.objectId === selectedId.value) || null)
const select = (n) => { selectedId.value = selectedId.value === n.entry.objectId ? null : n.entry.objectId }

/* The detail card is placed under its node, then pulled back inside the track if
   it would hang off an edge -- a popover that overflows the column is worse than
   one that is slightly off-centre from its node. */
const CARD_W = 300
const cardLeft = computed(() => {
    if (!selected.value) return 0
    const ideal = selected.value.x - CARD_W / 2
    return Math.max(8, Math.min(ideal, trackWidth.value - CARD_W - 8))
})

async function reload() {
    try {
        entries.value = await useGetMindsets()
    } catch (e) {
        console.error('could not load mindset entries', e)
    }
}

async function setStatus(entry, status) {
    busyId.value = entry.objectId
    try {
        // Only one stage can be the one you are working on. Standing it up stands
        // the previous one down, or "current focus" quietly becomes a second list.
        if (status === 'active') {
            const prev = entries.value.find((e) => e.status === 'active' && e.objectId !== entry.objectId)
            if (prev) await useSetMindsetStatus(prev.objectId, 'todo')
        }
        await useSetMindsetStatus(entry.objectId, status)
        await reload()
    } catch (e) {
        console.error('could not move the stage', e)
    } finally {
        busyId.value = null
    }
}

/* ---- composer ---- */
const composerOpen = ref(false)
const editingId = ref(null)
const title = ref('')
const body = ref('')
const theme = ref('')
const bodyEl = ref(null)

const isEditing = computed(() => !!editingId.value)
const canSave = computed(() => !!body.value.trim() && !saving.value)

function resetForm() {
    editingId.value = null
    title.value = ''
    body.value = ''
    theme.value = ''
    composerOpen.value = false
}

async function openComposer() {
    resetForm()
    composerOpen.value = true
    await nextTick()
    if (bodyEl.value) bodyEl.value.focus()
}

async function edit(entry) {
    editingId.value = entry.objectId
    title.value = entry.title
    body.value = entry.body
    theme.value = entry.theme
    composerOpen.value = true
    selectedId.value = null
    await nextTick()
    if (bodyEl.value) {
        bodyEl.value.focus()
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }
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
        await reload()
        resetForm()
    } catch (e) {
        console.error('could not save the mindset entry', e)
    } finally {
        saving.value = false
    }
}

/* Two-step delete: the second click is the confirmation, and unlike a modal it
   cannot be dismissed by reflex. */
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
        selectedId.value = null
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
    await nextTick()
    measure()
})
</script>

<template>
    <div class="mindsetPage">
        <!-- HEADER / PROGRESS -->
        <header class="pathHead">
            <div class="headText">
                <h2 class="headTitle">Your mindset path</h2>
                <p class="headSub" v-if="entries.length">
                    {{ masteredCount }} of {{ entries.length }} mastered<span v-if="activeEntry"> ·
                        working on <strong>{{ activeEntry.title || 'stage ' + (entries.indexOf(activeEntry) + 1) }}</strong></span>
                </p>
                <p class="headSub" v-else>Set the first rule you want to hold yourself to.</p>
            </div>
            <button type="button" class="primaryBtn" v-on:click="openComposer">
                <i class="uil uil-plus me-1"></i>New stage
            </button>
        </header>

        <div v-if="entries.length" class="progressTrack">
            <div class="progressFill" :style="{ width: progressPct + '%' }"></div>
        </div>

        <!-- COMPOSER -->
        <section v-if="composerOpen" class="composer" :class="{ editing: isEditing }">
            <div class="composerHead">
                <span class="composerTitle">
                    <i class="uil me-2" :class="isEditing ? 'uil-edit' : 'uil-flag-alt'"></i>
                    {{ isEditing ? 'Editing a stage' : 'New stage' }}
                </span>
                <button type="button" class="linkBtn" v-on:click="resetForm">Cancel</button>
            </div>
            <input v-model="title" type="text" class="composerInput" maxlength="120"
                placeholder="Name it — “Cut the loser before it becomes a story”" />
            <textarea ref="bodyEl" v-model="body" rows="4" class="composerBody"
                placeholder="What is the rule, and what does breaking it actually cost you?"></textarea>
            <div class="composerFoot">
                <input v-model="theme" type="text" class="themeInput" maxlength="24"
                    placeholder="Theme (risk, patience, ego…)" />
                <button type="button" class="primaryBtn" :disabled="!canSave" v-on:click="submit">
                    <span v-if="saving" class="spinner-border spinner-border-sm me-2" role="status"></span>
                    {{ isEditing ? 'Save changes' : 'Add to the path' }}
                </button>
            </div>
        </section>

        <!-- THE PATH -->
        <div ref="trackEl" class="track" :style="{ height: trackHeight + 'px' }">
            <svg v-if="entries.length > 1" class="trail" :width="trackWidth" :height="trackHeight">
                <path :d="trailPath" class="trailBase" />
                <path v-if="walkedPath" :d="walkedPath" class="trailWalked" />
            </svg>

            <div v-for="n in nodes" :key="n.entry.objectId" class="nodeWrap"
                :style="{ left: n.x + 'px', top: n.y + 'px' }">
                <div v-if="n.entry.status === 'active'" class="nowBubble">NOW</div>
                <button type="button" class="node" :class="[n.entry.status, { open: selectedId === n.entry.objectId }]"
                    :disabled="busyId === n.entry.objectId" v-on:click="select(n)"
                    :title="n.entry.title || 'Stage ' + (n.index + 1)">
                    <i v-if="n.entry.status === 'mastered'" class="uil uil-check"></i>
                    <span v-else class="nodeNum">{{ n.index + 1 }}</span>
                </button>
                <div class="nodeLabel" :class="n.entry.status">
                    {{ n.entry.title || 'Stage ' + (n.index + 1) }}
                </div>
            </div>

            <!-- DETAIL -->
            <div v-if="selected" class="detail"
                :style="{ left: cardLeft + 'px', top: (selected.y + 92) + 'px' }">
                <div class="detailTop">
                    <span class="stageTag">Stage {{ selected.index + 1 }}</span>
                    <span v-if="selected.entry.theme" class="theme">{{ selected.entry.theme }}</span>
                    <span class="date">{{ dateLabel(selected.entry.dateUnix) }}</span>
                </div>
                <h3 v-if="selected.entry.title" class="detailTitle">{{ selected.entry.title }}</h3>
                <p class="detailBody">{{ selected.entry.body }}</p>

                <div class="statusRow">
                    <button type="button" class="statusBtn" :class="{ on: selected.entry.status === 'todo' }"
                        :disabled="busyId === selected.entry.objectId" v-on:click="setStatus(selected.entry, 'todo')">
                        Not started</button>
                    <button type="button" class="statusBtn active" :class="{ on: selected.entry.status === 'active' }"
                        :disabled="busyId === selected.entry.objectId" v-on:click="setStatus(selected.entry, 'active')">
                        Working on it</button>
                    <button type="button" class="statusBtn done" :class="{ on: selected.entry.status === 'mastered' }"
                        :disabled="busyId === selected.entry.objectId" v-on:click="setStatus(selected.entry, 'mastered')">
                        Mastered</button>
                </div>

                <div class="detailActions">
                    <button type="button" class="iconBtn" title="Edit" v-on:click="edit(selected.entry)">
                        <i class="uil uil-edit-alt"></i></button>
                    <button type="button" class="iconBtn danger"
                        :class="{ armed: confirmingId === selected.entry.objectId }"
                        :disabled="busyId === selected.entry.objectId" v-on:click="askDelete(selected.entry)">
                        <i class="uil uil-trash-alt"></i>
                        <span v-if="confirmingId === selected.entry.objectId" class="ms-1">Sure?</span>
                    </button>
                    <button type="button" class="iconBtn ms-auto" title="Close" v-on:click="selectedId = null">
                        <i class="uil uil-times"></i></button>
                </div>
            </div>
        </div>

        <!-- EMPTY -->
        <div v-if="loaded && !entries.length" class="empty">
            <i class="uil uil-map-marker emptyIcon"></i>
            <div class="emptyTitle">The path starts empty</div>
            <p class="emptyBody">
                The rules you keep having to relearn are the ones worth putting here. Add one,
                mark it as the stage you are working on, and it stays in front of you until you
                have actually made it stick.
            </p>
        </div>
    </div>
</template>

<style scoped>
.mindsetPage {
    padding-bottom: 3rem;
    max-width: 46rem;
}

/* ---- head ---- */
.pathHead {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0.7rem;
}

.headTitle {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--white-87);
    margin: 0;
}

.headSub {
    font-size: 0.82rem;
    color: var(--white-60);
    margin: 0.2rem 0 0;
}

.headSub strong { color: var(--accent); font-weight: 600; }

.progressTrack {
    height: 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    overflow: hidden;
    margin-bottom: 1.4rem;
}

.progressFill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--green));
    transition: width 0.4s ease;
}

/* ---- composer ---- */
.composer {
    background:
        radial-gradient(120% 140% at 0% 0%, rgba(47, 155, 255, 0.10), transparent 60%),
        var(--black-bg-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 1.1rem 1.2rem;
    margin-bottom: 1.4rem;
}

.composer.editing { border-color: rgba(47, 155, 255, 0.5); }

.composerHead { display: flex; align-items: center; margin-bottom: 0.8rem; }
.composerTitle { font-size: 0.82rem; font-weight: 600; color: var(--white-87); }

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
    transition: border-color 0.15s ease;
}

.composerInput:focus,
.composerBody:focus,
.themeInput:focus { border-color: var(--accent); }

.composerInput { font-weight: 600; margin-bottom: 0.5rem; }
.composerBody { line-height: 1.6; resize: vertical; min-height: 5.5rem; }

.composerFoot {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
}

.themeInput { width: auto; flex: 1 1 12rem; font-size: 0.82rem; padding: 0.4rem 0.6rem; }

.primaryBtn {
    background: var(--accent);
    border: 0;
    border-radius: var(--radius-sm);
    color: #08111c;
    font-size: 0.84rem;
    font-weight: 600;
    padding: 0.45rem 1.1rem;
    white-space: nowrap;
    transition: filter 0.15s ease, opacity 0.15s ease;
}

.composerFoot .primaryBtn { margin-left: auto; }
.pathHead .primaryBtn { margin-left: auto; }
.primaryBtn:hover:not(:disabled) { filter: brightness(1.1); }
.primaryBtn:disabled { opacity: 0.4; }

/* ---- the path ---- */
.track {
    position: relative;
    width: 100%;
}

.trail {
    position: absolute;
    inset: 0;
    pointer-events: none;
}

/* Dashed for road ahead, solid for road walked -- the difference is legible at a
   glance without needing the colour to be noticed. */
.trailBase {
    fill: none;
    stroke: rgba(255, 255, 255, 0.12);
    stroke-width: 6;
    stroke-linecap: round;
    stroke-dasharray: 2 16;
}

.trailWalked {
    fill: none;
    stroke: var(--green);
    stroke-width: 6;
    stroke-linecap: round;
    opacity: 0.55;
}

.nodeWrap {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
}

.node {
    width: 62px;
    height: 62px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 1.15rem;
    font-weight: 800;
    border: 2px solid var(--border-subtle);
    background: var(--black-bg-7);
    color: var(--white-38);
    /* The lip underneath is what makes a flat circle read as a physical button. */
    box-shadow: 0 4px 0 rgba(0, 0, 0, 0.45);
    transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.15s ease;
}

.node:hover { filter: brightness(1.15); }

/* Pressing moves the button down onto its own lip. */
.node:active {
    transform: translateY(3px);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.45);
}

.node.mastered {
    background: linear-gradient(180deg, #3ddc97, #22b378);
    border-color: #46e8a6;
    color: #06281c;
    box-shadow: 0 4px 0 #157a52;
}

.node.active {
    width: 76px;
    height: 76px;
    font-size: 1.35rem;
    background: linear-gradient(180deg, #4aa8ff, #2f7fe0);
    border-color: #7cc4ff;
    color: #04182c;
    box-shadow: 0 5px 0 #1f5ba8, 0 0 0 6px rgba(47, 155, 255, 0.16);
}

.node.open { outline: 2px solid var(--accent); outline-offset: 4px; }

.nodeNum { line-height: 1; }

.nodeLabel {
    margin-top: 0.45rem;
    max-width: 8.5rem;
    text-align: center;
    font-size: 0.7rem;
    line-height: 1.3;
    color: var(--white-38);
    /* Two lines maximum: a long principle would otherwise shove the next node's
       label into it, and the full text is one click away anyway. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.nodeLabel.mastered { color: var(--white-60); }
.nodeLabel.active { color: var(--white-87); font-weight: 600; }

.nowBubble {
    margin-bottom: 0.4rem;
    font-size: 0.6rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #04182c;
    background: #7cc4ff;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    animation: bob 1.8s ease-in-out infinite;
}

@keyframes bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
}

@media (prefers-reduced-motion: reduce) {
    .nowBubble { animation: none; }
}

/* ---- detail popover ---- */
.detail {
    position: absolute;
    width: 300px;
    z-index: 3;
    background: var(--black-bg-5);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 0.85rem 0.95rem 0.6rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.detailTop {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.35rem;
}

.stageTag {
    font-size: 0.64rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--white-60);
}

.theme {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.06rem 0.42rem;
    border-radius: 999px;
}

.date {
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--white-38);
    font-variant-numeric: tabular-nums;
}

.detailTitle {
    font-size: 0.92rem;
    font-weight: 650;
    line-height: 1.35;
    color: var(--white-87);
    margin: 0 0 0.3rem;
}

.detailBody {
    font-size: 0.84rem;
    line-height: 1.6;
    color: var(--white-60);
    white-space: pre-wrap;
    margin: 0;
}

.statusRow {
    display: flex;
    gap: 0.25rem;
    margin-top: 0.7rem;
}

.statusBtn {
    flex: 1;
    font-size: 0.68rem;
    padding: 0.25rem 0.2rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--white-60);
    transition: all 0.15s ease;
}

.statusBtn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--white-87); }
.statusBtn.on { color: var(--white-87); border-color: transparent; }
.statusBtn.on:not(.active):not(.done) { background: rgba(255, 255, 255, 0.10); }
.statusBtn.active.on { background: rgba(47, 155, 255, 0.22); color: #cfe8ff; }
.statusBtn.done.on { background: rgba(52, 211, 153, 0.20); color: #b8f2da; }

.detailActions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    margin-top: 0.55rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.4rem;
}

.iconBtn {
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--white-38);
    font-size: 0.88rem;
    padding: 0.15rem 0.4rem;
    display: inline-flex;
    align-items: center;
    transition: color 0.15s ease, background 0.15s ease;
}

.iconBtn:hover { color: var(--white-87); background: var(--surface-hover); }
.iconBtn.danger:hover { color: var(--red-color); }

.iconBtn.danger.armed {
    color: var(--red-color);
    background: rgba(246, 70, 93, 0.12);
    font-size: 0.72rem;
}

/* ---- empty ---- */
.empty {
    text-align: center;
    padding: 2.5rem 1rem;
    color: var(--white-60);
}

.emptyIcon { font-size: 2.2rem; color: var(--white-38); }

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
