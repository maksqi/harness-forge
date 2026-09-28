import type { DeclarativeProvider, PluginContext, ProviderRuntime } from '@harness-forge/plugin-sdk'
import type { LanguageModel } from 'ai'
import process from 'node:process'
import { APICallError } from '@ai-sdk/provider'
import { applyDeclarativeProviderDefaults } from '@harness-forge/shared'
import { generateText } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeclarativeProvider,
  listDeclarativeModels,
  listedModel,
  listingItems,
  PLACEHOLDER_API_KEY,
  providerHeaders,
  registerDeclaredContributions,
  resolveTemplatedHeaders,
} from './declarative.ts'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function runtime(credentials: Record<string, string>, respond: (request: Recorded) => Response = () => Response.json({ error: { message: 'test stop' } }, { status: 400 })): { rt: ProviderRuntime, requests: Recorded[] } {
  const requests: Recorded[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const text = await request.text()
    const recorded: Recorded = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: text ? JSON.parse(text) as unknown : undefined }
    requests.push(recorded)
    return respond(recorded)
  }
  return { rt: { credentials, fetch }, requests }
}

function provider(extra: Partial<DeclarativeProvider> = {}): DeclarativeProvider {
  return { id: 'acme', name: 'Acme', baseURL: 'https://llm.example.com/v1/', apiFormat: 'openai-chat', ...extra }
}

async function send(definition: ReturnType<typeof createDeclarativeProvider>, rt: ProviderRuntime, options: { modelId?: string, reasoning?: ReturnType<NonNullable<typeof definition.reasoning>> } = {}): Promise<void> {
  const model = definition.createLanguageModel(options.modelId ?? 'acme-large', rt) as Exclude<LanguageModel, string>
  await generateText({
    model,
    prompt: 'ping',
    maxRetries: 0,
    ...(options.reasoning?.reasoning ? { reasoning: options.reasoning.reasoning } : {}),
    ...(options.reasoning?.providerOptions ? { providerOptions: options.reasoning.providerOptions } : {}),
  }).catch(() => {})
}

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_GENERATIVE_AI_API_KEY'] as const
const savedEnv = new Map<string, string | undefined>()

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
  savedEnv.clear()
})

function poisonEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    process.env[key] = key.endsWith('_URL') ? 'https://env-leak.example.com/v1' : 'env-leaked-secret-value'
  }
}

function everyHeader(requests: Recorded[]): string {
  return JSON.stringify(requests.map(request => [request.url, request.headers]))
}

