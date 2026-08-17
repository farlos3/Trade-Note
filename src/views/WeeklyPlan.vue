<script setup>
/**
 * Weekly Plan page -- the standing home for the weekly planning cycle that
 * weeklyGates.js otherwise only surfaces as a forced popup on Friday and Monday.
 *
 * The popup is a gate: it appears when an obligation is overdue and disappears the
 * moment it is met, which makes it useless for the ordinary case of wanting to
 * read, revise or look back at a plan on any other day. This page is that place,
 * and it reads and writes the SAME `notes` week records (tradeId "week", dateUnix =
 * ISO-week Monday) through the same saveWeeklyPlan/markPlanReviewed helpers -- so
 * the popup, Diary's Plan tab and this page can never disagree about a week.
 *
 * Laid out as the cycle actually runs rather than as a flat list: next week (write
 * it on Friday) and this week (re-read it on Monday) are pinned at the top as the
 * only two weeks that are ever actionable, with everything older kept below as
 * history.
 */
import { ref, reactive, computed, onBeforeMount, onUnmounted } from 'vue'
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(isoWeek)
dayjs.extend(utc)
dayjs.extend(timezone)

import NoData from '../components/NoData.vue'
import { timeZoneTrade } from '../stores/globals'
import { saveWeeklyPlan, markPlanReviewed, evaluateWeeklyGates, loadWeekNotes, planAttachmentIsImage } from '../utils/weeklyGates'

const loaded = ref(false)
const weekNotes = ref([])

const tz = () => timeZoneTrade.value || 'UTC'
const thisMonday = computed(() => dayjs().tz(tz()).startOf('isoWeek'))
const nextMonday = computed(() => thisMonday.value.add(7, 'day'))
const weekday = computed(() => dayjs().tz(tz()).isoWeekday())   // 1 = Monday, 5 = Friday

