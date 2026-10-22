// The web-search store (Phase 14, ADR-063; docs/UI.md 9.15, 11.10): the C54 skeleton's shape (state, getters, actions);
// W14.10 implements the actions (single flight, `maxAgeMs`, events) and extends this file.
import type { WebSearchConfig } from './web-search'
import { createServerEvent } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_SEARCH_PLUGIN_ID, useWebSearchStore, WEB_SEARCH_KEY_SETTINGS } from './web-search'

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

function config(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return { backend: 'brave', keys: { brave: { set: true, hint: null, source: 'stored' }, tavily: { set: false, hint: null, source: null }, exa: { set: false, hint: null, source: null } }, maxResults: 5, pluginActive: true, ...overrides }
}

describe('web-search store (skeleton)', () => {
  it('starts unloaded, with the builtin unavailable', () => {
    const store = useWebSearchStore()
    expect(store.config).toBeNull()
    expect(store.loadedAt).toBeNull()
    expect(store.saving).toBe(false)
    expect(store.testing).toBe(false)
    expect(store.lastTest).toBeNull()
    expect(store.testError).toBeNull()
    expect(store.builtinAvailable).toBe(false)
    expect(CORE_SEARCH_PLUGIN_ID).toBe('core-search')
    expect(WEB_SEARCH_KEY_SETTINGS).toEqual({ brave: 'braveApiKey', tavily: 'tavilyApiKey', exa: 'exaApiKey' })
  })

  it('builtinAvailable: core-search is on and the selected backend has a key (open point 5)', () => {
    const store = useWebSearchStore()
    store.config = config()
    expect(store.builtinAvailable).toBe(true)
    store.config = config({ backend: 'tavily' })
    expect(store.builtinAvailable).toBe(false)
    store.config = config({ pluginActive: false })
    expect(store.builtinAvailable).toBe(false)
  })

  it('backendLabel names a backend, by default the selected one', () => {
    const store = useWebSearchStore()
    expect(store.backendLabel()).toBe('Brave Search')
    expect(store.backendLabel('exa')).toBe('Exa')
    store.config = config({ backend: 'tavily' })
    expect(store.backendLabel()).toBe('Tavily')
  })

  it('the actions refuse until W14.10 implements them; applyEvent never throws', async () => {
    const store = useWebSearchStore()
    await expect(store.fetch({ maxAgeMs: 15_000 })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(store.save({ backend: 'exa' })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(store.setKey('brave', null)).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(store.test()).rejects.toMatchObject({ code: 'not_implemented' })
    expect(() => store.applyEvent(createServerEvent('plugin.changed', { id: CORE_SEARCH_PLUGIN_ID, plugin: null }, 1))).not.toThrow()
  })
})
