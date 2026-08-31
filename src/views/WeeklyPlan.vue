<script setup>
/**
 * Weekly Plan page -- the standing home for the weekly planning cycle that
 * weeklyGates.js otherwise only surfaces as a forced popup over the weekend and
 * on Monday.
 *
 * The popup is a gate: it appears when an obligation is overdue and disappears the
 * moment it is met, which makes it useless for the ordinary case of wanting to
 * read, revise or look back at a plan on any other day. This page is that place,
 * and it reads and writes the SAME `notes` week records (tradeId "week", dateUnix =
 * ISO-week Monday) through the same saveWeeklyPlan/markPlanReviewed helpers -- so
 * the popup, Diary's Plan tab and this page can never disagree about a week.
 *
 * Laid out as the cycle actually runs rather than as a flat list: next week (write
 * it over the weekend) and this week (re-read it on Monday) are pinned at the top as the
 * only two weeks that are ever actionable, with everything older kept below as
 * history.
 */
import { ref, reactive, computed, onBeforeMount, onMounted, onUnmounted } from 'vue'
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(isoWeek)
dayjs.extend(utc)
dayjs.extend(timezone)

import NoData from '../components/NoData.vue'
import { timeZoneTrade } from '../stores/globals'
import { saveWeeklyPlan, markPlanReviewed, evaluateWeeklyGates, loadWeekNotes, planAttachmentIsImage, isWeekendPlanningWindow, isMondayReviewWindow } from '../utils/weeklyGates'

// Grows the textarea to fit content as the user types, but never shrinks
// below its rows-defined default -- that min height is captured once, from
// the browser's own layout, before the first override.
function resizePlanInput(el) {
    if (!el.dataset.minH) el.dataset.minH = el.offsetHeight
    el.style.height = 'auto'
    el.style.height = Math.max(el.scrollHeight, Number(el.dataset.minH)) + 'px'
}
const vAutoGrow = { mounted: resizePlanInput, updated: resizePlanInput }

const loaded = ref(false)
const weekNotes = ref([])

const tz = () => timeZoneTrade.value || 'UTC'
const thisMonday = computed(() => dayjs().tz(tz()).startOf('isoWeek'))
const nextMonday = computed(() => thisMonday.value.add(7, 'day'))

/* Ticked, not read once at setup.
 *
 * The window opens at 23:59 on a Friday. A page left open across that minute --
 * which is exactly what a Friday evening looks like -- would otherwise keep
 * showing "not due yet" while the popup had already begun firing elsewhere. A
 * minute is fine: nothing here changes faster than that. */
const now = ref(dayjs().tz(tz()))
let clockTimer = null
onMounted(() => { clockTimer = setInterval(() => { now.value = dayjs().tz(tz()) }, 60000) })
onUnmounted(() => { if (clockTimer) clearInterval(clockTimer) })

const inPlanningWindow = computed(() => isWeekendPlanningWindow(now.value))
const inReviewWindow = computed(() => isMondayReviewWindow(now.value))

/* A week the user has not touched yet has no row in the database, but it still has
   to be editable -- the weekend plan is written into a week that does not exist yet
   by definition. Stubs fill that gap; saveWeeklyPlan upserts, so saving one creates
   the real record. */
const stub = (dateUnix) => ({
    dateUnix, note: '', reflection: '', checkReflected: false,
    planText: '', planPdfUrl: '', planPdfBase64: '', planPdfName: '', planReviewed: false, planReviewNote: '',
})
const weekAt = (dateUnix) =>
    weekNotes.value.find((n) => Number(n.dateUnix) === Number(dateUnix)) || stub(dateUnix)

const currentWeek = computed(() => weekAt(thisMonday.value.unix()))
const upcomingWeek = computed(() => weekAt(nextMonday.value.unix()))

// History is strictly the past: the two cards above already own this week and next.
const pastWeeks = computed(() =>
    [...weekNotes.value]
        .filter((n) => Number(n.dateUnix) < thisMonday.value.unix())
        .sort((a, b) => b.dateUnix - a.dateUnix)
)

const weekLabel = (dateUnix) => {
    const start = dayjs.unix(dateUnix).tz(tz())
    return start.format('DD MMM') + ' – ' + start.add(6, 'day').format('DD MMM YYYY')
}