/* A week the user has not touched yet has no row in the database, but it still has
   to be editable -- the Friday plan is written into a week that does not exist yet
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

const hasPdf = (w) => !!(files[w.dateUnix] || w.planPdfUrl || w.planPdfBase64)
const pdfHref = (w) => pickedUrlFor(w.dateUnix) || w.planPdfUrl || w.planPdfBase64 || ''
const pdfName = (w) => (files[w.dateUnix] && files[w.dateUnix].name) || w.planPdfName || 'plan.pdf'
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
    if (weekday.value === 1 && !currentWeek.value.planReviewed) {
        return {
            tone: 'due',
            icon: 'uil-bell',
            title: 'Monday — re-read this week’s plan',
            body: 'Read what you wrote on Friday before the first entry, then mark it reviewed.',
        }
    }
    if (weekday.value === 5 && !isPlanComplete(upcomingWeek.value)) {
        return {
            tone: 'due',
            icon: 'uil-edit',
            title: 'Friday — next week’s plan is due',
            body: 'Write the plan and attach the chart (PDF or image) while this week is still fresh.',
        }
    }
    if (!isPlanComplete(upcomingWeek.value)) {
        return {
            tone: 'soft',
            icon: 'uil-calendar-alt',
            title: 'Next week has no plan yet',
            body: 'It is due Friday. Writing it early is fine — you can keep editing until then.',
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

const draftFor = (w) => {
    if (drafts[w.dateUnix] === undefined) drafts[w.dateUnix] = w.planText || ''
    return drafts[w.dateUnix]
}
const setDraft = (dateUnix, v) => { drafts[dateUnix] = v }
const isDirty = (w) => draftFor(w) !== (w.planText || '') || !!files[w.dateUnix]

function onFileChange(dateUnix, event) {
    files[dateUnix] = (event.target.files && event.target.files[0]) || null
}

async function save(w) {
    const text = drafts[w.dateUnix] ?? ''
    const file = files[w.dateUnix] || null
    saving.value = w.dateUnix
    try {
        await saveWeeklyPlan(w.dateUnix, { text, file })
        // Re-read rather than patch the local copy. Only saveWeeklyPlan knows where
        // the PDF actually landed (an R2 URL, or inline base64 when R2 is off), so
        // guessing here is how the viewer ends up claiming "no PDF attached" on a
        // file that saved fine. Drafts are keyed by dateUnix in their own object,
        // so replacing weekNotes does not disturb anything half-typed.
        weekNotes.value = await loadWeekNotes()
        files[w.dateUnix] = null
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
const reviewNoteFor = (w) => {
    if (reviewNotes[w.dateUnix] === undefined) reviewNotes[w.dateUnix] = ''
    return reviewNotes[w.dateUnix]
}
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

            <div class="planBody">
                <label class="planLabel">
                    <i class="uil uil-clipboard-notes me-1"></i>Plan
                    <span v-if="savedAt === w.dateUnix" class="savedTag">saved</span>
                    <span v-else-if="isDirty(w)" class="unsavedTag">unsaved</span>
                </label>
                <textarea class="form-control planInput" rows="5"
                    placeholder="Bias, levels, the setups you will take — and what would make you stand aside."
                    :value="draftFor(w)" v-on:input="setDraft(w.dateUnix, $event.target.value)"></textarea>

                <div class="planFileRow">
                    <a v-if="hasPdf(w)" :href="pdfHref(w)" target="_blank" rel="noopener" class="planFileLink">
                        <i class="uil me-1" :class="isImageAttachment(w) ? 'uil-image-v' : 'uil-file-alt'"></i>{{ pdfName(w) }}
                        <i class="uil uil-external-link-alt ms-1"></i>
                    </a>
                    <span v-else class="planFileNone">No chart attached</span>
                    <input type="file" accept="application/pdf,.pdf,image/*"
                        class="form-control form-control-sm planFileInput"
                        v-on:change="onFileChange(w.dateUnix, $event)">
                </div>
                <!-- An image chart is shown in place. A chart you can see without
                     opening anything is the difference between re-reading the plan
                     and clicking past it. A PDF stays a link -- browsers cannot be
                     relied on to render one inline. -->
                <a v-if="hasPdf(w) && isImageAttachment(w)" :href="pdfHref(w)" target="_blank"
                    rel="noopener" class="planChartLink">
                    <img :src="pdfHref(w)" :alt="pdfName(w)" class="planChart" loading="lazy">
                </a>

                <!-- Written re-check: required before this week can be marked
                     reviewed, exactly as the Monday popup requires it. -->
                <div v-if="!w.planReviewed" class="reviewNoteBlock">
                    <label class="planLabel">
                        <i class="uil uil-repeat me-1"></i>Re-check — what are you trading this week?
                    </label>
                    <textarea class="form-control planInput" rows="2"
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
            <div class="planBody">
                <label class="planLabel">
                    <i class="uil uil-clipboard-notes me-1"></i>Plan
                    <span v-if="savedAt === w.dateUnix" class="savedTag">saved</span>
                    <span v-else-if="isDirty(w)" class="unsavedTag">unsaved</span>
                </label>
                <textarea class="form-control planInput" rows="3"
                    placeholder="No plan was written for this week."
                    :value="draftFor(w)" v-on:input="setDraft(w.dateUnix, $event.target.value)"></textarea>
                <div class="planFileRow">
                    <a v-if="hasPdf(w)" :href="pdfHref(w)" target="_blank" rel="noopener" class="planFileLink">
                        <i class="uil me-1" :class="isImageAttachment(w) ? 'uil-image-v' : 'uil-file-alt'"></i>{{ pdfName(w) }}
                        <i class="uil uil-external-link-alt ms-1"></i>
                    </a>
                    <span v-else class="planFileNone">No chart attached</span>
                    <input type="file" accept="application/pdf,.pdf,image/*"
                        class="form-control form-control-sm planFileInput"
                        v-on:change="onFileChange(w.dateUnix, $event)">
                </div>
                <!-- An image chart is shown in place. A chart you can see without
                     opening anything is the difference between re-reading the plan
                     and clicking past it. A PDF stays a link -- browsers cannot be
                     relied on to render one inline. -->
                <a v-if="hasPdf(w) && isImageAttachment(w)" :href="pdfHref(w)" target="_blank"
                    rel="noopener" class="planChartLink">
                    <img :src="pdfHref(w)" :alt="pdfName(w)" class="planChart" loading="lazy">
                </a>
                <div class="planActions">
                    <button class="btn btn-outline-success btn-sm" :disabled="!isDirty(w) || saving === w.dateUnix"
                        v-on:click="save(w)">
                        {{ saving === w.dateUnix ? 'Saving…' : 'Save plan' }}
                    </button>
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

.planBody {
    margin-top: 0.9rem;
    padding-top: 0.7rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
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
    resize: vertical;
}

.planFileRow {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.6rem;
}

.planFileLink {
    font-size: 0.85rem;
    color: #2f9bff;
}

.planFileLink:hover {
    text-decoration: underline;
}

.planFileNone {
    font-size: 0.85rem;
    color: var(--white-60);
}

.planFileInput {
    max-width: 16rem;
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
    margin-top: 0.6rem;
}

.planChart {
    display: block;
    max-width: 100%;
    max-height: 22rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
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
