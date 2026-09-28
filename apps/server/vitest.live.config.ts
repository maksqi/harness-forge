// Opt-in live provider suite (ADR-027): `pnpm test:live` from the repository root. Runs only `*.live.test.ts` files,
// one at a time, against real provider APIs with the keys found in the environment (paid calls). Each file also
// guards itself with `describe.runIf(process.env.HF_LIVE === '1')`, so `pnpm test` never calls a paid API even when
// provider keys are exported.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'server-live',
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    env: { HF_LIVE: '1' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    passWithNoTests: true,
  },
})
