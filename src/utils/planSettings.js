/**
 * Your trading plan's inputs, shared between the Trading Plan and Plan vs Actual
 * pages so you only type them once. Module-level refs are singletons, and the
 * values persist in localStorage across reloads.
 *
 * Deliberately empty by default — nothing is ever computed from made-up numbers.
 */
import { ref, watch } from 'vue'

const KEY = 'tradenote_plan_settings'

function load() {
    try {
        return JSON.parse(localStorage.getItem(KEY)) || {}
    } catch {
        return {}
    }
}

const saved = load()

export const startBalance = ref(saved.startBalance ?? '')
export const horizonMonths = ref(saved.horizonMonths ?? '')
export const dailyPct = ref(saved.dailyPct ?? '')
export const goalBalance = ref(saved.goalBalance ?? '')

watch([startBalance, horizonMonths, dailyPct, goalBalance], () => {
    try {
        localStorage.setItem(KEY, JSON.stringify({
            startBalance: startBalance.value,
            horizonMonths: horizonMonths.value,
            dailyPct: dailyPct.value,
            goalBalance: goalBalance.value,
        }))
    } catch {
        // storage unavailable (private mode / quota) — plan still works in-session
    }
})
