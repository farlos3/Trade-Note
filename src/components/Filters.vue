<script setup>
import { ref, onBeforeMount, onMounted } from "vue";
import { useMonthFormat, useDateCalFormat, useDateCalFormatMonth, useMountCalendar, useMountDashboard, useMountDaily, useCheckVisibleScreen, useExport } from "../utils/utils.js";
import { pageId, currentUser, timeZoneTrade, periodRange, positions, timeFrames, ratios, grossNet, plSatisfaction, selectedPositions, selectedTimeFrame, selectedRatio, selectedAccounts, selectedGrossNet, selectedPlSatisfaction, selectedDateRange, selectedMonth, selectedPeriodRange, tempSelectedPlSatisfaction, amountCase, amountCapital, hasData, selectedTags, tags, availableTags, filteredTradesTrades } from "../stores/globals"
import { useECharts } from "../utils/charts.js";
import { useRefreshScreenshot } from "../utils/screenshots"
import FpDate from "./FpDate.vue"
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
dayjs.extend(utc)
import isoWeek from 'dayjs/plugin/isoWeek.js'
dayjs.extend(isoWeek)
import timezone from 'dayjs/plugin/timezone.js'
dayjs.extend(timezone)
import duration from 'dayjs/plugin/duration.js'
dayjs.extend(duration)
import updateLocale from 'dayjs/plugin/updateLocale.js'
dayjs.extend(updateLocale)
import localizedFormat from 'dayjs/plugin/localizedFormat.js'
dayjs.extend(localizedFormat)
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
dayjs.extend(customParseFormat)

/*============================================
    VARIABLES
============================================*/

let filtersOpen = ref(false)
let filters = ref({
    "dashboard": ["accounts", "periodRange", "grossNet", "positions", "timeFrame", "ratio", "tags"],
    "calendar": ["month", "grossNet", "plSatisfaction"],
    "daily": ["accounts", "month", "grossNet", "positions", "tags"],
    "screenshots": ["accounts", "grossNet", "positions", "tags"],
})



/*if (selectedDateRange.value) {
    console.log(" -> Filtering date range")
    let tempFilter = periodRange.filter(element => element.start == selectedDateRange.value.start && element.end == selectedDateRange.value.end)
    if (tempFilter.length > 0) {
        selectedPeriodRange.value = tempFilter[0]
    } else {
        console.log(" -> Custom range in vue")
        selectedPeriodRange.value = periodRange.filter(element => element.start == -1)[0]
    }
}*/
//console.log(" -> Selected date range "+JSON.stringify(selectedPeriodRange))


//IMPORTANT : when exists in localstorage but is empty, then == ''. When does not exist in localstorage then == null. As it may be empty, we take the case of null


/*============================================
    LIFECYCLE
============================================*/
onBeforeMount(async () => {
})