/* A picked-but-unsaved file wins over what is stored, for all three of these.
 *
 * They have to agree: showing the new file's NAME next to the OLD file's image is
 * worse than showing neither, because it reads as confirmation that the right
 * chart is attached. Object URLs are cached per week and revoked when replaced or
 * when the page goes away, so picking repeatedly does not leak them. */
const pickedUrls = reactive({})
function pickedUrlFor(dateUnix) {
    const file = files[dateUnix]
    if (!file || !file.type.startsWith('image/')) return ''
    if (!pickedUrls[dateUnix] || pickedUrls[dateUnix].file !== file) {
        if (pickedUrls[dateUnix]) URL.revokeObjectURL(pickedUrls[dateUnix].url)
        pickedUrls[dateUnix] = { file, url: URL.createObjectURL(file) }
    }
    return pickedUrls[dateUnix].url
}
onUnmounted(() => {
    Object.values(pickedUrls).forEach((p) => URL.revokeObjectURL(p.url))
})

const hasPdf = (w) => !!(files[w.dateUnix] || (!removals[w.dateUnix] && (w.planPdfUrl || w.planPdfBase64)))
const pdfHref = (w) => pickedUrlFor(w.dateUnix) || w.planPdfUrl || w.planPdfBase64 || ''
const pdfName = (w) => (files[w.dateUnix] && files[w.dateUnix].name) || w.planPdfName || 'plan.pdf'
/* Only an image is worth a column of its own. A PDF cannot be shown in place, and
   a card standing in for one told the trader nothing a link does not. */
const hasImageChart = (w) => hasPdf(w) && isImageAttachment(w)
const isImageAttachment = (w) => {
    const file = files[w.dateUnix]
    return file ? file.type.startsWith('image/') : planAttachmentIsImage(w)
}

/* ---- Reminder ---------------------------------------------------------------
   Deliberately NOT a re-implementation of evaluateWeeklyGates' rules: this only
   describes what the page is showing, and the gate stays the single authority on
   what is actually enforced. Keeping them separate means a change to the rules
   cannot leave this banner quietly contradicting the popup. */
const reminder = computed(() => {
    // Same window the gate enforces (Monday from 06:00), so the two can never
    // describe different times.
    if (inReviewWindow.value && !currentWeek.value.planReviewed) {
        return {
            tone: 'due',
            icon: 'uil-bell',
            title: 'Monday — re-read this week’s plan',
            body: 'Read what you wrote on Friday before the first entry, then mark it reviewed.',
        }
    }
    // Same window the gate enforces, so the two can never describe different days.
    if (inPlanningWindow.value && !isPlanComplete(upcomingWeek.value)) {
        return {
            tone: 'due',
            icon: 'uil-edit',
            title: 'Weekend chart review — next week’s plan is due',
            body: 'The market is shut and the week is finished. Write the plan and attach the chart (PDF or image) before Monday.',
        }
    }
    if (!isPlanComplete(upcomingWeek.value)) {
        return {
            tone: 'soft',
            icon: 'uil-calendar-alt',
            title: 'Next week has no plan yet',
            body: 'It is due once Friday closes. Writing it early is fine — you can keep editing until then.',
        }
    }
    return {
        tone: 'ok',
        icon: 'uil-check-circle',
        title: 'Up to date',
        body: 'This week is reviewed and next week is planned. Nothing owed.',
    }
})

function isPlanComplete(w) {
    // Deliberately reads the STORED attachment, not hasPdf(): a file sitting in the
    // picker is not a plan until it has been saved, and the reminder must not go
    // green on one.
    return !!(w.planText || '').trim() && !!(w.planPdfUrl || w.planPdfBase64)
}

/* ---- Editing ----------------------------------------------------------------
   Drafts are held per week rather than mutating the loaded record, so an abandoned
   edit never leaves the page showing text that was never saved. */
const drafts = reactive({})
const files = reactive({})
const saving = ref(null)
const savedAt = ref(null)
const reviewing = ref(null)

