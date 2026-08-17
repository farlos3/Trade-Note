<script setup>
import { onMounted, onBeforeMount, computed, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'; dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'; dayjs.extend(timezone)
import isoWeek from 'dayjs/plugin/isoWeek.js'; dayjs.extend(isoWeek)
import SpinnerLoadingPage from '../components/SpinnerLoadingPage.vue';
import NoData from '../components/NoData.vue';
import { spinnerLoadingPage, diaries, selectedItem, spinnerLoadMore, endOfList, tags, satisfactionArray, dayFiles, timeZoneTrade } from '../stores/globals';
import { useCheckVisibleScreen, useCreatedDateFormat, useEditItem, useInitPopover, useLoadMore } from '../utils/utils';
import { useGetDiaries } from '../utils/diary';
import { useGetTags, useGetTagInfo, useGetAvailableTags, useDailySatisfactionChange, useGetSatisfactions, useGetWeekNotes, useGetDayNotes, useSetWeekNoteCheck, useSaveWeekReflection, useAnalyzeWeekReflection } from '../utils/daily';
import { useGetDayFiles, useDayFilesFor } from '../utils/dayFiles';
import { saveWeeklyPlan } from '../utils/weeklyGates';
import { loadEntryChecklists } from '../utils/entryChecklist';

onBeforeMount(async () => {

})

// One card per day, merging written diaries with days that only have an uploaded
// summary file — so a day's file shows here even without any diary text.
const diaryEntries = computed(() => {
    const byDay = new Map()
    diaries.forEach((d) => byDay.set(Number(d.dateUnix), { ...d, dateUnix: Number(d.dateUnix) }))
    dayFiles.forEach((f) => {
        const day = Number(f.dateUnixDay)
        if (!byDay.has(day)) byDay.set(day, { dateUnix: day, diary: '', objectId: null })
    })
    return [...byDay.values()].sort((a, b) => b.dateUnix - a.dateUnix)
})

/* Week notes, shown in the same stream as the day cards.
   A week note is keyed to the START of its ISO week (see useSaveWeekNote), so
   each day card is mapped to its own week start and the note is emitted once,
   above the first day of that week -- newest first, matching the day order.
   Weeks whose note exists but which have no diary/file days still appear, or a
   week you only wrote a summary for would be invisible here. */
const weekNotes = ref([])
const dayNotes = ref([])

/* Day / Week view. They answer different questions -- "what happened on this
   date" vs "what did the whole week amount to" -- and mixing both in one stream
   made the weekly summaries hard to find among the day cards. Persisted so the
   page opens on whichever one you actually use. */
const VIEWS = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'plan', label: 'Plan' }, { id: 'review', label: 'Entry reviews' }]
const view = ref(localStorage.getItem('diaryView') === 'week' ? 'week' : 'day')
watch(view, (v) => localStorage.setItem('diaryView', v))

const weekStartOf = (dateUnix) =>
    dayjs.unix(dateUnix).tz(timeZoneTrade.value || 'UTC').startOf('isoWeek').unix()

const dayNoteFor = (dateUnix) => {
    const n = dayNotes.value.find((x) => Number(x.dateUnix) === Number(dateUnix))
    return n ? n.note : ''
}

// Day view: one card per day that has a diary, a file, or a day note.
const dayFeed = computed(() => {
    const byDay = new Map(diaryEntries.value.map((e) => [Number(e.dateUnix), e]))
    dayNotes.value.forEach((n) => {
        const d = Number(n.dateUnix)
        if (!byDay.has(d)) byDay.set(d, { dateUnix: d, diary: '', objectId: null })
    })
    return [...byDay.values()].sort((a, b) => b.dateUnix - a.dateUnix)
})

/* Week view: one card per week note, with the days it covers listed underneath
   so the summary can be read against what actually happened. */
const weekFeed = computed(() =>
    [...weekNotes.value]
        .map((n) => {
            const wk = Number(n.dateUnix)
            return {
                ...n,
                dateUnix: wk,
                days: dayFeed.value.filter((e) => weekStartOf(e.dateUnix) === wk),
            }
        })
        .sort((a, b) => b.dateUnix - a.dateUnix),
)

/* Review checklist per week note. Flipped optimistically so the tick responds
   immediately, then reverted if the save fails -- a checkbox that waits on a
   round trip feels broken, and one that silently lies about being saved is
   worse. */
async function toggleWeekCheck(dateUnix, field) {
    const item = weekNotes.value.find((n) => Number(n.dateUnix) === Number(dateUnix))
    if (!item) return
    const next = !item[field]
    item[field] = next
    try {
        await useSetWeekNoteCheck(Number(dateUnix), field, next)
    } catch (e) {
        item[field] = !next
        console.error('could not save week note checklist', e)
    }
}

const weekCheck = (dateUnix, field) => {
    const item = weekNotes.value.find((n) => Number(n.dateUnix) === Number(dateUnix))
    return !!(item && item[field])
}

/* Reflection editing. Held in a local draft per week rather than bound straight
   to the list: typing must not mutate the loaded data before it is saved, or a
   failed save would leave the page showing text that is not in the database. */
