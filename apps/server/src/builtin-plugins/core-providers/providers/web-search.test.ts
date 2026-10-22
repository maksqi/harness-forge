// The builtin providers' `webSearch` hooks (W14.4-T3, plugin API 1.7.0, PROVIDERS.md 14 "Native search by provider"):
// the tool and key per provider, the model rules (deny-lists, Gemini versions, gpt-oss), `exclusive` for Gemini 2.x, the
// OpenRouter fallback for models without tools, and the request each answer produces on the wire (`generateText` with a
// fake `fetch`: never the network).
import type { ModelInfo, ProviderDefinition, WebSearchParams } from '@harness-forge/plugin-sdk'
import type { Tool } from 'ai'
import type { RecordedRequest } from '../testing.ts'
import { WEB_SEARCH_MAX_USES } from '@harness-forge/shared'
import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'
import { checkWebSearchParams } from '../../../registry/validate.ts'
import { baseModelId, searchMaxUses, WEB_SEARCH_MAX_USES_CAP } from '../lib/web-search.ts'
import { fakeRuntime, jsonResponse } from '../testing.ts'
import { supportsAnthropicWebSearch } from './anthropic.ts'
import { googleSearchSupport } from './google.ts'
import { supportsGroqBrowserSearch } from './groq.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'
import { supportsOpenAIWebSearch } from './openai.ts'
import { supportsXaiWebSearch } from './xai.ts'

const REQUEST = { functionTools: 0, maxUses: WEB_SEARCH_MAX_USES } as const

function provider(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
  if (!definition)
    throw new Error(`Unknown provider "${id}"`)
  return definition
}

function model(id: string, tools = true): ModelInfo {
  return { id, kind: 'chat', capabilities: { tools } }
}

function search(providerId: string, modelId: string, tools = true, request: { functionTools: number, maxUses: number } = REQUEST): WebSearchParams | undefined {
  return provider(providerId).webSearch?.(model(modelId, tools), request)
}

/** The one native tool of an answer: its key, provider tool id, args and whether the provider executes it. */
function nativeTool(params: WebSearchParams | undefined): { key: string, id: unknown, args: unknown, executed: unknown } | undefined {
  const entries = Object.entries(params?.tools ?? {})
  expect(entries.length).toBeLessThanOrEqual(1)
  const [key, tool] = entries[0] ?? []
  if (key === undefined || tool === undefined)
    return undefined
  const record = tool as { id?: unknown, args?: unknown, isProviderExecuted?: unknown, type?: unknown }
  expect(record.type).toBe('provider')
  return { key, id: record.id, args: record.args, executed: record.isProviderExecuted }
}

