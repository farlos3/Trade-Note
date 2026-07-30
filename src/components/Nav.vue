<script setup>
import { onMounted } from 'vue';
import { useCheckCloudPayment, useGetCurrentUser, useToggleMobileMenu } from '../utils/utils.js'
import { useInitShepherd, useInitTooltip } from "../utils/utils.js";
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
//console.log(" user "+useCheckCurrentUser())
onMounted(async () => {
    getLatestVersion()   // fire-and-forget: must not block navigation / tooltip init
    await useInitTooltip()
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

const navAdd = async (param) => {
    await useGetCurrentUser();
    try {
        await useCheckCloudPayment(currentUser.value);
        // Redirect only if no error occurs
        window.location.href = "/" + param;
    } catch (error) {
        //console.log("-> useCheckCloudPayment error: " + error);
        // Redirect to checkout page on error
        window.location.href = "/checkout";
    }
};


</script>

<template>
    <div class="justify-content-between navbar">
        <div class="navTitle">
            <span v-if="screenType == 'mobile'">
                <a v-on:click="useToggleMobileMenu">
                    <i v-bind:class="pages.filter(item => item.id == pageId)[0].icon" class="me-2"></i>{{
                        pages.filter(item => item.id == pageId)[0].name }}</a>
            </span>
            <span v-else>
                <i v-bind:class="pages.filter(item => item.id == pageId)[0].icon" class="me-2"></i>{{
                    pages.filter(item => item.id == pageId)[0].name }}</span>
        </div>
        <div class="navActions">
            <div id="step11" class="dropdown">
                <button class="btn blueBtn btn-sm" type="button" data-bs-toggle="dropdown" aria-expanded="false">
                    <i class="uil uil-plus me-2"></i>Add</button>
                <ul class="dropdown-menu dropdown-menu-end">
                    <li>
                        <a class="dropdown-item" data-bs-toggle="modal" data-bs-target="#addOrderModal">Order</a>
                    </li>
                    <li>
                        <a class="dropdown-item" @click="navAdd('addTrades')">Import file</a>
                    </li>
                    <li>
                        <a class="dropdown-item" @click="navAdd('addPlaybook')">Playbook</a>
                    </li>
                    <li>
                        <a class="dropdown-item" @click="navAdd('addExcursions')">Excursions</a>
                    </li>
                </ul>
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
</template>