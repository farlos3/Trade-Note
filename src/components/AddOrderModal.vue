<script setup>
import { reactive, computed, ref, onMounted, watch } from 'vue'
import { spinnerLoadingPage, timeZoneTrade } from '../stores/globals'
import { useAddManualOrder, useComputeForexPnL, usePipSize, useDefaultContractSize } from '../utils/addOrder'
import FpDate from './FpDate.vue'

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
dayjs.extend(utc)
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(timezone)

const submitting = ref(false)

const DEFAULT_SYMBOL = 'XAUUSD'

function nowLocal() {
    const tz = timeZoneTrade.value
    return tz ? dayjs().tz(tz).format('YYYY-MM-DD HH:mm') : dayjs().format('YYYY-MM-DD HH:mm')
}

function blankOrder() {
    return {
        symbol: DEFAULT_SYMBOL,
        direction: 'long',
        lot: '',
        entryPrice: '',
        entryDate: nowLocal(),
        exitPrice: '',
        exitDate: '',
        // Derived automatically from the symbol (no longer shown as inputs)
        contractSize: useDefaultContractSize(DEFAULT_SYMBOL),
        pipSize: usePipSize(DEFAULT_SYMBOL),
        commission: '',
        account: 'Manual',
        note: '',
        reason: '',
        screenshotBase64: null
    }
}

const order = reactive(blankOrder())

function resetForm() {
    Object.assign(order, blankOrder())
    submitting.value = false
}

onMounted(() => {
    const el = document.getElementById('addOrderModal')
    if (el) {
        // Reset the form each time the popup is opened
        el.addEventListener('show.bs.modal', () => resetForm())
    }
})

/* Contract size / pip size are always derived from the symbol (not user inputs) */
watch(() => order.symbol, (sym) => {
    order.contractSize = useDefaultContractSize(sym)
    order.pipSize = usePipSize(sym)
})

const pnl = computed(() => useComputeForexPnL(order))

function onScreenshotChange(event) {
    const file = event.target.files[0]
    if (!file) {
        order.screenshotBase64 = null
        return
    }
    const reader = new FileReader()
    reader.onloadend = () => { order.screenshotBase64 = reader.result }
    reader.readAsDataURL(file)
}

function validate() {
    if (!order.symbol || !order.symbol.trim()) return 'Please enter a symbol'
    if (order.lot === '' || isNaN(parseFloat(order.lot)) || parseFloat(order.lot) <= 0) return 'Please enter a valid lot size'
    if (order.entryPrice === '' || isNaN(parseFloat(order.entryPrice))) return 'Please enter a valid entry price'
    if (!order.entryDate) return 'Please enter an entry date/time'
    if (order.exitPrice !== '' && isNaN(parseFloat(order.exitPrice))) return 'Exit price is not a valid number'
    return null
}

async function submit() {
    const error = validate()
    if (error) {
        alert(error)
        return
    }
    submitting.value = true
    try {
        await useAddManualOrder(order)
        // useUploadTrades() redirects to /dashboard on success
    } catch (e) {
        console.error('Error adding manual order', e)
        alert('Error adding order: ' + e)
        submitting.value = false
        spinnerLoadingPage.value = false
    }
}
</script>

