import type { ModelInfo, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { ProvidersTestApp, ProvidersTestAppOptions } from '../providers/testing.ts'
import type { ModelCatalogInternals } from './index.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APICallError } from '@ai-sdk/provider'
import { catalogModelSchema, HarnessError } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelCache } from '../db/schema.ts'
import { createProvidersTestApp } from '../providers/testing.ts'
import { bundledSnapshotPath, LISTING_RETRY_MS, LISTING_TTL_MS, MODELS_DEV_MAX_AGE_MS } from './index.ts'
import { MODELS_DEV_URL } from './models-dev.ts'

const T0 = Date.parse('2026-09-28T00:00:00Z')

interface AcmeControl {
  calls: number
  /** The next listing, or an error to throw. */
  listing: ModelInfo[] | Error
}

function acmeProvider(control: AcmeControl, overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'acme',
    name: 'Acme',
    credentials: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'ACME_API_KEY' }],
    modelsDevId: 'acme',
    smallModelId: 'acme-small',
    seedModels: [
      { id: 'acme-large', name: 'Acme Large (seed)', capabilities: { reasoning: true }, reasoningEfforts: ['low', 'high'] },
      { id: 'acme-small', name: 'Acme Small', contextWindow: 16_000 },
    ],
    createLanguageModel: modelId => new MockLanguageModelV4({ provider: 'acme', modelId }),
    listModels: async () => {
      control.calls++
      if (control.listing instanceof Error)
        throw control.listing
      return control.listing
    },
    ...overrides,
  }
}

function unauthorized(): APICallError {
  return new APICallError({ message: 'invalid key', url: 'https://api.acme.test/v1/models', requestBodyValues: {}, statusCode: 401, responseBody: '{"error":{"message":"bad key"}}' })
}

let app: ProvidersTestApp | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await app?.close()
  app = undefined
})

async function setup(options: ProvidersTestAppOptions & { clock?: { now: number } } = {}): Promise<{ t: ProvidersTestApp, control: AcmeControl, catalog: ModelCatalogInternals }> {
  const clock = options.clock ?? { now: T0 }
  const t = await createProvidersTestApp({
    builtins: [],
    ...options,
    catalog: { now: () => clock.now, initialDelayMs: 3_600_000, ...options.catalog },
    providerService: { now: () => clock.now, ...options.providerService },
  })
  app = t
  const control: AcmeControl = { calls: 0, listing: [] }
  t.registry.providers.register('acme-plugin', acmeProvider(control))
  return { t, control, catalog: t.deps.catalog as ModelCatalogInternals }
}

