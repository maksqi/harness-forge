// Test helper (not app code; nested so Nuxt does not auto-import it): a stand-in for the typed API client where
// every `client.<module>.<action>` is a vi.fn() created on first access. Unconfigured calls reject with the Phase 0
// stub error (`not_implemented`), like the real server skeleton.
//
// Usage in a store test:
//   const mock = vi.hoisted(() => ({ api: null as unknown }))
//   vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
//   beforeEach(() => { mock.api = createMockApi() })
import type { ApiClient } from '@harness-forge/shared'
import type { Mock } from 'vitest'
import { HarnessError } from '@harness-forge/shared'
import { vi } from 'vitest'

export type MockApi = {
  [M in keyof ApiClient]: { [A in keyof ApiClient[M]]: Mock }
}

export function notImplemented(): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: 'Not implemented yet.' })
}

export function createMockApi(): MockApi {
  const modules = new Map<string, Record<string, Mock>>()
  const moduleProxy = (name: string) => {
    let actions = modules.get(name)
    if (!actions) {
      actions = {}
      modules.set(name, actions)
    }
    const store = actions
    return new Proxy(store, {
      get(target, action) {
        if (typeof action !== 'string' || action === 'then')
          return undefined
        target[action] ??= vi.fn(async () => {
          throw notImplemented()
        })
        return target[action]
      },
    })
  }
  return new Proxy({}, {
    get(_target, module) {
      if (typeof module !== 'string' || module === 'then')
        return undefined
      return moduleProxy(module)
    },
  }) as MockApi
}
