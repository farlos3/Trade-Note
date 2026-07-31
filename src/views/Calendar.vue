<script setup>
import { onBeforeMount} from 'vue'
import SpinnerLoadingPage from '../components/SpinnerLoadingPage.vue';
import NoData from '../components/NoData.vue';
import Calendar from '../components/Calendar.vue';
import { spinnerLoadingPage, calendarData, filteredTrades } from '../stores/globals';
import { useMountCalendar } from '../utils/utils'

onBeforeMount(async () => {
    useMountCalendar()
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