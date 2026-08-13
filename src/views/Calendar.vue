<script setup>
import { onBeforeMount, onMounted, onUnmounted } from 'vue'
import SpinnerLoadingPage from '../components/SpinnerLoadingPage.vue';
import NoData from '../components/NoData.vue';
import Calendar from '../components/Calendar.vue';
import { spinnerLoadingPage, calendarData, filteredTrades } from '../stores/globals';
import { useMountCalendar, useRefreshCalendarData } from '../utils/utils'
import { useJournalUpdates } from '../utils/journalStream'

onBeforeMount(async () => {
    useMountCalendar()
})

// The MT5 sync pushes trades in the background, so a Calendar tab left open has to
// be told about them. Driven by the journal push now rather than a 60s poll (see
// utils/journalStream.js); the long timer is only a safety net for a missed push.
let calendarRefreshTimer = null
let unsubscribeJournal = null
onMounted(() => {
    unsubscribeJournal = useJournalUpdates(useRefreshCalendarData)
    calendarRefreshTimer = setInterval(useRefreshCalendarData, 300000)
})
onUnmounted(() => {
    if (unsubscribeJournal) unsubscribeJournal()
    if (calendarRefreshTimer) clearInterval(calendarRefreshTimer)
})
</script>

<template>
    <SpinnerLoadingPage />
    <div v-show="!spinnerLoadingPage" class="row mt-2 mb-2">
        <!-- ============ CALENDAR ============ -->
        <!-- Always render the calendar (month nav + grid) so an empty month can
             still be paged away from. Gating it on filteredTrades.length hid the
             nav whenever the viewed month had no trades, trapping the user there. -->
        <div v-show="calendarData" class="col-12 text-center mt-2 align-self-start">
            <div class="dailyCard">
                <div class="row justify-content-center">
                    <Calendar />
                </div>
            </div>
            <NoData v-if="filteredTrades.length == 0" />
        </div>
    </div>
</template>