<script setup>
import { onMounted, onBeforeMount, computed } from 'vue'
import SpinnerLoadingPage from '../components/SpinnerLoadingPage.vue';
import NoData from '../components/NoData.vue';
import { spinnerLoadingPage, diaries, selectedItem, spinnerLoadMore, endOfList, tags, satisfactionArray, dayFiles } from '../stores/globals';
import { useCheckVisibleScreen, useCreatedDateFormat, useEditItem, useInitPopover, useLoadMore } from '../utils/utils';
import { useGetDiaries } from '../utils/diary';
import { useGetTags, useGetTagInfo, useGetAvailableTags, useDailySatisfactionChange, useGetSatisfactions } from '../utils/daily';
import { useGetDayFiles, useDayFileFor } from '../utils/dayFiles';

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

const fileSrc = (f) => (f ? (f.url || f.base64) : '')
const isPdf = (f) => !!f && ((f.url && /\.pdf(\?|$)/i.test(f.url)) || (f.base64 && f.base64.startsWith('data:application/pdf')))

onMounted(async () => {
    await useGetDiaries(true)
    await Promise.all([useGetTags(), useGetAvailableTags(), useGetSatisfactions(), useGetDayFiles()])
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
            <div v-if="diaryEntries.length == 0">
                <NoData />
            </div>

            <div v-for="(itemDiary, index) in diaryEntries" :key="itemDiary.dateUnix"
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

                <!-- Day summary file (whole-day PDF/image), uploaded on Daily -->
                <div v-if="useDayFileFor(itemDiary.dateUnix)" class="dayFileBlock mt-3">
                    <div class="dayFileHeader d-flex align-items-center mb-2">
                        <i class="uil uil-file-alt me-2"></i>
                        <a :href="fileSrc(useDayFileFor(itemDiary.dateUnix))" target="_blank" rel="noopener"
                            class="pointerClass fw-bold">{{ useDayFileFor(itemDiary.dateUnix).filename }}</a>
                        <a :href="fileSrc(useDayFileFor(itemDiary.dateUnix))" target="_blank" rel="noopener"
                            class="ms-2 pointerClass" title="Open in new tab"><i
                                class="uil uil-external-link-alt"></i></a>
                    </div>
                    <div class="dayFilePreview">
                        <iframe v-if="isPdf(useDayFileFor(itemDiary.dateUnix))"
                            :src="fileSrc(useDayFileFor(itemDiary.dateUnix))" class="dayFileFrame"
                            loading="lazy"></iframe>
                        <img v-else :src="fileSrc(useDayFileFor(itemDiary.dateUnix))" class="dayFileImg"
                            loading="lazy" />
                    </div>
                </div>
            </div>

            <!-- Load more spinner -->
            <div v-if="spinnerLoadMore" class="d-flex justify-content-center mt-3">
                <div class="spinner-border text-blue" role="status"></div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.diaryEntryCard {
    padding: 20px 24px;
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

.dayFileFrame {
    width: 100%;
    height: 70vh;
    min-height: 480px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 8px;
    background: #fff;
}

.dayFileImg {
    display: block;
    max-width: 100%;
    max-height: 70vh;
    margin: 0 auto;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 8px;
    object-fit: contain;
}
</style>