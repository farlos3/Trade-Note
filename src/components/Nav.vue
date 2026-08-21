<script setup>
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { useToggleMobileMenu } from '../utils/utils.js'
import { useInitShepherd, useInitTooltip } from "../utils/utils.js";
import { usePipSize, useDefaultContractSize } from '../utils/addOrder.js'
import { routeComponentLoaders } from '../router/index.js'
import { statsProfiles, activeStatsProfile, setActiveStatsProfile, addStatsProfile, removeStatsProfile } from '../utils/statsProfile'
import { pageId, currentUser, renderProfile, screenType, latestVersion } from "../stores/globals"
import { version } from '../../package.json';

/* MODULES */
import Parse from 'parse/dist/parse.min.js'
import axios from 'axios'

const pages = [{
    id: "registerSignup",
    name: "Login",
    icon: "uil uil-apps"
},
{
    id: "dashboard",
    name: "Dashboard",
    icon: "uil uil-apps"
},
{
    id: "live",
    name: "Live",
    icon: "uil uil-signal"
},
{
    id: "daily",
    name: "History",
    icon: "uil uil-signal-alt-3"
},
{
    id: "calendar",
    name: "Calendar",
    icon: "uil uil-calendar-alt"
},
{
    id: "analysis",
    name: "AI Analysis",
    icon: "uil uil-brain"
},
{
    id: "plan",
    name: "Trading Plan",
    icon: "uil uil-calculator-alt"
},
{
    id: "planVsActual",
    name: "Plan vs Actual",
    icon: "uil uil-balance-scale"
},
{
    id: "screenshots",
    name: "Screenshots",
    icon: "uil uil-image-v"
},
{
    id: "videos",
    name: "Videos",
    icon: "uil uil-clapper-board"
},
{
    id: "mindset",
    name: "Mindset",
    icon: "uil uil-brain"
},
{
    id: "weeklyPlan",
    name: "Weekly Plan",
    icon: "uil uil-calendar-alt"
},
{
    id: "diary",
    name: "Diary",
    icon: "uil uil-diary"
},
{
    id: "notes",
    name: "Notes",
    icon: "uil uil-diary"
},
{
    id: "playbook",
    name: "Playbook",
    icon: "uil uil-compass"
},
{
    id: "addPlaybook",
    name: "Add Playbook",
    icon: "uil uil-compass"
},
{
    id: "addTrades",
    name: "Add Trades",
    icon: "uil uil-plus-circle"
},
{
    id: "addEntry",
    name: "Add Entry",
    icon: "uil uil-signin"
},
{
    id: "addDiary",
    name: "Add Diary",
    icon: "uil uil-plus-circle"
},
{
    id: "settings",
    name: "Settings",
    icon: "uil uil-sliders-v-alt"
},
{
    id: "addScreenshot",
    name: "Add Screenshot",
    icon: "uil uil-image-v"
},
{
    id: "addExcursions",
    name: "Add Excursions",
    icon: "uil uil-refresh"
},
{
    id: "entries",
    name: "Entries",
    icon: "uil uil-signin"
},
{
    id: "forecast",
    name: "Forecast",
    icon: "uil uil-cloud-sun"
},
{
    id: "imports",
    name: "Imports",
    icon: "uil uil-import"
},
{
    id: "checkout",
    name: "Checkout",
    icon: "uil uil-shopping-cart"
},
{
    id: "checkoutSuccess",
    name: "Checkout Success",
    icon: "uil uil-shopping-cart"
}
]

/* The nav title, with a fallback for a pageId this table does not list.
 *
 * This used to be four inline `pages.filter(...)[0].icon` lookups in the template.
 * A route missing from the list above made that `undefined.icon` -- a throw inside
 * a render function, which does not fail politely: it aborts the render and Vue
 * re-mounts instead of patching, painting the whole app on the page a second time.
 * Adding a route and forgetting this list should cost a plain heading, not the
 * layout. (Same failure mode as the fullScreenModal date bug.) */
