<script setup>
/**
 * Post-entry review popup, offered by Live.vue (an open position with no
 * checklist yet) and Daily.vue/History (a trade that just synced in). See
 * src/utils/entryChecklist.js for the shared queue this reads from -- one
 * instance here (mounted once in DashboardLayout) serves both pages.
 */
import { reactive, ref, computed, watch, onMounted } from 'vue'
import { currentEntryChecklist, saveEntryChecklist, offerEntryChecklist } from '../utils/entryChecklist'
import { usePipSize } from '../utils/addOrder'

const EMOTIONS = [
    { id: 'calm', label: 'Calm', color: '#22c55e' },
    { id: 'confident', label: 'Confident', color: '#38bdf8' },
    { id: 'nervous', label: 'Nervous', color: '#ef4444' },
    { id: 'excited', label: 'Excited', color: '#f59e0b' },
    { id: 'frustrated', label: 'Frustrated', color: '#94a3b8' },
]
const REVENGE_SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

// The trader's own current risk rule, restated back at the "Oversized?" question
// so it's a comparison against a real number instead of a gut feeling. Update
// this if/when the acceptable size changes.
const MAX_ACCEPTABLE_LOT = 0.03

function blankAnswers() {
    return {
        // null, not false: "I have no stop" and "I have not answered yet" are
        // different states, and a checkbox defaulting to unticked conflates them --
        // which let the single most important question on the form be skipped by
        // simply not touching it.
        hasTp: null, tpPrice: '',
        hasSl: null, slPrice: '',
        tpSlAcceptable: null,
        positionQuality: null,
        entryEmotion: null,
        entryReasoning: '',
        logicValid: null,
        oversized: null,
        // A range slider always reports a number, unlike the other null-until-
        // chosen fields -- 1 (the low end, "no urge") is the honest resting
        // position for a trade you haven't dragged this for.
        revengeScore: 1,
    }
}
const answers = reactive(blankAnswers())
const submitting = ref(false)

// What the modal renders. Kept separate from currentEntryChecklist so the close
// (fade) animation always has real data to render instead of the DOM being torn
// out from under it the instant the queue empties.
const displayed = ref(null)

let modal = null
onMounted(() => {
    const el = document.getElementById('entryChecklistModal')
    // static + no keyboard-close + no dismiss button anywhere: the checklist is a
    // hard gate on a new order, not a dismissible toast. The only way out is
    // completing it -- save() is the sole caller of modal.hide().
    modal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false })
    el.addEventListener('hidden.bs.modal', () => {
        displayed.value = null
        showMissing.value = false
        Object.assign(answers, blankAnswers())
    })

    // Console-callable preview, so the checklist can be reviewed without waiting
    // for a real order: open devtools on any page and run testEntryChecklist().
    // Saving it writes a real entryChecklists row (tradeId "test-..."), same as
    // any other trade -- delete it from the DB afterwards if that matters.
    if (typeof window !== 'undefined') {
        window.testEntryChecklist = () => offerEntryChecklist({
            tradeId: 'test-' + Date.now(),
            dateUnix: Math.floor(Date.now() / 1000),
            symbol: 'XAUUSD',
            side: 'buy',
            entryPrice: 2440.00,
            tp: 2444.50,
            sl: 2438.00,
            lot: 0.05,
        })
    }
})

watch(currentEntryChecklist, (t) => {
    if (t) {
        Object.assign(answers, blankAnswers())
        showMissing.value = false
        // MT5 reports "no stop" as price 0 -- prefilled only when a real price
        // came from the live feed. History-sourced trades have no broker TP/SL
        // to prefill, so these stay blank for manual entry.
        if (t.tp) { answers.hasTp = true; answers.tpPrice = t.tp }
        if (t.sl) { answers.hasSl = true; answers.slPrice = t.sl }
        displayed.value = t
        if (modal) modal.show()
    } else if (modal) {
        modal.hide()   // displayed/answers are cleared by 'hidden.bs.modal' above
    }
}, { immediate: true })

