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
 *   3. plan        - today is Friday and next week's plan (text + PDF) is missing
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
    }))
}

function findWeek(dateUnix, notes) {
    return notes.find((n) => Number(n.dateUnix) === Number(dateUnix)) || null
}
function stubWeek(dateUnix) {
    return { dateUnix, note: '', reflection: '', checkReflected: false, planText: '', planPdfUrl: '', planPdfBase64: '', planPdfName: '', planReviewed: false }
}

export async function evaluateWeeklyGates() {
    if (!Parse.User.current()) return
    const notes = await loadWeekNotes()
    const monday = thisMonday()
    const today = dayjs().tz(tz())
    const isMonday = today.isoWeekday() === 1
    const isFriday = today.isoWeekday() === 5

    // 1. reflection: last week had a summary written but no reflection on it.
    const lastWeek = findWeek(monday.subtract(7, 'day').unix(), notes)
    if (lastWeek && lastWeek.note.trim() && !lastWeek.checkReflected) {
        activeGate.value = 'reflection'
        targetWeek.value = lastWeek
        return
    }

    // 2. review: Monday, this week's plan not yet re-read/acknowledged.
    if (isMonday) {
        const week = findWeek(monday.unix(), notes) || stubWeek(monday.unix())
        if (!week.planReviewed) {
            activeGate.value = 'review'
            targetWeek.value = week
            return
        }
    }

    // 3. plan: Friday, next week's plan (text + PDF, both required) is missing.
    if (isFriday) {
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

export async function markPlanReviewed(dateUnix) {
    const obj = await findOrCreateWeekNote(dateUnix)
    obj.set('planReviewed', true)
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