/*============================================
    FUNCTIONS
============================================*/
function filtersClick() {
    filtersOpen.value = !filtersOpen.value
    checkAllTagsSelected()
    //console.log(" -> Filters click: Selected Period Range " + JSON.stringify(selectedPeriodRange))
    //console.log(" -> Filters click: Selected Date Range Cal " + JSON.stringify(selectedDateRange))

    if (!filtersOpen.value) { //It's like clicking cancel of not saving so we remove data / go back to old data 

        // Restore Selected Date range cal
        selectedDateRange.value = JSON.parse(localStorage.getItem('selectedDateRange'))
        //console.log(" -> Filters click (close): Selected Date Range Cal " + JSON.stringify(selectedDateRange))
        //console.log(" periodRange "+JSON.stringify(periodRange))
        // Restore Selected Period range
        //console.log(" selectedDateRange "+JSON.stringify(selectedDateRange.value))
        let tempFilter = periodRange.filter(element => element.start == selectedDateRange.value.start && element.end == selectedDateRange.value.end)

        if (tempFilter.length > 0) {
            selectedPeriodRange.value = tempFilter[0]
        } else {
            //console.log(" -> Custom range in trades mixin")
            //console.log(" periodRange 2 " + JSON.stringify(periodRange))
            selectedPeriodRange.value = periodRange.filter(element => element.start == -1)[0]
        }

        //console.log(" -> Filters click (on close): Selected Period Range " + JSON.stringify(selectedPeriodRange))

        // Restore temp selected accounts
        if (localStorage.getItem('selectedAccounts')) {
            if (localStorage.getItem('selectedAccounts').includes(",")) {
                selectedAccounts.value = localStorage.getItem('selectedAccounts').split(",")
            } else {
                selectedAccounts.value = []
                selectedAccounts.value.push(localStorage.getItem('selectedAccounts'))
            }
        } else {
            selectedAccounts.value = []
        }


        //console.log(" Selected accounts " + selectedAccounts)

        //Restore gross net
        selectedGrossNet.value = localStorage.getItem('selectedGrossNet')
        //console.log(" Selected accounts " + selectedAccounts)

        // Restore temp selected positions
        if (localStorage.getItem('selectedPositions')) {
            if (localStorage.getItem('selectedPositions').includes(",")) {
                selectedPositions.value = localStorage.getItem('selectedPositions').split(",")
            } else {
                selectedPositions.value = []
                selectedPositions.value.push(localStorage.getItem('selectedPositions'))
            }
        } else {
            selectedPositions.value = []
        }

        selectedTimeFrame.value = localStorage.getItem('selectedTimeFrame')
        //console.log(" Selected timeframe " + selectedTimeFrame)

        selectedRatio.value = localStorage.getItem('selectedRatio')
        //console.log(" Selected ratio " + selectedRatio)

        selectedMonth.value = JSON.parse(localStorage.getItem('selectedMonth'))
        //console.log(" Selected Month " + JSON.stringify(selectedMonth))

        if (localStorage.getItem('selectedTags')) {
            if (localStorage.getItem('selectedTags').includes(",")) {
                selectedTags.value = localStorage.getItem('selectedTags').split(",")
            } else {
                selectedTags.value = []
                selectedTags.value.push(localStorage.getItem('selectedTags'))
            }
        } else {
            selectedTags.value = []
        }
    }
}

//Date : periode
function inputDateRange(param) {
    console.log(" -> Input Date Range - Param: " + param)
    //Filter to find the value of date range
    var filterJson = periodRange.filter(element => element.value == param)[0]
    selectedPeriodRange.value = filterJson
    //console.log(" -> Input range: Selected Date Range " + JSON.stringify(selectedPeriodRange.value))

    //Created selected Date range calendar mode
    let temp = {}
    temp.start = selectedPeriodRange.value.start
    temp.end = selectedPeriodRange.value.end
    selectedDateRange.value = temp
    //console.log(" -> Input range : Selected Date Range Cal " + JSON.stringify(selectedDateRange.value))

}
//Date : calendar
function inputDateRangeCal(param1, param2) {
    console.log(" -> Input Date Range Cal - type '" + param1 + "' and date " + param2)
    //console.log(" -> Initial selectedDateRange " + JSON.stringify(selectedDateRange.value))

    if (param1 == "start") {
        selectedDateRange.value.start = dayjs.tz(param2, timeZoneTrade.value).unix()
    }
    if (param1 == "end") {
        selectedDateRange.value.end = dayjs.tz(param2, timeZoneTrade.value).endOf("day").unix() // it must be tz(...). It cannot be dayjs().t
    }


    //console.log("selectedDateRange " + JSON.stringify(selectedDateRange.value))

    /* Update selectedPeriodRange */
    //console.log(" periodRange "+JSON.stringify(periodRange))
    //console.log(" selectedDateRange.value.start "+selectedDateRange.value.start)
    //console.log(" selectedDateRange.value.end "+selectedDateRange.value.end)
    let tempFilter = periodRange.filter(element => element.start == selectedDateRange.value.start && element.end == selectedDateRange.value.end)
    if (tempFilter.length > 0) {
        selectedPeriodRange.value = tempFilter[0]
    } else {
        //console.log(" -> Custom range in trades mixin")
        selectedPeriodRange.value = periodRange.filter(element => element.start == -1)[0]
    }
}