const drafts = reactive({})
const savingWeek = ref(null)
const savedWeek = ref(null)

const draftFor = (w) => {
    if (drafts[w.dateUnix] === undefined) drafts[w.dateUnix] = w.reflection || ''
    return drafts[w.dateUnix]
}
const setDraft = (dateUnix, v) => { drafts[dateUnix] = v }
const isDirty = (w) => draftFor(w) !== (w.reflection || '')

/* Grows the box to fit what's typed instead of scrolling inside a fixed box.
   rows="4" + CSS min-height still set the starting size, so a fresh box (or one
   short enough to fit) reads the same as before -- this only ever adds height,
   never removes the baseline. Height is reset to auto first so deleting text
   shrinks it back down too, not just grows. */
const autoGrow = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
}
const vAutoGrow = { mounted: autoGrow, updated: autoGrow }

async function saveReflection(w) {
    const text = drafts[w.dateUnix] ?? ''
    savingWeek.value = w.dateUnix
    try {
        await useSaveWeekReflection(Number(w.dateUnix), text)
        // Only now does the loaded copy match the database.
        w.reflection = text
        w.checkReflected = !!text.trim()
        savedWeek.value = w.dateUnix
        setTimeout(() => { if (savedWeek.value === w.dateUnix) savedWeek.value = null }, 2000)
    } catch (e) {
        console.error('could not save reflection', e)
    } finally {
        savingWeek.value = null
    }
}

/* AI check of the reflection against that week's own numbers. Requires a saved
   (non-dirty) reflection -- there is nothing to check yet if it only exists as an
   unsaved draft, and re-analyzing mid-edit would grade text that's about to
   change. Server call also persists the result, so it survives a reload. */
const AI_WEEK_HEADINGS = ['Verdict', 'What the reflection got right', 'What it missed']
const analyzingWeek = ref(null)
const analyzeError = reactive({})

async function analyzeReflection(w) {
    analyzingWeek.value = w.dateUnix
    delete analyzeError[w.dateUnix]
    try {
        const res = await useAnalyzeWeekReflection(w.dateUnix, timeZoneTrade.value)
        if (res.disabled) {
            analyzeError[w.dateUnix] = res.reason || 'AI analysis is not configured on the server.'
        } else if (res.refused || !res.summary) {
            analyzeError[w.dateUnix] = 'The AI declined to analyze this week.'
        } else {
            w.aiAnalysis = res.summary
            w.aiAnalysisAt = res.analyzedAt
        }
    } catch (e) {
        analyzeError[w.dateUnix] = e?.response?.data?.error || e.message || 'Analysis failed'
        console.error('could not analyze reflection', e)
    } finally {
        analyzingWeek.value = null
    }
}

const aiAnalysisTime = (t) => (t ? dayjs(t).tz(timeZoneTrade.value || 'UTC').format('MMM D, HH:mm') : '')

/* Entry reviews tab: the answers given to the post-entry checklist, newest first.
   Read-only on purpose -- the value of the questions is that they were answered in
   the moment, and a record you can quietly revise afterwards is not evidence of
   anything. Grouped by day so a day's entries can be read as one session. */
const entryReviews = ref([])

const EMOTION_COLORS = {
    calm: '#22c55e', confident: '#38bdf8', nervous: '#ef4444',
    excited: '#f59e0b', frustrated: '#94a3b8',
}
const reviewsByDay = computed(() => {
    const byDay = new Map()
    for (const r of entryReviews.value) {
        const day = dayjs.unix(r.dateUnix).tz(timeZoneTrade.value || 'UTC').startOf('day').unix()
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push(r)
    }
    return [...byDay.entries()]
        .map(([dateUnix, items]) => ({ dateUnix, items: items.sort((a, b) => b.dateUnix - a.dateUnix) }))
        .sort((a, b) => b.dateUnix - a.dateUnix)
})
const reviewTime = (dateUnix) =>
    dayjs.unix(dateUnix).tz(timeZoneTrade.value || 'UTC').format('HH:mm')

/* Plan tab: history of every week's plan (written the Friday before, reviewed
   the Monday after -- see weeklyGates.js, which forces both). This tab is the
   browse-anytime view of the same records; editing here goes through the same
   saveWeeklyPlan/markPlanReviewed calls the forced popup uses. */
const planFeed = computed(() => [...weekNotes.value].sort((a, b) => b.dateUnix - a.dateUnix))

const planDrafts = reactive({})     // dateUnix -> draft text
const planFiles = reactive({})      // dateUnix -> newly chosen File (not yet saved)
const savingPlan = ref(null)
const savedPlan = ref(null)

const planDraftFor = (w) => {
    if (planDrafts[w.dateUnix] === undefined) planDrafts[w.dateUnix] = w.planText || ''
    return planDrafts[w.dateUnix]
}
const setPlanDraft = (dateUnix, v) => { planDrafts[dateUnix] = v }
const isPlanDirty = (w) => planDraftFor(w) !== (w.planText || '') || !!planFiles[w.dateUnix]

