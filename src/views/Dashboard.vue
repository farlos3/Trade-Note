<script setup>
import { computed, onBeforeMount, ref } from 'vue'
import SpinnerLoadingPage from '../components/SpinnerLoadingPage.vue';
import Filters from '../components/Filters.vue'
import { selectedDashTab, spinnerLoadingPage, dashboardIdMounted, totals, amountCase, amountCapital, profitAnalysis, renderData, selectedRatio, dashboardChartsMounted, hasData, satisfactionArray, availableTags, groups, barChartNegativeTagGroups, currentUser } from '../stores/globals';
import { useThousandCurrencyFormat, useTwoDecCurrencyFormat, useXDecCurrencyFormat, useMountDashboard, useThousandFormat, useXDecFormat } from '../utils/utils';
import NoData from '../components/NoData.vue';

const dashTabs = [{
    id: "overviewTab",
    label: "Overview",
    target: "#overviewNav"
},
{
    id: "timeTab",
    label: "Time&Date",
    target: "#timeNav"
},
{
    id: "tradesTab",
    label: "Trades&Executions",
    target: "#tradesNav"
},
{
    id: "setupsTab",
    label: "Setups",
    target: "#setupsNav"
},
{
    id: "financialsTab",
    label: "Financials",
    target: "#financialsNav"
}
]
amountCapital.value = amountCase.value ? amountCase.value.charAt(0).toUpperCase() + amountCase.value.slice(1) : ''

// MT5 account snapshots (broker / login / balance / deposit / withdrawal),
// pushed by the sync and stored on the user. Refetched on load via useInitParse.
const mt5Accounts = computed(() =>
    (currentUser.value && Array.isArray(currentUser.value.mt5Accounts)) ? currentUser.value.mt5Accounts : []
)

// Headline performance stats derived from the already-computed `totals`
// (gross/net per the amount toggle). Fills the dashboard with the numbers a
// trader scans first: win rate, counts, averages, profit factor.
const keyStats = computed(() => {
    const ac = amountCase.value
    const cap = amountCapital.value
    const trades = Number(totals.trades) || 0
    const wins = Number(totals[ac + 'WinsCount']) || 0
    const losses = Number(totals[ac + 'LossCount']) || 0
    const winRate = trades ? Number(totals['prob' + cap + 'Wins']) * 100 : 0
    const avgWin = Number(totals['avg' + cap + 'Wins'])
    const avgLoss = Number(totals['avg' + cap + 'Loss'])
    const sumWin = Number(totals[ac + 'Wins']) || 0
    const sumLoss = Math.abs(Number(totals[ac + 'Loss']) || 0)
    const profitFactor = sumLoss > 0 ? sumWin / sumLoss : null
    return { trades, wins, losses, winRate, avgWin, avgLoss, profitFactor }
})

const ratioCompute = computed(() => {
    let ratio = {}
    if (localStorage.getItem('selectedRatio') == 'appt') {
        ratio.shortName = "APPT"
        ratio.name = "Average Profit Factor per Trade"
        ratio.value = useTwoDecCurrencyFormat(totals[amountCase.value + 'Proceeds'] / totals.trades)
        ratio.tooltipTitle = '<div>Average Profit Per Trade</div><div> APPT = Proceeds &divide; Number of Trades</div><div>Proceeds: ' + useThousandCurrencyFormat(totals[amountCase.value + 'Proceeds']) + '</div><div>Trades: ' + useThousandFormat(totals.trades) + '</div>'
    }
    if (localStorage.getItem('selectedRatio') == 'apps') {
        ratio.name = "Average Profit Factor per Security"
        ratio.shortName = "APPS"
        ratio.value = useXDecCurrencyFormat(totals[amountCase.value + 'Proceeds'] / (totals.quantity / 2), 4)
        ratio.tooltipTitle = '<div>Average Profit Per Security</div><div> APPS = Proceeds &divide; Number of Securities Acquired</div><div>Proceeds: ' + useThousandCurrencyFormat(totals[amountCase.value + 'Proceeds']) + '</div><div>Securities Acquired: ' + useThousandFormat(totals.quantity / 2) + '</div>'
    }
    if (localStorage.getItem('selectedRatio') == 'profitFactor') {
        ratio.shortName = "Profit Factor"
        ratio.name = "Profit Factor"
        let wins = parseFloat(totals[amountCase.value + 'Wins']).toFixed(2)
        let loss = parseFloat(-totals[amountCase.value + 'Loss']).toFixed(2)
        let profitFactor = 0
        //console.log("wins " + wins + " and loss " + loss)
        if (loss != 0) {
            profitFactor = wins / loss
            //console.log(" -> profitFactor "+profitFactor)
        }
        ratio.value = useXDecFormat(profitFactor, 2)
        ratio.tooltipTitle = '<div> Profit Factor = Wins &divide; Losses</div><div>Wins: ' + useThousandCurrencyFormat(totals[amountCase.value + 'Wins']) + '</div><div>Losses: ' + useThousandCurrencyFormat(totals[amountCase.value + 'Loss']) + '</div>'
    }
    return ratio
})