const currentPage = computed(() =>
    pages.find((item) => item.id === pageId.value) || { name: '', icon: 'uil uil-apps' }
)

// Every SideMenu link is a plain <a href> full-page reload, not client-side routing
// (this app intentionally keeps full reloads -- see CLAUDE.md history), so there is
// no SPA transition to prefetch on. What we CAN do: warm the browser's HTTP cache for
// the other pages' lazy-loaded chunks from the CURRENT page, at idle priority so it
// never competes with this page's own render/data fetches. A reload discards the JS
// module registry but not the HTTP cache, so the next real navigation to one of these
// still gets a cache hit instead of a fresh fetch+transform.
const MAIN_NAV_PATHS = ['/dashboard', '/live', '/daily', '/calendar', '/analysis', '/plan', '/plan-vs-actual', '/weekly-plan', '/mindset', '/diary', '/screenshots', '/playbook']

function prefetchOtherPages() {
    const run = () => {
        const currentPath = window.location.pathname
        for (const path of MAIN_NAV_PATHS) {
            if (path === currentPath) continue
            const loadComponent = routeComponentLoaders[path]
            if (loadComponent) loadComponent().catch(() => { /* best-effort warmup */ })
        }
    }
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 3000 })
    } else {
        setTimeout(run, 1500)
    }
}

/* Stats profile: the point in time every statistic is measured from. Lives in the
   nav rather than in Filters.vue because it applies to pages that have no filter
   bar (AI Analysis, Plan vs Actual) -- a scope that covers everything has to be
   reachable from everywhere.
   Switching reloads the page: the range is resolved once per page mount
   (useGetSelectedRange), so re-running every view's data fetch in place would mean
   touching every page, while a reload is exactly what this app already does on
   every nav. */
const newProfileName = ref('')
const newProfileDate = ref(new Date().toISOString().slice(0, 10))

// These now write to the database (see statsProfile.js), so each is a network
// round trip -- profileBusy disables the controls meanwhile rather than letting a
// second click race the first, and reload only fires once the write is actually
// durable so a slow connection can't reload onto the pre-change state.
const profileBusy = ref(false)

async function pickProfile(id) {
    if (id === activeStatsProfile.value.id || profileBusy.value) return
    profileBusy.value = true
    try {
        await setActiveStatsProfile(id)
        window.location.reload()
    } catch (e) {
        console.error('could not switch stats profile', e)
        profileBusy.value = false
    }
}

async function createProfile() {
    const name = newProfileName.value.trim()
    if (!name || profileBusy.value) return
    profileBusy.value = true
    try {
        const startUnix = newProfileDate.value
            ? Math.floor(new Date(newProfileDate.value + 'T00:00:00').getTime() / 1000)
            : null
        await addStatsProfile(name, startUnix)
        newProfileName.value = ''
        window.location.reload()
    } catch (e) {
        console.error('could not create stats profile', e)
        profileBusy.value = false
    }
}

async function deleteProfile(id) {
    if (profileBusy.value) return
    profileBusy.value = true
    try {
        await removeStatsProfile(id)
        window.location.reload()
    } catch (e) {
        console.error('could not delete stats profile', e)
        profileBusy.value = false
    }
}

// Risk-check bell: shakes on its own every 15 min as a passive nudge (no popup/toast).
// Clicking it opens a quick lot-size / emotional-state check-in, answers are not saved.
const bellShaking = ref(false)
const riskCheckLot = ref('')
const riskCheckState = ref(null) // 'calm' | 'confident' | 'nervous' | 'excited' | 'frustrated'
const riskCheckSummary = ref('') // short text shown next to the bell after the modal closes
const riskCheckSummaryColor = ref('inherit') // frozen alongside the summary text, not live-bound
let bellShakeInterval = null
let bellShakeTimeout = null
const BELL_SHAKE_INTERVAL_MS = 15 * 60 * 1000