/* The stored text until the trader types, and only then their draft.
 *
 * This used to seed `drafts` on first read -- inside a render -- which quietly
 * froze whatever was on screen at that instant. The two cards at the top always
 * render, from empty stubs, BEFORE loadWeekNotes() resolves, so the seed was
 * always the empty string, and every later read returned it because the key now
 * existed. A saved plan therefore came back as a blank box marked "unsaved", with
 * Save enabled -- one click from overwriting the real plan with nothing.
 *
 * Reading a value must not write one. The draft is created by setDraft, i.e. by an
 * actual keystroke, and until then this reflects the database. */
const draftFor = (w) => (drafts[w.dateUnix] !== undefined ? drafts[w.dateUnix] : (w.planText || ''))
const setDraft = (dateUnix, v) => { drafts[dateUnix] = v }
const isDirty = (w) => draftFor(w) !== (w.planText || '') || !!files[w.dateUnix] || !!removals[w.dateUnix]

function onFileChange(dateUnix, event) {
    files[dateUnix] = (event.target.files && event.target.files[0]) || null
    if (files[dateUnix]) removals[dateUnix] = false
}

/* Taking a chart off is a pending edit like any other: it shows immediately, but
   nothing leaves the database until Save. A picked-but-unsaved file needs no
   record change, so clearing it is enough -- the file input is keyed by this
   counter so a fresh, empty one replaces the element that still names the file.
   Without this a wrong chart could only be replaced, never removed. */
const removals = reactive({})
const pickerNonce = reactive({})
function clearFile(w) {
    if (files[w.dateUnix]) files[w.dateUnix] = null
    else removals[w.dateUnix] = true
    pickerNonce[w.dateUnix] = (pickerNonce[w.dateUnix] || 0) + 1
}

async function save(w) {
    // draftFor, not drafts[...]: attaching a file without touching the text leaves
    // no draft, and `?? ''` would have saved that as an empty plan.
    const text = draftFor(w)
    const file = files[w.dateUnix] || null
    saving.value = w.dateUnix
    try {
        await saveWeeklyPlan(w.dateUnix, { text, file, removeFile: !!removals[w.dateUnix] })
        // Re-read rather than patch the local copy. Only saveWeeklyPlan knows where
        // the PDF actually landed (an R2 URL, or inline base64 when R2 is off), so
        // guessing here is how the viewer ends up claiming "no PDF attached" on a
        // file that saved fine. Drafts are keyed by dateUnix in their own object,
        // so replacing weekNotes does not disturb anything half-typed.
        weekNotes.value = await loadWeekNotes()
        files[w.dateUnix] = null
        removals[w.dateUnix] = false
        savedAt.value = w.dateUnix
        setTimeout(() => { if (savedAt.value === w.dateUnix) savedAt.value = null }, 2000)
    } catch (e) {
        console.error('could not save the weekly plan', e)
    } finally {
        saving.value = null
    }
}

/* The written re-check, same requirement as the Monday popup.
 *
 * This page could otherwise be used to walk around the gate entirely: open it on
 * Monday, click "Mark reviewed" on a plan nobody read, and the popup stops asking.
 * A rule that only holds in one of the two places it can be answered is not a
 * rule, so the bar is identical here. */
const REVIEW_NOTE_MIN = 25
const reviewNotes = reactive({})
// Same rule as draftFor: no writing from a read. This one always starts empty, so
// it was harmless -- but leaving one accessor that mutates during render is how the
// pattern comes back.
const reviewNoteFor = (w) => reviewNotes[w.dateUnix] ?? ''
const setReviewNote = (dateUnix, v) => { reviewNotes[dateUnix] = v }
const reviewNoteLeft = (w) => Math.max(0, REVIEW_NOTE_MIN - (reviewNotes[w.dateUnix] || '').trim().length)
// isPlanComplete, not hasPdf: marking reviewed does not upload the picker's file,
// so accepting an unsaved one would flag the week reviewed against a chart that
// was never stored.
const canReview = (w) => isPlanComplete(w) && reviewNoteLeft(w) === 0

async function markReviewed(w) {
    if (!canReview(w)) return
    reviewing.value = w.dateUnix
    try {
        await markPlanReviewed(w.dateUnix, reviewNotes[w.dateUnix])
        weekNotes.value = await loadWeekNotes()
    } catch (e) {
        console.error('could not mark the plan reviewed', e)
    } finally {
        reviewing.value = null
    }
}

