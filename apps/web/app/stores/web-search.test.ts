// The web-search store (Phase 14, ADR-063; docs/UI.md 9.15, 11.10): the C54 shape (state, getters, actions) and the
// W14.10 actions: `fetch` (single flight, `maxAgeMs`, an answer older than the last event never wins, a fetch that raced
// a write is dropped), `save` (optimistic, rolled back), `setKey` (write-only, never kept), `test` and `applyEvent`.
import type { PluginSettingsView, SecretState, WebSearchTestResult } from '@harness-forge/shared'
import type { WebSearchConfig } from './web-search'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginDetail, pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { CORE_SEARCH_PLUGIN_ID, useWebSearchStore, WEB_SEARCH_KEY_SETTINGS } from './web-search'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

const SET: SecretState = { set: true, hint: 'BSA…9fQ2', source: 'stored' }
const MISSING: SecretState = { set: false, hint: null, source: null }

function view(overrides: { backend?: string, maxResults?: unknown, brave?: SecretState, tavily?: SecretState, exa?: SecretState } = {}): PluginSettingsView {
  return {
    schema: null,
    values: { backend: overrides.backend ?? 'brave', maxResults: overrides.maxResults ?? 5 },
    secrets: {
      braveApiKey: overrides.brave ?? SET,
      tavilyApiKey: overrides.tavily ?? MISSING,
      exaApiKey: overrides.exa ?? MISSING,
    },
  }
}

function config(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return { backend: 'brave', keys: { brave: SET, tavily: MISSING, exa: MISSING }, maxResults: 5, pluginActive: true, ...overrides }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function pluginEvent(state: 'active' | 'disabled' = 'active', id = CORE_SEARCH_PLUGIN_ID) {
  return createServerEvent('plugin.changed', { id, plugin: pluginSummary({ id, builtin: true, state, enabled: state === 'active' }) })
}

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  api.plugins.getSettings.mockResolvedValue(view())
  api.plugins.get.mockResolvedValue(pluginDetail({ id: CORE_SEARCH_PLUGIN_ID, builtin: true, state: 'active' }))
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.useRealTimers()
})

describe('web-search store: shape', () => {
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
})