function onPlanFileChange(dateUnix, event) {
    planFiles[dateUnix] = (event.target.files && event.target.files[0]) || null
}

const planPdfName = (w) => (planFiles[w.dateUnix] && planFiles[w.dateUnix].name) || w.planPdfName || 'plan.pdf'
const planPdfHref = (w) => w.planPdfUrl || w.planPdfBase64 || ''

async function savePlan(w) {
    const text = planDrafts[w.dateUnix] ?? ''
    const file = planFiles[w.dateUnix] || null
    savingPlan.value = w.dateUnix
    try {
        await saveWeeklyPlan(w.dateUnix, { text, file })
        w.planText = text
        if (file) {
            // Local echo only -- the real url/base64 lives in the DB now; next
            // load of this page re-fetches it. Good enough so the "attached"
            // state doesn't flicker back to empty right after saving.
            w.planPdfName = file.name
        }
        planFiles[w.dateUnix] = null
        savedPlan.value = w.dateUnix
        setTimeout(() => { if (savedPlan.value === w.dateUnix) savedPlan.value = null }, 2000)
    } catch (e) {
        console.error('could not save plan', e)
    } finally {
        savingPlan.value = null
    }
}

const weekLabel = (dateUnix) => {
    const s = dayjs.unix(dateUnix).tz(timeZoneTrade.value || 'UTC')
    return `Week of ${s.format('MMM D')} – ${s.add(6, 'day').format('MMM D, YYYY')}`
}

const fileSrc = (f) => (f ? (f.url || f.base64) : '')
const isPdf = (f) => !!f && ((f.url && /\.pdf(\?|$)/i.test(f.url)) || (f.base64 && f.base64.startsWith('data:application/pdf')))

/* Files are listed, not previewed, until you ask for one.
   Every file used to render its own inline <iframe>/<img> on load, so a page with
   a dozen day summaries pulled a dozen PDFs from R2 before you had looked at any
   of them -- slow, and it buried the diary text between full-height frames. The
   list answers "what is here" at a glance; opening a row answers "what is in it". */
const expanded = reactive(new Set())
const isOpen = (f) => expanded.has(f.objectId)
const toggle = (f) => { expanded.has(f.objectId) ? expanded.delete(f.objectId) : expanded.add(f.objectId) }

const kindOf = (f) => (isPdf(f) ? 'PDF' : 'Image')
const iconOf = (f) => (isPdf(f) ? 'uil uil-file-alt' : 'uil uil-image-v')

