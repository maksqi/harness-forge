import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginSummary, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { isProviderConfigured, useProvidersStore } from './providers'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.useRealTimers()
})

const anthropic = providerSummary()
const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)', status: 'not_configured', modelCount: 5 })
const ollama = providerSummary({ id: 'ollama', name: 'Ollama (local)', local: true, status: 'connected', modelCount: 0 })

describe('providers store', () => {
  it('loads the list and derives the connected providers', async () => {
    api.providers.list.mockResolvedValue({ items: [anthropic, openai, ollama] })
    const store = useProvidersStore()
    await store.fetchAll()
    expect(store.loaded).toBe(true)
    expect(store.byId('openai')?.name).toBe('OpenAI (ChatGPT)')
    expect(store.byId('nope')).toBeUndefined()
    expect(store.connected.map(provider => provider.id)).toEqual(['anthropic', 'ollama'])
    expect(store.hasUsableProvider).toBe(true)
  })

  it('needs a configured provider with models to be usable', async () => {
    api.providers.list.mockResolvedValue({ items: [openai, ollama, providerSummary({ enabled: false })] })
    const store = useProvidersStore()
    await store.fetchAll()
    expect(store.hasUsableProvider).toBe(false)
    expect(isProviderConfigured(providerSummary({ status: 'error' }))).toBe(true)
    expect(isProviderConfigured(providerSummary({ status: 'env' }))).toBe(true)
    expect(isProviderConfigured(providerSummary({ status: 'not_configured' }))).toBe(false)
  })

  it('surfaces the Phase 0 stub error', async () => {
    const store = useProvidersStore()
    await expect(store.fetchAll()).rejects.toBeInstanceOf(HarnessError)
    expect(store.loaded).toBe(false)
  })

  it('switches a provider optimistically and rolls back on failure', async () => {
    api.providers.list.mockResolvedValue({ items: [anthropic] })
    api.providers.update.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    const store = useProvidersStore()
    await store.fetchAll()
    const pending = store.setEnabled('anthropic', false)
    expect(store.byId('anthropic')?.enabled).toBe(false)
    await expect(pending).rejects.toMatchObject({ code: 'internal_error' })
    expect(store.byId('anthropic')?.enabled).toBe(true)
    expect(api.providers.update).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { enabled: false } })
  })

  it('saves and clears credentials and keeps the returned summary', async () => {
    api.providers.list.mockResolvedValue({ items: [openai] })
    api.credentials.set.mockResolvedValue({ ...openai, status: 'connected' })
    api.credentials.clear.mockResolvedValue(openai)
    const store = useProvidersStore()
    await store.fetchAll()
    await store.saveCredentials('openai', { apiKey: 'sk-test' })
    expect(api.credentials.set).toHaveBeenCalledWith({ params: { id: 'openai' }, body: { values: { apiKey: 'sk-test' } } })
    expect(store.byId('openai')?.status).toBe('connected')
    await store.clearCredentials('openai')
    expect(store.byId('openai')?.status).toBe('not_configured')
  })

  it('tracks tests in flight and returns failed tests as results', async () => {
    let finish: (value: unknown) => void = () => {}
    api.providers.test.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const store = useProvidersStore()
    const pending = store.test('anthropic', { apiKey: 'sk-draft' })
    expect(store.testing.anthropic).toBe(true)
    finish({ ok: false, latencyMs: 12, error: { code: 'auth_invalid', message: 'Rejected' } })
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(store.testing.anthropic).toBeUndefined()
    expect(api.providers.test).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { values: { apiKey: 'sk-draft' } } })
    await store.test('anthropic').catch(() => {})
    expect(api.providers.test).toHaveBeenLastCalledWith({ params: { id: 'anthropic' }, body: {} })
  })

  it('applies provider.changed events and refetches on plugin.changed', async () => {
    vi.useFakeTimers()
    api.providers.list.mockResolvedValue({ items: [anthropic, openai] })
    const store = useProvidersStore()
    await store.fetchAll()
    store.applyEvent({ type: 'provider.changed', data: { id: 'openai', provider: { ...openai, status: 'env' } }, at: 1 })
    expect(store.byId('openai')?.status).toBe('env')
    store.applyEvent({ type: 'provider.changed', data: { id: 'openai', provider: null }, at: 2 })
    expect(store.byId('openai')).toBeUndefined()
    store.applyEvent({ type: 'provider.changed', data: { id: 'together', provider: providerSummary({ id: 'together', pluginId: 'together' }) }, at: 3 })
    expect(store.items.map(provider => provider.id)).toEqual(['anthropic', 'together'])

    store.applyEvent({ type: 'plugin.changed', data: { id: 'together', plugin: pluginSummary({ id: 'together' }) }, at: 4 })
    store.applyEvent({ type: 'plugin.changed', data: { id: 'together', plugin: null }, at: 5 })
    await vi.advanceTimersByTimeAsync(500)
    expect(api.providers.list).toHaveBeenCalledTimes(2)
  })

  it('ignores provider events for an unloaded list', () => {
    const store = useProvidersStore()
    store.applyEvent({ type: 'provider.changed', data: { id: 'anthropic', provider: anthropic }, at: 1 })
    expect(store.items).toEqual([])
  })
})