describe('web-search store: fetch', () => {
  it('reads the settings and the plugin state of core-search (never a key value)', async () => {
    api.plugins.getSettings.mockResolvedValue(view({ backend: 'exa', maxResults: 8, exa: SET }))
    const store = useWebSearchStore()
    const loaded = await store.fetch()
    expect(api.plugins.getSettings).toHaveBeenCalledWith({ params: { id: 'core-search' } })
    expect(api.plugins.get).toHaveBeenCalledWith({ params: { id: 'core-search' } })
    expect(loaded).toEqual({ backend: 'exa', keys: { brave: SET, tavily: MISSING, exa: SET }, maxResults: 8, pluginActive: true })
    expect(store.config).toEqual(loaded)
    expect(store.loadedAt).toEqual(expect.any(Number))
    expect(store.builtinAvailable).toBe(true)
  })

  it('falls back to the manifest defaults for values it cannot read; a missing secret is "no key"', async () => {
    api.plugins.getSettings.mockResolvedValue({ schema: null, values: { backend: 'bing', maxResults: 42 }, secrets: {} })
    api.plugins.get.mockResolvedValue(pluginDetail({ id: CORE_SEARCH_PLUGIN_ID, state: 'disabled', enabled: false }))
    const store = useWebSearchStore()
    expect(await store.fetch()).toEqual({ backend: 'brave', keys: { brave: MISSING, tavily: MISSING, exa: MISSING }, maxResults: 5, pluginActive: false })
    expect(store.builtinAvailable).toBe(false)
  })

  it('is single flight: concurrent calls share one request', async () => {
    const settings = deferred<PluginSettingsView>()
    api.plugins.getSettings.mockReturnValue(settings.promise)
    const store = useWebSearchStore()
    const first = store.fetch()
    const second = store.fetch({ maxAgeMs: 15_000 })
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(1)
    settings.resolve(view())
    expect(await first).toEqual(await second)
    // Settled: the next call asks again.
    await store.fetch()
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(2)
  })

  it('reuses a configuration younger than maxAgeMs; without maxAgeMs it always asks', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const store = useWebSearchStore()
    await store.fetch()
    await store.fetch({ maxAgeMs: 15_000 })
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    await store.fetch({ maxAgeMs: 15_000 })
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(2)
    await store.fetch()
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(3)
  })

  it('rejects with a HarnessError and stays unloaded when the load fails', async () => {
    api.plugins.getSettings.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    const store = useWebSearchStore()
    await expect(store.fetch()).rejects.toMatchObject({ code: 'internal_error', message: 'The database is locked.' })
    expect(store.config).toBeNull()
    expect(store.loadedAt).toBeNull()
  })

  it('an answer older than the last event never wins: the newer request decides', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const old = deferred<PluginSettingsView>()
    api.plugins.getSettings.mockReturnValueOnce(old.promise)
    const pending = store.fetch()
    // The event refetches quietly (the store is loaded) with the key removed meanwhile.
    api.plugins.getSettings.mockResolvedValueOnce(view({ brave: MISSING }))
    store.applyEvent(pluginEvent())
    await vi.waitFor(() => expect(store.config?.keys.brave.set).toBe(false))
    // The old answer (key still set) arrives last and is dropped; its caller gets the newer configuration.
    old.resolve(view())
    expect((await pending).keys.brave.set).toBe(false)
    expect(store.config?.keys.brave.set).toBe(false)
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(3)
  })

  it('a stale answer that arrives first joins the newer request', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const old = deferred<PluginSettingsView>()
    const newer = deferred<PluginSettingsView>()
    api.plugins.getSettings.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const pending = store.fetch()
    store.applyEvent(pluginEvent())
    old.resolve(view({ maxResults: 2 }))
    await Promise.resolve()
    expect(store.config?.maxResults).toBe(5)
    newer.resolve(view({ maxResults: 9 }))
    expect((await pending).maxResults).toBe(9)
    expect(store.config?.maxResults).toBe(9)
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(3)
  })

  it('an event during the very first load makes that load ask again', async () => {
    const old = deferred<PluginSettingsView>()
    api.plugins.getSettings.mockReturnValueOnce(old.promise).mockResolvedValueOnce(view({ backend: 'tavily', tavily: SET }))
    const store = useWebSearchStore()
    const pending = store.fetch()
    store.applyEvent(pluginEvent())
    old.resolve(view())
    expect(await pending).toMatchObject({ backend: 'tavily' })
    expect(store.config?.backend).toBe('tavily')
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(2)
  })

  it('an event makes a fresh configuration stale for maxAgeMs', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    api.plugins.getSettings.mockResolvedValue(view({ maxResults: 9 }))
    store.applyEvent(pluginEvent())
    expect((await store.fetch({ maxAgeMs: 60_000 })).maxResults).toBe(9)
  })
})