const RISK_STATE_COLORS = {
    calm: '#22c55e',
    confident: '#38bdf8',
    nervous: '#ef4444',
    excited: '#f59e0b',
    frustrated: '#94a3b8',
}

function triggerBellShake() {
    bellShaking.value = true
    bellShakeTimeout = setTimeout(() => { bellShaking.value = false }, 1000)
}

// Position-size calculator, embedded in the same check-in modal: lot size = how much
// you're willing to lose (balance x risk%) divided by what the stop-loss actually costs
// per lot (pip size x contract size x SL pips). Symbol/risk% persist across opens like a
// setting; balance re-syncs from the latest MT5 snapshot and SL pips resets each open.
const riskCalcBalance = ref('')
const riskCalcRiskPercent = ref(5)
const riskCalcSymbol = ref('XAUUSDr')
const riskCalcSlPips = ref('')

function prefillRiskCalcBalance() {
    const accts = (currentUser.value && Array.isArray(currentUser.value.mt5Accounts)) ? currentUser.value.mt5Accounts : []
    if (accts.length && accts[0].balance != null) riskCalcBalance.value = accts[0].balance
}

const riskCalcSuggestedLot = computed(() => {
    const balance = parseFloat(riskCalcBalance.value)
    const riskPercent = parseFloat(riskCalcRiskPercent.value)
    const slPips = parseFloat(riskCalcSlPips.value)
    if (!balance || !riskPercent || !slPips) return null
    const pipValuePerLot = useDefaultContractSize(riskCalcSymbol.value) * usePipSize(riskCalcSymbol.value)
    const riskAmount = balance * (riskPercent / 100)
    return riskAmount / (slPips * pipValuePerLot)
})

//console.log(" user "+useCheckCurrentUser())
onMounted(async () => {
    getLatestVersion()   // fire-and-forget: must not block navigation / tooltip init
    prefetchOtherPages() // idle-priority, must not block navigation / tooltip init either
    await useInitTooltip()

    bellShakeInterval = setInterval(triggerBellShake, BELL_SHAKE_INTERVAL_MS)

    const riskCheckModalEl = document.getElementById("riskCheckModal")
    riskCheckModalEl.addEventListener('shown.bs.modal', () => {
        riskCheckLot.value = ''
        riskCheckState.value = null
        riskCalcSlPips.value = ''
        prefillRiskCalcBalance()
    })
    riskCheckModalEl.addEventListener('hidden.bs.modal', () => {
        const parts = []
        if (riskCheckLot.value !== '' && riskCheckLot.value !== null) parts.push(`${riskCheckLot.value} lot`)
        if (riskCheckState.value) parts.push(riskCheckState.value.charAt(0).toUpperCase() + riskCheckState.value.slice(1))
        if (parts.length) {
            riskCheckSummary.value = parts.join(' · ')
            riskCheckSummaryColor.value = RISK_STATE_COLORS[riskCheckState.value] || 'inherit'
        }
    })
})

onUnmounted(() => {
    // Nav remounts on every route change (see getLatestVersion's comment), so
    // the interval/timeout must be cleared here or they stack up per navigation.
    if (bellShakeInterval) clearInterval(bellShakeInterval)
    if (bellShakeTimeout) clearTimeout(bellShakeTimeout)
})

function logout() {
    Parse.User.logOut().then(async () => {
        Parse.User.current(); // this will now be null
        localStorage.clear()

        console.log("Logging out")
        window.location.replace("/");
    });
}

