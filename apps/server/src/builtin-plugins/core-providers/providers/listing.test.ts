import type { ModelInfo, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { FakeRoute } from '../testing.ts'
import { modelInfoListSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { chatCompletion, fakeRuntime, jsonResponse } from '../testing.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'

function provider(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
  if (!definition)
    throw new Error(`Unknown provider "${id}"`)
  return definition
}

/** Answers by exact URL; any other request fails the test. */
function routes(table: Record<string, () => Response>): FakeRoute {
  return (request) => {
    const handler = table[request.url]
    if (!handler)
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    return handler()
  }
}

async function list(id: string, credentials: Record<string, string>, route: FakeRoute) {
  const runtime = fakeRuntime(credentials, route)
  const definition = provider(id)
  if (!definition.listModels)
    throw new Error(`${id} has no listModels`)
  const models = await definition.listModels(runtime.rt)
  expect(modelInfoListSchema.safeParse(models).success).toBe(true)
  return { models, requests: runtime.requests }
}

function byId(models: readonly ModelInfo[], id: string): ModelInfo | undefined {
  return models.find(model => model.id === id)
}

function claudeCapabilities(overrides: Record<string, unknown> = {}) {
  return {
    batch: { supported: true },
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
    image_input: { supported: true },
    pdf_input: { supported: true },
    structured_outputs: { supported: true },
    thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
    ...overrides,
  }
}

describe('listModels', () => {
  it('anthropic: pages with after_id and maps capabilities and efforts', async () => {
    const { models, requests } = await list('anthropic', { apiKey: 'sk-ant-test' }, routes({
      'https://api.anthropic.com/v1/models?limit=1000': () => jsonResponse({
        data: [
          {
            id: 'claude-opus-5-5',
            type: 'model',
            display_name: 'Claude Opus 5.5',
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
            capabilities: claudeCapabilities({ thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } } }),
          },
          { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: claudeCapabilities() },
        ],
        has_more: true,
        first_id: 'claude-opus-5-5',
        last_id: 'claude-sonnet-5',
      }),
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5': () => jsonResponse({
        data: [
          {
            id: 'claude-haiku-4-5',
            display_name: 'Claude Haiku 4.5',
            max_input_tokens: 200_000,
            max_tokens: 64_000,
            capabilities: claudeCapabilities({
              effort: { supported: false, low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: null, max: { supported: false } },
              thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } },
            }),
          },
          { id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3', max_input_tokens: 0, max_tokens: 0, capabilities: null },
        ],
        has_more: false,
        first_id: 'claude-haiku-4-5',
        last_id: 'claude-3-haiku-20240307',
      }),
    }))
    expect(requests).toHaveLength(2)
    expect(requests[0]?.headers).toMatchObject({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' })
    expect(models).toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, vision: true, pdf: true, structuredOutput: true, reasoning: true },
        reasoningEfforts: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, vision: true, pdf: true, structuredOutput: true, reasoning: true },
        reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        capabilities: { tools: true, vision: true, pdf: true, structuredOutput: true, reasoning: true },
        reasoningEfforts: ['off', 'low', 'medium', 'high'],
      },
      { id: 'claude-3-haiku-20240307', name: 'Claude Haiku 3', capabilities: { tools: true } },
    ])
  })

  it('openai: keeps chat models and derives reasoning efforts from the id', async () => {
    const ids = ['gpt-6-sol', 'text-embedding-3-large', 'gpt-image-2', 'gpt-4.1', 'o4-mini', 'whisper-1', 'gpt-realtime', 'gpt-5-search-api', 'tts-1', 'sora-2']
    const { models, requests } = await list('openai', { apiKey: 'sk-test', baseURL: 'https://proxy.example.com/v1/' }, routes({
      'https://proxy.example.com/v1/models': () => jsonResponse({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'openai' })) }),
    }))
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-test')
    expect(models).toEqual([
      { id: 'gpt-6-sol', capabilities: { reasoning: true }, reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] },
      { id: 'gpt-4.1' },
      { id: 'o4-mini', capabilities: { reasoning: true }, reasoningEfforts: ['low', 'medium', 'high'] },
    ])
  })

  it('google: follows nextPageToken, strips models/ and keeps generateContent chat models', async () => {
    const gemini = (name: string, extra: Record<string, unknown> = {}) => ({
      name: `models/${name}`,
      displayName: name.toUpperCase(),
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
      ...extra,
    })
    const { models, requests } = await list('google', { apiKey: 'AIza-test' }, routes({
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000': () => jsonResponse({
        models: [
          gemini('gemini-3.8-flash', { thinking: true }),
          gemini('text-embedding-004', { supportedGenerationMethods: ['embedContent'] }),
          gemini('gemini-2.5-flash-image'),
        ],
        nextPageToken: 'page-2',
      }),
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2': () => jsonResponse({
        models: [gemini('gemini-2.5-pro', { thinking: true }), gemini('gemini-live-2.5-flash'), gemini('gemma-3-27b-it', { thinking: false })],
      }),
    }))
    expect(requests[0]?.headers['x-goog-api-key']).toBe('AIza-test')
    expect(models.map(model => model.id)).toEqual(['gemini-3.8-flash', 'gemini-2.5-pro', 'gemma-3-27b-it'])
    expect(byId(models, 'gemini-3.8-flash')).toEqual({
      id: 'gemini-3.8-flash',
      name: 'GEMINI-3.8-FLASH',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { reasoning: true },
      reasoningEfforts: ['low', 'medium', 'high'],
    })
    expect(byId(models, 'gemini-2.5-pro')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(byId(models, 'gemma-3-27b-it')?.capabilities).toEqual({ reasoning: false })
  })

  it('xai: drops grok-imagine models', async () => {
    const { models } = await list('xai', { apiKey: 'xai-test' }, routes({
      'https://api.x.ai/v1/models': () => jsonResponse({ data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }, { id: 'grok-4.20-reasoning' }] }),
    }))
    expect(models).toEqual([
      { id: 'grok-4.6', capabilities: { reasoning: true }, reasoningEfforts: ['low', 'medium', 'high', 'max'] },
      { id: 'grok-4.20-reasoning', capabilities: { reasoning: true }, reasoningEfforts: [] },
    ])
  })

  it('deepseek: maps limits, modalities and effort levels (plus off)', async () => {
    const { models, requests } = await list('deepseek', { apiKey: 'sk-test' }, routes({
      'https://api.deepseek.com/models': () => jsonResponse({
        object: 'list',
        data: [
          {
            id: 'deepseek-flash',
            object: 'model',
            owned_by: 'deepseek',
            name: 'DeepSeek-V4.1-Flash',
            context_window: 1_048_576,
            max_output_tokens: 393_216,
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
          },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ['text'] },
        ],
      }),
    }))
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-test')
    expect(models).toEqual([
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        capabilities: { vision: true, reasoning: true },
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_048_576, maxOutputTokens: 393_216, capabilities: { vision: false } },
    ])
  })

  it('moonshotai: ids with optional context length and Kimi efforts', async () => {
    const { models } = await list('moonshotai', { apiKey: 'sk-test' }, routes({
      'https://api.moonshot.ai/v1/models': () => jsonResponse({ object: 'list', data: [{ id: 'kimi-k3', context_length: 1_048_576 }, { id: 'moonshot-v1-8k', context_length: 8192 }] }),
    }))
    expect(models).toEqual([
      { id: 'kimi-k3', contextWindow: 1_048_576, capabilities: { reasoning: true }, reasoningEfforts: ['low', 'high', 'max'] },
      { id: 'moonshot-v1-8k', contextWindow: 8192 },
    ])
  })

  it('alibaba: keeps qwen / qwq chat models only', async () => {
    const ids = ['qwen3.8-max', 'qwen-mt-turbo', 'text-embedding-v4', 'wan2.6-t2v', 'qwq-plus', 'qwen3-asr-flash', 'qwen-image-edit', 'deepseek-v3.2', 'qwen3-tts-flash']
    const { models } = await list('alibaba', { apiKey: 'sk-test' }, routes({
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models': () => jsonResponse({ object: 'list', data: ids.map(id => ({ id })) }),
    }))
    expect(models).toEqual([{ id: 'qwen3.8-max' }, { id: 'qwq-plus' }])
  })

  it('zai: OpenAI-shaped ids with GLM efforts', async () => {
    const { models } = await list('zai', { apiKey: 'zai-test' }, routes({
      'https://api.z.ai/api/paas/v4/models': () => jsonResponse({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'glm-4.6' }] }),
    }))
    expect(models).toEqual([
      { id: 'glm-5.3', capabilities: { reasoning: true }, reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] },
      { id: 'glm-4.6', capabilities: { reasoning: true }, reasoningEfforts: ['off', 'high'] },
    ])
  })

  it('minimax: Anthropic-shaped listing with x-api-key', async () => {
    const { models, requests } = await list('minimax', { apiKey: 'mm-test' }, routes({
      'https://api.minimax.io/anthropic/v1/models?limit=1000': () => jsonResponse({
        data: [
          { id: 'MiniMax-M3', display_name: 'MiniMax-M3', type: 'model' },
          { id: 'MiniMax-M2.7', display_name: 'MiniMax-M2.7', type: 'model' },
        ],
        first_id: 'MiniMax-M3',
        has_more: false,
        last_id: 'MiniMax-M2.7',
      }),
    }))
    expect(requests[0]?.headers['x-api-key']).toBe('mm-test')
    expect(models).toEqual([
      { id: 'MiniMax-M3', capabilities: { tools: true, vision: true, reasoning: true }, reasoningEfforts: ['off', 'high'] },
      { id: 'MiniMax-M2.7', capabilities: { tools: true, vision: false, reasoning: true }, reasoningEfforts: [] },
    ])
  })

  it('mistral: chat models only, retired models dropped, aliases hidden', async () => {
    const chat = { completion_chat: true, function_calling: true, vision: true }
    const { models } = await list('mistral', { apiKey: 'test' }, routes({
      'https://api.mistral.ai/v1/models': () => jsonResponse({
        object: 'list',
        data: [
          { id: 'mistral-large-latest', name: 'mistral-large-2512', aliases: ['mistral-large-2512'], capabilities: chat, max_context_length: 262_144, deprecation: null },
          { id: 'mistral-large-2512', name: 'mistral-large-2512', aliases: ['mistral-large-latest'], capabilities: chat, max_context_length: 262_144, deprecation: null },
          { id: 'mistral-embed', name: 'mistral-embed', capabilities: { completion_chat: false } },
          { id: 'open-mistral-7b', name: 'open-mistral-7b', capabilities: chat, deprecation: '2025-03-30T12:00:00Z' },
          { id: 'ft:open-mistral-7b:abc', capabilities: chat, archived: true },
          { id: 'magistral-medium-latest', name: 'magistral-medium-2509', capabilities: { completion_chat: true, function_calling: true, vision: false } },
          { id: 'mistral-small-2603', name: 'mistral-small-2603', capabilities: chat, max_context_length: 256_000, deprecation: '2099-01-01T00:00:00Z' },
        ],
      }),
    }))
    expect(models).toEqual([
      { id: 'mistral-large-2512', contextWindow: 262_144, capabilities: { tools: true, vision: true } },
      { id: 'magistral-medium-latest', capabilities: { tools: true, vision: false, reasoning: true }, reasoningEfforts: ['off', 'high'] },
      { id: 'mistral-small-2603', contextWindow: 256_000, capabilities: { tools: true, vision: true, reasoning: true }, reasoningEfforts: ['off', 'high'] },
    ])
  })

  it('groq: active chat models with limits', async () => {
    const { models } = await list('groq', { apiKey: 'gsk_test' }, routes({
      'https://api.groq.com/openai/v1/models': () => jsonResponse({
        object: 'list',
        data: [
          { id: 'openai/gpt-oss-120b', active: true, context_window: 131_072, max_completion_tokens: 65_536 },
          { id: 'whisper-large-v3', active: true, context_window: 448 },
          { id: 'meta-llama/llama-prompt-guard-2-86m', active: true },
          { id: 'openai/gpt-oss-safeguard-20b', active: true },
          { id: 'llama-3.3-70b-versatile', active: true, context_window: 131_072, max_completion_tokens: 32_768 },
          { id: 'mixtral-8x7b-32768', active: false },
        ],
      }),
    }))
    expect(models).toEqual([
      { id: 'openai/gpt-oss-120b', contextWindow: 131_072, maxOutputTokens: 65_536, capabilities: { reasoning: true }, reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'llama-3.3-70b-versatile', contextWindow: 131_072, maxOutputTokens: 32_768 },
    ])
  })

  it('openrouter: public listing with capabilities, efforts and per-token pricing', async () => {
    const luna = {
      id: 'openai/gpt-6-luna',
      name: 'OpenAI: GPT-6 Luna',
      context_length: 1_050_000,
      architecture: { modality: 'text+image+file->text', input_modalities: ['file', 'image', 'text'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.0000001',
        completion: '0.0000005',
        web_search: '0.01',
        input_cache_read: '0.00000001',
        input_cache_write: '0.000000125',
        overrides: [{ min_prompt_tokens: 272_000, prompt: '0.0000002' }],
      },
      top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000, is_moderated: true },
      supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs', 'tool_choice', 'tools'],
      reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'], default_effort: 'medium' },
    }
    const route = routes({
      'https://openrouter.ai/api/v1/models': () => jsonResponse({
        data: [
          luna,
          { id: 'acme/image-gen', architecture: { input_modalities: ['text'], output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0' } },
          { id: 'openrouter/auto', name: 'Auto Router', context_length: 2_000_000, pricing: { prompt: '-1', completion: '-1' }, supported_parameters: ['tools'] },
          { id: 'acme/plain', name: 'Plain', pricing: { prompt: '0', completion: '0' } },
        ],
      }),
    })

    const anonymous = await list('openrouter', {}, route)
    expect(anonymous.requests[0]?.headers.authorization).toBeUndefined()
    const { models, requests } = await list('openrouter', { apiKey: 'sk-or-test' }, route)
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-or-test')
    expect(models).toEqual([
      {
        id: 'openai/gpt-6-luna',
        name: 'OpenAI: GPT-6 Luna',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
        reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
        cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      },
      {
        id: 'openrouter/auto',
        name: 'Auto Router',
        contextWindow: 2_000_000,
        capabilities: { tools: true, reasoning: false, structuredOutput: false },
      },
      { id: 'acme/plain', name: 'Plain', cost: { input: 0, output: 0 } },
    ])
  })

  describe('ollama', () => {
    const show: Record<string, Record<string, unknown>> = {
      'llama3:8b': { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 } },
      'gpt-oss:20b': {
        capabilities: ['completion', 'tools', 'thinking'],
        thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
        model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131_072 },
      },
      'gemma4:latest': { capabilities: ['completion', 'thinking', 'vision'], thinking: { values: [false, true], default: true } },
      'nomic-embed-text:latest': { capabilities: ['embedding'] },
    }
    const tags = ['llama3:8b', 'gpt-oss:20b', 'gemma4:latest', 'nomic-embed-text:latest', 'qwen3:8b']

    const route: FakeRoute = (request) => {
      if (request.url === 'http://localhost:11434/api/tags')
        return jsonResponse({ models: tags.map(name => ({ name, model: name, details: { family: 'x' } })) })
      if (request.url === 'http://localhost:11434/api/show' && request.method === 'POST') {
        const name = (request.body as { model: string }).model
        const body = show[name]
        return body ? jsonResponse(body) : jsonResponse({ error: 'boom' }, 500)
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }

    it('lists /api/tags on the origin and enriches with /api/show', async () => {
      const { models, requests } = await list('ollama', { baseURL: 'http://localhost:11434/v1' }, route)
      expect(requests[0]).toMatchObject({ method: 'GET', url: 'http://localhost:11434/api/tags' })
      expect(requests.filter(request => request.url.endsWith('/api/show'))).toHaveLength(tags.length)
      expect(requests.every(request => request.headers.authorization === undefined)).toBe(true)
      expect(models).toEqual([
        { id: 'llama3:8b', contextWindow: 8192, capabilities: { tools: true, vision: false, reasoning: false } },
        { id: 'gpt-oss:20b', contextWindow: 131_072, capabilities: { tools: true, vision: false, reasoning: true }, reasoningEfforts: ['low', 'medium', 'high'] },
        { id: 'gemma4:latest', capabilities: { tools: false, vision: true, reasoning: true }, reasoningEfforts: ['off', 'high'] },
        { id: 'qwen3:8b' },
      ])
    })

    it('sends the optional key as a bearer token', async () => {
      const { requests } = await list('ollama', { baseURL: 'http://localhost:11434/v1', apiKey: 'proxy-token' }, route)
      expect(requests.every(request => request.headers.authorization === 'Bearer proxy-token')).toBe(true)
    })

    it('falls back to the OpenAI-compatible listing when /api/tags does not exist', async () => {
      const { models } = await list('ollama', { baseURL: 'http://gateway.local:4000/v1' }, routes({
        'http://gateway.local:4000/api/tags': () => jsonResponse({ error: 'not found' }, 404),
        'http://gateway.local:4000/v1/models': () => jsonResponse({ object: 'list', data: [{ id: 'llama3.3' }] }),
      }))
      expect(models).toEqual([{ id: 'llama3.3' }])
    })

    it('reports an unreachable server with an Ollama hint', async () => {
      const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
      const { rt } = fakeRuntime({ baseURL: 'http://localhost:11434/v1' }, () => {
        throw new TypeError('fetch failed', { cause: refused })
      })
      const definition = provider('ollama')
      const error: unknown = await definition.listModels?.(rt).then(() => undefined, (reason: unknown) => reason)
      expect(definition.mapError?.(error)).toMatchObject({
        code: 'provider_unreachable',
        message: 'Cannot reach Ollama at http://localhost:11434. Is Ollama running?',
        providerId: 'ollama',
        action: 'retry',
      })
    })
  })

  it('rejects a 2xx body that is not a model list', async () => {
    const { rt } = fakeRuntime({ apiKey: 'test' }, () => jsonResponse({ unexpected: true }))
    await expect(provider('groq').listModels?.(rt)).rejects.toThrow('Groq returned an unexpected model list.')
  })

  it('turns a failed listing into an APICallError the provider maps', async () => {
    const { rt } = fakeRuntime({ apiKey: 'bad' }, () => jsonResponse({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401))
    const definition = provider('groq')
    const error: unknown = await definition.listModels?.(rt).then(() => undefined, (reason: unknown) => reason)
    expect(error).toMatchObject({ statusCode: 401, url: 'https://api.groq.com/openai/v1/models' })
    expect(definition.mapError?.(error)).toMatchObject({ code: 'auth_invalid', status: 401, action: 'configure-provider' })
  })
})