describe('wire formats and auth', () => {
  it('openai-chat: POST {baseURL}/chat/completions with bearer auth and templated headers', async () => {
    const definition = createDeclarativeProvider(provider({
      headers: { 'X-Team': 'team-{{credentials.team}}', 'X-Region': '{{credentials.region}}' },
      credentials: [
        { key: 'apiKey', label: 'API key', type: 'secret', required: true },
        { key: 'team', label: 'Team', type: 'text' },
        { key: 'region', label: 'Region', type: 'text' },
      ],
    }))
    const { rt, requests } = runtime({ apiKey: 'sk-live-key-1234567890', team: 'blue' })
    await send(definition, rt)
    expect(requests[0]).toMatchObject({ url: 'https://llm.example.com/v1/chat/completions', method: 'POST' })
    expect(requests[0]?.headers).toMatchObject({ 'authorization': 'Bearer sk-live-key-1234567890', 'x-team': 'team-blue' })
    // A header referencing an empty credential is omitted.
    expect(requests[0]?.headers['x-region']).toBeUndefined()
    expect((requests[0]?.body as { model: string }).model).toBe('acme-large')
  })

  it('openai-responses: POST {baseURL}/responses; a custom header auth replaces the placeholder bearer', async () => {
    const definition = createDeclarativeProvider(provider({ apiFormat: 'openai-responses', auth: { type: 'header', header: 'api-key' } }))
    const { rt, requests } = runtime({ apiKey: 'azure-style-key' })
    await send(definition, rt)
    expect(requests[0]?.url).toBe('https://llm.example.com/v1/responses')
    expect(requests[0]?.headers['api-key']).toBe('azure-style-key')
    expect(requests[0]?.headers.authorization).toBeUndefined()
    expect(everyHeader(requests)).not.toContain(PLACEHOLDER_API_KEY)
  })

  it('anthropic: x-api-key by default, bearer as authToken', async () => {
    const byHeader = runtime({ apiKey: 'anthropic-compatible-key' })
    await send(createDeclarativeProvider(provider({ apiFormat: 'anthropic', baseURL: 'https://api.example.com/anthropic/v1' })), byHeader.rt)
    expect(byHeader.requests[0]?.url).toBe('https://api.example.com/anthropic/v1/messages')
    expect(byHeader.requests[0]?.headers).toMatchObject({ 'x-api-key': 'anthropic-compatible-key', 'anthropic-version': expect.any(String) })

    const byBearer = runtime({ apiKey: 'bearer-token-value' })
    await send(createDeclarativeProvider(provider({ apiFormat: 'anthropic', auth: { type: 'bearer' } })), byBearer.rt)
    expect(byBearer.requests[0]?.headers.authorization).toBe('Bearer bearer-token-value')
    expect(byBearer.requests[0]?.headers['x-api-key']).toBeUndefined()
  })

  it('google: x-goog-api-key and the streamGenerateContent / generateContent path', async () => {
    const { rt, requests } = runtime({ apiKey: 'google-compatible-key' })
    await send(createDeclarativeProvider(provider({ apiFormat: 'google', baseURL: 'https://generativelanguage.example.com/v1beta' })), rt, { modelId: 'gemini-x' })
    expect(requests[0]?.url).toMatch(/^https:\/\/generativelanguage\.example\.com\/v1beta\/models\/gemini-x:generateContent/)
    expect(requests[0]?.headers['x-goog-api-key']).toBe('google-compatible-key')
  })

  it('sends no auth header for auth none or an empty optional key, and never uses SDK environment fallbacks', async () => {
    poisonEnv()
    for (const apiFormat of ['openai-chat', 'openai-responses', 'anthropic', 'google'] as const) {
      const optional = createDeclarativeProvider(provider({ apiFormat, credentials: [{ key: 'apiKey', label: 'API key', type: 'secret' }] }))
      const none = createDeclarativeProvider(provider({ apiFormat, auth: { type: 'none' } }))
      for (const definition of [optional, none]) {
        const { rt, requests } = runtime({})
        await send(definition, rt)
        const text = everyHeader(requests)
        expect(requests.length, apiFormat).toBeGreaterThan(0)
        expect(text, apiFormat).not.toContain('env-leak')
        expect(text, apiFormat).not.toContain('env-leaked-secret-value')
        expect(text, apiFormat).not.toContain(PLACEHOLDER_API_KEY)
        expect(requests[0]?.url.startsWith('https://llm.example.com/v1'), apiFormat).toBe(true)
        expect(requests[0]?.headers.authorization, apiFormat).toBeUndefined()
        expect(requests[0]?.headers['x-api-key'], apiFormat).toBeUndefined()
        expect(requests[0]?.headers['x-goog-api-key'], apiFormat).toBeUndefined()
      }
    }
  })

  it('does not perform network I/O when creating a model', () => {
    const { rt, requests } = runtime({ apiKey: 'k' })
    createDeclarativeProvider(provider()).createLanguageModel('x', rt)
    expect(requests).toEqual([])
  })
})