describe('entries and field precedence', () => {
  it('serves the seeds merged with models.dev while there is no listing', async () => {
    const { t } = await setup()
    const models = await t.deps.catalog.list({ providerId: 'acme' })
    expect(models.map(model => [model.id, model.source])).toEqual([['acme-large', 'seed'], ['acme-small', 'seed']])
    for (const model of models)
      catalogModelSchema.parse(model)
    expect(models[0]).toMatchObject({
      ref: 'acme:acme-large',
      name: 'Acme Large (models.dev)',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['auto', 'low', 'high'],
      cost: { input: 3, output: 15, cacheRead: 0.3 },
    })
    expect(models[1]).toMatchObject({ name: 'Acme Small', contextWindow: 16_000, reasoningEfforts: [], cost: null })
  })

  it('uses the live listing as the entry set after a refresh (custom -> live -> models.dev -> seed)', async () => {
    const { t, control } = await setup()
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = [
      { id: 'acme-large', name: 'Acme Large', contextWindow: 150_000 },
      { id: 'acme-embed-1' },
      { id: 'acme-paint' },
      { id: 'acme-vision-image' },
    ]
    t.events.clear()
    const refreshed = await t.deps.catalog.refresh('acme')
    expect(control.calls).toBe(1)
    // acme-paint is an image model (models.dev: image output only) and Acme cannot generate images: left out.
    expect(refreshed.map(model => model.id).sort()).toEqual(['acme-embed-1', 'acme-large', 'acme-vision-image'])
    const large = refreshed.find(model => model.id === 'acme-large')
    expect(large).toMatchObject({ source: 'live', name: 'Acme Large', contextWindow: 150_000, maxOutputTokens: 64_000, reasoningEfforts: ['auto', 'low', 'high'] })
    // classify(): models.dev modalities first, the id pattern for embeddings.
    expect(refreshed.find(model => model.id === 'acme-embed-1')).toMatchObject({ kind: 'embedding', hidden: true })
    expect(refreshed.find(model => model.id === 'acme-vision-image')).toMatchObject({ kind: 'chat', hidden: false, capabilities: { imageOutput: true } })
    expect(await t.deps.catalog.get('acme', 'acme-paint')).toBeNull()
    const visible = await t.deps.catalog.list({ providerId: 'acme' })
    expect(visible.map(model => model.id)).toEqual(['acme-large', 'acme-vision-image'])
    expect((await t.deps.catalog.list({ providerId: 'acme', includeHidden: true })).length).toBe(3)
    expect(t.events.ofType('catalog.changed').map(event => event.data)).toContainEqual({ providerId: 'acme' })
    expect(t.events.ofType('provider.changed').at(-1)?.data).toMatchObject({ id: 'acme', provider: { modelCount: 2, modelsFetchedAt: T0 } })
    expect(await t.deps.catalog.stats('acme')).toEqual({ modelCount: 2, fetchedAt: T0 })
  })

  it('adds plugin models (before seeds in precedence) and custom ids', async () => {
    const { t } = await setup()
    t.registry.models.register('other', 'acme', [
      { id: 'acme-plugin-model', name: 'From plugin' },
      { id: 'acme-small', name: 'Acme Small (plugin metadata)' },
    ])
    await t.deps.catalog.addCustom({ providerId: 'acme', modelId: 'my/custom:1', name: 'Mine', contextWindow: 1000, capabilities: { tools: true } })
    const models = await t.deps.catalog.list({ providerId: 'acme' })
    expect(models.map(model => [model.id, model.source, model.name])).toEqual([
      ['acme-large', 'seed', 'Acme Large (models.dev)'],
      // A seed that a plugin also contributes reports the higher tier.
      ['acme-small', 'plugin', 'Acme Small (plugin metadata)'],
      ['acme-plugin-model', 'plugin', 'From plugin'],
      ['my/custom:1', 'custom', 'Mine'],
    ].sort((a, b) => String(a[2]).localeCompare(String(b[2]), 'en', { numeric: true, sensitivity: 'base' })))
    const custom = await t.deps.catalog.get('acme', 'my/custom:1')
    expect(custom).toMatchObject({ ref: 'acme:my/custom:1', custom: true, kind: 'chat', contextWindow: 1000, capabilities: { tools: true } })
  })

  it('returns null for unknown models and zero stats for unknown providers', async () => {
    const { t } = await setup()
    expect(await t.deps.catalog.get('acme', 'nope')).toBeNull()
    expect(await t.deps.catalog.get('nope', 'x')).toBeNull()
    expect(await t.deps.catalog.stats('nope')).toEqual({ modelCount: 0, fetchedAt: null })
    await expect(t.deps.catalog.list({ providerId: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

function unusedFactory(): never {
  throw new Error('unused')
}

/** Media factories of a provider (never called by the catalog: only their presence matters). */
const MEDIA_FACTORIES = {
  createImageModel: unusedFactory,
  createTranscriptionModel: unusedFactory,
  createSpeechModel: unusedFactory,
} satisfies Partial<ProviderDefinition>

/** Seeds of every kind: one chat model and one explicit seed per media kind. */
const MEDIA_SEEDS: ModelInfo[] = [
  { id: 'studio-chat', name: 'Studio Chat' },
  { id: 'studio-paint', name: 'Studio Paint', kind: 'image', capabilities: { vision: true } },
  { id: 'studio-listen', name: 'Studio Listen', kind: 'transcription' },
  { id: 'studio-say', name: 'Studio Say', kind: 'speech', voices: ['ava', 'ben', 'ava'] },
]

describe('media models (Phase 6)', () => {
  it('lists the media seeds even next to a live listing; image models visible, voice models hidden', async () => {
    const { t } = await setup()
    const studio: AcmeControl = { calls: 0, listing: [{ id: 'studio-chat-2', name: 'Studio Chat 2' }, { id: 'studio-say', name: 'Studio Say (live)' }] }
    t.registry.providers.register('studio-plugin', acmeProvider(studio, { id: 'studio', name: 'Studio', modelsDevId: 'studio', smallModelId: undefined, seedModels: MEDIA_SEEDS, ...MEDIA_FACTORIES }))
    // No listing yet: every seed.
    expect((await t.deps.catalog.list({ providerId: 'studio', includeHidden: true })).map(model => [model.id, model.kind, model.hidden, model.source])).toEqual([
      ['studio-chat', 'chat', false, 'seed'],
      ['studio-listen', 'transcription', true, 'seed'],
      ['studio-paint', 'image', false, 'seed'],
      ['studio-say', 'speech', true, 'seed'],
    ])
    await t.credentials.set('studio', { apiKey: 'studio-key-00000000001' })
    const refreshed = await t.deps.catalog.refresh('studio')
    // With a listing: the listed models plus the media seeds (the chat seed is replaced by the listing).
    expect(refreshed.map(model => [model.id, model.kind, model.hidden, model.source])).toEqual([
      ['studio-chat-2', 'chat', false, 'live'],
      ['studio-listen', 'transcription', true, 'seed'],
      ['studio-paint', 'image', false, 'seed'],
      ['studio-say', 'speech', true, 'live'],
    ])
    for (const model of refreshed)
      catalogModelSchema.parse(model)
    // A listed media model keeps the seed's explicit kind and voices (unique) under the live name.
    expect(refreshed.find(model => model.id === 'studio-say')).toMatchObject({ name: 'Studio Say (live)', voices: ['ava', 'ben'] })
    expect(refreshed.find(model => model.id === 'studio-paint')).toMatchObject({ capabilities: { vision: true, imageOutput: false } })
    // The chat picker list: chat models and the image model; the model count counts visible chat models only.
    expect((await t.deps.catalog.list({ providerId: 'studio' })).map(model => model.id)).toEqual(['studio-chat-2', 'studio-paint'])
    expect(await t.deps.catalog.stats('studio')).toEqual({ modelCount: 1, fetchedAt: T0 })
    expect((await t.deps.providers.get('studio')).modelCount).toBe(1)
  })

  it('leaves out media models of a kind the provider cannot serve; custom models stay (hidden)', async () => {
    const { t } = await setup()
    const bare: AcmeControl = {
      calls: 0,
      listing: [
        { id: 'bare-chat' },
        { id: 'gpt-image-1' }, // image by the id pattern
        { id: 'bare-whisper' }, // transcription by the id
        { id: 'bare-tts' }, // speech by the id
        { id: 'bare-listed-say', kind: 'speech', voices: ['x'] },
      ],
    }
    // Only an image factory: image models are listed, voice models are not.
    t.registry.providers.register('bare-plugin', acmeProvider(bare, { id: 'bare', name: 'Bare', modelsDevId: 'bare', seedModels: MEDIA_SEEDS, createImageModel: unusedFactory }))
    t.registry.models.register('other-plugin', 'bare', [{ id: 'bare-plugin-listen', kind: 'transcription' }, { id: 'bare-plugin-chat' }])
    await t.credentials.set('bare', { apiKey: 'bare-key-000000000001' })
    const refreshed = await t.deps.catalog.refresh('bare')
    expect(refreshed.map(model => [model.id, model.kind, model.hidden])).toEqual([
      ['bare-chat', 'chat', false],
      ['bare-plugin-chat', 'chat', false],
      ['gpt-image-1', 'image', false],
      ['studio-paint', 'image', false],
    ])
    for (const id of ['bare-whisper', 'bare-tts', 'bare-listed-say', 'studio-listen', 'studio-say', 'bare-plugin-listen'])
      expect(await t.deps.catalog.get('bare', id), id).toBeNull()
    await expect(t.deps.catalog.updatePrefs({ providerId: 'bare', modelId: 'studio-say', favorite: true })).rejects.toMatchObject({ code: 'not_found' })

    // A provider without any factory: its image models are left out too.
    t.registry.providers.register('plain-plugin', acmeProvider({ calls: 0, listing: [] }, { id: 'plain', name: 'Plain', modelsDevId: 'plain', seedModels: MEDIA_SEEDS }))
    expect((await t.deps.catalog.list({ providerId: 'plain', includeHidden: true })).map(model => model.id)).toEqual(['studio-chat'])

    // Custom models of any kind stay listed: the resolvers explain why they cannot be served.
    await t.deps.catalog.addCustom({ providerId: 'plain', modelId: 'plain-paint', kind: 'image' })
    await t.deps.catalog.addCustom({ providerId: 'plain', modelId: 'plain-listen', kind: 'transcription' })
    expect(await t.deps.catalog.get('plain', 'plain-paint')).toMatchObject({ kind: 'image', custom: true, hidden: true })
    expect(await t.deps.catalog.get('plain', 'plain-listen')).toMatchObject({ kind: 'transcription', custom: true, hidden: true })
    expect((await t.deps.catalog.list({ providerId: 'plain' })).map(model => model.id)).toEqual(['studio-chat'])
  })

  it('lets an explicit kind win over classify() and passes voices and imageOutput of a listing through', async () => {
    const { t, control } = await setup()
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = [
      { id: 'acme-image-chat', kind: 'chat', capabilities: { imageOutput: true } },
      { id: 'acme-paint', kind: 'chat' }, // models.dev says image output only; the listing says chat
      { id: 'acme-vision-image', capabilities: { imageOutput: false } }, // the listing wins over models.dev
      { id: 'acme-say', voices: ['one', 'two'] }, // chat by default (no kind): voices are passed through anyway
    ]
    const refreshed = await t.deps.catalog.refresh('acme')
    const byId = new Map(refreshed.map(model => [model.id, model]))
    expect(byId.get('acme-image-chat')).toMatchObject({ kind: 'chat', hidden: false, capabilities: { imageOutput: true } })
    expect(byId.get('acme-paint')).toMatchObject({ kind: 'chat', hidden: false, capabilities: { imageOutput: false } })
    expect(byId.get('acme-vision-image')).toMatchObject({ kind: 'chat', capabilities: { imageOutput: false } })
    expect(byId.get('acme-say')).toMatchObject({ kind: 'chat', voices: ['one', 'two'] })
  })

  it('classifies the models of the bundled models.dev snapshot (image id pattern, image output, voice kinds)', async () => {
    const { t } = await setup({ catalog: { bundledSnapshotPath: bundledSnapshotPath() } })
    const register = (id: string, modelsDevId: string, models: string[], factories: Partial<ProviderDefinition>): void => {
      t.registry.providers.register(`${id}-plugin`, acmeProvider({ calls: 0, listing: [] }, {
        id,
        name: id,
        modelsDevId,
        credentials: [],
        smallModelId: undefined,
        listModels: undefined,
        seedModels: models.map(model => ({ id: model })),
        ...factories,
      }))
    }
    register('pics', 'openai', ['gpt-image-1-mini', 'gpt-image-1.5', 'chatgpt-image-latest'], { createImageModel: unusedFactory })
    register('gem', 'google', ['gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts'], { createSpeechModel: unusedFactory })
    register('fast', 'groq', ['whisper-large-v3'], { createTranscriptionModel: unusedFactory })
    const kinds = async (providerId: string): Promise<unknown[]> => (await t.deps.catalog.list({ providerId, includeHidden: true }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(model => [model.id, model.kind, model.capabilities.imageOutput, model.hidden])
    // models.dev lists these three with a [text, image] output: the id pattern still makes them image models.
    expect(await kinds('pics')).toEqual([
      ['chatgpt-image-latest', 'image', false, false],
      ['gpt-image-1-mini', 'image', false, false],
      ['gpt-image-1.5', 'image', false, false],
    ])
    expect(await kinds('gem')).toEqual([
      ['gemini-2.5-flash-image', 'chat', true, false],
      ['gemini-2.5-flash-preview-tts', 'speech', false, true],
    ])
    expect(await kinds('fast')).toEqual([['whisper-large-v3', 'transcription', false, true]])
  })

  it('shows the mock image model in the picker and keeps the voice models for Settings -> Media', async () => {
    const t = await createProvidersTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    app = t
    const visible = await t.deps.catalog.list({ providerId: 'mock' })
    expect(visible.map(model => model.id)).toEqual(['checkpoint', 'compact', 'echo', 'error', 'image', 'image-chat', 'image-tool', 'plan', 'reasoning', 'shell', 'steer', 'subagent', 'todo', 'tool-approval', 'workspace'])
    const all = await t.deps.catalog.list({ providerId: 'mock', includeHidden: true })
    expect(all.filter(model => model.hidden).map(model => [model.id, model.kind])).toEqual([['speech', 'speech'], ['transcribe', 'transcription']])
    expect(all.find(model => model.id === 'speech')?.voices).toEqual(['mock-voice-a', 'mock-voice-b'])
    expect(all.find(model => model.id === 'image-chat')).toMatchObject({ kind: 'chat', capabilities: { imageOutput: true } })
    expect(await t.deps.catalog.stats('mock')).toMatchObject({ modelCount: 14 })
  })
})

describe('live listings', () => {
  it('keeps the last good listing on failure and records the error', async () => {
    const { t, control } = await setup()
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = [{ id: 'acme-large' }, { id: 'acme-new' }]
    await t.deps.catalog.refresh('acme')
    control.listing = unauthorized()
    const error = await t.deps.catalog.refresh('acme').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'auth_invalid', providerId: 'acme', status: 401 })
    // GET /models keeps working with the cached listing.
    expect((await t.deps.catalog.list({ providerId: 'acme' })).map(model => model.id)).toEqual(['acme-large', 'acme-new'])
    const [row] = await t.db.select().from(modelCache).where(eq(modelCache.providerId, 'acme'))
    expect(row).toMatchObject({ fetchedAt: T0, error: { code: 'auth_invalid' } })
    const summary = await t.deps.providers.get('acme')
    expect(summary).toMatchObject({ status: 'error', lastError: { code: 'auth_invalid' } })
    expect(t.plugins.logEntries.at(-1)).toMatchObject({ pluginId: 'acme-plugin', level: 'warn' })
    // The next good listing clears the listing error.
    control.listing = [{ id: 'acme-large' }]
    await t.deps.catalog.refresh('acme')
    expect(await t.deps.providers.get('acme')).toMatchObject({ status: 'connected', lastError: null })
  })

  it('falls back to the seeds when the first listing fails', async () => {
    const { t, control } = await setup()
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    await expect(t.deps.catalog.refresh('acme')).rejects.toMatchObject({ code: 'provider_unreachable' })
    expect((await t.deps.catalog.list({ providerId: 'acme' })).map(model => model.source)).toEqual(['seed', 'seed'])
  })

  it('drops invalid models of a listing', async () => {
    const { t, control } = await setup()
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = [{ id: 'ok' }, { id: '' }, { name: 'no id' }, { id: 'ok' }, { id: 'priced', cost: { input: -1 } }] as ModelInfo[]
    const models = await t.deps.catalog.refresh('acme')
    expect(models.map(model => model.id)).toEqual(['ok', 'priced'])
    expect(models[1]?.cost).toBeNull()
  })

  it('requires an enabled, configured, known provider', async () => {
    const { t } = await setup()
    await expect(t.deps.catalog.refresh('acme')).rejects.toMatchObject({ code: 'provider_not_configured', action: 'configure-provider' })
    await expect(t.deps.catalog.refresh('nope')).rejects.toMatchObject({ code: 'not_found' })
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    await t.deps.providers.setEnabled('acme', false)
    await expect(t.deps.catalog.refresh('acme')).rejects.toMatchObject({ code: 'provider_not_configured' })
    expect(await t.deps.catalog.list()).toEqual([])
    expect(await t.deps.catalog.list({ providerId: 'acme' })).toEqual([])
  })

  it('shares a running listing between concurrent refreshes', async () => {
    const { t, control } = await setup()
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = [{ id: 'acme-large' }]
    await Promise.all([t.deps.catalog.refresh('acme'), t.deps.catalog.refresh('acme')])
    expect(control.calls).toBe(1)
  })
})

describe('background refresh (fake clock)', () => {
  it('refreshes stale listings after 24 h and backs off after a failure', async () => {
    const clock = { now: T0 }
    const { t, control, catalog } = await setup({ clock, catalog: { background: true } })
    control.listing = [{ id: 'acme-large' }]
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(0) // not configured yet
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(1)
    clock.now = T0 + LISTING_TTL_MS - 1
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(1)
    clock.now = T0 + LISTING_TTL_MS
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(2)
    const failedAt = T0 + 3 * LISTING_TTL_MS
    clock.now = failedAt
    control.listing = unauthorized()
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(3)
    expect((await t.deps.catalog.list({ providerId: 'acme' })).map(model => model.source)).toEqual(['live'])
    clock.now = failedAt + LISTING_RETRY_MS - 1
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(3)
    clock.now = failedAt + LISTING_RETRY_MS
    control.listing = [{ id: 'acme-large' }, { id: 'acme-new' }]
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(4)
    expect(await t.deps.catalog.stats('acme')).toEqual({ modelCount: 2, fetchedAt: failedAt + LISTING_RETRY_MS })
  })

  it('refreshes in the next cycle when the credentials change, even when the listing is fresh', async () => {
    const { t, control, catalog } = await setup({ catalog: { background: true } })
    control.listing = [{ id: 'acme-large' }]
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    await catalog.runBackgroundCycle()
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(1)
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000002' })
    await catalog.runBackgroundCycle()
    expect(control.calls).toBe(2)
  })

  it('checks a newly registered provider after start', async () => {
    const { t, catalog } = await setup({ catalog: { background: true } })
    await catalog.start()
    const late: AcmeControl = { calls: 0, listing: [{ id: 'late-1' }] }
    t.registry.providers.register('late-plugin', acmeProvider(late, { id: 'late', modelsDevId: 'late', credentials: [] }))
    await vi.waitFor(() => expect(late.calls).toBe(1), { timeout: 2000 })
    await vi.waitFor(async () => expect((await t.deps.catalog.list({ providerId: 'late' })).map(model => model.id)).toEqual(['late-1']))
  })

  it('does not flag a provider configured only by defaults when a background listing fails', async () => {
    const { t, catalog } = await setup({ catalog: { background: true } })
    const local: AcmeControl = { calls: 0, listing: new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }) }
    t.registry.providers.register('local-plugin', acmeProvider(local, {
      id: 'local',
      modelsDevId: 'local',
      credentials: [{ key: 'baseURL', label: 'Base URL', type: 'url', required: true, default: 'http://localhost:1234/v1' }],
    }))
    await catalog.runBackgroundCycle()
    expect(local.calls).toBe(1)
    expect(await t.deps.providers.get('local')).toMatchObject({ status: 'connected', lastError: null })
    // An explicit refresh reports the failure.
    await expect(t.deps.catalog.refresh('local')).rejects.toMatchObject({ code: 'provider_unreachable' })
    expect(await t.deps.providers.get('local')).toMatchObject({ status: 'error', lastError: { code: 'provider_unreachable' } })
  })

  it('reuses a listing made seconds ago with the same credentials for a forced refresh', async () => {
    const clock = { now: T0 }
    const { t, control } = await setup({ clock, catalog: { refreshDedupeMs: 3000 } })
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
    control.listing = [{ id: 'acme-large' }]
    await t.deps.catalog.refresh('acme')
    clock.now = T0 + 2999
    await t.deps.catalog.refresh('acme')
    expect(control.calls).toBe(1)
    clock.now = T0 + 3000
    await t.deps.catalog.refresh('acme')
    expect(control.calls).toBe(2)
    await t.credentials.set('acme', { apiKey: 'acme-key-000000000002' })
    await t.deps.catalog.refresh('acme')
    expect(control.calls).toBe(3)
  })
})

describe('models.dev', () => {
  const RAW = {
    acme: { models: { 'acme-large': { name: 'Acme Large (refreshed)', limit: { context: 300000, output: 1000 }, modalities: { input: ['text'], output: ['text'] } } } },
    other: { models: { 'x-1': { name: 'X' } } },
  }

  function fakeModelsDev(): { fetch: typeof globalThis.fetch, calls: string[] } {
    const calls: string[] = []
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input))
      return Response.json(RAW)
    }
    return { fetch, calls }
  }

  it('refreshes a snapshot older than a week into data/cache and announces it', async () => {
    const { fetch, calls } = fakeModelsDev()
    const fixtureFetchedAt = 1_790_000_000_000
    const clock = { now: fixtureFetchedAt + MODELS_DEV_MAX_AGE_MS - 1 }
    const { t, catalog } = await setup({ clock, catalog: { background: true, fetch } })
    await catalog.runBackgroundCycle()
    expect(calls).toEqual([])
    clock.now = fixtureFetchedAt + MODELS_DEV_MAX_AGE_MS
    t.events.clear()
    await catalog.runBackgroundCycle()
    expect(calls).toEqual([MODELS_DEV_URL])
    const snapshot = await catalog.modelsDevSnapshot()
    expect(snapshot).toMatchObject({ complete: true, fetchedAt: clock.now })
    expect(Object.keys(snapshot?.providers ?? {})).toEqual(['acme', 'other'])
    const cacheFile = join(t.env.paths.cache, 'models-dev.json')
    expect(existsSync(cacheFile)).toBe(true)
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ schemaVersion: 1, complete: true })
    expect(t.events.ofType('catalog.changed').map(event => event.data)).toContainEqual({ providerId: null })
    expect(await t.deps.catalog.get('acme', 'acme-large')).toMatchObject({ name: 'Acme Large (refreshed)', contextWindow: 300_000 })
  })

  it('refreshes early for a plugin provider that the bundled snapshot does not know', async () => {
    const { fetch, calls } = fakeModelsDev()
    const { t, catalog } = await setup({ clock: { now: 1_790_000_000_000 }, catalog: { background: true, fetch } })
    await catalog.runBackgroundCycle()
    expect(calls).toEqual([]) // acme is known
    t.registry.providers.register('together-plugin', acmeProvider({ calls: 0, listing: [] }, { id: 'together-plugin', modelsDevId: 'togetherai' }))
    await catalog.runBackgroundCycle()
    expect(calls).toEqual([MODELS_DEV_URL])
  })

  it('never fetches with HF_OFFLINE=1', async () => {
    const { fetch, calls } = fakeModelsDev()
    const { catalog } = await setup({ env: { HF_OFFLINE: '1' }, clock: { now: T0 + 365 * 24 * 3_600_000 }, catalog: { background: true, fetch } })
    await catalog.runBackgroundCycle()
    expect(calls).toEqual([])
  })

  it('prefers a newer cached snapshot over the bundled one at start', async () => {
    const { fetch } = fakeModelsDev()
    const clock = { now: 1_790_000_000_000 + MODELS_DEV_MAX_AGE_MS }
    const first = await setup({ clock, catalog: { background: true, fetch } })
    await first.catalog.runBackgroundCycle()
    const dataDir = first.t.env.dataDir
    const second = await createProvidersTestApp({ builtins: [], dataDir, catalog: { now: () => clock.now } })
    try {
      const snapshot = await (second.deps.catalog as ModelCatalogInternals).modelsDevSnapshot()
      expect(snapshot?.complete).toBe(true)
      expect(Object.keys(snapshot?.providers ?? {})).toEqual(['acme', 'other'])
    }
    finally {
      await second.close()
    }
  })
})