describe('web-search store: save and setKey', () => {
  it('save is optimistic and keeps the server answer', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const answer = deferred<PluginSettingsView>()
    api.plugins.updateSettings.mockReturnValue(answer.promise)
    const pending = store.save({ backend: 'tavily', maxResults: 3 })
    expect(store.config).toMatchObject({ backend: 'tavily', maxResults: 3 })
    expect(store.saving).toBe(true)
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'core-search' }, body: { values: { backend: 'tavily', maxResults: 3 } } })
    answer.resolve(view({ backend: 'tavily', maxResults: 3, tavily: SET }))
    expect(await pending).toEqual({ backend: 'tavily', keys: { brave: SET, tavily: SET, exa: MISSING }, maxResults: 3, pluginActive: true })
    expect(store.saving).toBe(false)
    expect(store.builtinAvailable).toBe(true)
  })

  it('save rolls back a failure, but keeps a value changed again meanwhile', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const first = deferred<PluginSettingsView>()
    const second = deferred<PluginSettingsView>()
    api.plugins.updateSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const failing = store.save({ backend: 'exa', maxResults: 7 })
    const later = store.save({ maxResults: 8 })
    first.reject(new HarnessError({ code: 'validation_error', message: 'Invalid settings.' }))
    await expect(failing).rejects.toMatchObject({ code: 'validation_error' })
    // backend rolls back; maxResults keeps the newer optimistic value.
    expect(store.config).toMatchObject({ backend: 'brave', maxResults: 8 })
    second.resolve(view({ maxResults: 8 }))
    await later
    expect(store.config).toMatchObject({ backend: 'brave', maxResults: 8 })
    expect(store.saving).toBe(false)
  })

  it('a write answer older than a newer write is dropped', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const first = deferred<PluginSettingsView>()
    const second = deferred<PluginSettingsView>()
    api.plugins.updateSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = store.save({ maxResults: 6 })
    const b = store.save({ maxResults: 7 })
    second.resolve(view({ maxResults: 7 }))
    await b
    first.resolve(view({ maxResults: 6 }))
    await a
    expect(store.config?.maxResults).toBe(7)
  })

  it('a fetch that raced a write never overwrites it', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const stale = deferred<PluginSettingsView>()
    api.plugins.getSettings.mockReturnValueOnce(stale.promise)
    const fetching = store.fetch()
    api.plugins.updateSettings.mockResolvedValue(view({ backend: 'exa', exa: SET }))
    await store.save({ backend: 'exa' })
    stale.resolve(view())
    expect((await fetching).backend).toBe('exa')
    expect(store.config?.backend).toBe('exa')
  })

  it('an event during a write refetches once the writes settle', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const answer = deferred<PluginSettingsView>()
    api.plugins.updateSettings.mockReturnValue(answer.promise)
    const pending = store.save({ maxResults: 4 })
    api.plugins.getSettings.mockResolvedValue(view({ maxResults: 4, exa: SET }))
    store.applyEvent(pluginEvent())
    answer.resolve(view({ maxResults: 4 }))
    await pending
    await vi.waitFor(() => expect(store.config?.keys.exa.set).toBe(true))
    expect(store.config?.maxResults).toBe(4)
  })

  it('save without a change saves nothing', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    await store.save({})
    expect(api.plugins.updateSettings).not.toHaveBeenCalled()
  })

  it('setKey stores a key (never kept) and removes one with an empty value', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    api.plugins.updateSettings.mockResolvedValueOnce(view({ tavily: { set: true, hint: 'tvly…abcd', source: 'stored' } }))
    const saved = await store.setKey('tavily', 'tvly-secret-value')
    expect(api.plugins.updateSettings).toHaveBeenLastCalledWith({ params: { id: 'core-search' }, body: { values: { tavilyApiKey: 'tvly-secret-value' } } })
    expect(saved.keys.tavily.set).toBe(true)
    expect(JSON.stringify(store.$state)).not.toContain('tvly-secret-value')

    api.plugins.updateSettings.mockResolvedValueOnce(view({ brave: MISSING }))
    await store.setKey('brave', null)
    expect(api.plugins.updateSettings).toHaveBeenLastCalledWith({ params: { id: 'core-search' }, body: { values: { braveApiKey: '' } } })
    expect(store.config?.keys.brave.set).toBe(false)
    expect(store.builtinAvailable).toBe(false)
  })

  it('setKey is not optimistic: a failure leaves the key state as it was', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    const answer = deferred<PluginSettingsView>()
    api.plugins.updateSettings.mockReturnValue(answer.promise)
    const pending = store.setKey('exa', 'exa-key')
    expect(store.config?.keys.exa.set).toBe(false)
    answer.reject(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await expect(pending).rejects.toMatchObject({ code: 'internal_error' })
    expect(store.config?.keys.exa.set).toBe(false)
    expect(store.saving).toBe(false)
  })

  it('a write before the first load loads first', async () => {
    api.plugins.updateSettings.mockResolvedValue(view({ backend: 'exa' }))
    const store = useWebSearchStore()
    expect((await store.save({ backend: 'exa' })).backend).toBe('exa')
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(1)
    expect(store.config?.pluginActive).toBe(true)
  })
})