function getLatestVersion() {
    return new Promise(async (resolve, reject) => {
        // Runs on every Nav mount (i.e. every route change). Check the two remote
        // sources once per browser session and cache the result, so navigating
        // doesn't re-fire two external calls each time.
        const cached = sessionStorage.getItem('latestVersion')
        if (cached) {
            try { latestVersion.value = JSON.parse(cached) } catch { /* ignore */ }
            resolve(); return
        }
        await axios.get("/api/dockerVersion", { timeout: 4000 })
    .then((response) => {
        //console.log(" -> data " + JSON.stringify(response.data));
        for (const element of response.data.results) { // Use for...of for iteration
            console.log("name " + element.name);
            if (element.name !== "latest") {
                latestVersion.value.docker = element.name;
                break; // Stop iterating after the first match
            }
        }
    })
    .catch((error) => {
        console.error("Error: ", error);
    })
    .finally(function () {
        // Always executed
    });
        
        await axios.get("https://raw.githubusercontent.com/Eleven-Trading/TradeNote/main/package.json", { timeout: 4000 })
            .then((response) => {
                //console.log(" -> data " + JSON.stringify(response.data))
                latestVersion.value.gitHub = response.data.version

            })
            .catch((error) => {
            })
            .finally(function () {
                // always executed
            })

            try { sessionStorage.setItem('latestVersion', JSON.stringify(latestVersion.value)) } catch { /* ignore */ }
        resolve()
    })
}


</script>

