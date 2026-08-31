import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

import 'flatpickr/dist/flatpickr.css'
import './assets/style-dark.css'


const app = createApp(App)


app.use(createPinia())
app.use(router)

/* Tear down any previous instance before mounting.
 *
 * Vue's mount() APPENDS into the container, it does not replace what is already
 * there. So if this module ever executes twice against the same document, the
 * page renders the whole app twice, stacked -- header, sidebar and content
 * duplicated top and bottom. That happens under Vite HMR (./tradenote.sh start --hot),
 * which re-runs the entry on an update.
 *
 * Unmounting the previous app and clearing the container makes a re-run
 * idempotent. In a production build this branch never fires: nothing has mounted
 * yet, so it costs one property read.
 */
const container = document.querySelector('#app')
if (container) {
    if (window.__tradenoteApp) {
        try { window.__tradenoteApp.unmount() } catch { /* already gone */ }
    }
    container.innerHTML = ''
}

app.mount('#app')
window.__tradenoteApp = app