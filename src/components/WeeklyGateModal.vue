<script setup>
/**
 * One modal, three gate types (see src/utils/weeklyGates.js). Mounted once in
 * DashboardLayout so it evaluates on every page load regardless of which page
 * -- static backdrop, no keyboard-close, no close button: the only way out is
 * completing the gate, which is what each Save/Reviewed handler does.
 */
import { ref, reactive, computed, watch, onMounted } from 'vue'
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(isoWeek)
dayjs.extend(utc)
dayjs.extend(timezone)
import { timeZoneTrade } from '../stores/globals.js'
import {
    weeklyGate, weeklyGateTarget, evaluateWeeklyGates, previewWeeklyGate,
    saveWeeklyPlan, markPlanReviewed, saveReflectionForGate,
} from '../utils/weeklyGates'

const submitting = ref(false)
const planDraftText = ref('')
const planFile = ref(null)
const reflectionDraft = ref('')

// What the modal renders -- kept separate from weeklyGate/weeklyGateTarget so
// the close (fade) animation always has real data, same reasoning as
// EntryChecklistModal's `displayed`.
const displayedGate = ref(null)
const displayedWeek = ref(null)

let modal = null
onMounted(() => {
    const el = document.getElementById('weeklyGateModal')
    modal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false })
    el.addEventListener('hidden.bs.modal', () => {
        displayedGate.value = null
        displayedWeek.value = null
    })

    // Console-callable preview: testWeeklyGate('plan' | 'review' | 'reflection').
    // Doesn't touch the database until you actually click Save/Reviewed inside it.
    if (typeof window !== 'undefined') {
        window.testWeeklyGate = (type) => previewWeeklyGate(type)
    }

    evaluateWeeklyGates()
})

watch([weeklyGate, weeklyGateTarget], ([gate, week]) => {
    if (gate) {
        planDraftText.value = (week && week.planText) || ''
        planFile.value = null
        reflectionDraft.value = (week && week.reflection) || ''
        displayedGate.value = gate
        displayedWeek.value = week
        if (modal) modal.show()
    } else if (modal) {
        modal.hide() // displayedGate/displayedWeek cleared by 'hidden.bs.modal' above
    }
}, { immediate: true })

const weekLabel = computed(() => {
    const w = displayedWeek.value
    if (!w) return ''
    const s = dayjs.unix(w.dateUnix).tz(timeZoneTrade.value || 'UTC')
    return `${s.format('MMM D')} – ${s.add(6, 'day').format('MMM D, YYYY')}`
})

function onFileChange(e) {
    planFile.value = (e.target.files && e.target.files[0]) || null
}

const hasPdf = computed(() => {
    const w = displayedWeek.value
    return !!(planFile.value || (w && (w.planPdfUrl || w.planPdfBase64)))
})
const pdfName = computed(() => {
    const w = displayedWeek.value
    return (planFile.value && planFile.value.name) || (w && w.planPdfName) || 'plan.pdf'
})
const pdfHref = computed(() => {
    const w = displayedWeek.value
    return w ? (w.planPdfUrl || w.planPdfBase64 || '') : ''
})

const isPlanComplete = computed(() => !!planDraftText.value.trim() && hasPdf.value)

async function submitPlan() {
    if (!isPlanComplete.value || submitting.value || !displayedWeek.value) return
    submitting.value = true
    try {
        await saveWeeklyPlan(displayedWeek.value.dateUnix, { text: planDraftText.value, file: planFile.value })
    } catch (e) {
        console.error('could not save weekly plan', e)
    } finally {
        submitting.value = false
    }
}

async function submitReview() {
    if (submitting.value || !displayedWeek.value) return
    submitting.value = true
    try {
        // The Monday popup allows editing -- if the text or file changed, save
        // that first so "Reviewed" also captures any revision, not just the ack.
        const w = displayedWeek.value
        if (planDraftText.value !== (w.planText || '') || planFile.value) {
            await saveWeeklyPlan(w.dateUnix, { text: planDraftText.value, file: planFile.value })
        }
        await markPlanReviewed(w.dateUnix)
    } catch (e) {
        console.error('could not save plan review', e)
    } finally {
        submitting.value = false
    }
}

async function submitReflection() {
    if (!reflectionDraft.value.trim() || submitting.value || !displayedWeek.value) return
    submitting.value = true
    try {
        await saveReflectionForGate(displayedWeek.value.dateUnix, reflectionDraft.value)
    } catch (e) {
        console.error('could not save reflection', e)
    } finally {
        submitting.value = false
    }
}
</script>

