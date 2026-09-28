import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { RECENT_MODELS_KEY, useModelsStore } from './models'
import { useProvidersStore } from './providers'
import { useSettingsStore } from './settings'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let storage: Storage

const sonnet = catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' })
const haiku = catalogModel({ id: 'claude-haiku-5', name: 'Claude Haiku 5', favorite: true })
const embed = catalogModel({ id: 'embed-1', kind: 'embedding', hidden: true })
const gpt = catalogModel({ providerId: 'openai', id: 'gpt-luna', name: 'GPT Luna' })
const llama = catalogModel({ providerId: 'ollama', id: 'llama3:8b', name: 'Llama 3 8B' })

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  storage = stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function loadCatalog() {
  api.providers.list.mockResolvedValue({
    items: [
      providerSummary(),
      providerSummary({ id: 'openai', status: 'not_configured' }),
      providerSummary({ id: 'ollama', local: true }),
    ],
  })
  api.models.list.mockResolvedValue({ items: [sonnet, haiku, embed, gpt, llama] })
  const models = useModelsStore()
  await Promise.all([useProvidersStore().fetchAll(), models.fetchAll()])
  return models
}

describe('models store', () => {
  it('loads every model, hidden ones included', async () => {
    const models = await loadCatalog()
    expect(api.models.list).toHaveBeenCalledWith({ query: { includeHidden: true } })
    expect(models.loaded).toBe(true)
    expect(models.byRef('anthropic:embed-1')?.hidden).toBe(true)
    expect(models.byRef('ollama:llama3:8b')?.name).toBe('Llama 3 8B')
  })

  it('shows only visible models of configured providers, grouped in provider order', async () => {
    const models = await loadCatalog()
    expect(models.visible.map(model => model.ref)).toEqual(['anthropic:claude-sonnet-5', 'anthropic:claude-haiku-5', 'ollama:llama3:8b'])
    expect(models.favorites.map(model => model.ref)).toEqual(['anthropic:claude-haiku-5'])
    expect(models.groupedByProvider.map(group => [group.provider.id, group.models.length])).toEqual([['anthropic', 2], ['ollama', 1]])
  })

  it('picks the default model: setting, then recent, then the first visible', async () => {
    const models = await loadCatalog()
    expect(models.defaultRef).toBe('anthropic:claude-sonnet-5')
    models.touchRecent('ollama:llama3:8b')
    expect(models.defaultRef).toBe('ollama:llama3:8b')
    // A default on a provider without a key still wins: sending then explains what is missing.
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, defaultModelRef: 'openai:gpt-luna' }
    expect(models.defaultRef).toBe('openai:gpt-luna')
  })

  it('groups chat models only; image, speech and transcription models stay out of the provider groups', async () => {
    const NO_CAPS = { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false }
    const image = catalogModel({ id: 'painter-1', kind: 'image', capabilities: { ...NO_CAPS, vision: true } })
    const imageChat = catalogModel({ id: 'claude-canvas', capabilities: { ...NO_CAPS, imageOutput: true } })
    const tts = catalogModel({ providerId: 'ollama', id: 'voice-1', kind: 'speech', capabilities: NO_CAPS })
    const onlyImages = catalogModel({ providerId: 'ollama', id: 'pixels', kind: 'image', capabilities: NO_CAPS })
    api.providers.list.mockResolvedValue({ items: [providerSummary(), providerSummary({ id: 'ollama', local: true })] })
    api.models.list.mockResolvedValue({ items: [image, sonnet, imageChat, tts, onlyImages] })
    const models = useModelsStore()
    await Promise.all([useProvidersStore().fetchAll(), models.fetchAll()])
    expect(models.visible.map(model => model.id)).toEqual(['painter-1', 'claude-sonnet-5', 'claude-canvas', 'voice-1', 'pixels'])
    expect(models.groupedByProvider.map(group => [group.provider.id, group.models.map(model => model.id)]))
      .toEqual([['anthropic', ['claude-sonnet-5', 'claude-canvas']]])
  })

  it('never picks an image model as the default: settings, recent and the first visible model skip it', async () => {
    const image = catalogModel({ id: 'painter-1', kind: 'image' })
    const speech = catalogModel({ id: 'voice-1', kind: 'speech' })
    api.providers.list.mockResolvedValue({ items: [providerSummary(), providerSummary({ id: 'ollama', local: true })] })
    api.models.list.mockResolvedValue({ items: [image, speech, sonnet, llama] })
    const models = useModelsStore()
    await Promise.all([useProvidersStore().fetchAll(), models.fetchAll()])
    expect(models.defaultRef).toBe('anthropic:claude-sonnet-5')
    models.touchRecent('anthropic:painter-1')
    expect(models.defaultRef).toBe('anthropic:claude-sonnet-5')
    models.touchRecent('ollama:llama3:8b')
    models.touchRecent('anthropic:painter-1')
    expect(models.defaultRef).toBe('ollama:llama3:8b')
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, defaultModelRef: 'anthropic:painter-1' }
    expect(models.defaultRef).toBe('ollama:llama3:8b')
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, defaultModelRef: 'anthropic:voice-1' }
    expect(models.defaultRef).toBe('ollama:llama3:8b')
    // A default the catalog does not know yet (still loading, or its provider has no key) is kept.
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, defaultModelRef: 'openai:gpt-luna' }
    expect(models.defaultRef).toBe('openai:gpt-luna')
  })

  it('has no default when only image models are visible', async () => {
    api.providers.list.mockResolvedValue({ items: [providerSummary()] })
    api.models.list.mockResolvedValue({ items: [catalogModel({ id: 'painter-1', kind: 'image' })] })
    const models = useModelsStore()
    await Promise.all([useProvidersStore().fetchAll(), models.fetchAll()])
    models.touchRecent('anthropic:painter-1')
    expect(models.defaultRef).toBeNull()
  })

  it('keeps five recent refs, newest first, in localStorage', async () => {
    const models = await loadCatalog()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f'])
      models.touchRecent(`anthropic:${id}`)
    models.touchRecent('anthropic:c')
    models.touchRecent('not a ref')
    expect(models.recentRefs).toEqual(['anthropic:c', 'anthropic:f', 'anthropic:e', 'anthropic:d', 'anthropic:b'])
    await Promise.resolve()
    expect(JSON.parse(storage.getItem(RECENT_MODELS_KEY)!)).toEqual(models.recentRefs)
    models.touchRecent('anthropic:claude-haiku-5')
    expect(models.recent.map(model => model.ref)).toEqual(['anthropic:claude-haiku-5'])
  })

  it('restores recent refs from localStorage and drops invalid ones', () => {
    storage.setItem(RECENT_MODELS_KEY, JSON.stringify(['anthropic:x', 42, 'bad', 'anthropic:x', 'ollama:llama3:8b']))
    const models = useModelsStore()
    expect(models.recentRefs).toEqual(['anthropic:x', 'ollama:llama3:8b'])
  })

  it('sets preferences by providerId + modelId, optimistic for favorite', async () => {
    const models = await loadCatalog()
    api.models.updatePrefs.mockResolvedValue({ ...llama, favorite: true })
    const pending = models.setPref('ollama:llama3:8b', { favorite: true })
    expect(models.byRef('ollama:llama3:8b')?.favorite).toBe(true)
    await pending
    expect(api.models.updatePrefs).toHaveBeenCalledWith({ body: { providerId: 'ollama', modelId: 'llama3:8b', favorite: true } })

    api.models.updatePrefs.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Unknown model' }))
    await expect(models.setPref('anthropic:claude-sonnet-5', { hidden: true })).rejects.toMatchObject({ code: 'not_found' })
    expect(models.byRef('anthropic:claude-sonnet-5')?.hidden).toBe(false)
    await expect(models.setPref('no-colon', { favorite: true })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('refreshes one provider in place and tracks the refresh', async () => {
    const models = await loadCatalog()
    const opus = catalogModel({ id: 'claude-opus-5', name: 'Claude Opus 5', source: 'live' })
    let finish: (value: unknown) => void = () => {}
    api.models.refresh.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const pending = models.refresh('anthropic')
    expect(models.refreshing.anthropic).toBe(true)
    finish({ items: [sonnet, opus] })
    await pending
    expect(models.refreshing.anthropic).toBeUndefined()
    expect(models.items.map(model => model.ref)).toEqual(['anthropic:claude-sonnet-5', 'anthropic:claude-opus-5', 'openai:gpt-luna', 'ollama:llama3:8b'])
  })

  it('adds and removes custom models', async () => {
    const models = await loadCatalog()
    const custom = catalogModel({ providerId: 'ollama', id: 'qwen3:32b', custom: true, source: 'custom' })
    api.models.addCustom.mockResolvedValue(custom)
    api.models.removeCustom.mockResolvedValue(undefined)
    await models.addCustom({ providerId: 'ollama', modelId: 'qwen3:32b' })
    expect(models.byRef('ollama:qwen3:32b')?.custom).toBe(true)
    await models.removeCustom('ollama', 'qwen3:32b')
    expect(api.models.removeCustom).toHaveBeenCalledWith({ query: { providerId: 'ollama', modelId: 'qwen3:32b' } })
    expect(models.byRef('ollama:qwen3:32b')).toBeUndefined()
  })

  it('coalesces catalog events into one refetch, only when loaded', async () => {
    vi.useFakeTimers()
    const models = useModelsStore()
    models.applyEvent({ type: 'catalog.changed', data: { providerId: null }, at: 1 })
    await vi.advanceTimersByTimeAsync(500)
    expect(api.models.list).not.toHaveBeenCalled()

    api.models.list.mockResolvedValue({ items: [sonnet] })
    await models.fetchAll()
    models.applyEvent({ type: 'catalog.changed', data: { providerId: 'anthropic' }, at: 2 })
    models.applyEvent({ type: 'provider.changed', data: { id: 'anthropic', provider: null }, at: 3 })
    models.applyEvent({ type: 'plugin.log', data: { pluginId: 'x', entry: { seq: 1, at: 1, level: 'info', message: 'm' } }, at: 4 })
    await vi.advanceTimersByTimeAsync(500)
    expect(api.models.list).toHaveBeenCalledTimes(2)
  })
})
