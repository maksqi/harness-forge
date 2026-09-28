// The e2e `test`: Playwright's test with the `api` fixture (HarnessApi over the `request` fixture, same base URL as the
// pages) and the `cleanup` fixture. Specs import `test` and `expect` from here (or from `./index.ts`).
import { test as base, expect } from '@playwright/test'
import { HarnessApi } from './api.ts'
import { baseUrlFromEnv } from './env.ts'

/** Work to undo after a test, e.g. `api => api.updateSettings(before)` or `api => api.deleteChat(id)`. */
export type CleanupTask = (api: HarnessApi) => unknown

export interface HarnessFixtures {
  /** API helpers for setup and teardown, bound to the test's `request` context. */
  api: HarnessApi
  /**
   * Registers a task that runs after the test whatever happened, last registered first; every task runs even when an
   * earlier one fails. Unlike a `finally` block it also runs after a timeout: the test's request context is closed by
   * then, but this fixture's teardown still has a live `api`. Register a task before the change it undoes.
   */
  cleanup: (task: CleanupTask) => void
}

export const test = base.extend<HarnessFixtures>({
  api: async ({ request, baseURL }, use) => {
    await use(new HarnessApi(request, baseURL ?? baseUrlFromEnv()))
  },
  cleanup: async ({ api }, use) => {
    const tasks: CleanupTask[] = []
    await use((task) => {
      tasks.push(task)
    })
    const errors: unknown[] = []
    for (const task of tasks.reverse()) {
      try {
        await task(api)
      }
      catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0)
      throw errors[0]
  },
})

export { expect }