<template>
    <div class="modal fade" id="weeklyGateModal" tabindex="-1" aria-labelledby="weeklyGateModalLabel" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content" v-if="displayedGate">

                <!-- ===== Friday: set next week's plan (mandatory) ===== -->
                <template v-if="displayedGate === 'plan'">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="uil uil-calendar-alt me-2"></i>Weekend chart review — plan for next week</h5>
                    </div>
                    <div class="modal-body">
                        <p class="wgIntro">Week of {{ weekLabel }}. Write the plan and attach the chart PDF before this
                            closes -- both are required.</p>
                        <label class="wgLabel">Plan — what's the setup, how are you reading the chart?</label>
                        <textarea class="form-control form-control-sm mb-3" rows="5" v-model="planDraftText"
                            placeholder="Levels, bias, what would confirm or invalidate it, how you're reading the chart..."></textarea>
                        <label class="wgLabel">Chart PDF <span class="wgReq">required</span></label>
                        <input type="file" accept="application/pdf" class="form-control form-control-sm" v-on:change="onFileChange">
                        <div v-if="hasPdf" class="wgFileOk"><i class="uil uil-check-circle me-1"></i>{{ pdfName }}</div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-success btn-sm" :disabled="!isPlanComplete || submitting" v-on:click="submitPlan">
                            <span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status"></span>Save plan
                        </button>
                    </div>
                </template>

                <!-- ===== Monday: review (and optionally edit) this week's plan ===== -->
                <template v-else-if="displayedGate === 'review'">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="uil uil-repeat me-2"></i>Monday — review your plan</h5>
                    </div>
                    <div class="modal-body">
                        <p class="wgIntro">Week of {{ weekLabel }}. Read back what you planned last Friday. Edit it if
                            it needs changing, then confirm.</p>
                        <label class="wgLabel">Plan</label>
                        <textarea class="form-control form-control-sm mb-3" rows="5" v-model="planDraftText"
                            placeholder="No plan was written for this week -- write one now."></textarea>
                        <label class="wgLabel">Chart PDF</label>
                        <a v-if="pdfHref" :href="pdfHref" target="_blank" rel="noopener" class="wgFileOk wgFileLink">
                            <i class="uil uil-file-alt me-1"></i>{{ pdfName }} <i class="uil uil-external-link-alt ms-1"></i>
                        </a>
                        <div v-else class="wgIntro mb-2">No PDF was attached.</div>
                        <input type="file" accept="application/pdf" class="form-control form-control-sm mt-2" v-on:change="onFileChange"
                            placeholder="Replace PDF (optional)">
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-success btn-sm" :disabled="submitting" v-on:click="submitReview">
                            <span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status"></span>Reviewed
                        </button>
                    </div>
                </template>

                <!-- ===== Missing reflection on a past week ===== -->
                <template v-else-if="displayedGate === 'reflection'">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="uil uil-comment-alt-edit me-2"></i>Write last week's reflection</h5>
                    </div>
                    <div class="modal-body">
                        <p class="wgIntro">Week of {{ weekLabel }} has no reflection yet.</p>
                        <div class="wgSummary" v-if="displayedWeek && displayedWeek.note">{{ displayedWeek.note }}</div>
                        <label class="wgLabel">What did this week teach you? What will you do differently?</label>
                        <textarea class="form-control form-control-sm" rows="5" v-model="reflectionDraft"
                            placeholder="Write it here..."></textarea>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-success btn-sm" :disabled="!reflectionDraft.trim() || submitting" v-on:click="submitReflection">
                            <span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status"></span>Save reflection
                        </button>
                    </div>
                </template>

            </div>
        </div>
    </div>
</template>

<style scoped>
.modal-header { border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
.modal-footer { border-top: 1px solid rgba(255, 255, 255, 0.06); }

.wgIntro {
    font-size: 0.85rem;
    color: var(--white-60);
    margin-bottom: 0.9rem;
}

.wgLabel {
    display: block;
    font-size: 0.82rem;
    font-weight: 600;
    margin-bottom: 0.4rem;
}

.wgReq {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #f59e0b;
    margin-left: 0.3rem;
}

.wgFileOk {
    margin-top: 0.5rem;
    font-size: 0.82rem;
    color: #00CA73;
}

.wgFileLink { display: inline-block; }
.wgFileLink:hover { text-decoration: underline; }

.wgSummary {
    white-space: pre-wrap;
    font-size: 0.85rem;
    line-height: 1.55;
    color: var(--white-60);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 0.4rem;
    padding: 0.6rem 0.75rem;
    margin-bottom: 0.9rem;
}
</style>