describe('validate', () => {
  it('openrouter: checks the key with GET /key (the listing is public)', async () => {
    const ok = fakeRuntime({ apiKey: 'sk-or-good' }, routes({
      'https://openrouter.ai/api/v1/key': () => jsonResponse({ data: { label: 'harness', usage: 0, limit: null } }),
    }))
    await expect(provider('openrouter').validate?.(ok.rt)).resolves.toBeUndefined()
    expect(ok.requests[0]?.headers.authorization).toBe('Bearer sk-or-good')

    const bad = fakeRuntime({ apiKey: 'sk-or-bad' }, () => jsonResponse({ error: { message: 'User not found.', code: 401 } }, 401))
    const error: unknown = await provider('openrouter').validate?.(bad.rt).then(() => undefined, (reason: unknown) => reason)
    expect(provider('openrouter').mapError?.(error)).toMatchObject({ code: 'auth_invalid', providerId: 'openrouter' })
  })

  it('openrouter: a proxy base URL without /key gets a tiny call instead', async () => {
    const proxied = fakeRuntime({ apiKey: 'sk-or-good', baseURL: 'https://gateway.example.com/openrouter/v1' }, routes({
      'https://gateway.example.com/openrouter/v1/key': () => jsonResponse({ error: 'Not Found' }, 404),
      'https://gateway.example.com/openrouter/v1/chat/completions': () => jsonResponse(chatCompletion('openai/gpt-6-luna')),
    }))
    await expect(provider('openrouter').validate?.(proxied.rt)).resolves.toBeUndefined()
    expect(proxied.requests[1]?.body).toMatchObject({ model: 'openai/gpt-6-luna', max_tokens: 16, usage: { include: true } })
  })

  it('zai: uses the listing, and falls back to a tiny call when /models is missing', async () => {
    const listed = fakeRuntime({ apiKey: 'zai-key' }, () => jsonResponse({ data: [{ id: 'glm-5.3' }] }))
    await expect(provider('zai').validate?.(listed.rt)).resolves.toBeUndefined()
    expect(listed.requests).toHaveLength(1)

    const fallback = fakeRuntime({ apiKey: 'zai-key' }, routes({
      'https://api.z.ai/api/paas/v4/models': () => jsonResponse({ error: { code: '404', message: 'Not Found' } }, 404),
      'https://api.z.ai/api/paas/v4/chat/completions': () => jsonResponse(chatCompletion('glm-5.3-flash')),
    }))
    await expect(provider('zai').validate?.(fallback.rt)).resolves.toBeUndefined()
    expect(fallback.requests[1]?.body).toMatchObject({ model: 'glm-5.3-flash', thinking: { type: 'disabled' } })

    const rejected = fakeRuntime({ apiKey: 'zai-key' }, () => jsonResponse({ error: { code: '401', message: 'token expired or incorrect' } }, 401))
    await expect(provider('zai').validate?.(rejected.rt)).rejects.toMatchObject({ statusCode: 401 })
    expect(rejected.requests).toHaveLength(1)
  })
})