describe('definition fields', () => {
  it('maps the declarative fields and defaults', () => {
    const definition = createDeclarativeProvider(provider({
      smallModelId: 'acme-small',
      modelsDevId: 'acmeai',
      credentials: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true, helpUrl: 'https://example.com/keys' }],
      listModels: false,
    }), { manifestIcon: 'lobe:together' })
    expect(definition).toMatchObject({ id: 'acme', name: 'Acme', icon: 'lobe:together', smallModelId: 'acme-small', modelsDevId: 'acmeai', keyUrl: 'https://example.com/keys' })
    expect(definition.listModels).toBeUndefined()
    expect(definition.reasoning).toBeUndefined()
    expect(createDeclarativeProvider(provider(), { manifestIcon: 'icon.svg' }).icon).toBeUndefined()
    expect(createDeclarativeProvider(provider({ icon: 'lobe:vllm' }), { manifestIcon: 'lobe:together' }).icon).toBe('lobe:vllm')
    expect(createDeclarativeProvider(provider({ auth: { type: 'none' } })).credentials).toEqual([])
    expect(() => createDeclarativeProvider(provider({ headers: { Cookie: 'x' } }))).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })

  it('maps efforts per reasoning style (PLUGINS.md 4)', () => {
    const openaiChat = createDeclarativeProvider(provider({ reasoningStyle: 'openai-effort' })).reasoning!
    expect(openaiChat('auto', { id: 'm' })).toBeUndefined()
    expect(openaiChat('off', { id: 'm' })).toEqual({ reasoning: 'none' })
    expect(openaiChat('max', { id: 'm' })).toEqual({ reasoning: 'xhigh' })

    const responses = createDeclarativeProvider(provider({ apiFormat: 'openai-responses', reasoningStyle: 'openai-effort' })).reasoning!
    expect(responses('low', { id: 'm' })).toEqual({ reasoning: 'low', providerOptions: { openai: { forceReasoning: true } } })
    const azure = createDeclarativeProvider(provider({ id: 'my-azure', apiFormat: 'openai-responses', reasoningStyle: 'openai-effort' })).reasoning!
    expect(azure('high', { id: 'm' })?.providerOptions).toEqual({ openai: { forceReasoning: true }, azure: { forceReasoning: true } })

    const anthropic = createDeclarativeProvider(provider({ apiFormat: 'anthropic', reasoningStyle: 'anthropic-thinking' })).reasoning!
    expect(anthropic('off', { id: 'm' })).toEqual({ providerOptions: { anthropic: { thinking: { type: 'disabled' } } } })
    expect(anthropic('low', { id: 'm' })).toEqual({ providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } } })
    expect(anthropic('medium', { id: 'm' })?.providerOptions?.anthropic).toEqual({ thinking: { type: 'enabled', budgetTokens: 8192 } })
    expect(anthropic('high', { id: 'm' })?.providerOptions?.anthropic).toEqual({ thinking: { type: 'enabled', budgetTokens: 16_384 } })
    expect(anthropic('max', { id: 'm' })?.providerOptions?.anthropic).toEqual({ thinking: { type: 'enabled', budgetTokens: 32_768 } })

    const google = createDeclarativeProvider(provider({ apiFormat: 'google', reasoningStyle: 'google-thinking' })).reasoning!
    expect(google('off', { id: 'm' })).toEqual({ reasoning: 'none' })
    expect(google('medium', { id: 'm' })).toEqual({ reasoning: 'medium', providerOptions: { google: { thinkingConfig: { includeThoughts: true } } } })
    expect(google('max', { id: 'm' })?.reasoning).toBe('xhigh')
  })

  it('sends the mapped reasoning on the wire (openai-chat reasoning_effort, anthropic thinking budget)', async () => {
    const chat = createDeclarativeProvider(provider({ reasoningStyle: 'openai-effort' }))
    const chatRuntime = runtime({ apiKey: 'k' })
    await send(chat, chatRuntime.rt, { reasoning: chat.reasoning!('high', { id: 'acme-large' }) })
    expect((chatRuntime.requests[0]?.body as Record<string, unknown>).reasoning_effort).toBe('high')

    const anthropic = createDeclarativeProvider(provider({ apiFormat: 'anthropic', reasoningStyle: 'anthropic-thinking' }))
    const anthropicRuntime = runtime({ apiKey: 'k' })
    await send(anthropic, anthropicRuntime.rt, { reasoning: anthropic.reasoning!('low', { id: 'acme-large' }) })
    expect((anthropicRuntime.requests[0]?.body as Record<string, unknown>).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  })

  it('resolves templated headers from credentials and field defaults', () => {
    const resolved = applyDeclarativeProviderDefaults(provider({
      headers: { 'X-A': '{{credentials.a}}-{{credentials.b}}' },
      credentials: [
        { key: 'apiKey', label: 'Key', type: 'secret', required: true },
        { key: 'a', label: 'A', type: 'text', default: 'da' },
        { key: 'b', label: 'B', type: 'text' },
      ],
    }))
    expect(resolveTemplatedHeaders(resolved, { credentials: { b: 'vb' }, fetch })).toEqual({ 'X-A': 'da-vb' })
    expect(resolveTemplatedHeaders(resolved, { credentials: {}, fetch })).toEqual({})
    expect(providerHeaders(resolved, { credentials: { apiKey: ' sk-1 ', b: 'x' }, fetch })).toEqual({ 'X-A': 'da-x', 'Authorization': 'Bearer sk-1' })
  })
})