describe('web-search store: test', () => {
  const result: WebSearchTestResult = { ok: true, backend: 'brave', results: 5, ms: 412 }

  it('posts the backend and keeps the result', async () => {
    api.webSearch.test.mockResolvedValue(result)
    const store = useWebSearchStore()
    const pending = store.test('brave')
    expect(store.testing).toBe(true)
    expect(await pending).toEqual(result)
    expect(api.webSearch.test).toHaveBeenCalledWith({ body: { backend: 'brave' } })
    expect(store.lastTest).toEqual(result)
    expect(store.testError).toBeNull()
    expect(store.testing).toBe(false)
  })

  it('without a backend the server uses the selected one; concurrent calls share the running test', async () => {
    const answer = deferred<WebSearchTestResult>()
    api.webSearch.test.mockReturnValue(answer.promise)
    const store = useWebSearchStore()
    const first = store.test()
    const second = store.test()
    expect(api.webSearch.test).toHaveBeenCalledTimes(1)
    expect(api.webSearch.test).toHaveBeenCalledWith({ body: {} })
    answer.resolve(result)
    expect(await first).toBe(await second)
  })

  it('keeps a failure as testError and clears the previous result', async () => {
    api.webSearch.test.mockResolvedValueOnce(result)
    api.webSearch.test.mockRejectedValueOnce(new HarnessError({ code: 'provider_error', message: 'The search key was rejected.', status: 401 }))
    const store = useWebSearchStore()
    await store.test('brave')
    await expect(store.test('brave')).rejects.toMatchObject({ code: 'provider_error' })
    expect(store.lastTest).toBeNull()
    expect(store.testError).toMatchObject({ code: 'provider_error', status: 401 })
    expect(store.testing).toBe(false)
  })
})

describe('web-search store: applyEvent', () => {
  it('ignores other events and other plugins', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    store.applyEvent(pluginEvent('active', 'dice-roller'))
    store.applyEvent(createServerEvent('catalog.changed', { providerId: null }))
    await Promise.resolve()
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(1)
  })

  it('does not load an unloaded store', () => {
    const store = useWebSearchStore()
    expect(() => store.applyEvent(createServerEvent('plugin.changed', { id: CORE_SEARCH_PLUGIN_ID, plugin: null }))).not.toThrow()
    expect(api.plugins.getSettings).not.toHaveBeenCalled()
    expect(store.config).toBeNull()
  })

  it('takes the plugin state from the event at once, then refetches quietly', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    api.plugins.get.mockResolvedValue(pluginDetail({ id: CORE_SEARCH_PLUGIN_ID, state: 'disabled', enabled: false }))
    store.applyEvent(pluginEvent('disabled'))
    expect(store.config?.pluginActive).toBe(false)
    expect(store.builtinAvailable).toBe(false)
    await vi.waitFor(() => expect(api.plugins.getSettings).toHaveBeenCalledTimes(2))
    expect(store.config?.pluginActive).toBe(false)
  })

  it('a failed quiet refetch is swallowed and keeps the configuration', async () => {
    const store = useWebSearchStore()
    await store.fetch()
    api.plugins.getSettings.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    store.applyEvent(pluginEvent())
    await vi.waitFor(() => expect(api.plugins.getSettings).toHaveBeenCalledTimes(2))
    expect(store.config).toEqual(config())
  })
})