const pipSize = computed(() => usePipSize(displayed.value && displayed.value.symbol))

function pipsFor(price) {
    const t = displayed.value
    if (!t || !t.entryPrice || price === '' || price == null) return null
    const d = Number(price) - Number(t.entryPrice)
    const directional = (t.side === 'sell' || t.side === 'short') ? -d : d
    return directional / pipSize.value
}
// Signed in the direction that matters: positive TP pips is profit distance,
// negative SL pips means the stop sits on the losing side, as it must.
const tpPips = computed(() => (answers.hasTp ? pipsFor(answers.tpPrice) : null))
const slPips = computed(() => (answers.hasSl ? pipsFor(answers.slPrice) : null))
const fmtPips = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1))

const sideLabel = computed(() => {
    const s = displayed.value && displayed.value.side
    return s === 'sell' || s === 'short' ? 'SELL' : 'BUY'
})

/* Every question, and whether it has been answered.
 *
 * One list rather than a boolean, because "you may not skip anything" is only
 * enforceable if the form can say WHICH thing is outstanding. A Save button that
 * is simply disabled tells the trader they are not finished and nothing else, and
 * on a form this long that is a hunt -- so the same list drives the gate, the
 * counter, the jump-to chips and the per-block highlight. There is no way for
 * them to disagree with each other.
 *
 * Order matches the form top to bottom, so "2 left" reads in the order they will
 * be filled in.
 */
const REQUIREMENTS = [
    { key: 'stops', block: 'stops', label: 'SL / TP', done: (a) => a.hasSl !== null && a.hasTp !== null && !(a.hasSl && !a.slPrice) && !(a.hasTp && !a.tpPrice) },
    { key: 'tpSlAcceptable', block: 'judgment', label: 'SL/TP acceptable', done: (a) => a.tpSlAcceptable !== null },
    { key: 'positionQuality', block: 'judgment', label: 'Position quality', done: (a) => a.positionQuality !== null },
    { key: 'oversized', block: 'judgment', label: 'Oversized', done: (a) => a.oversized !== null },
    { key: 'entryEmotion', block: 'emotion', label: 'Emotion', done: (a) => a.entryEmotion !== null },
    { key: 'entryReasoning', block: 'reasoning', label: 'Why you entered', done: (a) => !!a.entryReasoning.trim() },
    { key: 'logicValid', block: 'logic', label: 'Logic still valid', done: (a) => a.logicValid !== null },
]

const missing = computed(() =>
    displayed.value ? REQUIREMENTS.filter((r) => !r.done(answers)) : REQUIREMENTS
)
const isComplete = computed(() => !!displayed.value && missing.value.length === 0)
const answeredCount = computed(() => REQUIREMENTS.length - missing.value.length)

// Blocks with something outstanding are only marked once the trader has tried to
// finish. Flagging every unanswered question the instant the popup opens would
// paint the whole form red before they have had a chance to answer anything.
const showMissing = ref(false)
const blockIncomplete = (block) =>
    showMissing.value && missing.value.some((m) => m.block === block)

