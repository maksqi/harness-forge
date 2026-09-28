import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { ProvidersTestApp, ProvidersTestAppOptions } from './testing.ts'
import { APICallError } from '@ai-sdk/provider'
import { BUILTIN_PROVIDER_IDS, HarnessError, providerSummarySchema, providerTestResultSchema } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerConfigs } from '../db/schema.ts'
import { isLocalProvider, providerStatus } from './index.ts'
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
    expect(providers.at(-1)).toMatchObject({ id: 'mock', pluginId: 'mock', status: 'connected', local: true, icon: null, modelCount: 4, credentials: {} })
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