describe('the hooks per provider', () => {
  it('anthropic: web_search = webSearch_20250305({ maxUses: 5 }), provider-executed, never exclusive', () => {
    const params = search('anthropic', 'claude-sonnet-5')
    expect(nativeTool(params)).toEqual({ key: 'web_search', id: 'anthropic.web_search_20250305', args: { maxUses: 5 }, executed: true })
    expect(params?.exclusive).toBeUndefined()
    expect(params?.providerOptions).toBeUndefined()
    // The request's search count (capped), the same tool for a turn with function tools.
    expect(nativeTool(search('anthropic', 'claude-opus-5-5', true, { functionTools: 3, maxUses: 2 }))?.args).toEqual({ maxUses: 2 })
    expect(nativeTool(search('anthropic', 'claude-opus-5-5', true, { functionTools: 0, maxUses: 99 }))?.args).toEqual({ maxUses: WEB_SEARCH_MAX_USES_CAP })
  })

  it('anthropic: every claude-* model except claude-instant, claude-1 / 2 and plain Claude 3', () => {
    for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-3.5-sonnet', 'claude-next-unknown'])
      expect(supportsAnthropicWebSearch(id), id).toBe(true)
    for (const id of ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307', 'claude-3', 'claude-2.1', 'claude-2', 'claude-v2', 'claude-instant-1.2', 'claude-1.3', 'gpt-6-sol', 'MiniMax-M3', ''])
      expect(supportsAnthropicWebSearch(id), id).toBe(false)
    expect(search('anthropic', 'claude-3-haiku-20240307')).toBeUndefined()
  })

  it('openai: web_search = webSearch({}) unless the id is on the deny-list (unknown ids count as supported)', () => {
    expect(nativeTool(search('openai', 'gpt-6-sol'))).toEqual({ key: 'web_search', id: 'openai.web_search', args: {}, executed: true })
    for (const id of ['gpt-6-astra', 'gpt-6-luna', 'gpt-5', 'gpt-5.1', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o3-pro', 'o4-mini', 'chatgpt-4o-latest', 'ft:gpt-4o-mini:org::abc', 'some-future-model'])
      expect(supportsOpenAIWebSearch(id), id).toBe(true)
    for (const id of ['o1', 'o1-mini', 'o1-preview', 'o1-pro-2025-03-19', 'o3-mini', 'o3-mini-2025-01-31', 'gpt-4.1-nano', 'gpt-5-nano', 'gpt-5-nano-2025-08-07', 'gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-4', 'gpt-4-turbo', 'gpt-4-0613', 'GPT-4-32K', 'ft:gpt-3.5-turbo:org::abc'])
      expect(supportsOpenAIWebSearch(id), id).toBe(false)
    expect(search('openai', 'o1-mini')).toBeUndefined()
  })

  it('google: google_search = googleSearch({}); Gemini 2.x exclusive, Gemini 3 and later combined, others none', () => {
    const gemini3 = search('google', 'gemini-3.8-flash')
    expect(nativeTool(gemini3)).toEqual({ key: 'google_search', id: 'google.google_search', args: {}, executed: true })
    expect(gemini3?.exclusive).toBeUndefined()
    const gemini25 = search('google', 'gemini-2.5-pro')
    expect(nativeTool(gemini25)?.key).toBe('google_search')
    expect(gemini25?.exclusive).toBe(true)
    // Exclusive whatever the turn sends (the host keeps it off turns with function tools).
    expect(search('google', 'gemini-2.5-flash', true, { functionTools: 4, maxUses: 5 })?.exclusive).toBe(true)

    for (const id of ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'models/gemini-3-pro', 'gemini-3-pro-image-preview'])
      expect(googleSearchSupport(id), id).toBe('combined')
    for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-001'])
      expect(googleSearchSupport(id), id).toBe('exclusive')
    for (const id of ['gemini-1.5-pro', 'gemini-1.0-pro', 'gemini-pro', 'gemini-pro-vision', 'gemini-2.0-flash-lite', 'gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation', 'gemini-2.5-flash-preview-tts', 'gemini-embedding-001', 'gemini-live-2.5-flash', 'gemma-3-27b-it', 'learnlm-2.0-flash-experimental', 'nano-banana-pro-preview'])
      expect(googleSearchSupport(id), id).toBeNull()
    expect(search('google', 'gemma-3-27b-it')).toBeUndefined()
  })

  it('xai: web_search = webSearch({}) for every model except Grok 2 and Grok 3', () => {
    expect(nativeTool(search('xai', 'grok-4.7'))).toEqual({ key: 'web_search', id: 'xai.web_search', args: {}, executed: true })
    for (const id of ['grok-4.7', 'grok-4.3', 'grok-4-fast-reasoning', 'grok-4.20-non-reasoning', 'grok-code-fast-1', 'grok-5'])
      expect(supportsXaiWebSearch(id), id).toBe(true)
    for (const id of ['grok-2', 'grok-2-1212', 'grok-2-vision-1212', 'grok-3', 'grok-3-mini', 'grok-3-fast-beta', 'grok-3.5'])
      expect(supportsXaiWebSearch(id), id).toBe(false)
    expect(search('xai', 'grok-3-mini')).toBeUndefined()
  })

  it('openrouter: the web_search server tool for models with tools, else the web plugin in provider options', () => {
    const withTools = search('openrouter', 'anthropic/claude-sonnet-5')
    expect(nativeTool(withTools)).toEqual({ key: 'web_search', id: 'openrouter.web_search', args: { maxResults: 5 }, executed: false })
    expect(withTools?.providerOptions).toBeUndefined()
    const withoutTools = search('openrouter', 'some/model-without-tools', false)
    expect(withoutTools).toEqual({ providerOptions: { openrouter: { plugins: [{ id: 'web', max_results: 5 }] } } })
    expect(search('openrouter', 'any/model', true, { functionTools: 0, maxUses: 3 })?.tools?.web_search).toMatchObject({ args: { maxResults: 3 } })
    // Unknown tool support (no capabilities) counts as none: the plugin.
    expect(provider('openrouter').webSearch?.({ id: 'x/y' }, REQUEST)).toEqual({ providerOptions: { openrouter: { plugins: [{ id: 'web', max_results: 5 }] } } })
  })

  it('groq: browser_search for the gpt-oss models only', () => {
    expect(nativeTool(search('groq', 'openai/gpt-oss-120b'))).toEqual({ key: 'browser_search', id: 'groq.browser_search', args: {}, executed: true })
    for (const id of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'gpt-oss-120b'])
      expect(supportsGroqBrowserSearch(id), id).toBe(true)
    for (const id of ['qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct-0905'])
      expect(supportsGroqBrowserSearch(id), id).toBe(false)
    expect(search('groq', 'qwen/qwen3.8-27b')).toBeUndefined()
  })

  it('the other builtin providers have no hook (their chats use the builtin search_web)', () => {
    const withHook = PROVIDER_DEFINITIONS.filter(definition => definition.webSearch !== undefined).map(definition => definition.id)
    expect(withHook).toEqual(['anthropic', 'openai', 'google', 'xai', 'groq', 'openrouter'])
  })

  it('every answer is a fresh object that the host accepts as it is (no problem), for the seed models too', () => {
    for (const definition of PROVIDER_DEFINITIONS) {
      if (definition.webSearch === undefined)
        continue
      for (const seed of definition.seedModels ?? []) {
        if (seed.kind !== undefined && seed.kind !== 'chat')
          continue
        const first = definition.webSearch(seed, REQUEST)
        const checked = checkWebSearchParams(first)
        expect(checked.problems, `${definition.id}:${seed.id}`).toEqual([])
        if (first !== undefined) {
          expect(checked.params, `${definition.id}:${seed.id}`).toBeDefined()
          const second = definition.webSearch(seed, REQUEST)
          expect(second).not.toBe(first)
          for (const [key, tool] of Object.entries(first.tools ?? {}))
            expect(second?.tools?.[key], `${definition.id}:${seed.id}`).not.toBe(tool)
        }
      }
    }
  })
})

describe('the helpers', () => {
  it('searchMaxUses: whole numbers 1 ... 20, else the default', () => {
    expect(searchMaxUses({ maxUses: 5 })).toBe(5)
    expect(searchMaxUses({ maxUses: 1 })).toBe(1)
    expect(searchMaxUses({ maxUses: 50 })).toBe(WEB_SEARCH_MAX_USES_CAP)
    for (const maxUses of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(searchMaxUses({ maxUses }), String(maxUses)).toBe(WEB_SEARCH_MAX_USES)
    expect(searchMaxUses(undefined)).toBe(WEB_SEARCH_MAX_USES)
  })

  it('baseModelId: lowercase, without a fine-tune prefix', () => {
    expect(baseModelId(' FT:GPT-4o-mini:org::abc ')).toBe('gpt-4o-mini:org::abc')
    expect(baseModelId('Claude-Sonnet-5')).toBe('claude-sonnet-5')
  })
})

// ---------- on the wire ----------

/** One `generateText` call with the hook's tools and provider options; the fake API fails, the request is recorded. */
async function wire(providerId: string, modelId: string, tools = true): Promise<RecordedRequest> {
  const definition = provider(providerId)
  const params = definition.webSearch?.(model(modelId, tools), REQUEST)
  expect(params, `${providerId}:${modelId}`).toBeDefined()
  const { rt, requests } = fakeRuntime({ apiKey: 'test-key' }, () => jsonResponse({ error: { message: 'stop here', type: 'test' } }, 400))
  await generateText({
    model: definition.createLanguageModel(modelId, rt),
    prompt: 'Find cats',
    maxRetries: 0,
    ...(params?.tools === undefined ? {} : { tools: params.tools as Record<string, Tool> }),
    ...(params?.providerOptions === undefined ? {} : { providerOptions: params.providerOptions }),
  }).catch(() => {})
  expect(requests).toHaveLength(1)
  return requests[0] as RecordedRequest
}

describe('on the wire', () => {
  it('anthropic: the web_search_20250305 server tool named web_search with max_uses', async () => {
    const request = await wire('anthropic', 'claude-sonnet-5')
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect((request.body as { tools?: unknown[] }).tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
  })

  it('openai: the Responses API web_search tool', async () => {
    const request = await wire('openai', 'gpt-6-sol')
    expect(request.url).toBe('https://api.openai.com/v1/responses')
    expect((request.body as { tools?: unknown[] }).tools).toEqual([expect.objectContaining({ type: 'web_search' })])
  })

  it('google: googleSearch in the tools of a Gemini 3 and of a Gemini 2.5 request', async () => {
    for (const modelId of ['gemini-3.8-flash', 'gemini-2.5-flash']) {
      const request = await wire('google', modelId)
      expect(request.url, modelId).toContain(`/models/${modelId}:generateContent`)
      expect((request.body as { tools?: unknown[] }).tools, modelId).toEqual([{ googleSearch: {} }])
    }
  })

  it('xai: the Responses API web_search tool', async () => {
    const request = await wire('xai', 'grok-4.7')
    expect(request.url).toBe('https://api.x.ai/v1/responses')
    expect((request.body as { tools?: unknown[] }).tools).toEqual([expect.objectContaining({ type: 'web_search' })])
  })

  it('openrouter: openrouter:web_search with max_results; the web plugin (next to usage accounting) without tools', async () => {
    const server = await wire('openrouter', 'anthropic/claude-sonnet-5')
    expect(server.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((server.body as { tools?: unknown[] }).tools).toEqual([{ type: 'openrouter:web_search', max_results: 5 }])
    const plugin = await wire('openrouter', 'some/model-without-tools', false)
    expect(plugin.body).toMatchObject({ plugins: [{ id: 'web', max_results: 5 }], usage: { include: true } })
    expect((plugin.body as { tools?: unknown }).tools).toBeUndefined()
  })

  it('groq: the browser_search tool for gpt-oss', async () => {
    const request = await wire('groq', 'openai/gpt-oss-120b')
    expect(request.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect((request.body as { tools?: unknown[] }).tools).toEqual([{ type: 'browser_search' }])
  })
})
