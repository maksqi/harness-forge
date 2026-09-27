import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineProject } from 'vitest/config'

const appDir = fileURLToPath(new URL('./app', import.meta.url))

// Plain Vue component/unit tests (no Nuxt runtime): import what you use explicitly.
export default defineProject({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': appDir,
      '~': appDir,
    },
  },
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['app/**/*.test.ts'],
  },
})
