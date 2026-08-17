<script setup>
import { computed } from "vue"
import { pageId, screenType } from "../stores/globals"
import { useToggleMobileMenu } from "../utils/utils";
import { weeklyGate } from "../utils/weeklyGates"

/* Dot on Weekly Plan when the weekly cycle owes something -- Monday's review or
   Friday's plan. Read straight off the gate rather than re-deriving the dates, so
   the badge cannot drift from what the gate actually enforces. It is already
   evaluated once per page load by WeeklyGateModal in the layout, so this costs no
   extra query. 'reflection' is left out on purpose: that one belongs to Diary's
   week notes, not to planning. */
const weeklyPlanDue = computed(() => weeklyGate.value === 'review' || weeklyGate.value === 'plan')

</script>

<template>
    <div class="logoDiv d-flex align-items-center">
        <span v-if="screenType == 'mobile'">
            <a v-on:click="useToggleMobileMenu"><img src="../assets/sun_full_blue.png" class="logo me-2" />TradeNote</a>
        </span>
        <span v-else><img src="../assets/sun_full_blue.png" class="logo me-2" />TradeNote</span>
    </div>
    <div id="step2">
        <div class="sideMenuDiv">
            <div class="sideMenuDivContent">
                <label class="sideMenuSection">Analytics</label>
                <a id="step3" v-bind:class="[pageId === 'dashboard' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/dashboard">
                    <i class="uil uil-apps me-2"></i>Dashboard</a>
                <a id="step3b" v-bind:class="[pageId === 'live' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/live">
                    <i class="uil uil-signal me-2"></i>Live</a>
                <a id="step4" v-bind:class="[pageId === 'daily' ? 'activeNavCss' : '', 'nav-link', 'mb-1']" href="/daily">
                    <i class="uil uil-signal-alt-3 me-2"></i>History
                </a>
                <a id="step5" v-bind:class="[pageId === 'calendar' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/calendar">
                    <i class="uil uil-calendar-alt me-2"></i>Calendar</a>
                <a id="step5b" v-bind:class="[pageId === 'analysis' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/analysis">
                    <i class="uil uil-brain me-2"></i>AI Analysis</a>
                <a id="step5c" v-bind:class="[pageId === 'plan' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/plan">
                    <i class="uil uil-calculator-alt me-2"></i>Trading Plan</a>
                <a id="step5d" v-bind:class="[pageId === 'planVsActual' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/plan-vs-actual">
                    <i class="uil uil-balance-scale me-2"></i>Plan vs Actual</a>
            </div>
        </div>

        <div class="sideMenuDiv">
            <div class="sideMenuDivContent">
                <label class="sideMenuSection">Journal</label>
                <a id="step6b" v-bind:class="[pageId === 'weeklyPlan' ? 'activeNavCss' : '', 'nav-link', 'mb-1']"
                    href="/weekly-plan">
                    <i class="uil uil-calendar-alt me-2"></i>Weekly Plan
                    <span v-if="weeklyPlanDue" class="dueDot" title="Weekly plan needs attention"></span>
                </a>
                <a id="step6" v-bind:class="[pageId === 'diary' ? 'activeNavCss' : '', 'nav-link', 'mb-1']" href="/diary">
                    <i class="uil uil-diary me-2"></i>Diary
                </a>
                <!-- Screenshots and Playbook are hidden from the menu on request.
                     The routes, views and stored data are all left intact, so this
                     is reversible by restoring these two links -- /screenshots and
                     /playbook still work if opened directly. -->
            </div>
        </div>
    </div>
</template>
<style scoped>
/* Amber, and inline after the label rather than a corner badge: the sidebar is
   scanned top-to-bottom, so the dot has to sit where the eye already is. */
.dueDot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
    margin-left: 0.45rem;
    vertical-align: middle;
}
</style>