onBeforeMount(async () => {
    barChartNegativeTagGroups.length = 0
    await useMountDashboard()
    //console.log(" availableTags "+JSON.stringify(availableTags))
    //console.log(" groups "+JSON.stringify(groups))

    //getting the "id" of barChartNegative based on the tag groups
    
    //console.log(" barChartNegativeTagGroups "+JSON.stringify(barChartNegativeTagGroups.value))
})


</script>

<template>
    <SpinnerLoadingPage />
    <div class="row mt-2">

        <div v-show="!spinnerLoadingPage">
            <Filters />

            <!-- MT5 ACCOUNT SNAPSHOT -->
            <div v-if="mt5Accounts.length" class="row g-3 mb-3">
                <div v-for="acc in mt5Accounts" :key="acc.login" class="col-12">
                    <div class="dailyCard acctCard">
                        <div class="acctHead">
                            <span class="acctBroker"><i class="uil uil-university me-1"></i>{{ acc.server }}</span>
                            <span class="acctLogin">MT5 #{{ acc.login }}</span>
                        </div>
                        <div class="acctStats">
                            <div class="acctStat">
                                <span class="acctStatLabel">Balance</span>
                                <span class="acctStatVal">{{ useTwoDecCurrencyFormat(acc.balance) }}</span>
                            </div>
                            <div class="acctStat">
                                <span class="acctStatLabel">Deposit</span>
                                <span class="acctStatVal acctPos">{{ useTwoDecCurrencyFormat(acc.deposit) }}</span>
                            </div>
                            <div class="acctStat">
                                <span class="acctStatLabel">Withdraw</span>
                                <span class="acctStatVal acctNeg">{{ useTwoDecCurrencyFormat(acc.withdrawal) }}</span>
                            </div>
                            <div class="acctStat">
                                <span class="acctStatLabel">Currency</span>
                                <span class="acctStatVal">{{ acc.currency }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- KEY PERFORMANCE STATS -->
            <div v-if="hasData" class="row g-2 mb-3 text-center">
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc">{{ useThousandFormat(keyStats.trades) }}</h5>
                        <span class="dashInfoTitle">Total Trades</span>
                    </div>
                </div>
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc">{{ keyStats.winRate.toFixed(1) }}%</h5>
                        <span class="dashInfoTitle">Win Rate</span>
                    </div>
                </div>
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc acctPos">{{ keyStats.wins }}</h5>
                        <span class="dashInfoTitle">Wins</span>
                    </div>
                </div>
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc acctNeg">{{ keyStats.losses }}</h5>
                        <span class="dashInfoTitle">Losses</span>
                    </div>
                </div>
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc">
                            {{ keyStats.profitFactor === null ? (keyStats.wins ? '∞' : '-') : keyStats.profitFactor.toFixed(2) }}
                        </h5>
                        <span class="dashInfoTitle">Profit Factor</span>
                    </div>
                </div>
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc acctPos">{{ isNaN(keyStats.avgWin) ? '-' : useTwoDecCurrencyFormat(keyStats.avgWin) }}</h5>
                        <span class="dashInfoTitle">Avg Win</span>
                    </div>
                </div>
                <div class="col-6 col-md-4 col-xl">
                    <div class="dailyCard statCard">
                        <h5 class="titleWithDesc acctNeg">{{ isNaN(keyStats.avgLoss) ? '-' : useTwoDecCurrencyFormat(keyStats.avgLoss) }}</h5>
                        <span class="dashInfoTitle">Avg Loss</span>
                    </div>
                </div>
            </div>

            <div v-if="!hasData">
                <NoData />
            </div>
            <div v-else>
                <nav>
                    <div class="nav nav-tabs mb-2" id="nav-tab" role="tablist">
                        <button v-for="dashTab in dashTabs" :key="dashTab.id"
                            :class="'nav-link ' + (selectedDashTab == dashTab.id ? 'active' : '')" :id="dashTab.id"
                            data-bs-toggle="tab" :data-bs-target="dashTab.target" type="button" role="tab"
                            aria-controls="nav-overview" aria-selected="true">{{ dashTab.label }}</button>
                    </div>
                </nav>

                <div class="tab-content" id="nav-tabContent">

                    <!-- ============ OVERVIEW ============ -->
                    <div v-bind:class="'tab-pane fade ' + (selectedDashTab == 'overviewTab' ? 'active show' : '')"
                        id="overviewNav" role="tabpanel" aria-labelledby="nav-overview-tab">
                        <!-- ============ LINE 2: ID CARDS ============ -->
                        <div class="col-12 text-center">
                            <div class="row">

                                <div v-if="dashboardIdMounted">
                                    <!-- FIRST LINE -->
                                    <div class="col-12 mb-3">
                                        <div class="row">
                                            <div class="col-6 mb-2 mb-lg-0 col-lg-3">
                                                <div class="dailyCard">
                                                    <h4 class="titleWithDesc">
                                                        {{
            useTwoDecCurrencyFormat(totals[amountCase
                +
                'Proceeds']) }}
                                                    </h4>
                                                    <span class="dashInfoTitle">Cumulated P&L</span>

                                                </div>
                                            </div>
                                            <div class="col-6 mb-2 mb-lg-0 col-lg-3">
                                                <div class="dailyCard">
                                                    <h4 class="titleWithDesc">
                                                        {{ ratioCompute.value }}
                                                    </h4>
                                                    <span class="dashInfoTitle">{{ ratioCompute.shortName }}<i
                                                            class="ps-1 uil uil-info-circle"
                                                            data-bs-custom-class="tooltipLargeLeft"
                                                            data-bs-toggle="tooltip" data-bs-html="true"
                                                            :data-bs-title="ratioCompute.tooltipTitle"></i></span>
                                                </div>
                                            </div>
                                            <div
                                                v-bind:class="[profitAnalysis[amountCase + 'MfeR'] != null ? 'col-6 col-lg-3' : 'col-12 col-lg-6']">
                                                <div class="dailyCard">
                                                    <h4 class="titleWithDesc">
                                                        <span v-if="!isNaN(profitAnalysis[amountCase + 'R'])">{{
            (profitAnalysis[amountCase +
                'R']).toFixed(2)
        }}</span>
                                                        <span v-else>-</span>
                                                    </h4>
                                                    <span class="dashInfoTitle">P/L Ratio</span>
                                                </div>
                                            </div>
                                            <div v-show="profitAnalysis[amountCase + 'MfeR'] != null"
                                                class="col-6 col-lg-3">
                                                <div class="dailyCard">
                                                    <h4 class="titleWithDesc">
                                                        <span v-if="profitAnalysis[amountCase + 'MfeR'] != null">{{
            (profitAnalysis[amountCase +
                'MfeR']).toFixed(2)
        }}</span>
                                                        <span v-else>-</span>
                                                    </h4>
                                                    <span class="dashInfoTitle">MFE P/L Ratio</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <!-- SECOND LINE -->
                                    <div class="col-12">
                                        <div class="row">
                                            <!-- Left square -->
                                            <div class="col-12 order-lg-2 col-lg-6">
                                                <!-- first line -->
                                                <div class="row mb-2">
                                                    <div class="col-6">
                                                        <div class="dailyCard">
                                                            <h5 class="titleWithDesc">
                                                                <span
                                                                    v-if="!isNaN(profitAnalysis[amountCase + 'AvWinPerShare'])">{{
            useTwoDecCurrencyFormat(profitAnalysis[amountCase +
                'AvWinPerShare'])
        }}</span>
                                                                <span v-else>-</span>
                                                            </h5>
                                                            <span class="dashInfoTitle">Win Per Share (avg.)</span>
                                                        </div>
                                                    </div>
                                                    <div class="col-6">
                                                        <div class="dailyCard">
                                                            <h5 class="titleWithDesc">
                                                                <span
                                                                    v-if="!isNaN(profitAnalysis[amountCase + 'AvLossPerShare'])">{{
            useTwoDecCurrencyFormat(profitAnalysis[amountCase +
                'AvLossPerShare'])
        }}</span>
                                                                <span v-else>-</span>
                                                            </h5>
                                                            <span class="dashInfoTitle">Loss Per Share (avg.)</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                <!-- second line -->
                                                <div class="row mb-2 mb-lg-0">
                                                    <div class="col-6">
                                                        <div class="dailyCard">
                                                            <h5 class="titleWithDesc">
                                                                <span
                                                                    v-if="profitAnalysis[amountCase + 'HighWinPerShare'] > 0">{{
            useTwoDecCurrencyFormat(profitAnalysis[amountCase +
                'HighWinPerShare'])
        }}</span>
                                                                <span v-else>-</span>
                                                            </h5>
                                                            <span class="dashInfoTitle">Win Per Share (high)</span>
                                                        </div>
                                                    </div>
                                                    <div class="col-6">
                                                        <div class="dailyCard">
                                                            <h5 class="titleWithDesc">
                                                                <span
                                                                    v-if="profitAnalysis[amountCase + 'HighLossPerShare'] > 0">{{
            useTwoDecCurrencyFormat(profitAnalysis[amountCase +
                'HighLossPerShare']) }}</span>
                                                                <span v-else>-</span>
                                                            </h5>
                                                            <span class="dashInfoTitle">Loss Per Share (high)</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>


                                            <!-- Right square -->
                                            <div class="col-12 order-lg-1 col-lg-6">
                                                <div class="row text-center mb-3">
                                                    <div
                                                        v-bind:class="[satisfactionArray.length > 0 ? 'col-6' : 'col-12']">
                                                        <div class="dailyCard">
                                                            <div v-if="dashboardIdMounted">
                                                                <div v-bind:key="renderData" id="pieChart1"
                                                                    class="chartIdCardClass">
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div v-show="satisfactionArray.length > 0" class="col-6">
                                                        <div v-if="dashboardIdMounted">
                                                            <div v-if="!satisfactionArray.length > 0" class="dailyCard">
                                                                <div
                                                                    class="chartIdCardClass d-flex align-items-center justify-content-center">
                                                                    <div>
                                                                        <div>-</div>
                                                                        <div class="dashInfoTitle">Satisfaction</div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div v-show="satisfactionArray.length > 0"
                                                                class="dailyCard">
                                                                <div v-bind:key="renderData" id="pieChart2"
                                                                    class="chartIdCardClass">
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- ============ LINE 3 : TOTAL CHARTS ============ -->
                        <div class="col-12">
                            <div class="row">
                                <!-- CUMULATIVE P&L -->
                                <div class="col-12 mb-3">
                                    <div class="dailyCard">
                                        <h6>Cumulated P&L</h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="lineBarChart1" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- APPT/APPS/PROFIT FACTOR CHART -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>{{ ratioCompute.name }} <span
                                                v-if="ratioCompute.name != 'Profit Factor'">({{ ratioCompute.shortName
                                                }})</span></h6>
                                        <div v-bind:key="renderData" id="barChart1" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- WIN LOSS CHART -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Win Rate</h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChart2" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- RISK REWARD CHART
                    <div class="col-12 col-xl-6 mb-3">
                        <div class="dailyCard">
                            <h6>Risk & Reward</h6>
                            <div class="text-center" v-if="!dashboardChartsMounted">
                                <div class="spinner-border text-blue" role="status"></div>
                            </div>
                            <div v-bind:key="renderData" id="boxPlotChart1" class="chartClass"></div>
                        </div>
                    </div>-->

                            </div>
                        </div>

                    </div>

                    <!-- ============ TIME ============ -->
                    <div v-bind:class="'tab-pane fade ' + (selectedDashTab == 'timeTab' ? 'active show' : '')"
                        id="timeNav" role="tabpanel" aria-labelledby="nav-time-tab">
                        <div class="col-12">
                            <div class="row">
                                <!-- GROUP BY DAY OF WEEK -->
                                <div class="col-12 col-xl-4 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Day of Week ({{ ratioCompute.shortName }})
                                        </h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative3" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- GROUP BY TIMEFRAME -->
                                <div class="col-12 col-xl-4 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Timeframe ({{ratioCompute.shortName}})
                                        </h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative1" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- GROUP BY DURATION -->
                                <div class="col-12 col-xl-4 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Duration ({{ ratioCompute.shortName }})
                                        </h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative2" class="chartClass"></div>
                                    </div>
                                </div>


                                <!-- SCATTER WINS
                                <div class="col-12">
                                    <div class="dailyCard">
                                        <h6>Scatter Wins</h6>
                                        <div v-bind:key="renderData" id="scatterChart1" class="chartClass"></div>
                                    </div>
                                </div>

                                SCATTER LOSSES 
                                <div class="col-12">
                                    <div class="dailyCard">
                                        <h6>Scatter Losses</h6>
                                        <div v-bind:key="renderData" id="scatterChart2" class="chartClass"></div>
                                    </div>
                                </div>-->

                            </div>
                        </div>
                    </div>

                    <!-- ============ TRADES ============ -->
                    <div v-bind:class="'tab-pane fade ' + (selectedDashTab == 'tradesTab' ? 'active show' : '')"
                        id="tradesNav" role="tabpanel" aria-labelledby="nav-trades-tab">
                        <div class="col-12">
                            <div class="row">

                                <!-- GROUP BY TRADES -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Trades ({{ ratioCompute.shortName }})</h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative4" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- GROUP BY EXECUTIONS -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Executions ({{ ratioCompute.shortName }})</h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative7" class="chartClass"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ============ SETUPS ============ -->
                    <div v-bind:class="'tab-pane fade ' + (selectedDashTab == 'setupsTab' ? 'active show' : '')"
                        id="setupsNav" role="tabpanel" aria-labelledby="nav-setups-tab">
                        <div class="col-12">
                            <div class="row">

                                <!-- GROUP BY POSITION -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Position ({{ ratioCompute.shortName }})</h6>
                                        <div class="text-center" v-if="!dashboardChartsMounted">
                                            <div class="spinner-border text-blue" role="status"></div>
                                        </div>
                                        <div v-bind:key="renderData" id="barChartNegative17" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- GROUP BY TAGS -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Tag ({{ ratioCompute.shortName }})</h6>
                                        <div class="text-center" v-if="!dashboardChartsMounted">
                                            <div class="spinner-border text-blue" role="status"></div>
                                        </div>
                                        <div v-bind:key="renderData" id="barChartNegative18" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- GROUP BY TAG COMBINATION -->
                                <div class="col-12 col-xl-6 mb-3" v-for="obj in barChartNegativeTagGroups">
                                    <div class="dailyCard">
                                        <h6>Group by Tag Group - {{ obj.name }} ({{ ratioCompute.shortName }})</h6>
                                        <div class="text-center" v-if="!dashboardChartsMounted">
                                            <div class="spinner-border text-blue" role="status"></div>
                                        </div>
                                        <div v-bind:key="renderData" :id="'barChartNegative'+obj.id" class="chartClass"></div>
                                    </div>
                                </div>

                            </div>
                        </div>
                    </div>

                    <!-- ============ FINANCIALS ============ -->
                    <div v-bind:class="'tab-pane fade ' + (selectedDashTab == 'financialsTab' ? 'active show' : '')"
                        id="financialsNav" role="tabpanel" aria-labelledby="nav-financials-tab">
                        <div class="col-12">
                            <div class="row">

                                <!-- GROUP BY SYMBOL -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Symbol ({{ ratioCompute.shortName }})</h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative16" class="chartClass"></div>
                                    </div>
                                </div>

                                <!-- GROUP BY FLOAT
                        <div class="col-12 col-xl-4 mb-3">
                            <div class="dailyCard">
                                <h6>Group by Share Float</h6>
                                <div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>
                                <div v-bind:key="renderData" id="barChartNegative12" class="chartClass"></div>
                            </div>
                        </div>-->

                                <!-- GROUP BY MARKET CAP
                        <div class="col-12 col-xl-4 mb-3">
                            <div class="dailyCard">
                                <h6>Group by Market Cap</h6>
                                <div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>
                                <div v-bind:key="renderData" id="barChartNegative14" class="chartClass"></div>
                            </div>
                        </div>-->

                                <!-- GROUP BY ENTRYPRICE -->
                                <div class="col-12 col-xl-6 mb-3">
                                    <div class="dailyCard">
                                        <h6>Group by Entry Price ({{ ratioCompute.shortName }})</h6>
                                        <!--<div class="text-center" v-if="!dashboardChartsMounted">
                                    <div class="spinner-border text-blue" role="status"></div>
                                </div>-->
                                        <div v-bind:key="renderData" id="barChartNegative13" class="chartClass"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.acctCard {
    padding: 1rem 1.25rem;
}

.acctHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.85rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
}

.acctBroker {
    font-weight: 700;
    font-size: 1rem;
    color: var(--white-87, rgba(255, 255, 255, 0.87));
}

.acctLogin {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--white-70, rgba(255, 255, 255, 0.6));
    font-variant-numeric: tabular-nums;
}

.acctStats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
}

@media (max-width: 576px) {
    .acctStats {
        grid-template-columns: repeat(2, 1fr);
    }
}

.acctStat {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.acctStatLabel {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-50, rgba(255, 255, 255, 0.45));
}

.acctStatVal {
    font-weight: 800;
    font-size: 1.2rem;
    color: var(--white-87, rgba(255, 255, 255, 0.87));
    font-variant-numeric: tabular-nums;
}

.acctPos {
    color: #16a34a;
}

.acctNeg {
    color: #dc2626;
}

/* Equal-height, vertically-centered stat cards so rows line up (no jagged
   bottoms when a card's value/label wraps to a different height). Account
   snapshot card keeps its own layout. */
.dailyCard:not(.acctCard) {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
</style>