function inputMonth(param1) {
    //console.log(" param1 " + param1)
    let temp = {}
    temp.start = dayjs.tz(param1, timeZoneTrade.value).unix()
    temp.end = dayjs.tz(param1, timeZoneTrade.value).endOf("month").unix()
    selectedMonth.value = temp
    //console.log(" -> Selected Month "+JSON.stringify(selectedMonth.value))
}

async function saveFilter() {
    console.log(" -> Save filters: Selected Date Range Cal " + JSON.stringify(selectedDateRange.value))
    console.log(" -> Save filters: Selected Period Range " + JSON.stringify(selectedPeriodRange.value))
    //console.log(" -> Selected accounts "+selectedAccounts.value)
    // Check if start date before end date and vice versa
    if (selectedDateRange.value.end < selectedDateRange.value.start) {
        alert("End date cannot be before start date")
        return
    } else {
        localStorage.setItem('selectedDateRange', JSON.stringify(selectedDateRange.value))
    }


    if (pageId.value == "dashboard" && selectedDateRange.value.end >= selectedDateRange.value.start && hasData.value) {
        useECharts("clear")
    }

    localStorage.setItem('selectedPeriodRange', JSON.stringify(selectedPeriodRange.value))
    localStorage.setItem('selectedAccounts', selectedAccounts.value)

    localStorage.setItem('selectedGrossNet', selectedGrossNet.value)
    amountCase.value = selectedGrossNet.value
    amountCapital.value = selectedGrossNet.value.charAt(0).toUpperCase() + selectedGrossNet.value.slice(1)
    //console.log("filter amountCapital " + amountCapital.value)

    localStorage.setItem('selectedPositions', selectedPositions.value)

    localStorage.setItem('selectedTimeFrame', selectedTimeFrame.value)

    localStorage.setItem('selectedRatio', selectedRatio.value)

    if (pageId.value == "daily" || pageId.value == "calendar") {
        localStorage.setItem('selectedMonth', JSON.stringify(selectedMonth.value))
    }

    localStorage.setItem('selectedTags', selectedTags.value)
    checkAllTagsSelected()

    if (tempSelectedPlSatisfaction.value != null) {
        selectedPlSatisfaction.value = tempSelectedPlSatisfaction.value
        localStorage.setItem('selectedPlSatisfaction', selectedPlSatisfaction.value)
        tempSelectedPlSatisfaction.value = null
    }

    if (pageId.value == "dashboard") {
        useMountDashboard()
    }

    if (pageId.value == "daily") {
        await useMountDaily()
        useCheckVisibleScreen()
    }

    if (pageId.value == "screenshots") {
        await useRefreshScreenshot()
        useCheckVisibleScreen()
    }
    if (pageId.value == "calendar") {
        useMountCalendar(true)
    }
}

let allTagsSelected = ref(false)

const checkAllTagsSelected = () => {
    let temp = []
    for (let index = 0; index < availableTags.length; index++) {
        const element = availableTags[index];
        for (let index = 0; index < element.tags.length; index++) {
            const el = element.tags[index];
            temp.push(el.id)
        }
    }

    if ((temp.length + 1) == selectedTags.value.length) {
        allTagsSelected.value = true
    } else {
        allTagsSelected.value = false
    }

}
const selectAllTags = () => {

    selectedTags.value = []
    if (allTagsSelected.value) {
        allTagsSelected.value = !allTagsSelected.value
    } else {
        selectedTags.value.push("t000t")
        for (let index = 0; index < availableTags.length; index++) {
            const element = availableTags[index];
            for (let index = 0; index < element.tags.length; index++) {
                const el = element.tags[index];
                selectedTags.value.push(el.id)
            }
        }
        allTagsSelected.value = !allTagsSelected.value
    }

}
</script>

