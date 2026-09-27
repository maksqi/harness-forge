import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/server', 'apps/web'],
    passWithNoTests: true,
  },
})
