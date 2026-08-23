/**
 * Weekly discipline gates -- global, non-dismissible until satisfied. Unlike
 * entryChecklist (queued, one popup per new order), these are date-driven and
 * read/write the SAME `notes` week records Diary.vue already shows (plan
 * fields + reflection/checkReflected), re-evaluated on every page load: this
 * app navigates by full page reload, not SPA routing, so "keeps popping up
 * across pages" just means re-checking fresh each time, same as
 * entryChecklist's own queue does for open positions.
 *
 * Three gates, in this priority when more than one applies on the same day:
 *   1. reflection  - last week has a summary but no written reflection
 *   2. review      - today is Monday and this week's plan hasn't been re-read
 *   3. plan        - the weekend has started (Friday 23:59 through Sunday) and
 *                    next week's plan (text + PDF) is missing
 */
import { ref, computed } from 'vue'
import Parse from 'parse/dist/parse.min.js'
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(isoWeek)
dayjs.extend(utc)
dayjs.extend(timezone)
import { timeZoneTrade } from '../stores/globals.js'
import { useUploadImageToR2 } from './r2.js'

const activeGate = ref(null)     // 'reflection' | 'review' | 'plan' | null
const targetWeek = ref(null)     // the week note (real or stub) the gate concerns

function tz() {
    return timeZoneTrade.value || 'UTC'
}
function thisMonday() {
    return dayjs().tz(tz()).startOf('isoWeek')
}

/**
 * Every week record, unfiltered. Exported for the Weekly Plan page, which needs
 * exactly this and not daily.js's useGetWeekNotes(): that one drops weeks with no
 * summary AND no plan text, so a week carrying only `planReviewed` disappears --
 * and the page would then redraw it as "Not reviewed", losing a flag the user had
 * just set. Nothing here is thrown away, so the caller decides what is relevant.
 */
export async function loadWeekNotes() {
    const parseObject = Parse.Object.extend('notes')
    const query = new Parse.Query(parseObject)
    query.equalTo('user', Parse.User.current())
    query.equalTo('tradeId', 'week')
    query.descending('dateUnix')
    query.limit(500) // one row per week, so the whole history is still tiny
    const results = await query.find()
    return results.map((r) => ({
        dateUnix: r.get('dateUnix'),
        note: r.get('note') || '',
        reflection: r.get('reflection') || '',
        checkReflected: !!r.get('checkReflected'),
        planText: r.get('planText') || '',
        planPdfUrl: r.get('planPdfUrl') || '',
        planPdfBase64: r.get('planPdfBase64') || '',
        planPdfName: r.get('planPdfName') || '',
        planReviewed: !!r.get('planReviewed'),
        planReviewNote: r.get('planReviewNote') || '',
    }))
}

/**
 * Does a week's chart attachment hold an image rather than a PDF?
 *
 * The stored fields are still named planPdf* -- they predate images being allowed,
 * and renaming them would mean migrating every existing week for no behavioural
 * gain. So the type is read from the value: a data URL states its own mime, and a
 * stored URL or filename is judged by extension.
 *
 * Worth distinguishing because an image can be shown in place, and a chart you can
 * see without opening anything is the difference between re-reading the plan on
 * Monday and clicking past it.
 */
export function planAttachmentIsImage(week) {
    if (!week) return false
    if (week.planPdfBase64) return week.planPdfBase64.startsWith('data:image/')
    const source = week.planPdfUrl || week.planPdfName || ''
    return /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(source)
}

/**
 * Is it the weekend planning window -- Friday 23:59 through the end of Sunday?
 *
 * The gate used to fire from Friday midnight, i.e. all through Friday's session.
 * That is precisely the wrong time: it interrupts trading to demand a plan for a
 * week that has not started, using a chart that is still moving. It is called a
 * WEEKEND chart review because the market being shut is the point -- the week is
 * finished, the closing prints are final, and there is nothing to react to.
 *
 * So it opens once Friday is effectively over and stays open across Saturday and
 * Sunday. Monday is deliberately not included: by then the review gate has taken
 * over, and a plan written after the week has started is a different thing.
 *
 * Exported because the Weekly Plan page describes this window to the trader, and
 * a banner that says "due Friday" while the popup arrives on Saturday is worse
 * than either alone.
 */
const FRIDAY_OPENS_AT_MINUTE = 23 * 60 + 59   // 23:59 in the trade timezone

export function isWeekendPlanningWindow(now) {
    const t = now || dayjs().tz(tz())
    const day = t.isoWeekday()                 // 1 = Monday ... 7 = Sunday
    if (day === 6 || day === 7) return true
    return day === 5 && (t.hour() * 60 + t.minute()) >= FRIDAY_OPENS_AT_MINUTE
}

/**
 * Monday re-read window: from 06:00 on Monday, in the trade timezone.
 *
 * Not from midnight. Monday 00:00 is still Sunday night in every practical sense
 * -- the weekend planning window has only just closed, the trader is asleep, and
 * a gate that fires then is answered half-awake or dismissed by reflex, which is
 * the opposite of re-reading anything. 06:00 puts it in the morning, before the
 * session, which is when the plan actually has to be back in mind.
 *
 * Exported for the same reason as the planning window: the Weekly Plan page
 * describes this to the trader, and a banner that disagrees with the popup is
 * worse than either alone.
 */
