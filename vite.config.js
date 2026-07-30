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