describe('model listing', () => {
  it('parses the documented response shapes', () => {
    expect(listingItems({ data: [1] })).toEqual({ shape: 'data', items: [1] })
    expect(listingItems({ models: [] })).toEqual({ shape: 'models', items: [] })
    expect(listingItems(['a'])).toEqual({ shape: 'array', items: ['a'] })
    expect(listingItems({ other: [] })).toBeNull()
    expect(listedModel('data', { id: 'gpt-x', display_name: 'GPT X', context_length: 128_000, max_completion_tokens: 4096, type: 'chat' }))
      .toEqual({ id: 'gpt-x', name: 'GPT X', contextWindow: 128_000, maxOutputTokens: 4096, kind: 'chat' })
    expect(listedModel('models', { name: 'models/gemini-3', displayName: 'Gemini 3', inputTokenLimit: 1000, outputTokenLimit: 100, supportedGenerationMethods: ['generateContent'] }))
      .toEqual({ id: 'gemini-3', name: 'Gemini 3', contextWindow: 1000, maxOutputTokens: 100 })
    expect(listedModel('models', { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] })).toBeUndefined()
    expect(listedModel('models', { name: 'llama3:8b' })).toEqual({ id: 'llama3:8b' })
    expect(listedModel('array', 'plain-id')).toEqual({ id: 'plain-id' })
    expect(listedModel('array', { id: 'x', type: 'embeddings' })).toEqual({ id: 'x', kind: 'embedding' })
    expect(listedModel('data', { id: 'x', type: 'tts' })?.kind).toBe('audio')
    expect(listedModel('data', { id: 'x', type: 'weird' })?.kind).toBe('other')
    expect(listedModel('data', { name: 'no id' })).toBeUndefined()
  })

  it('lists with auth and filters (exclude wins over include)', async () => {
    const definition = createDeclarativeProvider(provider({ listModels: { path: '/catalog/models', include: 'chat|embed', exclude: 'embed' } }))
    const { rt, requests } = runtime({ apiKey: 'list-key' }, () => Response.json({ data: [{ id: 'chat-1' }, { id: 'embed-chat' }, { id: 'other' }, { id: 'chat-1' }] }))
    expect(await definition.listModels!(rt)).toEqual([{ id: 'chat-1' }])
    expect(requests[0]).toMatchObject({ url: 'https://llm.example.com/v1/catalog/models', method: 'GET' })
    expect(requests[0]?.headers).toMatchObject({ authorization: 'Bearer list-key', accept: 'application/json' })
  })

  it('follows anthropic and google paging up to 10 pages', async () => {
    const anthropic = applyDeclarativeProviderDefaults(provider({ apiFormat: 'anthropic' }))
    const pages = runtime({ apiKey: 'k' }, (request) => {
      const after = new URL(request.url).searchParams.get('after_id')
      const page = after === null ? 0 : Number(after.slice(1)) + 1
      return Response.json({ data: [{ id: `m${page}` }], has_more: true, last_id: `p${page}` })
    })
    const models = await listDeclarativeModels(anthropic, pages.rt)
    expect(models).toHaveLength(10)
    expect(pages.requests[1]?.url).toBe('https://llm.example.com/v1/models?limit=1000&after_id=p0')

    const google = applyDeclarativeProviderDefaults(provider({ apiFormat: 'google' }))
    const googlePages = runtime({ apiKey: 'k' }, (request) => {
      const token = new URL(request.url).searchParams.get('pageToken')
      return Response.json(token === null ? { models: [{ name: 'models/a' }], nextPageToken: 'next' } : { models: [{ name: 'models/b' }] })
    })
    expect(await listDeclarativeModels(google, googlePages.rt)).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(googlePages.requests.map(request => new URL(request.url).search)).toEqual(['?pageSize=1000', '?pageSize=1000&pageToken=next'])
  })

  it('throws APICallError for failed listings and an error for unknown shapes', async () => {
    const definition = createDeclarativeProvider(provider())
    const denied = runtime({ apiKey: 'bad' }, () => Response.json({ error: 'invalid key' }, { status: 401 }))
    const error = await definition.listModels!(denied.rt).catch(caught => caught)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 401 })
    const weird = runtime({ apiKey: 'k' }, () => Response.json({ unexpected: true }))
    await expect(definition.listModels!(weird.rt)).rejects.toThrow(/unexpected model list/)
  })
})

describe('registerDeclaredContributions', () => {
  it('registers providers, models, MCP servers and commands through ctx and skips duplicate commands', () => {
    const calls: string[] = []
    const warnings: string[] = []
    const ctx = {
      providers: { register: (definition: { id: string }) => void calls.push(`provider:${definition.id}`) },
      models: { register: (providerId: string, models: unknown[]) => void calls.push(`models:${providerId}:${models.length}`) },
      mcp: { register: (decl: { id: string }) => void calls.push(`mcp:${decl.id}`) },
      commands: {
        register: (command: { name: string }) => {
          if (command.name === 'taken')
            throw Object.assign(new Error('The command "/taken" is already registered by the plugin "core-commands".'), { name: 'HarnessError', code: 'conflict' })
          calls.push(`command:${command.name}`)
        },
      },
      logger: { warn: (message: string) => void warnings.push(message) },
    } as unknown as PluginContext
    registerDeclaredContributions(ctx, {
      manifestVersion: 1,
      id: 'acme',
      name: 'Acme',
      version: '1.0.0',
      engines: { harness: '^1.0.0' },
      contributes: {
        providers: [{ ...provider(), models: [{ id: 'a' }] }],
        models: [{ providerId: 'openai', models: [{ id: 'b' }, { id: 'c' }] }],
        mcpServers: [{ id: 'acme', name: 'Acme', transport: { type: 'http', url: 'https://mcp.example.com' } }],
        commands: [{ name: 'taken', description: 'x', template: 'x' }, { name: 'free', description: 'y', template: 'y' }],
      },
    })
    expect(calls).toEqual(['provider:acme', 'models:acme:1', 'models:openai:2', 'mcp:acme', 'command:free'])
    expect(warnings).toEqual([expect.stringContaining('The command "/taken" was skipped')])
  })
})