describe('prefs and custom models', () => {
  it('stores favorite, alias and hidden (null restores the default)', async () => {
    const { t } = await setup()
    t.events.clear()
    const favorite = await t.deps.catalog.updatePrefs({ providerId: 'acme', modelId: 'acme-small', favorite: true, alias: 'Tiny' })
    expect(favorite).toMatchObject({ favorite: true, alias: 'Tiny', name: 'Tiny', hidden: false })
    expect(t.events.ofType('catalog.changed').map(event => event.data)).toEqual([{ providerId: 'acme' }])
    expect((await t.deps.catalog.updatePrefs({ providerId: 'acme', modelId: 'acme-small', hidden: true })).hidden).toBe(true)
    expect((await t.deps.catalog.list({ providerId: 'acme' })).map(model => model.id)).toEqual(['acme-large'])
    const restored = await t.deps.catalog.updatePrefs({ providerId: 'acme', modelId: 'acme-small', hidden: null, alias: null })
    expect(restored).toMatchObject({ hidden: false, alias: null, name: 'Acme Small', favorite: true })
  })

  it('rejects prefs of unknown providers and models', async () => {
    const { t } = await setup()
    await expect(t.deps.catalog.updatePrefs({ providerId: 'nope', modelId: 'x', favorite: true })).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.catalog.updatePrefs({ providerId: 'acme', modelId: 'nope', favorite: true })).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.catalog.addCustom({ providerId: 'nope', modelId: 'x' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('adds, replaces and removes custom models', async () => {
    const { t } = await setup()
    await t.deps.catalog.addCustom({ providerId: 'acme', modelId: 'text-embedding-custom' })
    expect(await t.deps.catalog.get('acme', 'text-embedding-custom')).toMatchObject({ kind: 'chat', hidden: false, source: 'custom' })
    const replaced = await t.deps.catalog.addCustom({ providerId: 'acme', modelId: 'text-embedding-custom', kind: 'embedding', name: 'Embedder' })
    expect(replaced).toMatchObject({ kind: 'embedding', hidden: true, name: 'Embedder' })
    await t.deps.catalog.updatePrefs({ providerId: 'acme', modelId: 'text-embedding-custom', favorite: true })
    await t.deps.catalog.removeCustom({ providerId: 'acme', modelId: 'text-embedding-custom' })
    expect(await t.deps.catalog.get('acme', 'text-embedding-custom')).toBeNull()
    await expect(t.deps.catalog.removeCustom({ providerId: 'acme', modelId: 'text-embedding-custom' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.catalog.removeCustom({ providerId: 'acme', modelId: 'acme-large' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('orders favorites, then recent, then provider order and name', async () => {
    const { t } = await setup()
    t.registry.providers.register('beta-plugin', acmeProvider({ calls: 0, listing: [] }, {
      id: 'beta',
      name: 'Beta',
      modelsDevId: 'beta',
      seedModels: [{ id: 'b-2', name: 'B 10' }, { id: 'b-1', name: 'B 9' }],
    }))
    expect((await t.deps.catalog.list()).map(model => model.ref)).toEqual(['acme:acme-large', 'acme:acme-small', 'beta:b-1', 'beta:b-2'])
    await t.deps.catalog.markUsed('beta', 'b-2', 100)
    await t.deps.catalog.markUsed('acme', 'acme-small', 200)
    await t.deps.catalog.updatePrefs({ providerId: 'beta', modelId: 'b-1', favorite: true })
    const models = await t.deps.catalog.list()
    expect(models.map(model => model.ref)).toEqual(['beta:b-1', 'acme:acme-small', 'beta:b-2', 'acme:acme-large'])
    expect(models[1]?.lastUsedAt).toBe(200)
  })
})

describe('lifecycle', () => {
  it('starts and stops even when the registry and the event bus fail', async () => {
    const failing = new Proxy({}, {
      get: () => {
        throw new Error('registry down')
      },
    })
    const t = await createProvidersTestApp({ builtins: [], overrides: { registry: failing as never }, catalog: { background: true } })
    app = t
    await expect(t.deps.catalog.start()).resolves.toBeUndefined()
    await expect(t.deps.catalog.stop()).resolves.toBeUndefined()
  })

  it('persists the listing and prefs across apps sharing one database file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hf-catalog-'))
    const databasePath = join(dataDir, 'harness.db')
    try {
      const first = await setup({ dataDir, databasePath })
      await first.t.credentials.set('acme', { apiKey: 'acme-key-000000000001' })
      first.control.listing = [{ id: 'acme-live' }]
      await first.t.deps.catalog.refresh('acme')
      await first.t.deps.catalog.addCustom({ providerId: 'acme', modelId: 'kept' })
      await first.t.deps.catalog.updatePrefs({ providerId: 'acme', modelId: 'acme-live', favorite: true })
      await first.t.close()
      app = undefined

      const second = await setup({ dataDir, databasePath })
      const models = await second.t.deps.catalog.list({ providerId: 'acme' })
      expect(models.map(model => [model.id, model.source, model.favorite])).toEqual([['acme-live', 'live', true], ['kept', 'custom', false]])
      expect(second.control.calls).toBe(0)
      expect(await second.t.deps.catalog.stats('acme')).toEqual({ modelCount: 2, fetchedAt: T0 })
    }
    finally {
      await app?.close()
      app = undefined
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