// Size is only known for files still stored as base64 (the pre-R2 fallback): a
// remote URL would need a HEAD request per file, which is exactly the per-file
// network cost this list exists to avoid.
function sizeOf(f) {
    if (!f || !f.base64) return null
    const b64 = f.base64.split(',')[1] || ''
    const bytes = Math.floor(b64.length * 3 / 4)
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

// "where the file lives" -- R2 vs still inline in the database.
const storageOf = (f) => (f && f.url ? 'R2' : 'database')

onMounted(async () => {
    await useGetDiaries(true)
    await Promise.all([useGetTags(), useGetAvailableTags(), useGetSatisfactions(), useGetDayFiles()])
    try {
        const [wn, dn, ec] = await Promise.all([useGetWeekNotes(), useGetDayNotes(), loadEntryChecklists()])
        weekNotes.value = wn
        dayNotes.value = dn
        entryReviews.value = ec
    } catch (e) { console.error('notes failed', e) }
    useInitPopover()
    window.addEventListener('scroll', () => {
        let scrollTop = window.scrollY
        let visibleScreen = window.innerHeight
        let documentHeight = document.documentElement.scrollHeight
        let difference = documentHeight - (scrollTop + visibleScreen)

        if (difference <= 0) {
            if (!spinnerLoadMore.value && !spinnerLoadingPage.value && !endOfList.value) { //To avoid firing multiple times, make sure it's not loadin for the first time and that there is not already a loading more (spinner)
                useLoadMore()
            }
        }
    })
    useCheckVisibleScreen()
})
</script>

<template>
    <SpinnerLoadingPage />
    <div v-show="!spinnerLoadingPage" class="row justify-content-center mt-3 mb-4">
        <div class="col-12 col-xxl-10">
            <!-- Day / Week -->
            <div class="viewToolbar mb-3">
                <span class="viewLabel">VIEW BY</span>
                <button v-for="v in VIEWS" :key="v.id" type="button"
                    :class="['viewBtn', { active: view === v.id }]" v-on:click="view = v.id">{{ v.label }}</button>
            </div>

            <!-- ================= ENTRY REVIEWS ================= -->
            <template v-if="view === 'review'">
                <div v-if="reviewsByDay.length == 0">
                    <NoData />
                </div>

                <div v-for="d in reviewsByDay" :key="'rv-' + d.dateUnix" class="mb-4">
                    <div class="reviewDayHead">
                        <i class="uil uil-calendar-alt me-2"></i>{{ useCreatedDateFormat(d.dateUnix) }}
                        <span class="reviewDayCount">{{ d.items.length }} entr{{ d.items.length === 1 ? 'y' : 'ies' }}</span>
                    </div>

                    <div v-for="r in d.items" :key="r.objectId" class="dailyCard reviewCard mb-3">
                        <div class="reviewHead">
                            <span class="sideTag" :class="(r.side === 'sell' || r.side === 'short') ? 'sell' : 'buy'">
                                {{ (r.side === 'sell' || r.side === 'short') ? 'SELL' : 'BUY' }}
                            </span>
                            <span class="reviewSymbol">{{ r.symbol }}</span>
                            <span class="reviewLot">{{ r.lot }} lot</span>
                            <span class="reviewTime ms-auto">{{ reviewTime(r.dateUnix) }}</span>
                        </div>

                        <!-- The judgment calls, as they were answered. Colour carries the
                             answer so a run of bad entries is visible without reading. -->
                        <div class="reviewFacts">
                            <span class="reviewFact" :class="r.hasSl ? 'ok' : 'bad'">
                                SL {{ r.hasSl ? r.slPrice : 'none' }}
                                <em v-if="r.hasSl">{{ r.slPips.toFixed(1) }}p</em>
                            </span>
                            <span class="reviewFact" :class="r.hasTp ? 'ok' : 'bad'">
                                TP {{ r.hasTp ? r.tpPrice : 'none' }}
                                <em v-if="r.hasTp">{{ r.tpPips.toFixed(1) }}p</em>
                            </span>
                            <span class="reviewFact" :class="r.tpSlAcceptable ? 'ok' : 'bad'">
                                SL/TP {{ r.tpSlAcceptable ? 'acceptable' : 'not acceptable' }}
                            </span>
                            <span class="reviewFact" :class="r.positionQuality === 'good' ? 'ok' : 'bad'">
                                {{ r.positionQuality === 'good' ? 'Good position' : 'Bad position' }}
                            </span>
                            <span class="reviewFact" :class="r.oversized ? 'bad' : 'ok'">
                                {{ r.oversized ? 'Oversized' : 'Size ok' }}
                            </span>
                            <span class="reviewFact" :class="r.logicValid ? 'ok' : 'bad'">
                                Logic {{ r.logicValid ? 'valid' : 'broken' }}
                            </span>
                            <span v-if="r.entryEmotion" class="reviewFact emotion"
                                :style="{ borderColor: EMOTION_COLORS[r.entryEmotion], color: EMOTION_COLORS[r.entryEmotion] }">
                                {{ r.entryEmotion }}
                            </span>
                            <span class="reviewFact" :class="r.revengeScore >= 6 ? 'bad' : 'ok'">
                                Revenge {{ r.revengeScore }}/10
                            </span>
                        </div>

                        <div v-if="r.entryReasoning" class="reviewReason">
                            <label class="reviewReasonLabel">Why you entered</label>
                            <div class="reviewReasonText">{{ r.entryReasoning }}</div>
                        </div>
                    </div>
                </div>
            </template>

            <!-- ================= WEEK ================= -->
            <template v-if="view === 'week'">
                <div v-if="weekFeed.length == 0">
                    <NoData />
                </div>

                <div v-for="w in weekFeed" :key="'w-' + w.dateUnix" class="dailyCard weekNoteCard mb-4">
                    <div class="weekNoteHead">
                        <i class="uil uil-bell me-2"></i>
                        <span class="weekNoteTitle">{{ weekLabel(w.dateUnix) }}</span>
                        <span class="weekDayCount ms-auto">{{ w.days.length }} day(s) journalled</span>
                    </div>
                    <p class="weekNoteBody mb-0">{{ w.note }}</p>

                    <!-- Reflection is written HERE, not just ticked off: a checkbox
                         claiming a reflection exists with nowhere to read it is
                         worth nothing when you come back to the week later. -->
                    <div class="reflectionBlock">
                        <label class="reflectionLabel">
                            <i class="uil uil-comment-alt-edit me-1"></i>Reflection
                            <span v-if="savedWeek === w.dateUnix" class="savedTag">saved</span>
                            <span v-else-if="isDirty(w)" class="unsavedTag">unsaved</span>
                        </label>
                        <textarea class="form-control reflectionInput" rows="4" v-auto-grow
                            placeholder="What did this week teach you? What will you do differently next week?"
                            :value="draftFor(w)"
                            v-on:input="setDraft(w.dateUnix, $event.target.value); autoGrow($event.target)"></textarea>
                        <div class="reflectionActions">
                            <button class="btn btn-outline-success btn-sm" :disabled="!isDirty(w) || savingWeek === w.dateUnix"
                                v-on:click="saveReflection(w)">
                                {{ savingWeek === w.dateUnix ? 'Saving…' : 'Save reflection' }}
                            </button>
                            <button class="btn btn-outline-primary btn-sm ms-2"
                                :disabled="!w.checkReflected || isDirty(w) || analyzingWeek === w.dateUnix"
                                :title="!w.checkReflected ? 'Save a reflection first' : (isDirty(w) ? 'Save your changes first' : '')"
                                v-on:click="analyzeReflection(w)">
                                {{ analyzingWeek === w.dateUnix ? 'Analyzing…' : (w.aiAnalysis ? 'Re-analyze with AI' : 'Analyze with AI') }}
                            </button>
                        </div>

                        <div v-if="analyzeError[w.dateUnix]" class="aiAnalysisErr mt-2">{{ analyzeError[w.dateUnix] }}</div>

                        <div v-if="w.aiAnalysis" class="aiAnalysisBlock mt-3">
                            <div class="aiAnalysisHead">
                                <i class="uil uil-robot me-1"></i>AI analysis
                                <span v-if="w.aiAnalysisAt" class="aiAnalysisTime">{{ aiAnalysisTime(w.aiAnalysisAt) }}</span>
                            </div>
                            <template v-for="(line, i) in w.aiAnalysis.split('\n')" :key="i">
                                <div v-if="AI_WEEK_HEADINGS.includes(line.trim())" class="aiAnalysisLineHead">{{ line }}</div>
                                <div v-else class="aiAnalysisLine">{{ line }}</div>
                            </template>
                        </div>
                    </div>

                    <div class="weekCheckList">
                        <label class="weekCheck" v-bind:class="{ done: weekCheck(w.dateUnix, 'checkRead') }">
                            <input type="checkbox" :checked="weekCheck(w.dateUnix, 'checkRead')"
                                v-on:change="toggleWeekCheck(w.dateUnix, 'checkRead')" />
                            <span>Reviewed</span>
                        </label>
                        <!-- Driven by the reflection text itself, so it can never
                             claim something that was never written. Not `disabled` --
                             browsers grey a disabled checkbox out regardless of
                             accent-color, so it stopped matching Reviewed's green the
                             moment it was checked. click.prevent blocks toggling
                             instead, which keeps the same colored, checked look. -->
                        <label class="weekCheck" v-bind:class="{ done: weekCheck(w.dateUnix, 'checkReflected') }">
                            <input type="checkbox" :checked="weekCheck(w.dateUnix, 'checkReflected')"
                                tabindex="-1" v-on:click.prevent />
                            <span>Reflection written</span>
                        </label>
                    </div>

                    <div v-if="w.days.length" class="weekDayList">
                        <span v-for="d in w.days" :key="'wd-' + d.dateUnix" class="weekDayChip">
                            {{ useCreatedDateFormat(d.dateUnix) }}
                        </span>
                    </div>
                </div>
            </template>

            <!-- ================= PLAN ================= -->
            <template v-if="view === 'plan'">
                <div v-if="planFeed.length == 0">
                    <NoData />
                </div>

                <div v-for="w in planFeed" :key="'p-' + w.dateUnix" class="dailyCard weekNoteCard planCard mb-4">
                    <div class="weekNoteHead">
                        <i class="uil uil-calendar-alt me-2"></i>
                        <span class="weekNoteTitle">{{ weekLabel(w.dateUnix) }}</span>
                        <span class="planReviewedBadge ms-auto" v-bind:class="{ done: w.planReviewed }">
                            {{ w.planReviewed ? 'Reviewed' : 'Not reviewed' }}
                        </span>
                    </div>

                    <div class="reflectionBlock" style="margin-top: 0;">
                        <label class="reflectionLabel">
                            <i class="uil uil-clipboard-notes me-1"></i>Plan
                            <span v-if="savedPlan === w.dateUnix" class="savedTag">saved</span>
                            <span v-else-if="isPlanDirty(w)" class="unsavedTag">unsaved</span>
                        </label>
                        <textarea class="form-control reflectionInput" rows="4" v-auto-grow
                            placeholder="No plan written for this week yet."
                            :value="planDraftFor(w)"
                            v-on:input="setPlanDraft(w.dateUnix, $event.target.value); autoGrow($event.target)"></textarea>

                        <div class="planFileRow">
                            <a v-if="planPdfHref(w)" :href="planPdfHref(w)" target="_blank" rel="noopener" class="planFileLink">
                                <i class="uil uil-file-alt me-1"></i>{{ planPdfName(w) }} <i class="uil uil-external-link-alt ms-1"></i>
                            </a>
                            <span v-else class="planFileNone">No PDF attached</span>
                            <input type="file" accept="application/pdf" class="form-control form-control-sm planFileInput"
                                v-on:change="onPlanFileChange(w.dateUnix, $event)">
                        </div>

                        <div class="reflectionActions">
                            <!-- Reviewing happens on the Weekly Plan page (or the
                                 Monday popup), both of which require the written
                                 re-check. A bare "Mark reviewed" button here was a
                                 way around that requirement, which made the rule
                                 hold in two places out of three -- i.e. not at all. -->
                            <a v-if="!w.planReviewed" href="/weekly-plan"
                                class="btn btn-outline-secondary btn-sm me-2">Review on Weekly Plan</a>
                            <button class="btn btn-outline-success btn-sm" :disabled="!isPlanDirty(w) || savingPlan === w.dateUnix"
                                v-on:click="savePlan(w)">
                                {{ savingPlan === w.dateUnix ? 'Saving…' : 'Save plan' }}
                            </button>
                        </div>
                    </div>
                </div>
            </template>

            <!-- ================= DAY ================= -->
            <template v-else>
            <div v-if="dayFeed.length == 0">
                <NoData />
            </div>

            <div v-for="itemDiary in dayFeed" :key="itemDiary.dateUnix"
                class="dailyCard diaryEntryCard mb-4">
                <!-- Header: date + satisfaction + actions -->
                <div class="d-flex align-items-center flex-wrap diaryHeader">
                    <span class="diaryDate fw-bold">{{ useCreatedDateFormat(itemDiary.dateUnix) }}</span>
                    <i v-on:click="useDailySatisfactionChange(itemDiary.dateUnix, true)"
                        v-bind:class="[(satisfactionArray.find(obj => obj.dateUnix == itemDiary.dateUnix) != undefined && satisfactionArray.find(obj => obj.dateUnix == itemDiary.dateUnix).satisfaction == true) ? 'greenTrade' : '', 'uil', 'uil-thumbs-up', 'ms-3', 'me-1', 'pointerClass']"></i>
                    <i v-on:click="useDailySatisfactionChange(itemDiary.dateUnix, false)"
                        v-bind:class="[(satisfactionArray.find(obj => obj.dateUnix == itemDiary.dateUnix) != undefined && satisfactionArray.find(obj => obj.dateUnix == itemDiary.dateUnix).satisfaction == false) ? 'redTrade' : '', 'uil', 'uil-thumbs-down', 'pointerClass']"></i>
                    <span v-if="itemDiary.objectId" class="ms-auto diaryActions">
                        <i class="uil uil-edit-alt pointerClass" v-on:click="useEditItem(itemDiary.objectId)"></i>
                        <i v-on:click="selectedItem = itemDiary.objectId"
                            class="ps-2 uil uil-trash-alt popoverDelete pointerClass" data-bs-html="true"
                            data-bs-content="<div>Are you sure?</div><div class='text-center'><a type='button' class='btn btn-red btn-sm popoverYes'>Yes</a><a type='button' class='btn btn-outline-secondary btn-sm ms-2 popoverNo'>No</a></div>"
                            data-bs-toggle="popover" data-bs-placement="left"></i>
                    </span>
                </div>

                <!-- Tags -->
                <div class="diaryTags mt-2">
                    <span
                        v-for="tagGroup in tags.filter(obj => obj.tradeId == itemDiary.dateUnix.toString())"
                        :key="tagGroup.tradeId">
                        <span v-for="tag in tagGroup.tags.slice(0, 7)" class="tag txt-small"
                            :style="{ 'background-color': useGetTagInfo(tag).groupColor }">{{
                                useGetTagInfo(tag).tagName }}
                        </span>
                        <span v-show="tagGroup.tags.length > 7">+{{ tagGroup.tags.length - 7 }}</span>
                    </span>
                </div>

                <!-- Diary text -->
                <div v-if="itemDiary.diary" class="quill diaryText mt-3" v-html="itemDiary.diary"></div>

                <!-- The whole-day note written from History's bell icon. It lived
                     only on that page before, so a day journalled there looked
                     empty here. -->
                <div v-if="dayNoteFor(itemDiary.dateUnix)" class="dayNoteBlock mt-3">
                    <div class="dayNoteHead"><i class="uil uil-bell me-1"></i>Day note</div>
                    <p class="dayNoteBody mb-0">{{ dayNoteFor(itemDiary.dateUnix) }}</p>
                </div>

                <!-- Day summary files: an overview list first (what/where), and the
                     file itself only once a row is opened. -->
                <div v-if="useDayFilesFor(itemDiary.dateUnix).length" class="dayFileBlock mt-3">
                    <div class="dayFileCount">
                        <i class="uil uil-paperclip me-1"></i>
                        {{ useDayFilesFor(itemDiary.dateUnix).length }} file(s) attached
                    </div>

                    <div v-for="f in useDayFilesFor(itemDiary.dateUnix)" :key="f.objectId" class="fileRow">
                        <div class="fileLine" v-on:click="toggle(f)">
                            <i v-bind:class="[isOpen(f) ? 'uil uil-angle-down' : 'uil uil-angle-right', 'fileChevron']"></i>
                            <i v-bind:class="[iconOf(f), 'fileIcon']"></i>
                            <span class="fileName">{{ f.filename }}</span>
                            <span class="fileMeta">{{ kindOf(f) }}</span>
                            <span v-if="sizeOf(f)" class="fileMeta">{{ sizeOf(f) }}</span>
                            <span class="fileMeta fileWhere">{{ storageOf(f) }}</span>
                            <!-- .stop so opening in a new tab doesn't also expand the row -->
                            <a :href="fileSrc(f)" target="_blank" rel="noopener" class="fileOpen"
                                title="Open in new tab" v-on:click.stop>
                                <i class="uil uil-external-link-alt"></i>
                            </a>
                        </div>

                        <!-- v-if, not v-show: the point is that nothing is fetched
                             until you actually open the row. -->
                        <div v-if="isOpen(f)" class="dayFilePreview mt-2">
                            <iframe v-if="isPdf(f)" :src="fileSrc(f) + '#view=FitH'" class="dayFileFrame"
                                loading="lazy"></iframe>
                            <img v-else :src="fileSrc(f)" class="dayFileImg" loading="lazy" />
                        </div>
                    </div>
                </div>
            </div>

            </template>

            <!-- Load more spinner -->
            <div v-if="spinnerLoadMore" class="d-flex justify-content-center mt-3">
                <div class="spinner-border text-blue" role="status"></div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.reviewDayHead {
    display: flex;
    align-items: center;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--white-87);
    margin-bottom: 0.6rem;
}

