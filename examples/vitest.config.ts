import { defineProject } from 'vitest/config'

// Example plugins: manifests parse and plugins load through the host test harness (see examples.test.ts).
export default defineProject({
  test: {
    name: 'examples',
    environment: 'node',
    include: ['plugins/**/*.test.ts'],
  },
})
