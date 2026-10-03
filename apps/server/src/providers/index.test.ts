import type { ProviderDefinition, ProviderRuntime } from '@harness-forge/plugin-sdk'
import type { ProvidersTestApp, ProvidersTestAppOptions } from './testing.ts'
import { APICallError } from '@ai-sdk/provider'
import { BUILTIN_PROVIDER_IDS, HarnessError, providerSummarySchema, providerTestResultSchema } from '@harness-forge/shared'
import { generateImage, generateSpeech, transcribe } from 'ai'
import { MockImageModelV4, MockLanguageModelV4, MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOCK_TRANSCRIPT } from '../builtin-plugins/mock/index.ts'
import { providerConfigs } from '../db/schema.ts'
import { isLocalProvider, MODEL_FACTORY_TIMEOUT_MS, providerStatus } from './index.ts'
import { createProvidersTestApp } from './testing.ts'

const KEY = 'sk-ant-test-key-0123456789abcdef'

let app: ProvidersTestApp | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await app?.close()
  app = undefined
})

async function setup(options: ProvidersTestAppOptions = {}): Promise<ProvidersTestApp> {
  app = await createProvidersTestApp(options)
  return app
}

/** A provider with an optional custom behavior; its model answers "pong". */
function testProvider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'acme',
    name: 'Acme',
    credentials: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'ACME_API_KEY' },
      { key: 'baseURL', label: 'Base URL', type: 'url', default: 'https://api.acme.test/v1', advanced: true },
    ],
    smallModelId: 'acme-small',
    seedModels: [{ id: 'acme-small' }],
    createLanguageModel: modelId => new MockLanguageModelV4({
      provider: 'acme',
      modelId,
      doGenerate: {
        content: [{ type: 'text', text: 'pong' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      },
    }),
    ...overrides,
  }
}

/** Seeds of every kind (one chat model, one explicit seed per media kind) under `<prefix>-...` ids. */
function mediaSeeds(prefix: string): NonNullable<ProviderDefinition['seedModels']> {
  return [
    { id: `${prefix}-chat` },
    { id: `${prefix}-paint`, kind: 'image', capabilities: { vision: true } },
    { id: `${prefix}-listen`, kind: 'transcription' },
    { id: `${prefix}-say`, kind: 'speech', voices: ['ava', 'ben'] },
  ]
}

/** A provider with media seeds and factories built on the `ai/test` mocks. */
function mediaProvider(id: string, overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return testProvider({
    id,
    name: `Provider ${id}`,
    smallModelId: `${id}-chat`,
    seedModels: mediaSeeds(id),
    createImageModel: modelId => new MockImageModelV4({ provider: id, modelId }),
    createTranscriptionModel: modelId => new MockTranscriptionModelV4({ provider: id, modelId }),
    createSpeechModel: modelId => new MockSpeechModelV4({ provider: id, modelId }),
    ...overrides,
  })
}

function http401(): APICallError {
  return new APICallError({ message: 'unauthorized', url: 'https://api.acme.test/v1/models', requestBodyValues: {}, statusCode: 401 })
}

