<script setup>
import { ref, onMounted } from 'vue';
import { selectedItem, modalDailyTradeOpen, pageId, tags, notes } from '../stores/globals';
import { useSetupMarkerArea, useSelectedScreenshotFunction, useDeleteScreenshot } from '../utils/screenshots';
import { useHourMinuteFormat, useTimeFormat, useEditItem, useCreatedDateFormat } from '../utils/utils';
import { useGetTagInfo, useSaveTradeNote } from '../utils/daily';


const props = defineProps({
    screenshotData: Object,
    showTitle: Boolean,
    source: String,
    index: Number
})

// Inline per-trade principle/note (Screenshots page). Keyed by the screenshot's
// trade id (screenshotData.name), saved to the shared `notes` collection.
const principle = ref('')
const principleSaved = ref(false)
const principleSaving = ref(false)

onMounted(() => {
    if (props.source == 'screenshots') {
        const n = notes.find(x => x.tradeId == props.screenshotData.name)
        principle.value = n ? (n.note || '') : ''
    }
})

// Delete straight from a confirm() instead of a Bootstrap popover: the popover
// isn't initialised on content that renders later (e.g. inside the full-screen /
// daily modal), so its "Yes" never appeared and the image couldn't be deleted.
async function confirmDeleteScreenshot() {
    if (!window.confirm('Delete this screenshot? This cannot be undone.')) return
    selectedItem.value = props.screenshotData.objectId
    await useDeleteScreenshot()
}

async function savePrinciple() {
    if (principleSaving.value) return
    principleSaving.value = true
    try {
        await useSaveTradeNote(props.screenshotData.name, props.screenshotData.dateUnix, principle.value)
        const n = notes.find(x => x.tradeId == props.screenshotData.name)
        if (n) n.note = principle.value
        else notes.push({ tradeId: props.screenshotData.name, note: principle.value, dateUnix: props.screenshotData.dateUnix })
        principleSaved.value = true
        setTimeout(() => (principleSaved.value = false), 1500)
    } finally {
        principleSaving.value = false
    }
}
</script>

