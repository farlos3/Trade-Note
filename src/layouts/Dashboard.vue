<script setup>
import SideMenu from '../components/SideMenu.vue'
import Nav from '../components/Nav.vue'
import Screenshot from '../components/Screenshot.vue'
import ReturnToTopButton from '../components/ReturnToTopButton.vue'
import AddOrderModal from '../components/AddOrderModal.vue'
import EntryChecklistModal from '../components/EntryChecklistModal.vue'
import WeeklyGateModal from '../components/WeeklyGateModal.vue'
import { onBeforeMount, onMounted, onUnmounted, computed } from 'vue'
import { useInitParse, usePageId, useScreenType, useGetTimeZone, useGetPeriods, useReconcileSelectedDateRange, useInitPostHog, useCreatedDateFormat, useTimeFormat, useHourMinuteFormat } from '../utils/utils.js'
import { screenType, sideMenuMobileOut, screenshots, pageId, screenshot, selectedScreenshot, selectedScreenshotIndex, getMore } from '../stores/globals'
import { useSelectedScreenshotFunction } from '../utils/screenshots'
import { startEntryChecklistWatch, stopEntryChecklistWatch } from '../utils/entryChecklist'

/*========================================
  Functions used on all Dashboard components
========================================*/
onBeforeMount(async () => {
  usePageId()
  useInitParse()
  useGetTimeZone()
  await useGetPeriods()
  useReconcileSelectedDateRange()
  useScreenType()
})
useInitPostHog()

/* New orders are watched from the layout, not from a page.
   The modal has always been mounted here (i.e. on every page) but only
   Live.vue and Daily.vue ever fed its queue, so a fill that landed while the
   trader was on the Dashboard or the Calendar was never offered at all.

   onMounted, NOT setup: useInitParse() runs in onBeforeMount above, and touching
   Parse.User.current() before it throws. */
onMounted(startEntryChecklistWatch)
onUnmounted(stopEntryChecklistWatch)

// Keyed off "has anything been assigned" rather than a particular field, because
// useSelectedScreenshotFunction fills this object from two different shapes (a
// carousel entry, or a single screenshot passed straight in) and they do not
// share a guaranteed key.
const hasSelectedScreenshot = computed(() => Object.keys(selectedScreenshot).length > 0)
</script>
<template>
  <ReturnToTopButton />
  <div v-cloak class="container-fluid g-0">
    <div class="row g-0">
      <div id="sideMenu" v-bind:class="'min-vh-100 ' +
        (screenType == 'computer' ? 'sideMenu col-2' : 'sideMenuMobile')
        ">
        <SideMenu />
      </div>
      <div class="col-12 col-lg-10 position-relative">
        <div v-show="sideMenuMobileOut" class="sideMenuMobileOut position-absolute" v-on:click="toggleMobileMenu"></div>
        <Nav />
        <main>
          <slot />
        </main>
      </div>
      <!--footer-->
    </div>
  </div>
  <!-- Add Order popup (triggered from the +Add menu in Nav) -->
  <AddOrderModal />
  <!-- Post-entry review. Sole feeder is startEntryChecklistWatch above, which
       runs on every page. -->
  <EntryChecklistModal />
  <!-- Weekly discipline gates: Friday plan, Monday review, missing reflection -->
  <WeeklyGateModal />
  <!-- Modal -->
  <div class="modal fade" id="fullScreenModal" tabindex="-1" aria-labelledby="fullScreenModalLabel" aria-hidden="true">
    <div class="modal-dialog modal-fullscreen">
      <div class="modal-content">
        <div class="modal-body">
          <!-- Only once something is actually selected. selectedScreenshot starts
               as an empty reactive({}), and Screenshot renders its date header
               unconditionally for source="fullScreen" -- so rendering it eagerly
               meant formatting an undefined date on every single page load. There
               is also nothing to show in an empty full-screen viewer. -->
          <Screenshot v-if="hasSelectedScreenshot" :index="selectedScreenshotIndex" source="fullScreen"
            :screenshot-data="selectedScreenshot" />
        </div>
        <div class="modal-footer">
          <!-- NEXT / PREVIOUS -->
          
            <div class="text-start">
              <button v-if="selectedScreenshotIndex - 1 >= 0" class="btn btn-outline-primary btn-sm ms-3 mb-2"
                v-on:click="useSelectedScreenshotFunction((selectedScreenshotIndex - 1), 'fullScreen')">
                <i class="fa fa-chevron-left me-2"></i></button>
            </div>
            <div v-if="selectedScreenshotIndex + 1 > 0 && screenshots[selectedScreenshotIndex + 1]"
              class="ms-auto text-end">
              <button class="btn btn-outline-primary btn-sm me-3 mb-2"
                v-on:click="useSelectedScreenshotFunction((selectedScreenshotIndex + 1), 'fullScreen')"
                :disabled="getMore"><span v-if="!getMore"><i class="fa fa-chevron-right ms-2"></i></span>
                <span v-else>
                  <div class="spinner-border spinner-border-sm" role="status">
                  </div>
                </span>
              </button>
            </div>
          
        </div>
      </div>
    </div>
  </div>
</template>