const MONDAY_REVIEW_OPENS_AT_MINUTE = 6 * 60   // 06:00 in the trade timezone

export function isMondayReviewWindow(now) {
    const t = now || dayjs().tz(tz())
    if (t.isoWeekday() !== 1) return false
    return (t.hour() * 60 + t.minute()) >= MONDAY_REVIEW_OPENS_AT_MINUTE
}

function findWeek(dateUnix, notes) {
    return notes.find((n) => Number(n.dateUnix) === Number(dateUnix)) || null
}
function stubWeek(dateUnix) {
    return { dateUnix, note: '', reflection: '', checkReflected: false, planText: '', planPdfUrl: '', planPdfBase64: '', planPdfName: '', planReviewed: false, planReviewNote: '' }
}

export async function evaluateWeeklyGates() {
    if (!Parse.User.current()) return
    const notes = await loadWeekNotes()
    const monday = thisMonday()
    const today = dayjs().tz(tz())
    const reviewWindow = isMondayReviewWindow(today)
    const planningWindow = isWeekendPlanningWindow(today)

    // 1. reflection: last week had a summary written but no reflection on it.
    const lastWeek = findWeek(monday.subtract(7, 'day').unix(), notes)
    if (lastWeek && lastWeek.note.trim() && !lastWeek.checkReflected) {
        activeGate.value = 'reflection'
        targetWeek.value = lastWeek
        return
    }

    // 2. review: Monday from 06:00, this week's plan not yet re-read/acknowledged.
    if (reviewWindow) {
        const week = findWeek(monday.unix(), notes) || stubWeek(monday.unix())
        if (!week.planReviewed) {
            activeGate.value = 'review'
            targetWeek.value = week
            return
        }
    }

    // 3. plan: the weekend is here and next week's plan (text + PDF, both
    //    required) is missing. See isWeekendPlanningWindow for the timing.
    if (planningWindow) {
        const nextMonday = monday.add(7, 'day').unix()
        const week = findWeek(nextMonday, notes) || stubWeek(nextMonday)
        if (!week.planText.trim() || (!week.planPdfUrl && !week.planPdfBase64)) {
            activeGate.value = 'plan'
            targetWeek.value = week
            return
        }
    }

    activeGate.value = null
    targetWeek.value = null
}

export const weeklyGate = computed(() => activeGate.value)
export const weeklyGateTarget = computed(() => targetWeek.value)

/** Console-callable preview (see WeeklyGateModal's testWeeklyGate hook). Does
 *  not touch the database -- only Save/Reviewed inside the modal does that. */
export function previewWeeklyGate(type) {
    const w = stubWeek(thisMonday().unix())
    w.note = 'Sample week summary.'
    activeGate.value = type || 'plan'
    targetWeek.value = w
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}

async function findOrCreateWeekNote(dateUnix) {
    const parseObject = Parse.Object.extend('notes')
    const query = new Parse.Query(parseObject)
    query.equalTo('user', Parse.User.current())
    query.equalTo('tradeId', 'week')
    query.equalTo('dateUnix', Number(dateUnix))
    const existing = await query.first()
    if (existing) return existing
    const obj = new parseObject()
    obj.set('user', Parse.User.current())
    obj.set('tradeId', 'week')
    obj.set('dateUnix', Number(dateUnix))
    obj.set('note', '')
    obj.setACL(new Parse.ACL(Parse.User.current()))
    return obj
}

/** Friday gate + Monday review both write through here -- same fields, same upsert. */
export async function saveWeeklyPlan(dateUnix, { text, file }) {
    const obj = await findOrCreateWeekNote(dateUnix)
    obj.set('planText', text || '')
    if (file) {
        const base64 = await fileToBase64(file)
        const dateStr = dayjs.unix(dateUnix).tz(tz()).format('YYYY-MM-DD')
        const safe = (file.name || 'weekplan').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
        const up = await useUploadImageToR2(base64, 'weekplan_' + dateStr + '_' + safe)
        if (up) { obj.set('planPdfUrl', up.url); obj.set('planPdfKey', up.key); obj.unset('planPdfBase64') }
        else { obj.set('planPdfBase64', base64); obj.unset('planPdfUrl') } // R2 off -> keep in DB
        obj.set('planPdfName', file.name || 'plan.pdf')
    }
    await obj.save()
    await evaluateWeeklyGates()
}

/**
 * Monday's acknowledgement. The written re-check is the point, not the flag: a
 * boolean can be set by a reflex click on a plan nobody looked at, whereas you
 * cannot write what the plan says without having read it. So the note is required
 * by every caller (the gate popup and the Weekly Plan page both collect one), and
 * it is stored alongside the flag so the week can show WHAT was re-checked.
 */
export async function markPlanReviewed(dateUnix, note) {
    const text = (note || '').trim()
    if (!text) throw new Error('a written re-check is required to mark a plan reviewed')
    const obj = await findOrCreateWeekNote(dateUnix)
    obj.set('planReviewed', true)
    obj.set('planReviewNote', text)
    obj.set('planReviewedAt', new Date())
    await obj.save()
    await evaluateWeeklyGates()
}

export async function saveReflectionForGate(dateUnix, reflection) {
    const obj = await findOrCreateWeekNote(dateUnix)
    obj.set('reflection', reflection || '')
    obj.set('checkReflected', !!(reflection || '').trim())
    await obj.save()
    await evaluateWeeklyGates()
}