<template>
    <div class="modal fade" id="addOrderModal" tabindex="-1" aria-labelledby="addOrderModalLabel" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="addOrderModalLabel"><i class="uil uil-plus me-2"></i>Add Order</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                    <!-- Row 1: symbol / direction / lot -->
                    <div class="row g-2 mb-2">
                        <div class="col-md-4">
                            <label class="form-label txt-small mb-1">Symbol</label>
                            <input type="text" class="form-control" v-model="order.symbol"
                                placeholder="EURUSD, XAUUSD..." />
                        </div>
                        <div class="col-md-4">
                            <label class="form-label txt-small mb-1">Direction</label>
                            <select class="form-select" v-model="order.direction">
                                <option value="long">Buy / Long</option>
                                <option value="short">Sell / Short</option>
                            </select>
                        </div>
                        <div class="col-md-4">
                            <label class="form-label txt-small mb-1">Lot (volume)</label>
                            <input type="number" step="0.01" min="0.01" class="form-control" v-model="order.lot"
                                placeholder="0.01" />
                        </div>
                    </div>

                    <!-- Row 2: entry -->
                    <div class="row g-2 mb-2">
                        <div class="col-md-6">
                            <label class="form-label txt-small mb-1">Entry price</label>
                            <input type="number" step="any" class="form-control" v-model="order.entryPrice" />
                        </div>
                        <div class="col-md-6">
                            <label class="form-label txt-small mb-1">Entry date / time</label>
                            <FpDate mode="datetime" v-model="order.entryDate" />
                        </div>
                    </div>

                    <!-- Row 3: exit (optional) -->
                    <div class="row g-2 mb-2">
                        <div class="col-md-6">
                            <label class="form-label txt-small mb-1">Exit price <span
                                    class="fst-italic fw-lighter">(optional — leave blank if still
                                    open)</span></label>
                            <input type="number" step="any" class="form-control" v-model="order.exitPrice" />
                        </div>
                        <div class="col-md-6">
                            <label class="form-label txt-small mb-1">Exit date / time <span
                                    class="fst-italic fw-lighter">(optional)</span></label>
                            <FpDate mode="datetime" v-model="order.exitDate" placeholder="Leave blank if still open" />
                        </div>
                    </div>

                    <!-- Row 4: commission -->
                    <div class="row g-2 mb-2">
                        <div class="col-md-4">
                            <label class="form-label txt-small mb-1">Commission <span
                                    class="fst-italic fw-lighter">(optional)</span></label>
                            <input type="number" step="any" class="form-control" v-model="order.commission"
                                placeholder="0" />
                        </div>
                    </div>

                    <!-- Computed P&L preview -->
                    <div class="row g-2 mb-3 mt-1">
                        <div class="col-12">
                            <div class="p-2 rounded" style="background-color: var(--bsdark-2, rgba(255,255,255,0.04));">
                                <span class="me-4">Pips:
                                    <strong v-if="pnl.pips !== null"
                                        v-bind:class="[pnl.pips >= 0 ? 'greenTrade' : 'redTrade']">{{
                                            pnl.pips.toFixed(1) }}</strong>
                                    <span v-else class="fw-lighter">—</span>
                                </span>
                                <span class="me-4">Gross P&L:
                                    <strong v-if="pnl.gross !== null"
                                        v-bind:class="[pnl.gross >= 0 ? 'greenTrade' : 'redTrade']">{{
                                            pnl.gross.toFixed(2) }}</strong>
                                    <span v-else class="fw-lighter">— (open)</span>
                                </span>
                                <span>Net P&L:
                                    <strong v-if="pnl.net !== null"
                                        v-bind:class="[pnl.net >= 0 ? 'greenTrade' : 'redTrade']">{{ pnl.net.toFixed(2)
                                        }}</strong>
                                    <span v-else class="fw-lighter">—</span>
                                </span>
                            </div>
                        </div>
                    </div>

                    <!-- Screenshot -->
                    <div class="mb-3">
                        <label class="form-label txt-small mb-1">Screenshot <span
                                class="fst-italic fw-lighter">(optional)</span></label>
                        <input type="file" accept="image/*" class="form-control" v-on:change="onScreenshotChange" />
                        <img v-if="order.screenshotBase64" :src="order.screenshotBase64" class="img-fluid mt-2 rounded"
                            style="max-height: 220px;" />
                    </div>

                    <!-- Review note -->
                    <div class="mb-2">
                        <label class="form-label txt-small mb-1">Review note for this order</label>
                        <textarea class="form-control" rows="3" v-model="order.note"
                            placeholder="What was the setup, how did it go, what to improve..."></textarea>
                    </div>
                    <div class="mb-2">
                        <label class="form-label txt-small mb-1">Reason <span
                                class="fst-italic fw-lighter">(optional)</span></label>
                        <input type="text" class="form-control" v-model="order.reason"
                            placeholder="Reason for taking this trade" />
                    </div>

                    <!-- Account -->
                    <div class="mb-1">
                        <label class="form-label txt-small mb-1">Account</label>
                        <input type="text" class="form-control" v-model="order.account" placeholder="Manual" />
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal"
                        :disabled="submitting">Cancel</button>
                    <button type="button" class="btn btn-success btn-sm" v-on:click="submit" :disabled="submitting">
                        <span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status"></span>
                        Save order
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Soften the harsh white divider lines on the header/footer so they blend
   into the dark modal instead of reading as bright white rules. */
.modal-header {
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.modal-footer {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
}

/* Close (X) button: Bootstrap's default icon is dark and near-invisible on the
   dark background. Swap in a white glyph with a subtle circular hover target. */
.btn-close {
    width: 2em;
    height: 2em;
    border-radius: 50%;
    opacity: 0.7;
    background: transparent url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23fff'%3e%3cpath d='M.293.293a1 1 0 0 1 1.414 0L8 6.586 14.293.293a1 1 0 1 1 1.414 1.414L9.414 8l6.293 6.293a1 1 0 0 1-1.414 1.414L8 9.414l-6.293 6.293a1 1 0 0 1-1.414-1.414L6.586 8 .293 1.707a1 1 0 0 1 0-1.414z'/%3e%3c/svg%3e") center / 0.9em auto no-repeat;
    transition: opacity 0.15s ease, background-color 0.15s ease;
}

.btn-close:hover {
    opacity: 1;
    background-color: rgba(255, 255, 255, 0.1);
}

.btn-close:focus,
.btn-close:active {
    box-shadow: none;
    outline: none;
}
</style>