<template>
    <div class="justify-content-between navbar">
        <div class="navTitle">
            <span v-if="screenType == 'mobile'">
                <a v-on:click="useToggleMobileMenu">
                    <i v-bind:class="currentPage.icon" class="me-2"></i>{{ currentPage.name }}</a>
            </span>
            <span v-else>
                <i v-bind:class="currentPage.icon" class="me-2"></i>{{ currentPage.name }}</span>
        </div>
        <div class="navActions">
            <div class="dropdown me-2">
                <button class="btn btn-sm profileBtn" type="button" data-bs-toggle="dropdown" aria-expanded="false"
                    title="Stats profile — what every statistic is measured from">
                    <i class="uil uil-layer-group me-1"></i>{{ activeStatsProfile.name }}
                </button>
                <ul class="dropdown-menu dropdown-menu-end statsProfileMenu">
                    <li class="spHeader">Measure stats from</li>
                    <li v-for="p in statsProfiles" :key="p.id">
                        <!-- Own classes rather than .dropdown-item/.active: the global
                             .dropdown-item.active paints a solid blue bar with
                             !important, which made the selected row tower over the
                             others instead of just marking which one is on. -->
                        <div class="spRow" v-bind:class="{ on: p.id === activeStatsProfile.id }"
                            v-on:click="pickProfile(p.id)">
                            <i class="spTick uil" v-bind:class="p.id === activeStatsProfile.id ? 'uil-check' : ''"></i>
                            <span class="spName">{{ p.name }}</span>
                            <span class="spFrom">{{ p.startUnix ? new Date(p.startUnix * 1000).toISOString().slice(0, 10) : 'everything' }}</span>
                            <i v-if="p.id !== 'all'" class="uil uil-trash-alt spDel" title="Delete profile"
                                v-on:click.stop="deleteProfile(p.id)"></i>
                        </div>
                    </li>
                    <li class="spDivider"></li>
                    <li class="spNew">
                        <div class="spHeader">New profile</div>
                        <input class="form-control form-control-sm spInput" placeholder="Name"
                            v-model="newProfileName" v-on:click.stop />
                        <input class="form-control form-control-sm spInput" type="date"
                            v-model="newProfileDate" v-on:click.stop />
                        <button type="button" class="btn btn-outline-success btn-sm spAdd"
                            :disabled="!newProfileName.trim()" v-on:click.stop="createProfile">Add</button>
                    </li>
                </ul>
            </div>
            <div id="step11" class="navBellWrap">
                <span v-if="riskCheckSummary" class="navBellSummary" v-bind:style="{ color: riskCheckSummaryColor }">{{
                    riskCheckSummary }}</span>
                <i class="uil uil-bell navBell" v-bind:class="{ navBellShake: bellShaking }"
                    data-bs-toggle="modal" data-bs-target="#riskCheckModal" title="Risk check-in"></i>
            </div>
            <div id="step12" class="dropdown" v-bind:key="renderProfile">
                <a role="button" data-bs-toggle="dropdown" aria-expanded="false" class="profileTrigger">
                    <span v-if="currentUser.hasOwnProperty('avatar')"><img class="profileImg"
                            v-bind:src="currentUser.avatar.url" /></span>
                    <span v-else><img class="profileImg" src="../assets/astronaut.png" /></span>
                </a>
                <ul class="dropdown-menu dropdown-menu-end">

                        <li>
                            <a class="dropdown-item" href="settings">
                                <i class="uil uil-sliders-v-alt me-2"></i>Settings</a>
                        </li>

                        <li>
                            <a class="dropdown-item" href="imports">
                                <i class="uil uil-import me-2"></i>Imports</a>
                        </li>

                        <li>
                            <a class="dropdown-item" v-on:click="useInitShepherd()">
                                <i class="uil uil-question-circle me-2"></i>Tutorial</a>
                        </li>

                        <li>
                            <a class="dropdown-item" v-on:click="logout()">
                                <i class="uil uil-signout me-2"></i>Logout</a>
                        </li>
                        <li>
                            <hr class="dropdown-divider">
                        </li>
                        <li class="text-center">
                            <span class="txt-x-small" style="color: var(--white-38)">v{{ version }}</span>
                        </li>
                        <!--<li class="text-center"><a class="txt-small blue-link" target="_blank"
                                href="https://eleven.m-pages.com/tradenote">Get Updates</a></li>-->
                    </ul>
                </div>
            </div>
        </div>

        <!-- Risk check-in: opened from the nav bell, not saved anywhere -- just a
             pause-and-answer prompt. -->
        <div class="modal fade" id="riskCheckModal" tabindex="-1" aria-labelledby="riskCheckModalLabel"
            aria-hidden="true">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="container col mt-4">
                        <label class="dashInfoTitle mb-3"><i class="uil uil-bell me-1"></i>Risk check-in</label>

                        <div class="mb-3 p-2 riskCalcBox">
                            <label class="txt-small fw-bold mb-2 d-block">Position size calculator</label>
                            <div class="row g-2">
                                <div class="col-6">
                                    <label class="form-label txt-x-small mb-1">Balance ($)</label>
                                    <input type="number" step="0.01" class="form-control form-control-sm"
                                        v-model="riskCalcBalance" />
                                </div>
                                <div class="col-6">
                                    <label class="form-label txt-x-small mb-1">Risk %</label>
                                    <input type="number" step="0.1" min="0" class="form-control form-control-sm"
                                        v-model="riskCalcRiskPercent" />
                                </div>
                                <div class="col-6">
                                    <label class="form-label txt-x-small mb-1">Symbol</label>
                                    <input type="text" class="form-control form-control-sm" v-model="riskCalcSymbol" />
                                </div>
                                <div class="col-6">
                                    <label class="form-label txt-x-small mb-1">Stop-loss (pips)</label>
                                    <input type="number" step="1" min="0" class="form-control form-control-sm"
                                        v-model="riskCalcSlPips" placeholder="e.g. 200" />
                                </div>
                            </div>
                            <div class="mt-2 txt-small" v-if="riskCalcSuggestedLot !== null">
                                Suggested lot size: <strong>{{ riskCalcSuggestedLot.toFixed(2) }}</strong>
                                <button type="button" class="btn btn-outline-primary btn-sm ms-2"
                                    v-on:click="riskCheckLot = riskCalcSuggestedLot.toFixed(2)">Use this</button>
                            </div>
                        </div>

                        <div class="mb-3">
                            <label class="form-label txt-small">What lot size do you feel comfortable with right
                                now?</label>
                            <input type="number" step="0.01" min="0" class="form-control" v-model="riskCheckLot"
                                placeholder="e.g. 0.10" />
                        </div>
                        <div class="mb-2">
                            <label class="form-label txt-small d-block">Are you feeling good right now -- not
                                nervous, not excited?</label>
                            <div class="d-flex flex-wrap gap-2">
                                <button type="button" class="btn btn-sm flex-fill"
                                    v-bind:class="riskCheckState === 'calm' ? 'btn-success' : 'btn-outline-success'"
                                    v-on:click="riskCheckState = 'calm'">Calm</button>
                                <button type="button" class="btn btn-sm flex-fill"
                                    v-bind:class="riskCheckState === 'confident' ? 'btn-info' : 'btn-outline-info'"
                                    v-on:click="riskCheckState = 'confident'">Confident</button>
                                <button type="button" class="btn btn-sm flex-fill"
                                    v-bind:class="riskCheckState === 'nervous' ? 'btn-danger' : 'btn-outline-danger'"
                                    v-on:click="riskCheckState = 'nervous'">Nervous</button>
                                <button type="button" class="btn btn-sm flex-fill"
                                    v-bind:class="riskCheckState === 'excited' ? 'btn-warning' : 'btn-outline-warning'"
                                    v-on:click="riskCheckState = 'excited'">Excited</button>
                                <button type="button" class="btn btn-sm flex-fill"
                                    v-bind:class="riskCheckState === 'frustrated' ? 'btn-secondary' : 'btn-outline-secondary'"
                                    v-on:click="riskCheckState = 'frustrated'">Frustrated</button>
                            </div>
                        </div>
                    </div>
                    <div class="col text-center mt-2 mb-4">
                        <button class="btn btn-outline-primary btn-sm" data-bs-dismiss="modal">Close</button>
                    </div>
                </div>
            </div>
        </div>