<template>
    <!-- ============ FILTERS ============ -->
    <div id="step10" class="col-12 mb-3">
        <div class="dailyCard filtersCard">

            <!-- Header / toggle + active filter chips -->
            <div class="filtersHeader" v-on:click="filtersClick">
                <span class="filtersToggle">
                    <i class="uil uil-filter me-2"></i>Filters
                    <i :class="filtersOpen ? 'uil uil-angle-up' : 'uil uil-angle-down'" class="ms-1"></i>
                </span>

                <span v-if="!filtersOpen" class="filtersChips">
                    <span v-show="filters[pageId].includes('accounts')" class="filterChip">
                        <i class="uil uil-user-circle"></i>
                        <span
                            v-if="currentUser.hasOwnProperty('accounts') && currentUser.accounts.length == selectedAccounts.length">All
                            accounts</span>
                        <span v-else>{{ selectedAccounts.length }} account(s)</span>
                    </span>

                    <span v-show="filters[pageId].includes('periodRange')" class="filterChip">
                        <i class="uil uil-calendar-alt"></i>{{ selectedPeriodRange.label }}
                    </span>

                    <span v-show="filters[pageId].includes('month')" class="filterChip">
                        <i class="uil uil-calendar-alt"></i>{{ useMonthFormat(selectedMonth.start) }}
                    </span>

                    <span v-show="filters[pageId].includes('grossNet')" class="filterChip">
                        {{ selectedGrossNet.charAt(0).toUpperCase() + selectedGrossNet.slice(1) }} data
                    </span>

                    <span v-show="filters[pageId].includes('positions')" class="filterChip">
                        <span v-if="positions.length == selectedPositions.length">All positions</span>
                        <span v-else>{{ selectedPositions.toString().charAt(0).toUpperCase() +
                            selectedPositions.toString().slice(1) }}</span>
                    </span>

                    <span v-show="filters[pageId].includes('timeFrame')" class="filterChip">
                        {{ selectedTimeFrame.charAt(0).toUpperCase() + selectedTimeFrame.slice(1) }} TF
                    </span>

                    <span v-show="filters[pageId].includes('ratio')" class="filterChip">
                        <span v-if="selectedRatio != 'profitFactor'">{{ selectedRatio.toUpperCase() }}</span>
                        <span v-else>Profit Factor</span>
                    </span>

                    <span v-show="filters[pageId].includes('tags')" class="filterChip">
                        <i class="uil uil-tag-alt"></i>
                        <span v-if="tags.length == selectedTags.length">All tags</span>
                        <span v-else>{{ selectedTags.length }} tag(s)</span>
                    </span>

                    <span v-show="filters[pageId].includes('plSatisfaction')" class="filterChip">
                        {{ selectedPlSatisfaction == 'satisfaction' ? 'Satisfaction' : "P&L" }}
                    </span>
                </span>
            </div>

            <!-- Filter controls -->
            <div v-show="filtersOpen" class="filtersBody">
                <div class="row g-3 align-items-end">

                    <!-- Date : period -->
                    <div class="col-12 col-lg-4 filterField" v-show="pageId == 'dashboard'">
                        <label class="filterLabel">Period</label>
                        <select v-on:input="inputDateRange($event.target.value)" class="form-select">
                            <option v-for="item in periodRange" :key="item.value" :value="item.value"
                                :selected="item.value == selectedPeriodRange.value">{{ item.label }}</option>
                        </select>
                    </div>

                    <!-- Date : range -->
                    <div class="col-12 col-lg-8 filterField" v-show="pageId == 'dashboard'">
                        <label class="filterLabel">Date range</label>
                        <div class="dateRange">
                            <FpDate mode="date" :model-value="useDateCalFormat(selectedDateRange.start)"
                                @update:model-value="inputDateRangeCal('start', $event)" />
                            <i class="uil uil-arrow-right dateRangeArrow"></i>
                            <FpDate mode="date" :model-value="useDateCalFormat(selectedDateRange.end)"
                                @update:model-value="inputDateRangeCal('end', $event)" />
                        </div>
                    </div>

                    <!-- Month -->
                    <div class="col-12 col-lg-4 filterField" v-show="pageId == 'daily' || pageId == 'calendar'">
                        <label class="filterLabel">Month</label>
                        <FpDate mode="month" :model-value="useDateCalFormatMonth(selectedMonth.start)"
                            @update:model-value="inputMonth($event)" />
                    </div>

                    <!-- Accounts -->
                    <div class="col-6 col-lg-3 filterField dropdown" v-show="pageId != 'screenshots' && pageId != 'calendar'">
                        <label class="filterLabel">Accounts</label>
                        <button class="btn btn-secondary dropdown-toggle filterDropdownBtn" type="button"
                            data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false">
                            {{ currentUser.hasOwnProperty('accounts') && currentUser.accounts.length == selectedAccounts.length ? 'All' : selectedAccounts.length + ' selected' }}
                        </button>
                        <ul class="dropdown-menu dropdownCheck">
                            <div v-for="item in currentUser.accounts" :key="item.value" class="form-check">
                                <input class="form-check-input" type="checkbox" :value="item.value"
                                    v-model="selectedAccounts">
                                {{ item.label }}
                            </div>
                        </ul>
                    </div>

                    <!-- Tags -->
                    <div :class="[pageId == 'screenshots' ? 'col-12 col-lg-4' : 'col-6 col-lg-3', 'filterField dropdown']"
                        v-show="pageId != 'calendar'">
                        <label class="filterLabel">Tags</label>
                        <button class="btn btn-secondary dropdown-toggle filterDropdownBtn" type="button"
                            data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false">
                            {{ tags.length == selectedTags.length ? 'All' : selectedTags.length + ' selected' }}
                        </button>
                        <ul class="dropdown-menu dropdownCheck">
                            <div>
                                <a class="pointerClass nav-link selectAllLink" v-on:click="selectAllTags"><span
                                        v-if="!allTagsSelected">Select All</span><span v-else>Unselect All</span></a>
                            </div>
                            <hr>
                            <label class="form-check noTagCheck">
                                <input class="form-check-input" type="checkbox" value="t000t" v-model="selectedTags">
                                No Tag
                            </label>
                            <hr>
                            <span v-for="group in availableTags">
                                <h6 class="p-1 mb-0 tagGroupHeader" :style="'background-color: ' + group.color + ';'">
                                    {{ group.name }}</h6>
                                <div v-for="item in group.tags" class="form-check">
                                    <input class="form-check-input" type="checkbox" :value="item.id"
                                        v-model="selectedTags">
                                    {{ item.name }}
                                </div>
                            </span>
                        </ul>
                    </div>

                    <!-- Positions -->
                    <div class="col-6 col-lg-3 filterField dropdown" v-show="pageId != 'screenshots' && pageId != 'calendar'">
                        <label class="filterLabel">Positions</label>
                        <button class="btn btn-secondary dropdown-toggle filterDropdownBtn" type="button"
                            data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false">
                            {{ positions.length == selectedPositions.length ? 'All' : selectedPositions.length + ' selected' }}
                        </button>
                        <ul class="dropdown-menu dropdownCheck">
                            <div v-for="item in positions" :key="item.value" class="form-check">
                                <input class="form-check-input" type="checkbox" :value="item.value"
                                    v-model="selectedPositions">
                                {{ item.label }}
                            </div>
                        </ul>
                    </div>

                    <!-- Gross/Net -->
                    <div class="col-6 col-lg-3 filterField" v-show="pageId != 'screenshots'">
                        <label class="filterLabel">Data</label>
                        <select v-on:input="selectedGrossNet = $event.target.value" class="form-select">
                            <option v-for="item in grossNet" :key="item.value" :value="item.value"
                                :selected="item.value == selectedGrossNet">{{ item.label }}</option>
                        </select>
                    </div>

                    <!-- Timeframe -->
                    <div class="col-6 col-lg-3 filterField" v-show="pageId == 'dashboard'">
                        <label class="filterLabel">Timeframe</label>
                        <select v-on:input="selectedTimeFrame = $event.target.value" class="form-select">
                            <option v-for="item in timeFrames" :key="item.value" :value="item.value"
                                :selected="item.value == selectedTimeFrame">{{ item.label }}</option>
                        </select>
                    </div>

                    <!-- Ratio -->
                    <div class="col-6 col-lg-3 filterField" v-show="pageId == 'dashboard'">
                        <label class="filterLabel">Ratio</label>
                        <select v-on:input="selectedRatio = $event.target.value" class="form-select">
                            <option v-for="item in ratios" :key="item.value" :value="item.value"
                                :selected="item.value == selectedRatio">{{ item.label }}</option>
                        </select>
                    </div>

                    <!-- P&L / Satisfaction -->
                    <div class="col-6 col-lg-3 filterField" v-show="pageId == 'calendar'">
                        <label class="filterLabel">Calendar shows</label>
                        <select v-on:input="tempSelectedPlSatisfaction = $event.target.value" class="form-select">
                            <option v-for="item in plSatisfaction" :key="item.value" :value="item.value"
                                :selected="item.value == selectedPlSatisfaction">{{ item.label }}</option>
                        </select>
                    </div>
                </div>

                <!-- Actions -->
                <div class="filtersActions">
                    <button class="btn blueBtn btn-sm" v-on:click="saveFilter">
                        <i class="uil uil-check me-1"></i>Apply filters
                    </button>
                    <button class="btn btn-outline-secondary btn-sm" v-on:click="filtersClick">Cancel</button>
                    <span v-if="pageId == 'dashboard'" class="dropdown ms-auto">
                        <button class="btn btn-outline-secondary btn-sm dropdown-toggle" type="button"
                            data-bs-toggle="dropdown" aria-expanded="false">
                            <i class="uil uil-export me-1"></i>Export
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end">
                            <li><a class="dropdown-item"
                                    v-on:click="useExport('json', useDateCalFormat(selectedDateRange.start), useDateCalFormat(selectedDateRange.end), filteredTradesTrades)">JSON</a>
                            </li>
                            <li><a class="dropdown-item"
                                    v-on:click="useExport('csv', useDateCalFormat(selectedDateRange.start), useDateCalFormat(selectedDateRange.end), filteredTradesTrades)">CSV</a>
                            </li>
                        </ul>
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.filtersCard {
    padding: 0.85em 1em;
}