onBeforeMount(async () => {
    try {
        weekNotes.value = await loadWeekNotes()
    } catch (e) {
        console.error('could not load week notes', e)
    }
    loaded.value = true
    // Keeps the sidebar badge honest if this page is the first thing opened.
    evaluateWeeklyGates()
})
</script>

<template>
    <div class="weeklyPlanPage">
        <!-- REMINDER -->
        <div class="reminderCard" :class="'tone-' + reminder.tone">
            <i class="uil me-2" :class="reminder.icon"></i>
            <div>
                <div class="reminderTitle">{{ reminder.title }}</div>
                <div class="reminderBody">{{ reminder.body }}</div>
            </div>
        </div>

        <!-- THE TWO ACTIONABLE WEEKS -->
        <div v-for="w in [upcomingWeek, currentWeek]" :key="'focus-' + w.dateUnix"
            class="planCard" :class="{ isCurrent: w.dateUnix === currentWeek.dateUnix }">
            <div class="planHead">
                <i class="uil uil-calendar-alt me-2"></i>
                <span class="planTitle">{{ weekLabel(w.dateUnix) }}</span>
                <span class="planScope">{{ w.dateUnix === currentWeek.dateUnix ? 'This week' : 'Next week' }}</span>
                <span class="reviewBadge ms-auto" :class="{ done: w.planReviewed }">
                    {{ w.planReviewed ? 'Reviewed' : 'Not reviewed' }}
                </span>
            </div>

            <!-- Chart on the left, the writing on the right: the chart is the thing
                 the plan is about, so it is read beside the words rather than found
                 below them, and the two columns fill a width one column left empty. -->
            <div class="planBody" :class="{ split: hasImageChart(w) }">
                <div class="planChartCol">
                    <!-- An image chart is shown in place. A chart you can see without
                         opening anything is the difference between re-reading the plan
                         and clicking past it. A PDF stays a link -- browsers cannot be
                         relied on to render one inline. -->
                    <a v-if="hasPdf(w) && isImageAttachment(w)" :href="pdfHref(w)" target="_blank"
                        rel="noopener" class="planChartLink">
                        <img :src="pdfHref(w)" :alt="pdfName(w)" class="planChart" loading="lazy">
                        <span class="planChartCaption">
                            <i class="uil uil-image-v me-1"></i>{{ pdfName(w) }}
                            <i class="uil uil-external-link-alt ms-1"></i>
                        </span>
                    </a>
                    <a v-else :href="pdfHref(w)" target="_blank" rel="noopener" class="planChartFile">
                        <i class="uil uil-file-alt"></i>{{ pdfName(w) }}
                        <i class="uil uil-external-link-alt"></i>
                    </a>
                    <button type="button" class="planChartRemove" v-on:click="clearFile(w)">
                        <i class="uil uil-times me-1"></i>Remove chart
                    </button>
                </div>

                <div class="planFormCol">
                    <label class="planLabel">
                        <i class="uil uil-clipboard-notes me-1"></i>Plan
                        <span v-if="savedAt === w.dateUnix" class="savedTag">saved</span>
                        <span v-else-if="isDirty(w)" class="unsavedTag">unsaved</span>
                    </label>
                    <textarea class="form-control planInput" rows="2" v-auto-grow
                        placeholder="Bias, levels, the setups you will take — and what would make you stand aside."
                        :value="draftFor(w)" v-on:input="setDraft(w.dateUnix, $event.target.value)"></textarea>

                    <div class="planFileRow">
                        <input type="file" accept="application/pdf,.pdf,image/*"
                            :key="'picker-' + w.dateUnix + '-' + (pickerNonce[w.dateUnix] || 0)"
                            class="form-control form-control-sm planFileInput"
                            v-on:change="onFileChange(w.dateUnix, $event)">
                        <button v-if="hasPdf(w)" type="button" class="planChartRemove"
                            v-on:click="clearFile(w)">
                            <i class="uil uil-times me-1"></i>Remove
                        </button>
                    </div>

                    <!-- Written re-check: required before this week can be marked
                         reviewed, exactly as the Monday popup requires it. -->
                    <div v-if="!w.planReviewed" class="reviewNoteBlock">
                        <label class="planLabel">
                            <i class="uil uil-repeat me-1"></i>Re-check — what are you trading this week?
                        </label>
                        <textarea class="form-control planInput" rows="2" v-auto-grow
                            placeholder="In your own words: the levels that matter and what would make you stand aside."
                            :value="reviewNoteFor(w)"
                            v-on:input="setReviewNote(w.dateUnix, $event.target.value)"></textarea>
                        <div class="reviewHint" :class="{ ok: reviewNoteLeft(w) === 0 }">
                            {{ reviewNoteLeft(w) > 0 ? reviewNoteLeft(w) + ' more characters' : 'Re-check written' }}
                        </div>
                    </div>
                    <div v-else-if="w.planReviewNote" class="reviewNoteDone">
                        <label class="planLabel"><i class="uil uil-repeat me-1"></i>Re-check</label>
                        <div class="reviewNoteText">{{ w.planReviewNote }}</div>
                    </div>

                    <div class="planActions">
                        <button v-if="!w.planReviewed" class="btn btn-outline-secondary btn-sm me-2"
                            :disabled="!canReview(w) || reviewing === w.dateUnix" v-on:click="markReviewed(w)">
                            {{ reviewing === w.dateUnix ? 'Saving…' : 'Mark reviewed' }}
                        </button>
                        <button class="btn btn-outline-success btn-sm" :disabled="!isDirty(w) || saving === w.dateUnix"
                            v-on:click="save(w)">
                            {{ saving === w.dateUnix ? 'Saving…' : 'Save plan' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- HISTORY -->
        <label class="historyLabel">Earlier weeks</label>
        <div v-if="loaded && pastWeeks.length === 0">
            <NoData />
        </div>
        <div v-for="w in pastWeeks" :key="'past-' + w.dateUnix" class="planCard past">
            <div class="planHead">
                <i class="uil uil-calendar-alt me-2"></i>
                <span class="planTitle">{{ weekLabel(w.dateUnix) }}</span>
                <span class="reviewBadge ms-auto" :class="{ done: w.planReviewed }">
                    {{ w.planReviewed ? 'Reviewed' : 'Not reviewed' }}
                </span>
            </div>
            <div class="planBody" :class="{ split: hasImageChart(w) }">
                <div v-if="hasImageChart(w)" class="planChartCol">
                    <a :href="pdfHref(w)" target="_blank" rel="noopener" class="planChartLink">
                        <img :src="pdfHref(w)" :alt="pdfName(w)" class="planChart" loading="lazy">
                        <span class="planChartCaption">
                            <i class="uil uil-image-v me-1"></i>{{ pdfName(w) }}
                            <i class="uil uil-external-link-alt ms-1"></i>
                        </span>
                    </a>
                </div>

                <div class="planFormCol">
                    <label class="planLabel">
                        <i class="uil uil-clipboard-notes me-1"></i>Plan
                        <span v-if="savedAt === w.dateUnix" class="savedTag">saved</span>
                        <span v-else-if="isDirty(w)" class="unsavedTag">unsaved</span>
                    </label>
                    <textarea class="form-control planInput" rows="2" v-auto-grow
                        placeholder="No plan was written for this week."
                        :value="draftFor(w)" v-on:input="setDraft(w.dateUnix, $event.target.value)"></textarea>
                    <div class="planFileRow">
                        <input type="file" accept="application/pdf,.pdf,image/*"
                            :key="'picker-' + w.dateUnix + '-' + (pickerNonce[w.dateUnix] || 0)"
                            class="form-control form-control-sm planFileInput"
                            v-on:change="onFileChange(w.dateUnix, $event)">
                        <button v-if="hasPdf(w)" type="button" class="planChartRemove"
                            v-on:click="clearFile(w)">
                            <i class="uil uil-times me-1"></i>Remove
                        </button>
                    </div>
                    <div class="planActions">
                        <button class="btn btn-outline-success btn-sm" :disabled="!isDirty(w) || saving === w.dateUnix"
                            v-on:click="save(w)">
                            {{ saving === w.dateUnix ? 'Saving…' : 'Save plan' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.weeklyPlanPage {
    padding: 0 0 2rem 0;
}

/* --- reminder --- */
.reminderCard {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    padding: 0.9rem 1.1rem;
    border-radius: var(--radius);
    border-left: 3px solid var(--white-38);
    background: var(--black-bg-5);
    margin-bottom: 1.5rem;
}

.reminderCard > i {
    font-size: 1.15rem;
    line-height: 1.4;
}

/* Three tones rather than one alert style: a plan that is merely not written yet
   must not look like the same emergency as one that is overdue today, or the
   colour stops carrying information. */
.tone-due {
    border-left-color: #f59e0b;
    color: #f59e0b;
}

.tone-soft {
    border-left-color: #2f9bff;
    color: #2f9bff;
}

.tone-ok {
    border-left-color: #00CA73;
    color: #00CA73;
}

.reminderTitle {
    font-weight: 600;
    font-size: 0.95rem;
}

.reminderBody {
    font-size: 0.85rem;
    color: var(--white-60);
    margin-top: 0.15rem;
}

/* --- week cards --- */
.planCard {
    height: auto;
    padding: 16px 20px;
    border-radius: var(--radius);
    background: var(--black-bg-5);
    border-left: 3px solid #2f9bff;
    margin-bottom: 1.25rem;
}

.planCard.isCurrent {
    border-left-color: #f59e0b;
}

/* Past weeks recede: they are reference, not work in front of you. */
.planCard.past {
    border-left-color: var(--white-38);
    opacity: 0.85;
}

.planHead {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    color: #2f9bff;
}

.planCard.isCurrent .planHead {
    color: #f59e0b;
}

.planCard.past .planHead {
    color: var(--white-60);
}

.planTitle {
    font-weight: 600;
    font-size: 0.95rem;
}

.planScope {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
    background: rgba(255, 255, 255, 0.05);
}

.reviewBadge {
    font-size: 0.68rem;
    padding: 0.1rem 0.5rem;
    border-radius: 0.25rem;
    color: var(--white-60);
    background: rgba(255, 255, 255, 0.05);
}

.reviewBadge.done {
    color: #00CA73;
    background: rgba(0, 202, 115, 0.1);
}

/* One column until there is a chart to put beside the writing: an empty left
   half is worse balance than none, and the file picker already says a chart
   can be added. Below the split the chart would be a thumbnail and the plan a
   slot, so the narrow layout stacks chart-then-plan. */
.planBody {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
    margin-top: 0.9rem;
    padding-top: 0.7rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

@media (min-width: 992px) {
    .planBody.split {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
}

.planChartCol,
.planFormCol {
    min-width: 0;
}

.planLabel {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin-bottom: 0.4rem;
}

.savedTag { color: #00CA73; text-transform: none; letter-spacing: 0; }
.unsavedTag { color: #f59e0b; text-transform: none; letter-spacing: 0; }

.planInput {
    font-size: 0.9rem;
    line-height: 1.55;
    resize: none;
    overflow-y: hidden;
}

.planFileRow {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.6rem;
}

/* Full width like the textareas above and below it -- a 16rem picker in a
   column this wide just left a hole on its right. */
.planFileInput {
    flex: 1 1 auto;
}

.reviewNoteBlock,
.reviewNoteDone {
    margin-top: 0.9rem;
    padding-top: 0.7rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.reviewHint {
    font-size: 0.72rem;
    color: #f59e0b;
    margin-top: 0.25rem;
    font-variant-numeric: tabular-nums;
}

.reviewHint.ok { color: #00CA73; }

.reviewNoteText {
    font-size: 0.88rem;
    line-height: 1.55;
    color: var(--white-60);
    white-space: pre-wrap;
}

.planChartLink {
    display: block;
}

.planChart {
    display: block;
    width: 100%;
    max-height: 24rem;
    object-fit: contain;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
}

.planChartCaption {
    display: block;
    margin-top: 0.4rem;
    font-size: 0.8rem;
    color: #2f9bff;
}

.planChartLink:hover .planChartCaption {
    text-decoration: underline;
}

.planChartRemove {
    flex: 0 0 auto;
    padding: 0;
    font-size: 0.78rem;
    color: var(--white-60);
    background: none;
    border: none;
}

.planChartRemove:hover {
    color: #ef4444;
}

.planActions {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.8rem;
}

.historyLabel {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin: 2rem 0 0.75rem 0;
}
</style>