</template>

<style scoped>
.riskCalcBox {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
}

.navBellWrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.navBellSummary {
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
}

.navBell {
    font-size: 1.4rem;
    cursor: pointer;
    color: var(--white-87);
}

.navBell:hover {
    color: #f59e0b;
}

@keyframes navBellShakeAnim {

    0%,
    100% {
        transform: rotate(0deg);
    }

    10%,
    30%,
    50%,
    70% {
        transform: rotate(-15deg);
    }

    20%,
    40%,
    60%,
    80% {
        transform: rotate(15deg);
    }

    90% {
        transform: rotate(-8deg);
    }
}

.navBellShake {
    display: inline-block;
    color: #f59e0b;
    animation: navBellShakeAnim 0.8s ease-in-out;
}

.profileBtn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--white-87);
    font-size: 0.8rem;
    white-space: nowrap;
}




.statsProfileMenu {
    min-width: 268px;
    padding: 0.35rem;
}

/* One header treatment for both the list and the new-profile block, so the two
   halves of the menu read as the same thing. */
.spHeader {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--white-60);
    padding: 0.35rem 0.5rem 0.3rem;
}

/* Every row the same height whether selected or not -- selection is a tick and a
   tint, not a change of size. */
.spRow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    line-height: 1.2;
}

.spRow:hover { background: var(--surface-hover); }
.spRow.on { background: rgba(47, 155, 255, 0.14); }

.spTick {
    width: 0.9rem;
    flex: 0 0 auto;
    color: #2f9bff;
    font-size: 0.9rem;
}

.spName {
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.spFrom {
    font-size: 0.72rem;
    color: var(--white-60);
    margin-left: auto;
    white-space: nowrap;
}

.spDel {
    flex: 0 0 auto;
    opacity: 0.4;
    font-size: 0.85rem;
}

.spDel:hover { opacity: 1; color: #F6465D; }

.spDivider {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 0.35rem 0.25rem;
}

.spNew { padding: 0 0.5rem 0.4rem; }

.spInput { margin-bottom: 0.35rem; }

.spAdd { width: 100%; }

/* Explicit rather than relying on Bootstrap's own outline-hover fill: this
   button sits inside a dropdown menu, and pinning the exact fill color here
   guarantees it matches "Save reflection" (the other outline-success button in
   the app) once a name is typed, instead of depending on cascade order. */
.spAdd:not(:disabled):hover {
    background-color: #198754;
    border-color: #198754;
    color: #fff;
}

</style>
