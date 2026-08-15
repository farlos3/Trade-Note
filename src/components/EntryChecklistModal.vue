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
        hasTp: false, tpPrice: '',
        hasSl: false, slPrice: '',
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

const isComplete = computed(() => {
    if (!displayed.value) return false
    if (answers.hasTp && !answers.tpPrice) return false
    if (answers.hasSl && !answers.slPrice) return false
    return answers.tpSlAcceptable !== null
        && answers.positionQuality !== null
        && answers.entryEmotion !== null
        && answers.logicValid !== null
        && answers.oversized !== null
        && answers.revengeScore !== null
        && !!answers.entryReasoning.trim()
})

async function save() {
    if (!isComplete.value || submitting.value) return
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
                    <div class="ecBlock">
                        <label class="ecLabel">Stop loss / take profit — price and pips</label>
                        <div class="row g-2">
                            <div class="col-6">
                                <div class="ecStopRow">
                                    <div class="form-check">
                                        <input class="form-check-input" type="checkbox" id="ecHasSl"
                                            v-model="answers.hasSl">
                                        <label class="form-check-label" for="ecHasSl">SL set</label>
                                    </div>
                                    <input v-if="answers.hasSl" type="number" step="any"
                                        class="form-control form-control-sm ecPriceInput" v-model="answers.slPrice"
                                        placeholder="Price">
                                    <span v-if="answers.hasSl" class="ecPips neg">{{ fmtPips(slPips) }} pips</span>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="ecStopRow">
                                    <div class="form-check">
                                        <input class="form-check-input" type="checkbox" id="ecHasTp"
                                            v-model="answers.hasTp">
                                        <label class="form-check-label" for="ecHasTp">TP set</label>
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
                    <div class="ecBlock">
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
                    <div class="ecBlock">
                        <label class="ecLabel">How did you feel entering this?</label>
                        <div class="ecChoice ecWrap">
                            <button v-for="e in EMOTIONS" :key="e.id" type="button" class="btn btn-sm ecEmotionBtn"
                                v-bind:class="{ on: answers.entryEmotion === e.id }"
                                v-bind:style="answers.entryEmotion === e.id ? { backgroundColor: e.color, borderColor: e.color, color: '#0b0f14' } : { borderColor: e.color, color: e.color }"
                                v-on:click="answers.entryEmotion = e.id">{{ e.label }}</button>
                        </div>
                    </div>

                    <!-- 6: reasoning, full width -->
                    <div class="ecBlock">
                        <label class="ecLabel">Why did you enter here? Does your logic still hold?</label>
                        <textarea class="form-control form-control-sm" rows="3" v-model="answers.entryReasoning"
                            placeholder="What was the setup / trigger, and is that logic still valid right now?"></textarea>
                    </div>

                    <!-- 7: logic still valid, its own row -->
                    <div class="ecBlock">
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
                <div class="modal-footer">
                    <button type="button" class="btn btn-success btn-sm" :disabled="!isComplete || submitting"
                        v-on:click="save">
                        <span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status"></span>
                        Save
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

.ecRangeScale {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--white-60);
    padding: 0 0.15rem;
    margin-top: 0.1rem;
}
</style>