<template>
    <div class="row">
        <!-- HEADER / DATE & INFO -->
        <div v-if="props.source == 'fullScreen' || props.source == 'screenshots'" class="col-12 cardFirstLine">
            <div class="row">
                <div class="col">
                    <h5>{{ useCreatedDateFormat(props.screenshotData.dateUnix) }}</h5>
                </div>
                <div v-if="props.source == 'fullScreen'" class="col me-auto text-end" data-bs-theme="dark">
                    <button v-if="!modalDailyTradeOpen" type="button" class="btn-close" data-bs-dismiss="modal"
                        aria-label="Close"></button>
                    <button v-if="modalDailyTradeOpen" type="button" class="btn-close" data-bs-target="#tradesModal"
                        data-bs-toggle="modal"></button>
                </div>
            </div>
        </div>

        <!-- SUB HEADER -->
        <div class="col-12 mt-2">
            <div class="row">

                <!-- Left: info -->
                <div v-if="props.source != 'addScreenshot' && props.source != 'dailyModal'" class="col-6">
                    <span>{{ props.screenshotData.symbol }}</span><span v-if="props.screenshotData.side"
                        class="col mt-1">
                        | {{ props.screenshotData.side == 'SS' || props.screenshotData.side == 'BC' ? 'Short' :
            'Long' }}
                        | {{ useTimeFormat(props.screenshotData.dateUnix) }}</span>
                    <span v-else class="col mb-2"> | {{
            useHourMinuteFormat(props.screenshotData.dateUnix)
        }}</span>


                    <span v-for="tags in tags.filter(obj => obj.tradeId == props.screenshotData.name)"><span
                            v-if="tags.tags.length > 0"> | <span v-for="tag in tags.tags.slice(0, 2)"
                                class="tag txt-small" :style="{ 'background-color': useGetTagInfo(tag).groupColor }">{{
            useGetTagInfo(tag).tagName }}
                            </span>
                            <span v-show="tags.tags.length > 2">+{{
            tags.tags.length
            - 2 }}</span></span></span>

                </div>

                <!-- Right: tools -->
                <div v-if="props.source != 'fullScreen'"
                    :class="[props.source == 'addScreenshot' || props.source == 'dailyModal' ? 'offset-6' : '', 'col-6 text-end']">

                    <!-- Expand / fullScreen screen -->
                    <i v-if="props.screenshotData.objectId && props.source != 'addScreenshot'"
                        class="uil uil-expand-arrows-alt pointerClass me-3" data-bs-toggle="modal"
                        data-bs-target="#fullScreenModal"
                        v-on:click="useSelectedScreenshotFunction(props.index, props.source, props.screenshotData)"></i>

                    <!-- Annotate -->
                    <i class="uil uil-image-edit pointerClass me-3"
                        v-on:click="useSetupMarkerArea(props.source, props.screenshotData)"></i>

                    <!-- Edit -->
                    <i v-if="props.source == 'screenshots'" class="uil uil-edit-alt pointerClass me-4"
                        v-on:click="useEditItem(props.screenshotData.objectId)"></i>

                    <!-- Delete -->
                    <i v-if="props.screenshotData.objectId && props.source != 'addScreenshot'"
                        v-on:click="confirmDeleteScreenshot()"
                        class="ps-2 uil uil-trash-alt pointerClass"></i>
                </div>
            </div>
        </div>

    </div>

    <!-- SCREENSHOTS -->
    <div :class="[pageId === 'addScreenshot' ? 'imgContainerAddScreenshot' : 'imgContainer',
        (props.source !== 'fullScreen' && pageId !== 'addScreenshot') ? 'imgContainerPreview' : '']">
        <img :id="props.screenshotData.objectId ? 'screenshotDiv-' + props.source + '-' + props.screenshotData.objectId : 'screenshotDiv-' + props.source + '-' + props.screenshotData.dateUnix"
            class="screenshotImg mt-3 img-fluid"
            v-bind:src="props.screenshotData.originalUrl || props.screenshotData.originalBase64" />
        <img class="overlayImg screenshotImg mt-3 img-fluid"
            v-bind:src="props.screenshotData.annotatedUrl || props.screenshotData.annotatedBase64" />
    </div>

    <!-- INLINE TRADE PRINCIPLE (Screenshots page) -->
    <div v-if="props.source == 'screenshots'" class="mt-3">
        <div class="tradePrincipleHead">
            <span>Trade principle / หลักการเทรด</span>
            <span v-show="principleSaved" class="tradePrincipleSaved">Saved</span>
        </div>
        <textarea class="form-control tradePrincipleInput" rows="3"
            v-model="principle" @blur="savePrinciple"
            placeholder="เขียนหลักการ/เหตุผลของการเข้าเทรดนี้ แล้วคลิกออกเพื่อบันทึก"></textarea>

        <!--<img v-if="props.screenshotData.markersOnly" :id="props.screenshotData.objectId ? 'screenshotDiv-' + props.source + '-' + props.screenshotData.objectId : 'screenshotDiv-' + props.source + '-' + props.screenshotData.dateUnix" class="screenshotImg mt-3 img-fluid" v-bind:src="props.screenshotData.originalBase64" />

        <img :id="!props.screenshotData.markersOnly ? props.screenshotData.objectId ? 'screenshotDiv-' + props.source + '-' + props.screenshotData.objectId : 'screenshotDiv-' + props.source + '-' + props.screenshotData.dateUnix : ''"
            v-bind:class="[props.screenshotData.markersOnly ? 'overlayImg' : '', 'screenshotImg mt-3 img-fluid']"
            v-bind:src="props.screenshotData.annotatedBase64" />-->

        <!--<img v-if="props.screenshotData.markersOnly" class="screenshotImg mt-3 img-fluid"
            v-bind:src="props.screenshotData.originalBase64" />
        <img v-bind:class="[props.screenshotData.markersOnly ? 'overlayImg' : '', 'screenshotImg mt-3 img-fluid']"
            v-bind:src="props.screenshotData.annotatedBase64" />-->
    </div>
</template>

<style scoped>
.tradePrincipleHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--white-70, rgba(255, 255, 255, 0.7));
    margin-bottom: 0.4rem;
}

.tradePrincipleSaved {
    font-size: 0.72rem;
    font-weight: 600;
    color: #16a34a;
}

.tradePrincipleInput {
    background-color: var(--black-bg-7, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
    color: var(--white-87, rgba(255, 255, 255, 0.87));
    border-radius: 8px;
    font-size: 0.85rem;
    resize: vertical;
}

.tradePrincipleInput:focus {
    background-color: var(--black-bg-7, rgba(255, 255, 255, 0.04));
    border-color: var(--border-strong, rgba(255, 255, 255, 0.24));
    color: var(--white-87, rgba(255, 255, 255, 0.87));
    box-shadow: none;
}

/* Constrain the inline preview (Screenshots list / Daily tab) so a tall image
   doesn't fill the whole page. The full-screen modal is exempt — it stays large. */
.imgContainerPreview {
    height: auto !important;
    max-height: 460px;
}

.imgContainerPreview :deep(.screenshotImg) {
    max-height: 460px;
    width: auto;
    max-width: 100%;
}
</style>
