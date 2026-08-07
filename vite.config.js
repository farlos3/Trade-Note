import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      output: {
        // Without this every heavy lib lands in ONE ~2.6MB entry chunk, because
        // several lazy route chunks share them and Rollup hoists shared deps into
        // the common chunk. Two costs: a page with no chart still downloads all of
        // echarts, and changing any app code invalidates the whole blob so the
        // browser re-downloads the vendors too. Splitting per-library means each
        // keeps its own content hash -- app edits leave the vendor caches intact,
        // and a lib is fetched only by the pages that actually import it.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('echarts') || id.includes('zrender')) return 'vendor-echarts'
          if (id.includes('xlsx')) return 'vendor-xlsx'          // imports/brokers only
          if (id.includes('quill')) return 'vendor-quill'        // diary/notes editors
          if (id.includes('markerjs2')) return 'vendor-markerjs' // screenshot annotation
          if (id.includes('shepherd')) return 'vendor-shepherd'  // tutorial
          if (id.includes('/parse/')) return 'vendor-parse'
          if (id.includes('lodash')) return 'vendor-lodash'
        }
      }
    }
  },
  // Dev speed: routes are lazy-loaded, so the FIRST visit to a page otherwise
  // compiles that view + its heavy deps (echarts, quill, ...) on demand — that's
  // the slow tab-switch. Pre-bundle the heavy deps and pre-transform the views at
  // server start so navigation is warm. (No effect on the production build.)
  optimizeDeps: {
    include: ['echarts', 'dayjs', 'quill', 'papaparse', 'axios', 'parse']
  },
  server: {
    warmup: {
      clientFiles: [
        './src/main.js',
        './src/App.vue',
        './src/layouts/*.vue',
        './src/components/*.vue',
        './src/views/*.vue',
        './src/utils/*.js'
      ]
    }
  }
})
