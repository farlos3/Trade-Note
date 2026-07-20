/**
 * Multiple trading plans, each identified by a numeric ID (Plan 1, Plan 2, ...),
 * shared between the Trading Plan and Plan vs Actual pages so switching plans on
 * one page is reflected on the other. Persisted to localStorage.
 *
 * Deliberately empty by default — nothing is ever computed from made-up numbers.
 */
import { reactive, computed, watch } from 'vue'
import dayjs from 'dayjs'

const KEY = 'tradenote_plans_v1'
const LEGACY_KEY = 'tradenote_plan_settings' // pre-multi-plan single settings blob

function blankPlan(id) {
    return {
        id,
        name: `Plan ${id}`,
        startDate: dayjs().format('YYYY-MM-DD'),
        startBalance: '',
        horizonMonths: '',
        dailyPct: '',
        goalBalance: '',
        // Ad-hoc deposits: { id, date: 'YYYY-MM-DD', amount }. No fixed cadence —
        // add one whenever you actually put money in.
        deposits: [],
        // Translates the $/day target into pips/day, using the same pip-size /
        // contract-size conventions as manual order entry (see addOrder.js).
        symbol: 'XAUUSD',
        lotSize: '',
    }
}

function load() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY))
        if (raw && Array.isArray(raw.plans) && raw.plans.length) return raw
    } catch {
        // fall through to legacy migration / fresh state
    }

    // One-time migration from the single-plan settings this replaced. Deposits
    // there were cadence-based (amount + every week/month) with no explicit
    // dates, so they can't be converted to ad-hoc entries — only the balance
    // and rate fields carry over; deposits start empty on the migrated plan.
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY))
        if (legacy) {
            const p = blankPlan(1)
            p.startBalance = legacy.startBalance ?? ''
            p.horizonMonths = legacy.horizonMonths ?? ''
            p.dailyPct = legacy.dailyPct ?? ''
            p.goalBalance = legacy.goalBalance ?? ''
            return { plans: [p], activePlanId: 1, nextId: 2 }
        }
    } catch {
        // fall through to fresh state
    }

    return { plans: [blankPlan(1)], activePlanId: 1, nextId: 2 }
}

/** Backfill any fields added after a plan was first saved (e.g. symbol/lotSize),
 * so older persisted plans don't silently miss new features. */
function normalize(raw) {
    const template = blankPlan(0)
    raw.plans = raw.plans.map((p) => ({ ...template, ...p, id: p.id }))
    return raw
}

const state = reactive(normalize(load()))

export const plans = computed(() => state.plans)

export const activePlanId = computed({
    get: () => state.activePlanId,
    set: (id) => { if (state.plans.some((p) => p.id === id)) state.activePlanId = id },
})

export const activePlan = computed(
    () => state.plans.find((p) => p.id === state.activePlanId) || state.plans[0],
)

export function createPlan() {
    const id = state.nextId++
    const p = blankPlan(id)
    state.plans.push(p)
    state.activePlanId = id
    return p
}

/** Never deletes the last remaining plan — there must always be one to edit. */
export function deletePlan(id) {
    if (state.plans.length <= 1) return
    const idx = state.plans.findIndex((p) => p.id === id)
    if (idx === -1) return
    state.plans.splice(idx, 1)
    if (state.activePlanId === id) state.activePlanId = state.plans[0].id
}

export function renamePlan(id, name) {
    const p = state.plans.find((p) => p.id === id)
    if (p) p.name = (name || '').trim() || `Plan ${id}`
}

export function addDeposit(plan) {
    plan.deposits.push({ id: Date.now() + Math.random(), date: dayjs().format('YYYY-MM-DD'), amount: '' })
}

export function removeDeposit(plan, depositId) {
    const idx = plan.deposits.findIndex((d) => d.id === depositId)
    if (idx !== -1) plan.deposits.splice(idx, 1)
}

watch(state, () => {
    try {
        localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
        // storage unavailable (private mode / quota) — plans still work in-session
    }
}, { deep: true })