.reviewDayCount {
    margin-left: 0.6rem;
    font-size: 0.72rem;
    font-weight: 400;
    color: var(--white-60);
}

.reviewCard {
    height: auto;
    padding: 14px 18px;
    border-left: 3px solid #2f9bff;
}

.reviewHead {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
}

.sideTag {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 0.25rem;
}

.sideTag.buy { color: #00CA73; background: rgba(0, 202, 115, 0.12); }
.sideTag.sell { color: #F6465D; background: rgba(246, 70, 93, 0.12); }

.reviewSymbol { font-weight: 700; font-size: 0.92rem; }
.reviewLot, .reviewTime { font-size: 0.8rem; color: var(--white-60); }

.reviewFacts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.7rem;
}

/* Green/red rather than neutral chips: the point of keeping these is to see a run
   of bad entries at a glance, which a uniform list of labels does not give you. */
.reviewFact {
    font-size: 0.72rem;
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
    border: 1px solid transparent;
    white-space: nowrap;
}

.reviewFact em {
    font-style: normal;
    opacity: 0.75;
    margin-left: 0.2rem;
}

.reviewFact.ok { color: #00CA73; background: rgba(0, 202, 115, 0.1); border-color: rgba(0, 202, 115, 0.3); }
.reviewFact.bad { color: #F6465D; background: rgba(246, 70, 93, 0.1); border-color: rgba(246, 70, 93, 0.3); }
.reviewFact.emotion { background: transparent; text-transform: capitalize; }

.reviewReason {
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.reviewReasonLabel {
    display: block;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin-bottom: 0.25rem;
}

.reviewReasonText {
    font-size: 0.88rem;
    line-height: 1.55;
    white-space: pre-wrap;
}


.diaryEntryCard {
    padding: 20px 24px;
    /* .dailyCard sets height:100%, which is meant for cards sitting side by side
       in a grid row. Here the cards are stacked in one column, so each one tried
       to be as tall as the whole stack. It went unnoticed while every card was
       filled by a full-height PDF iframe; with the files collapsed to a list the
       card is short and the leftover stretch became a page of empty space. */
    height: auto;
}

.diaryHeader {
    row-gap: 4px;
}

.diaryDate {
    font-size: 1.1rem;
}

.diaryActions i {
    font-size: 1.05rem;
}

.diaryText {
    line-height: 1.6;
}

.dayFileBlock {
    border-top: 1px solid rgba(128, 128, 128, 0.2);
    padding-top: 16px;
}

.dayFilePreview {
    width: 100%;
}

/* Flex to the page shape instead of reserving a fixed height: the frame scales
   with the card width at ~A4 portrait aspect, and #view=FitH fits the page to
   that width -- so the page fills the frame with little leftover space. */
.dayFileFrame {
    width: 100%;
    aspect-ratio: 1 / 1.414;
    max-height: 88vh;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 8px;
    background: #fff;
}

.dayFileImg {
    display: block;
    width: auto;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 8px;
}

.dayFileCount {
    font-size: 0.78rem;
    color: var(--white-60);
    margin-bottom: 0.4rem;
}
/* One compact row per file: name first, then the facts that tell you what it is
   and where it lives, without opening anything. */
.fileRow {
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    padding: 0.4rem 0;
}
.fileLine {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
}
.fileLine:hover .fileName {
    text-decoration: underline;
}
.fileChevron {
    color: var(--white-60);
    width: 0.9rem;
    flex: 0 0 auto;
}
.fileIcon {
    color: #2f9bff;
    flex: 0 0 auto;
}
.fileName {
    font-size: 0.88rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.fileMeta {
    font-size: 0.72rem;
    color: var(--white-60);
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    background: rgba(255, 255, 255, 0.05);
    flex: 0 0 auto;
}
.fileWhere {
    text-transform: lowercase;
}
/* Pushed to the right so the row reads name-then-facts, action last. */
.fileOpen {
    margin-left: auto;
    color: var(--white-60);
    flex: 0 0 auto;
}
.fileOpen:hover {
    color: #2f9bff;
}

/* Week note reads as a header for the days beneath it, not as another day card:
   accent border on the leading edge, no satisfaction/actions row. */
.weekNoteCard {
    height: auto;
    padding: 16px 20px;
    border-left: 3px solid #f59e0b;
}

/* Plan cards get their own accent (blue) so the Plan tab doesn't read as a
   re-skinned Week tab -- different question (what's coming) vs (what happened). */
.planCard {
    border-left-color: #2f9bff;
}

.planCard .weekNoteHead {
    color: #2f9bff;
}

.planReviewedBadge {
    font-size: 0.68rem;
    text-transform: none;
    letter-spacing: 0;
    padding: 0.1rem 0.5rem;
    border-radius: 0.25rem;
    color: var(--white-60);
    background: rgba(255, 255, 255, 0.05);
}

.planReviewedBadge.done {
    color: #00CA73;
    background: rgba(0, 202, 115, 0.1);
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

.weekNoteHead {
    display: flex;
    align-items: center;
    color: #f59e0b;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.5rem;
}

.weekNoteTitle {
    font-weight: 700;
}

/* The notes are written as paragraphs with blank lines between them, so the
   newlines have to survive rendering. */
.weekNoteBody {
    white-space: pre-wrap;
    line-height: 1.6;
    font-size: 0.9rem;
}


.weekCheckList {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin-top: 0.9rem;
    padding-top: 0.7rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.weekCheck {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
    color: var(--white-60);
    cursor: pointer;
    margin-bottom: 0;
}

.weekCheck input {
    cursor: pointer;
    width: 15px;
    height: 15px;
    accent-color: #00CA73;
}

/* Struck through once done, so an unfinished week is what stands out rather
   than a wall of identical rows. */
.weekCheck.done span {
    color: #00CA73;
    text-decoration: line-through;
    text-decoration-color: rgba(0, 202, 115, 0.5);
}

/* Day / Week toolbar -- mirrors the History page's VIEW BY control so the two
   journal pages are operated the same way. */
.viewToolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.6rem;
    border-radius: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
}

.viewLabel {
    font-size: 0.68rem;
    letter-spacing: 0.05em;
    color: var(--white-60);
    margin-right: 0.25rem;
}

.viewBtn {
    background: transparent;
    border: 0;
    color: var(--white-60);
    font-size: 0.82rem;
    padding: 0.2rem 0.7rem;
    border-radius: 0.35rem;
    cursor: pointer;
}

.viewBtn.active {
    background: #2f9bff;
    color: #fff;
    font-weight: 600;
}

.weekDayCount {
    font-size: 0.72rem;
    color: var(--white-60);
    text-transform: none;
    letter-spacing: 0;
}

.reflectionBlock {
    margin-top: 0.9rem;
    padding-top: 0.7rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.reflectionLabel {
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

.reflectionInput {
    font-size: 0.9rem;
    line-height: 1.55;
    /* rows="4" sets the starting height via the DOM; min-height keeps it from
       ever going shorter than that once JS takes over. resize:none because a
       manually-dragged height would just get overwritten on the next keystroke. */
    min-height: 6.2rem;
    overflow-y: hidden;
    resize: none;
}

.reflectionActions {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.5rem;
}

.aiAnalysisErr {
    font-size: 0.8rem;
    line-height: 1.5;
    color: #f28b8b;
    background: rgba(220, 53, 69, 0.08);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 0.5rem;
    padding: 0.5rem 0.7rem;
}

/* AI output gets its own accent (blue, matching the app's other AI-analysis
   surfaces) so it reads visibly distinct from the trader's own writing above --
   the reflection is what they wrote, this is a model checking it. */
.aiAnalysisBlock {
    border-left: 3px solid #2f9bff;
    padding: 0.55rem 0.75rem;
    background: rgba(47, 155, 255, 0.06);
    border-radius: 0 0.35rem 0.35rem 0;
}

.aiAnalysisHead {
    display: flex;
    align-items: center;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #2f9bff;
    margin-bottom: 0.35rem;
}

.aiAnalysisTime {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.7rem;
    color: var(--white-60);
}

.aiAnalysisLineHead {
    font-weight: 700;
    font-size: 0.88rem;
    margin-top: 0.6rem;
}

.aiAnalysisLineHead:first-child {
    margin-top: 0;
}

.aiAnalysisLine {
    white-space: pre-wrap;
    font-size: 0.88rem;
    line-height: 1.55;
}

/* The days the week covers, so the summary can be checked against them. */
.weekDayList {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.8rem;
    padding-top: 0.6rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.weekDayChip {
    font-size: 0.72rem;
    color: var(--white-60);
    background: rgba(255, 255, 255, 0.05);
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
}

.dayNoteBlock {
    border-left: 3px solid #f59e0b;
    padding: 0.5rem 0.75rem;
    background: rgba(245, 158, 11, 0.05);
    border-radius: 0 0.35rem 0.35rem 0;
}

.dayNoteHead {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #f59e0b;
    margin-bottom: 0.25rem;
}

.dayNoteBody {
    white-space: pre-wrap;
    font-size: 0.88rem;
    line-height: 1.55;
}

</style>
