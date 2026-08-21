import { createRouter, createWebHistory } from 'vue-router'
import LoginRegisterLayout from '../layouts/LoginRegister.vue'
import DashboardLayout from '../layouts/Dashboard.vue'
import { registerOff } from '../stores/globals'
import axios from 'axios'

(async () => {
    async function getRegisterPage() {
        return new Promise((resolve, reject) => {
            console.log("\nGETTING REGISTER PAGE")
            axios.post('/api/registerPage')
                .then((response) => {
                    //console.log(" response "+JSON.stringify(response))
                    //localStorage.setItem('parse_app_id', response.data)
                    //console.log("  --> App id in localstorage " + localStorage.getItem('parse_app_id'))
                    registerOff.value = response.data
                    resolve()
                })
                .catch((error) => {
                    console.log(" -> Error getting register page " + error)
                    reject(error)
                });


        })
    }

    await getRegisterPage()
})();


const routes = [{
        path: '/',
        name: 'login',
        meta: {
            title: "Login",
            layout: LoginRegisterLayout
        },
        component: () =>
            import('../views/Login.vue')
    },
    {
        path: '/register',
        name: 'register',
        meta: {
            title: "Register",
            layout: LoginRegisterLayout
        },
        component: () =>
            import('../views/Register.vue')
    },
    {
        path: '/dashboard',
        name: 'dashboard',
        meta: {
            title: "Dashboard",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Dashboard.vue')
    },
    {
        path: '/live',
        name: 'live',
        meta: {
            title: "Live",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Live.vue')
    },
    {
        path: '/calendar',
        name: 'calendar',
        meta: {
            title: "Calendar",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Calendar.vue')
    },
    {
        path: '/analysis',
        name: 'analysis',
        meta: {
            title: "AI Analysis",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Analysis.vue')
    },
    {
        path: '/plan',
        name: 'plan',
        meta: {
            title: "Trading Plan",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Plan.vue')
    },
    {
        path: '/plan-vs-actual',
        name: 'planVsActual',
        meta: {
            title: "Plan vs Actual",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/PlanVsActual.vue')
    },
    {
        path: '/daily',
        name: 'daily',
        meta: {
            title: "History",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Daily.vue')
    },
    {
        path: '/mindset',
        name: 'mindset',
        meta: {
            title: "Mindset",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Mindset.vue')
    },
    {
        path: '/weekly-plan',
        name: 'weeklyPlan',
        meta: {
            title: "Weekly Plan",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/WeeklyPlan.vue')
    },
    {
        path: '/diary',
        name: 'diary',
        meta: {
            title: "Diary",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Diary.vue')
    },
    {
        path: '/screenshots',
        name: 'screenshots',
        meta: {
            title: "Screenshots",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Screenshots.vue')
    },
    {
        path: '/playbook',
        name: 'playbook',
        meta: {
            title: "Playbook",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Playbook.vue')
    },
    {
        path: '/addTrades',
        name: 'addTrades',
        meta: {
            title: "Add Trades",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/AddTrades.vue')
        
    },
    {
        path: '/addDiary',
        name: 'addDiary',
        meta: {
            title: "Add Diary",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/AddDiary.vue')
    },
    {
        path: '/addPlaybook',
        name: 'addPlaybook',
        meta: {
            title: "Add Playbook",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/AddPlaybook.vue')
    },
    {
        path: '/addScreenshot',
        name: 'addScreenshot',
        meta: {
            title: "Add Screenshot",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/AddScreenshot.vue')
    },
    {
        path: '/addExcursions',
        name: 'addExcursions',
        meta: {
            title: "Add Excursions",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/AddExcursions.vue')
    },
    {
        path: '/settings',
        name: 'settings',
        meta: {
            title: "Settings",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Settings.vue')
    },
    {
        path: '/imports',
        name: 'imports',
        meta: {
            title: "Imports",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Imports.vue')
    },
    {
        path: '/checkout',
        name: 'checkout',
        meta: {
            title: "Checkout",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/Checkout.vue')
    },
    {
        path: '/checkoutSuccess',
        name: 'checkoutSuccess',
        meta: {
            title: "Checkout Success",
            layout: DashboardLayout
        },
        component: () =>
            import('../views/CheckoutSuccess.vue')
    }
]

const router = createRouter({
    history: createWebHistory(
        import.meta.env.BASE_URL),
    routes
})

// Path -> lazy component loader, reusing the exact same import() functions passed
// to the router above (no separate hardcoded list to drift out of sync). Every nav
// link in this app is a plain <a href> full-page reload (see SideMenu.vue), not
// client-side routing, so there's no SPA route-transition to prefetch on -- but the
// browser's HTTP cache survives a reload, so warming these chunks from the CURRENT
// page (see Nav.vue's prefetchOtherPages) still pays off on the next real navigation.
export const routeComponentLoaders = Object.fromEntries(
    routes.filter((r) => r.meta && r.meta.layout === DashboardLayout).map((r) => [r.path, r.component])
)

router.beforeEach((to, from, next) => {
    // Get the page title from the route meta data that we have defined
    // See further down below for how we setup this data
    const title = to.meta.title
    // If the route has a title, set it as the page title of the document/page
    if (title) {
        document.title = title
    }
    // Continue resolving the route
    if (to.name === 'register' && registerOff.value) {
        next('/')
    } else {
        next()
    }
})

export default router