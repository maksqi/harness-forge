// The e2e `test`: Playwright's test with the `api` fixture (HarnessApi over the `request` fixture, same base URL as the
// pages). Specs import `test` and `expect` from here (or from `./index.ts`).
import { test as base, expect } from '@playwright/test'
import { HarnessApi } from './api.ts'
import { baseUrlFromEnv } from './env.ts'

export interface HarnessFixtures {
  /** API helpers for setup and teardown, bound to the test's `request` context. */
  api: HarnessApi
}

export const test = base.extend<HarnessFixtures>({
  api: async ({ request, baseURL }, use) => {
    await use(new HarnessApi(request, baseURL ?? baseUrlFromEnv()))
  },
})

export { expect }
