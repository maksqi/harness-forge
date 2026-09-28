import { defaultExclude, defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live provider tests make paid calls: only `pnpm test:live` (vitest.live.config.ts) runs them (ADR-027).
    exclude: [...defaultExclude, 'src/**/*.live.test.ts'],
  },
})