/* Header */
.filtersHeader {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    cursor: pointer;
}

.filtersToggle {
    font-weight: 700;
    color: var(--white-87);
    white-space: nowrap;
}

.filtersToggle i {
    color: var(--accent);
}

/* Active filter chips (collapsed state) */
.filtersChips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
}

.filterChip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background-color: var(--accent-soft);
    color: var(--white-87);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    padding: 0.12rem 0.6rem;
    font-size: 11px;
    line-height: 1.6;
    white-space: nowrap;
}

.filterChip i {
    color: var(--accent);
    font-size: 12px;
}

/* Body */
.filtersBody {
    margin-top: 0.9rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border-subtle);
}

.filterField {
    text-align: left;
}

.filterLabel {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
    margin-bottom: 0.25rem;
    font-weight: 600;
}

/* Make the dropdown trigger buttons match the form-select look */
.filterDropdownBtn {
    width: 100%;
    text-align: left;
}

/* Date range row */
.dateRange {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}

.dateRange .form-control {
    flex: 1;
}

.dateRangeArrow {
    color: var(--white-38);
    flex: 0 0 auto;
}

/* Dropdown checkbox menus */
.dropdownCheck {
    max-height: 320px;
    overflow-y: auto;
}

.selectAllLink {
    color: var(--accent);
    padding: 0.15rem 0.25rem;
}

.noTagCheck {
    cursor: pointer;
}

.tagGroupHeader {
    border-radius: var(--radius-sm);
    color: #fff;
    font-size: 11px;
}

/* Actions */
.filtersActions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--border-subtle);
}
</style>