describe('provider list', () => {
  it('lists the 13 builtin providers in registry order with valid summaries', async () => {
    const t = await setup()
    const providers = await t.deps.providers.list()
    expect(providers.map(provider => provider.id)).toEqual([...BUILTIN_PROVIDER_IDS])
    for (const provider of providers)
      providerSummarySchema.parse(provider)
    expect(providers.every(provider => provider.pluginId === 'core-providers' && provider.enabled)).toBe(true)
  })

  it('adds the mock provider with HF_MOCK_PROVIDER=1', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1' } })
    const providers = await t.deps.providers.list()
    expect(providers.map(provider => provider.id)).toEqual([...BUILTIN_PROVIDER_IDS, 'mock'])
    // Visible chat models: the four of v1 plus image-chat, image-tool and workspace (Phase 7) (mock:image is visible but
    // not a chat model; the transcription and speech models are hidden).
    expect(providers.at(-1)).toMatchObject({ id: 'mock', pluginId: 'mock', status: 'connected', local: true, icon: null, modelCount: 7, credentials: {} })
  })

  it('reports statuses: not_configured, env, stored (connected), local and error', async () => {
    const t = await setup({ env: { ANTHROPIC_API_KEY: KEY } })
    const byId = async (id: string) => t.deps.providers.get(id)
    expect(await byId('openai')).toMatchObject({ status: 'not_configured', local: false, credentials: { apiKey: { set: false, hint: null, source: null } } })
    expect(await byId('anthropic')).toMatchObject({ status: 'env', credentials: { apiKey: { set: true, source: 'env' } } })
    expect(await byId('ollama')).toMatchObject({ status: 'connected', local: true, credentials: { baseURL: { value: 'http://localhost:11434/v1' } } })
    await t.credentials.set('openai', { apiKey: 'sk-openai-test-000000000000' })
    expect(await byId('openai')).toMatchObject({ status: 'connected', credentials: { apiKey: { set: true, source: 'stored', hint: 'sk-…0000' } } })
    await t.deps.providers.recordOutcome('openai', { ok: false, error: { code: 'auth_invalid', message: 'bad key', providerId: 'openai' } })
    expect(await byId('openai')).toMatchObject({ status: 'error', lastError: { code: 'auth_invalid' } })
  })

  it('never exposes a stored key', async () => {
    const t = await setup()
    await t.credentials.set('deepseek', { apiKey: KEY })
    const text = JSON.stringify(await t.deps.providers.list())
    expect(text).not.toContain(KEY)
    expect(text).toContain('sk-…cdef')
  })

  it('resolves icon URLs from the LobeHub package', async () => {
    const t = await setup()
    const version = t.deps.icons.version
    const icon = async (id: string) => (await t.deps.providers.get(id)).icon
    expect(await icon('anthropic')).toEqual({ color: `/api/icons/lobe/claude-color?v=${version}`, mono: `/api/icons/lobe/claude?v=${version}` })
    expect(await icon('openai')).toEqual({ mono: `/api/icons/lobe/openai?v=${version}` })
    expect(await icon('zai')).toEqual({ color: `/api/icons/lobe/zhipu-color?v=${version}`, mono: `/api/icons/lobe/zai?v=${version}` })
  })

  it('computes statuses and locality from the rules', () => {
    const definition = testProvider()
    const resolved = { values: { apiKey: 'k' }, sources: { apiKey: 'env' as const }, missing: [] }
    expect(isLocalProvider(definition)).toBe(false)
    expect(isLocalProvider({ ...definition, credentials: [] })).toBe(true)
    expect(providerStatus(definition, null, null)).toBe('not_configured')
    expect(providerStatus(definition, resolved, null)).toBe('env')
    expect(providerStatus(definition, resolved, { code: 'rate_limited', message: 'x' })).toBe('env')
    expect(providerStatus(definition, resolved, { code: 'provider_unreachable', message: 'x' })).toBe('error')
    expect(providerStatus({ ...definition, credentials: [] }, { values: {}, sources: {}, missing: [] }, null)).toBe('connected')
  })
})