function jumpTo(req) {
    showMissing.value = true
    const el = document.getElementById('ecBlock-' + req.block)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function save() {
    if (submitting.value) return
    if (!isComplete.value) {
        // Reachable now that Save stays clickable while incomplete: pressing it is
        // how the trader asks "what is left?", so answer that instead of nothing.
        showMissing.value = true
        jumpTo(missing.value[0])
        return
    }
    submitting.value = true
    try {
        await saveEntryChecklist(displayed.value, {
            ...answers,
            tpPips: tpPips.value,
            slPips: slPips.value,
        })
    } catch (e) {
        console.error('could not save entry checklist', e)
    } finally {
        submitting.value = false
    }
}
</script>

<template>
    <div class="modal fade" id="entryChecklistModal" tabindex="-1" aria-labelledby="entryChecklistModalLabel"
        aria-hidden="true">
        <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content" v-if="displayed">
                <div class="modal-header">
                    <h5 class="modal-title" id="entryChecklistModalLabel">
                        <i class="uil uil-clipboard-notes me-2"></i>New order — quick review
                    </h5>
                </div>
                <div class="modal-body">
                    <div class="ecHead mb-3">
                        <span class="sideTag" v-bind:class="sideLabel.toLowerCase()">{{ sideLabel }}</span>
                        <span class="ecSymbol">{{ displayed.symbol }}</span>
                        <span v-if="displayed.entryPrice" class="ecEntry">
                            entry {{ displayed.entryPrice }}
                        </span>
                    </div>

                    <div class="ecSectionLabel">The setup</div>

                    <!-- 1: TP/SL -->
                    <div class="ecBlock" id="ecBlock-stops" :class="{ ecIncomplete: blockIncomplete('stops') }">
                        <label class="ecLabel">Stop loss / take profit — price and pips</label>
                        <div class="row g-2">
                            <div class="col-6">
                                <div class="ecStopRow">
                                    <span class="ecStopName">SL</span>
                                    <div class="ecChoice ecStopChoice">
                                        <button type="button" class="btn btn-sm"
                                            v-bind:class="answers.hasSl === true ? 'btn-success' : 'btn-outline-success'"
                                            v-on:click="answers.hasSl = true">Set</button>
                                        <button type="button" class="btn btn-sm"
                                            v-bind:class="answers.hasSl === false ? 'btn-danger' : 'btn-outline-danger'"
                                            v-on:click="answers.hasSl = false; answers.slPrice = ''">None</button>
                                    </div>
                                    <input v-if="answers.hasSl" type="number" step="any"
                                        class="form-control form-control-sm ecPriceInput" v-model="answers.slPrice"
                                        placeholder="Price">
                                    <span v-if="answers.hasSl" class="ecPips neg">{{ fmtPips(slPips) }} pips</span>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="ecStopRow">
                                    <span class="ecStopName">TP</span>
                                    <div class="ecChoice ecStopChoice">
                                        <button type="button" class="btn btn-sm"
                                            v-bind:class="answers.hasTp === true ? 'btn-success' : 'btn-outline-success'"
                                            v-on:click="answers.hasTp = true">Set</button>
                                        <button type="button" class="btn btn-sm"
                                            v-bind:class="answers.hasTp === false ? 'btn-danger' : 'btn-outline-danger'"
                                            v-on:click="answers.hasTp = false; answers.tpPrice = ''">None</button>
                                    </div>
                                    <input v-if="answers.hasTp" type="number" step="any"
                                        class="form-control form-control-sm ecPriceInput" v-model="answers.tpPrice"
                                        placeholder="Price">
                                    <span v-if="answers.hasTp" class="ecPips pos">{{ fmtPips(tpPips) }} pips</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 2/3/4: three quick judgment calls on the setup itself, side by
                         side -- these used to be three separate full-width blocks and
                         made the modal feel much longer than a "quick review" should. -->
                    <div class="ecBlock" id="ecBlock-judgment" :class="{ ecIncomplete: blockIncomplete('judgment') }">
                        <div class="row g-3">
                            <div class="col-md-4">
                                <label class="ecLabel">SL/TP acceptable?</label>
                                <div class="ecChoice">
                                    <button type="button" class="btn btn-sm"
                                        v-bind:class="answers.tpSlAcceptable === true ? 'btn-success' : 'btn-outline-success'"
                                        v-on:click="answers.tpSlAcceptable = true">Yes</button>
                                    <button type="button" class="btn btn-sm"
                                        v-bind:class="answers.tpSlAcceptable === false ? 'btn-danger' : 'btn-outline-danger'"
                                        v-on:click="answers.tpSlAcceptable = false">No</button>
                                </div>
                            </div>
                            <div class="col-md-4">
                                <label class="ecLabel">Position quality?</label>
                                <div class="ecChoice">
                                    <button type="button" class="btn btn-sm"
                                        v-bind:class="answers.positionQuality === 'good' ? 'btn-success' : 'btn-outline-success'"
                                        v-on:click="answers.positionQuality = 'good'">Good</button>
                                    <button type="button" class="btn btn-sm"
                                        v-bind:class="answers.positionQuality === 'bad' ? 'btn-danger' : 'btn-outline-danger'"
                                        v-on:click="answers.positionQuality = 'bad'">Bad</button>
                                </div>
                            </div>
                            <div class="col-md-4">
                                <label class="ecLabel">
                                    Oversized?
                                    <span class="ecLotInfo" v-if="displayed.lot != null">
                                        Lot <strong v-bind:class="{ over: displayed.lot > MAX_ACCEPTABLE_LOT }">{{ displayed.lot }}</strong> <span class="ecLotMax">· max {{ MAX_ACCEPTABLE_LOT }}</span>
                                    </span>
                                </label>
                                <div class="ecChoice">
                                    <button type="button" class="btn btn-sm"
                                        v-bind:class="answers.oversized === true ? 'btn-danger' : 'btn-outline-danger'"
                                        v-on:click="answers.oversized = true">Yes</button>
                                    <button type="button" class="btn btn-sm"
                                        v-bind:class="answers.oversized === false ? 'btn-success' : 'btn-outline-success'"
                                        v-on:click="answers.oversized = false">No</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="ecSectionLabel">Your head right now</div>

                    <!-- 5: emotion at entry -->
                    <div class="ecBlock" id="ecBlock-emotion" :class="{ ecIncomplete: blockIncomplete('emotion') }">
                        <label class="ecLabel">How did you feel entering this?</label>
                        <div class="ecChoice ecWrap">
                            <button v-for="e in EMOTIONS" :key="e.id" type="button" class="btn btn-sm ecEmotionBtn"
                                v-bind:class="{ on: answers.entryEmotion === e.id }"
                                v-bind:style="answers.entryEmotion === e.id ? { backgroundColor: e.color, borderColor: e.color, color: '#0b0f14' } : { borderColor: e.color, color: e.color }"
                                v-on:click="answers.entryEmotion = e.id">{{ e.label }}</button>
                        </div>
                    </div>

                    <!-- 6: reasoning, full width -->
                    <div class="ecBlock" id="ecBlock-reasoning" :class="{ ecIncomplete: blockIncomplete('reasoning') }">
                        <label class="ecLabel">Why did you enter here? Does your logic still hold?</label>
                        <textarea class="form-control form-control-sm" rows="3" v-model="answers.entryReasoning"
                            placeholder="What was the setup / trigger, and is that logic still valid right now?"></textarea>
                    </div>

                    <!-- 7: logic still valid, its own row -->
                    <div class="ecBlock" id="ecBlock-logic" :class="{ ecIncomplete: blockIncomplete('logic') }">
                        <label class="ecLabel">Logic still valid?</label>
                        <div class="ecChoice">
                            <button type="button" class="btn btn-sm"
                                v-bind:class="answers.logicValid === true ? 'btn-success' : 'btn-outline-success'"
                                v-on:click="answers.logicValid = true">Yes</button>
                            <button type="button" class="btn btn-sm"
                                v-bind:class="answers.logicValid === false ? 'btn-danger' : 'btn-outline-danger'"
                                v-on:click="answers.logicValid = false">No</button>
                        </div>
                    </div>

                    <!-- 8: revenge score -- a slider spans the full width of the
                         popup instead of ten small buttons clustered on one side. -->
                    <div class="ecBlock mb-0">
                        <label class="ecLabel">
                            How much do you want to get your money back right now?
                            <span class="ecRevengeValue">{{ answers.revengeScore }}</span>
                        </label>
                        <input type="range" min="1" max="10" step="1" class="ecRange"
                            v-model.number="answers.revengeScore">
                        <div class="ecRangeScale">
                            <span v-for="n in REVENGE_SCORES" :key="n">{{ n }}</span>
                        </div>
                    </div>
                </div>
                <div class="modal-footer ecFooter">
                    <div class="ecProgress">
                        <span class="ecCount" :class="{ done: isComplete }">
                            {{ answeredCount }} / {{ REQUIREMENTS.length }} answered
                        </span>
                        <!-- The outstanding questions, by name and clickable. Save
                             cannot be reached without them, so saying which they are
                             (and jumping there) is the whole difference between an
                             enforced checklist and a stuck one. -->
                        <span v-if="!isComplete" class="ecMissingList">
                            <button v-for="m in missing" :key="m.key" type="button" class="ecMissingChip"
                                v-on:click="jumpTo(m)">{{ m.label }}</button>
                        </span>
                    </div>
                    <button type="button" class="btn btn-sm" :class="isComplete ? 'btn-success' : 'btn-outline-secondary'"
                        :disabled="submitting" v-on:click="save">
                        <span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status"></span>
                        {{ isComplete ? 'Save' : 'Answer all to save' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.modal-header {
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.modal-footer {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.ecHead {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}

.sideTag {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 0.25rem;
}

.sideTag.buy { color: #00CA73; background: rgba(0, 202, 115, 0.12); }
.sideTag.sell { color: #F6465D; background: rgba(246, 70, 93, 0.12); }

.ecSymbol { font-weight: 700; font-size: 1rem; }
.ecEntry { color: var(--white-60); font-size: 0.85rem; }

.ecSectionLabel {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #2f9bff;
    margin: 0 0 0.6rem;
}

.ecBlock {
    margin-bottom: 1.1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.ecLabel {
    display: block;
    font-size: 0.82rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
}

.ecSubLabel {
    font-size: 0.8rem;
    color: var(--white-60);
    margin-right: 0.3rem;
}

/* Inline next to the "Oversized?" label text itself, not its own row -- a
   qualifier on the question, not a separate line. */
.ecLotInfo {
    font-weight: 400;
    font-size: 0.78rem;
    color: var(--white-60);
    margin-left: 0.4rem;
    font-variant-numeric: tabular-nums;
}

.ecLotInfo strong.over { color: #F6465D; }
.ecLotMax { opacity: 0.8; }

.ecChoice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

/* Yes/No and Good/Bad pairs stretch to fill their column instead of sitting as
   two small buttons in a lot of empty space -- the wider dialog made that gap
   obvious. Emotion and revenge-score rows keep their compact, wrapped sizing. */
.ecChoice:not(.ecWrap) .btn {
    flex: 1;
}

.ecWrap {
    flex-wrap: wrap;
}

.ecWrap .ecEmotionBtn {
    flex: 1 1 auto;
    min-width: 6rem;
}

.ecStopRow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
}

.ecPriceInput { width: 7.5rem; }

.ecPips {
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.ecPips.pos { color: #00CA73; }
.ecPips.neg { color: #F6465D; }

.ecEmotionBtn {
    background: transparent;
}

.ecRevengeValue {
    margin-left: 0.5rem;
    font-weight: 700;
    color: #f59e0b;
}

.ecRange {
    width: 100%;
    accent-color: #f59e0b;
}

/* Outstanding blocks, marked only after a save attempt (see showMissing). */
.ecIncomplete {
    border-left: 2px solid #f59e0b;
    padding-left: 0.7rem;
    margin-left: -0.7rem;
}

.ecStopName {
    font-weight: 700;
    font-size: 0.8rem;
    color: var(--white-60);
    min-width: 1.4rem;
}

.ecStopChoice .btn {
    padding: 0.1rem 0.5rem;
    font-size: 0.75rem;
}

/* Footer carries the progress read-out on the left and the action on the right,
   rather than a lone button whose disabled state was the only feedback. */
.ecFooter {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
}

.ecProgress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
}

.ecCount {
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    color: #f59e0b;
    font-weight: 600;
    white-space: nowrap;
}

.ecCount.done { color: #00CA73; }

.ecMissingList {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
}

.ecMissingChip {
    font-size: 0.72rem;
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
    border: 1px solid rgba(245, 158, 11, 0.45);
    background: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
}

.ecMissingChip:hover {
    background: rgba(245, 158, 11, 0.2);
}

.ecRangeScale {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--white-60);
    padding: 0 0.15rem;
    margin-top: 0.1rem;
}
</style>