describe('enable / disable', () => {
  it('persists the flag, emits events and hides the models', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1' } })
    expect(await t.deps.providers.isEnabled('mock')).toBe(true)
    t.events.clear()
    const summary = await t.deps.providers.setEnabled('mock', false)
    expect(summary.enabled).toBe(false)
    expect(t.events.ofType('provider.changed').map(event => event.data.id)).toEqual(['mock'])
    expect(t.events.ofType('catalog.changed').map(event => event.data)).toEqual([{ providerId: 'mock' }])
    expect(await t.deps.providers.isEnabled('mock')).toBe(false)
    expect((await t.deps.catalog.list()).some(model => model.providerId === 'mock')).toBe(false)
    const [row] = await t.db.select().from(providerConfigs).where(eq(providerConfigs.providerId, 'mock'))
    expect(row?.enabled).toBe(false)
    expect(await t.deps.providers.isEnabled('nope')).toBe(false)
    await expect(t.deps.providers.setEnabled('nope', true)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('resolveModel', () => {
  it('resolves a mock model with its catalog entry', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1' } })
    const resolved = await t.deps.providers.resolveModel('mock:echo')
    expect(resolved).toMatchObject({ modelRef: 'mock:echo', providerId: 'mock', modelId: 'echo', provider: { pluginId: 'mock' } })
    expect(resolved.model).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'echo' })
    expect(resolved.entry).toMatchObject({ ref: 'mock:echo', contextWindow: 32_000 })
    expect(resolved.info).toMatchObject({ id: 'echo', capabilities: { vision: true }, reasoningEfforts: [] })
    const reasoning = await t.deps.providers.resolveModel('mock:reasoning')
    expect(reasoning.info.reasoningEfforts).toEqual(['off', 'low', 'medium', 'high', 'max'])
  })

  it('splits the ref on the first colon', async () => {
    const t = await setup()
    await t.deps.catalog.addCustom({ providerId: 'ollama', modelId: 'llama3:8b' })
    const resolved = await t.deps.providers.resolveModel('ollama:llama3:8b')
    expect(resolved).toMatchObject({ providerId: 'ollama', modelId: 'llama3:8b', modelRef: 'ollama:llama3:8b' })
    expect(resolved.model).toMatchObject({ modelId: 'llama3:8b' })
  })

  it('fails before any network call without credentials', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const t = await setup()
    const error = await t.deps.providers.resolveModel('anthropic:claude-haiku-4-5').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'provider_not_configured', action: 'configure-provider', providerId: 'anthropic' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps unknown providers, invalid refs, disabled providers and unknown models', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1', ANTHROPIC_API_KEY: KEY } })
    await expect(t.deps.providers.resolveModel('nocolon')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.providers.resolveModel('nope:model')).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.providers.resolveModel('mock:nope')).rejects.toMatchObject({ code: 'model_not_found', action: 'refresh-models' })
    await t.deps.providers.setEnabled('mock', false)
    await expect(t.deps.providers.resolveModel('mock:echo')).rejects.toMatchObject({ code: 'provider_not_configured' })
    const anthropic = await t.deps.providers.resolveModel('anthropic:claude-haiku-4-5')
    expect(anthropic.model).toMatchObject({ modelId: 'claude-haiku-4-5' })
    expect(anthropic.entry).toMatchObject({ name: 'Claude Haiku 4.5 (latest)', source: 'seed' })
  })

  it('reports createLanguageModel failures as plugin errors', async () => {
    const t = await setup({ builtins: [] })
    t.registry.providers.register('acme-plugin', testProvider({
      createLanguageModel: () => {
        throw new Error('boom')
      },
    }))
    t.registry.providers.register('other-plugin', testProvider({ id: 'other', createLanguageModel: () => 'a-string' as never }))
    await t.credentials.set('acme', { apiKey: 'acme-key' })
    await t.credentials.set('other', { apiKey: 'acme-key' })
    await expect(t.deps.providers.resolveModel('acme:acme-small')).rejects.toMatchObject({ code: 'plugin_error', details: { pluginId: 'acme-plugin' } })
    await expect(t.deps.providers.resolveModel('other:acme-small')).rejects.toMatchObject({ code: 'plugin_error', details: { pluginId: 'other-plugin' } })
    expect(t.plugins.logEntries.map(entry => entry.pluginId)).toEqual(['acme-plugin', 'other-plugin'])
  })

  it('hands resolved credentials and the host fetch to the provider runtime', async () => {
    const t = await setup({ builtins: [], env: { ACME_API_KEY: 'acme-env-key' } })
    t.registry.providers.register('acme-plugin', testProvider())
    const rt = await t.deps.providers.runtime('acme')
    expect(rt.credentials).toEqual({ apiKey: 'acme-env-key', baseURL: 'https://api.acme.test/v1' })
    expect(typeof rt.fetch).toBe('function')
    await expect(t.deps.providers.runtime('nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('media resolvers (Phase 6)', () => {
  it('resolves image, transcription and speech models with their catalog entry, credentials and the run signal', async () => {
    const t = await setup({ builtins: [] })
    const runtimes: ProviderRuntime[] = []
    t.registry.providers.register('studio-plugin', mediaProvider('studio', {
      createImageModel: (modelId, rt) => {
        runtimes.push(rt)
        return new MockImageModelV4({ provider: 'studio', modelId })
      },
    }))
    await t.credentials.set('studio', { apiKey: 'studio-key' })
    const controller = new AbortController()
    const image = await t.deps.providers.resolveImageModel('studio:studio-paint', { signal: controller.signal })
    expect(image).toMatchObject({
      modelRef: 'studio:studio-paint',
      providerId: 'studio',
      modelId: 'studio-paint',
      entry: { ref: 'studio:studio-paint', kind: 'image', hidden: false },
      info: { id: 'studio-paint', kind: 'image', capabilities: { vision: true, imageOutput: false } },
      provider: { pluginId: 'studio-plugin' },
    })
    expect(image.imageModel).toMatchObject({ specificationVersion: 'v4', provider: 'studio', modelId: 'studio-paint' })
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0]?.credentials).toMatchObject({ apiKey: 'studio-key' })
    expect(runtimes[0]?.signal).toBe(controller.signal)

    const transcription = await t.deps.providers.resolveTranscriptionModel('studio:studio-listen')
    expect(transcription).toMatchObject({ modelRef: 'studio:studio-listen', entry: { kind: 'transcription', hidden: true }, model: { modelId: 'studio-listen' } })
    const speech = await t.deps.providers.resolveSpeechModel('studio:studio-say')
    expect(speech).toMatchObject({ modelRef: 'studio:studio-say', entry: { kind: 'speech', voices: ['ava', 'ben'] }, info: { voices: ['ava', 'ben'] }, model: { modelId: 'studio-say' } })
  })

  it('answers the resolver error table', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const t = await setup({ builtins: [], providerService: { factoryTimeoutMs: 30 } })
    t.registry.providers.register('studio-plugin', mediaProvider('studio'))
    // No media factory: its media seeds are left out of the catalog; custom media models stay listed.
    t.registry.providers.register('bare-plugin', testProvider({ id: 'bare', name: 'Bare', smallModelId: 'bare-chat', seedModels: mediaSeeds('bare') }))
    t.registry.providers.register('broken-plugin', mediaProvider('broken', {
      createImageModel: () => {
        throw new Error('boom')
      },
      createTranscriptionModel: () => 'a-string' as never,
      createSpeechModel: () => new Promise(() => {}) as never,
    }))
    t.registry.providers.register('strict-plugin', mediaProvider('strict', {
      createImageModel: () => {
        throw new HarnessError({ code: 'provider_not_configured', message: 'Set a region first.', providerId: 'strict' })
      },
    }))
    t.registry.providers.register('off-plugin', mediaProvider('off'))
    t.registry.providers.register('nokey-plugin', mediaProvider('nokey'))
    for (const id of ['studio', 'bare', 'broken', 'strict', 'off'])
      await t.credentials.set(id, { apiKey: `${id}-key` })
    await t.deps.providers.setEnabled('off', false)
    for (const [modelId, kind] of [['bare-custom-paint', 'image'], ['bare-custom-listen', 'transcription'], ['bare-custom-say', 'speech']] as const)
      await t.deps.catalog.addCustom({ providerId: 'bare', modelId, kind })

    const providers = t.deps.providers
    const table: Array<[string, () => Promise<unknown>, Record<string, unknown>]> = [
      ['an invalid ref', () => providers.resolveImageModel('nocolon'), { code: 'validation_error' }],
      ['an unknown provider', () => providers.resolveTranscriptionModel('nope:model'), { code: 'not_found', providerId: 'nope' }],
      ['a disabled provider', () => providers.resolveImageModel('off:off-paint'), { code: 'provider_not_configured', action: 'configure-provider' }],
      ['missing credentials', () => providers.resolveSpeechModel('nokey:nokey-say'), { code: 'provider_not_configured', action: 'configure-provider', providerId: 'nokey' }],
      ['an unknown model', () => providers.resolveImageModel('studio:nope'), { code: 'model_not_found', action: 'refresh-models' }],
      ['a chat model as an image model', () => providers.resolveImageModel('studio:studio-chat'), { code: 'validation_error', message: 'modelRef: The model "studio:studio-chat" is not an image model.' }],
      ['a speech model as an image model', () => providers.resolveImageModel('studio:studio-say'), { code: 'validation_error' }],
      ['a speech model for dictation', () => providers.resolveTranscriptionModel('studio:studio-say'), { code: 'validation_error', message: 'modelRef: The model "studio:studio-say" is not a speech-to-text model.' }],
      ['a transcription model for read-aloud', () => providers.resolveSpeechModel('studio:studio-listen'), { code: 'validation_error', message: 'modelRef: The model "studio:studio-listen" is not a text-to-speech model.' }],
      ['an image model for read-aloud', () => providers.resolveSpeechModel('studio:studio-paint'), { code: 'validation_error' }],
      ['an image model as a chat model', () => providers.resolveModel('studio:studio-paint'), { code: 'validation_error', message: 'modelRef: The model "studio:studio-paint" is an image model: it answers image turns only.' }],
      ['a seeded image model without createImageModel', () => providers.resolveImageModel('bare:bare-paint'), { code: 'model_not_found' }],
      ['a custom image model without createImageModel', () => providers.resolveImageModel('bare:bare-custom-paint'), { code: 'model_not_found', providerId: 'bare', message: 'The provider "Bare" cannot generate images, so the model "bare:bare-custom-paint" cannot be used.' }],
      ['a custom transcription model without the factory', () => providers.resolveTranscriptionModel('bare:bare-custom-listen'), { code: 'validation_error', message: 'modelRef: The provider "Bare" cannot transcribe speech, so the model "bare:bare-custom-listen" cannot be used.' }],
      ['a custom speech model without the factory', () => providers.resolveSpeechModel('bare:bare-custom-say'), { code: 'validation_error', message: 'modelRef: The provider "Bare" cannot read text aloud, so the model "bare:bare-custom-say" cannot be used.' }],
      ['a throwing factory', () => providers.resolveImageModel('broken:broken-paint'), { code: 'plugin_error', providerId: 'broken', details: { pluginId: 'broken-plugin' } }],
      ['a factory that returns no model', () => providers.resolveTranscriptionModel('broken:broken-listen'), { code: 'plugin_error', details: { pluginId: 'broken-plugin' } }],
      ['a factory that does not return in time', () => providers.resolveSpeechModel('broken:broken-say'), { code: 'plugin_error', details: { pluginId: 'broken-plugin' } }],
      ['a factory that throws a HarnessError', () => providers.resolveImageModel('strict:strict-paint'), { code: 'provider_not_configured', message: 'Set a region first.' }],
    ]
    for (const [label, call, expected] of table) {
      const error = await call().then(() => null, (caught: unknown) => caught)
      expect(error, label).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).toJSON().error, label).toMatchObject(expected)
    }
    // The model_not_found of a missing image factory has no refresh action (refreshing cannot help).
    const noFactory = await providers.resolveImageModel('bare:bare-custom-paint').then(() => null, (caught: unknown) => caught)
    expect(noFactory).toBeInstanceOf(HarnessError)
    expect((noFactory as HarnessError).action).toBeUndefined()
    expect(t.plugins.logEntries.map(entry => entry.pluginId)).toEqual(['broken-plugin', 'broken-plugin', 'broken-plugin'])
    expect(t.plugins.logEntries.map(entry => entry.message)).toEqual([
      'createImageModel("broken-paint") of "broken" threw an error.',
      'createTranscriptionModel("broken-listen") of "broken" did not return a speech-to-text model instance.',
      'createSpeechModel("broken-say") of "broken" did not return within 30 ms.',
    ])
    expect(fetch).not.toHaveBeenCalled()
    // resolveModel still resolves the chat models of the same provider.
    expect((await providers.resolveModel('studio:studio-chat')).model).toMatchObject({ modelId: 'studio-chat' })
  })

  it('guards the factories for 5 s by default and awaits a factory that returns a promise', async () => {
    expect(MODEL_FACTORY_TIMEOUT_MS).toBe(5000)
    const t = await setup({ builtins: [] })
    t.registry.providers.register('async-plugin', mediaProvider('async', {
      createSpeechModel: (async (modelId: string) => new MockSpeechModelV4({ provider: 'async', modelId })) as never,
    }))
    await t.credentials.set('async', { apiKey: 'async-key' })
    expect((await t.deps.providers.resolveSpeechModel('async:async-say')).model).toMatchObject({ specificationVersion: 'v4', modelId: 'async-say' })
  })

  it('resolves the mock media models end to end', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1' } })
    const image = await t.deps.providers.resolveImageModel('mock:image')
    expect(image).toMatchObject({ modelRef: 'mock:image', entry: { kind: 'image', hidden: false }, provider: { pluginId: 'mock' } })
    const generated = await generateImage({ model: image.imageModel, prompt: 'a red fox', n: 2, aspectRatio: '16:9' })
    expect(generated.images).toHaveLength(2)
    expect(generated.images.every(file => file.mediaType === 'image/png')).toBe(true)
    const transcription = await t.deps.providers.resolveTranscriptionModel('mock:transcribe')
    expect((await transcribe({ model: transcription.model, audio: new Uint8Array(64) })).text).toBe(MOCK_TRANSCRIPT)
    const speech = await t.deps.providers.resolveSpeechModel('mock:speech')
    expect(speech.entry.voices).toEqual(['mock-voice-a', 'mock-voice-b'])
    expect((await generateSpeech({ model: speech.model, text: 'Hello world' })).audio.mediaType).toBe('audio/wav')
    // Chat models with image output and tools stay chat models; image models are refused by resolveModel.
    expect((await t.deps.providers.resolveModel('mock:image-chat')).entry).toMatchObject({ kind: 'chat', capabilities: { imageOutput: true } })
    await expect(t.deps.providers.resolveModel('mock:image')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.providers.resolveImageModel('mock:image-chat')).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('provider test', () => {
  it('uses validate() and stores the result', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1' } })
    t.events.clear()
    const result = providerTestResultSchema.parse(await t.deps.providers.test('mock'))
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect((await t.deps.providers.get('mock')).validatedAt).toBeTypeOf('number')
    expect(t.events.ofType('provider.changed').map(event => event.data.id)).toEqual(['mock'])
  })

  it('lists models with candidate values without storing anything', async () => {
    const t = await setup({ builtins: [] })
    const seen: string[] = []
    t.registry.providers.register('acme-plugin', testProvider({
      listModels: async (rt) => {
        seen.push(rt.credentials.apiKey ?? '')
        return [{ id: 'a' }, { id: 'b' }]
      },
    }))
    t.events.clear()
    expect(await t.deps.providers.test('acme', { apiKey: 'candidate-key' })).toMatchObject({ ok: true, modelCount: 2 })
    expect(seen).toEqual(['candidate-key'])
    expect(t.events.events).toEqual([])
    expect((await t.deps.providers.get('acme')).validatedAt).toBeNull()
    expect((await t.deps.catalog.list({ providerId: 'acme' })).map(model => model.source)).toEqual(['seed'])
  })

  it('stores the listing of a test with stored credentials', async () => {
    const t = await setup({ builtins: [] })
    t.registry.providers.register('acme-plugin', testProvider({ listModels: async () => [{ id: 'a' }, { id: 'b' }, { id: 'text-embedding-x' }] }))
    await t.credentials.set('acme', { apiKey: 'stored-key' })
    expect(await t.deps.providers.test('acme')).toMatchObject({ ok: true, modelCount: 2 })
    expect((await t.deps.catalog.list({ providerId: 'acme' })).map(model => [model.id, model.source])).toEqual([['a', 'live'], ['b', 'live']])
  })

  it('reports and stores a rejected key', async () => {
    const t = await setup({ builtins: [] })
    t.registry.providers.register('acme-plugin', testProvider({
      validate: async () => {
        throw http401()
      },
    }))
    await t.credentials.set('acme', { apiKey: 'bad-key' })
    const result = await t.deps.providers.test('acme')
    expect(result).toMatchObject({ ok: false, error: { code: 'auth_invalid', status: 401, providerId: 'acme', action: 'configure-provider' } })
    expect(await t.deps.providers.get('acme')).toMatchObject({ status: 'error', lastError: { code: 'auth_invalid' } })
    // A candidate test is not stored.
    expect((await t.deps.providers.test('acme', { apiKey: 'other-bad-key' })).ok).toBe(false)
  })

  it('pings the small model when there is neither validate nor listModels', async () => {
    const t = await setup({ builtins: [] })
    t.registry.providers.register('acme-plugin', testProvider())
    await t.credentials.set('acme', { apiKey: 'stored-key' })
    expect(await t.deps.providers.test('acme')).toMatchObject({ ok: true })
    t.registry.providers.register('broken-plugin', testProvider({
      id: 'broken',
      createLanguageModel: modelId => new MockLanguageModelV4({
        modelId,
        doGenerate: async () => {
          throw http401()
        },
      }),
    }))
    await t.credentials.set('broken', { apiKey: 'stored-key' })
    expect(await t.deps.providers.test('broken')).toMatchObject({ ok: false, error: { code: 'auth_invalid' } })
  })

  it('never pings an image, transcription or speech model', async () => {
    const t = await setup({ builtins: [] })
    const pinged: string[] = []
    const pingProvider = (id: string, extra: Partial<ProviderDefinition>): ProviderDefinition => testProvider({
      id,
      name: id,
      smallModelId: undefined,
      createLanguageModel: (modelId) => {
        pinged.push(`${id}:${modelId}`)
        return testProvider().createLanguageModel(modelId, { credentials: {}, fetch: globalThis.fetch }) as MockLanguageModelV4
      },
      ...extra,
    })
    // Seeds: media models first (a whisper id without a kind is a transcription model), then the chat model.
    t.registry.providers.register('seeds-plugin', pingProvider('seeds', {
      seedModels: [{ id: 'paint', kind: 'image' }, { id: 'whisper-small' }, { id: 'say', kind: 'speech' }, { id: 'chat-1' }],
      createImageModel: () => new MockImageModelV4(),
      createSpeechModel: () => new MockSpeechModelV4(),
    }))
    // No seeds: the first visible chat model of the catalog, not the visible image model that sorts first.
    t.registry.providers.register('plugged-plugin', pingProvider('plugged', { seedModels: undefined, createImageModel: () => new MockImageModelV4() }))
    t.registry.models.register('other-plugin', 'plugged', [{ id: 'a-paint', name: 'A Paint', kind: 'image' }, { id: 'b-chat', name: 'B Chat' }])
    // Only media models: nothing to ping.
    t.registry.providers.register('media-plugin', pingProvider('media', { seedModels: [{ id: 'paint', kind: 'image' }], createImageModel: () => new MockImageModelV4() }))
    for (const id of ['seeds', 'plugged', 'media'])
      await t.credentials.set(id, { apiKey: `${id}-key` })
    expect((await t.deps.catalog.list({ providerId: 'plugged' })).map(model => model.id)).toEqual(['a-paint', 'b-chat'])
    expect(await t.deps.providers.test('seeds')).toMatchObject({ ok: true })
    expect(await t.deps.providers.test('plugged')).toMatchObject({ ok: true })
    expect(await t.deps.providers.test('media')).toMatchObject({ ok: false, error: { code: 'provider_error' } })
    expect(pinged).toEqual(['seeds:chat-1', 'plugged:b-chat'])
  })

  it('times out after the test timeout', async () => {
    const t = await setup({ builtins: [], providerService: { testTimeoutMs: 30 } })
    let aborted = false
    t.registry.providers.register('acme-plugin', testProvider({
      validate: rt => new Promise((_resolve, reject) => {
        rt.signal?.addEventListener('abort', () => {
          aborted = true
          reject(rt.signal?.reason)
        })
      }),
    }))
    await t.credentials.set('acme', { apiKey: 'stored-key' })
    expect(await t.deps.providers.test('acme')).toMatchObject({ ok: false, error: { code: 'provider_unreachable' } })
    expect(aborted).toBe(true)
  })

  it('rejects unknown keys and reports missing credentials without a request', async () => {
    const t = await setup({ builtins: [] })
    const listModels = vi.fn(async () => [])
    t.registry.providers.register('acme-plugin', testProvider({ listModels }))
    await expect(t.deps.providers.test('acme', { nope: 'x' })).rejects.toMatchObject({ code: 'validation_error' })
    expect(await t.deps.providers.test('acme')).toMatchObject({ ok: false, latencyMs: 0, error: { code: 'provider_not_configured' } })
    expect(await t.deps.providers.test('acme', { apiKey: '' })).toMatchObject({ ok: false, error: { code: 'provider_not_configured' } })
    expect(listModels).not.toHaveBeenCalled()
    await expect(t.deps.providers.test('nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('mapError and recordOutcome', () => {
  it('asks the definition first, then applies the default mapping', async () => {
    const t = await setup({ builtins: [] })
    t.registry.providers.register('acme-plugin', testProvider({
      mapError: error => (error instanceof Error && error.message === 'custom')
        ? { code: 'rate_limited', message: 'Slow down', retryAfterMs: 5 }
        : error instanceof Error && error.message === 'invalid' ? { code: 'nope', message: 1 } as never : undefined,
    }))
    expect(t.deps.providers.mapError('acme', new Error('custom')).toJSON().error).toEqual({ code: 'rate_limited', message: 'Slow down', retryAfterMs: 5, providerId: 'acme' })
    expect(t.deps.providers.mapError('acme', new Error('invalid')).code).toBe('provider_error')
    expect(t.deps.providers.mapError('acme', http401())).toMatchObject({ code: 'auth_invalid', message: 'Acme rejected the credentials (HTTP 401). Check the API key in Settings > Providers.' })
    const passthrough = new HarnessError({ code: 'plugin_error', message: 'x' })
    expect(t.deps.providers.mapError('acme', passthrough)).toBe(passthrough)
    expect(t.deps.providers.mapError('unknown', http401())).toMatchObject({ code: 'auth_invalid', providerId: 'unknown' })
    const hostile = new Proxy({}, {
      get: () => {
        throw new Error('trap')
      },
    })
    expect(t.deps.providers.mapError('acme', hostile)).toBeInstanceOf(HarnessError)
  })

  it('records auth and network failures, clears them on success and emits only on changes', async () => {
    const t = await setup({ env: { HF_MOCK_PROVIDER: '1' } })
    t.events.clear()
    await t.deps.providers.recordOutcome('mock', { ok: false, error: { code: 'rate_limited', message: 'slow' } })
    expect(t.events.events).toEqual([])
    await t.deps.providers.recordOutcome('mock', { ok: false, error: { code: 'provider_unreachable', message: 'down' } })
    expect(await t.deps.providers.get('mock')).toMatchObject({ status: 'error', lastError: { code: 'provider_unreachable', providerId: 'mock' } })
    await t.deps.providers.recordOutcome('mock', { ok: false, error: { code: 'provider_unreachable', message: 'down' } })
    expect(t.events.ofType('provider.changed')).toHaveLength(1)
    await t.deps.providers.recordOutcome('mock', { ok: true })
    expect(await t.deps.providers.get('mock')).toMatchObject({ status: 'connected', lastError: null })
    expect(t.events.ofType('provider.changed')).toHaveLength(2)
    await t.deps.providers.recordOutcome('mock', { ok: true })
    expect(t.events.ofType('provider.changed')).toHaveLength(2)
  })
})
