// Request-level checks through `generateText` with a fake `fetch`: credentials, base URLs, always-on options,
// attribution headers and reasoning parameters as they reach the wire.
import type { ModelInfo, ProviderDefinition, ProviderOptions, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { RecordedRequest } from '../testing.ts'
import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'
import { anthropicMessage, chatCompletion, fakeRuntime, jsonResponse } from '../testing.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'
import { OPENROUTER_APP_NAME, OPENROUTER_APP_URL } from './openrouter.ts'

function provider(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
  if (!definition)
    throw new Error(`Unknown provider "${id}"`)
  return definition
}

interface CallOptions {
  credentials?: Record<string, string>
  effort?: ReasoningEffort
  providerOptions?: ProviderOptions
  maxOutputTokens?: number
}

/** One `generateText` call with the provider's model and (optionally) its reasoning params; returns the request. */
async function call(id: string, modelId: string, response: () => Response, options: CallOptions = {}): Promise<RecordedRequest> {
  const definition = provider(id)
  const { rt, requests } = fakeRuntime(options.credentials ?? { apiKey: 'test-key' }, response)
  const model: ModelInfo = { id: modelId, capabilities: { reasoning: true } }
  const params = options.effort ? definition.reasoning?.(options.effort, model) : undefined
  await generateText({
    model: definition.createLanguageModel(modelId, rt),
    prompt: 'Hello',
    maxRetries: 0,
    reasoning: params?.reasoning,
    providerOptions: params?.providerOptions ?? options.providerOptions,
    maxOutputTokens: params?.maxOutputTokens ?? options.maxOutputTokens,
  })
  expect(requests).toHaveLength(1)
  return requests[0] as RecordedRequest
}

describe('requests on the wire', () => {
  it('anthropic: x-api-key and base URL; max sends adaptive thinking with effort max', async () => {
    const request = await call('anthropic', 'claude-sonnet-5', () => jsonResponse(anthropicMessage('claude-sonnet-5')), { effort: 'max' })
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers['x-api-key']).toBe('test-key')
    expect(request.body).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } })
  })

  it('minimax: default max_tokens instead of the 4096 cap for unknown models; a call value wins', async () => {
    const response = () => jsonResponse(anthropicMessage('MiniMax-M3'))
    const request = await call('minimax', 'MiniMax-M3', response, { effort: 'high' })
    expect(request.url).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(request.headers['x-api-key']).toBe('test-key')
    expect(request.body).toMatchObject({ model: 'MiniMax-M3', max_tokens: 131_072, thinking: { type: 'adaptive' } })

    const legacy = await call('minimax', 'MiniMax-M2.7', response, { maxOutputTokens: 2048 })
    expect(legacy.body).toMatchObject({ max_tokens: 2048 })
    expect((await call('minimax', 'MiniMax-M2.7', response)).body).toMatchObject({ max_tokens: 65_536 })
  })

  it('groq: reasoningFormat parsed for think-tag models (merged with the effort), never for gpt-oss', async () => {
    const qwen = await call('groq', 'qwen/qwen3.8-27b', () => jsonResponse(chatCompletion('qwen/qwen3.8-27b')), { effort: 'off' })
    expect(qwen.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(qwen.body).toMatchObject({ reasoning_format: 'parsed', reasoning_effort: 'none' })

    const gptOss = await call('groq', 'openai/gpt-oss-120b', () => jsonResponse(chatCompletion('openai/gpt-oss-120b')), { effort: 'low' })
    expect(gptOss.body).toMatchObject({ reasoning_effort: 'low' })
    expect((gptOss.body as Record<string, unknown>).reasoning_format).toBeUndefined()
  })

  it('openrouter: attribution headers, usage accounting and the effort in providerOptions', async () => {
    const request = await call('openrouter', 'openai/gpt-6-luna', () => jsonResponse(chatCompletion('openai/gpt-6-luna')), { effort: 'high' })
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request.headers).toMatchObject({
      'authorization': 'Bearer test-key',
      'http-referer': OPENROUTER_APP_URL,
      'x-openrouter-title': OPENROUTER_APP_NAME,
    })
    expect(request.body).toMatchObject({ usage: { include: true }, reasoning: { effort: 'high' } })
  })

  it('ollama: no key by default, the base URL field, reasoning_effort passthrough', async () => {
    const response = () => jsonResponse(chatCompletion('gpt-oss:20b'))
    const request = await call('ollama', 'gpt-oss:20b', response, { credentials: { baseURL: 'http://gpu-box:11434/v1' }, effort: 'max' })
    expect(request.url).toBe('http://gpu-box:11434/v1/chat/completions')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.body).toMatchObject({ model: 'gpt-oss:20b', reasoning_effort: 'max' })

    const off = await call('ollama', 'qwen3:8b', response, { credentials: { baseURL: 'http://localhost:11434/v1', apiKey: 'proxy' }, effort: 'off' })
    expect(off.headers.authorization).toBe('Bearer proxy')
    expect(off.body).toMatchObject({ reasoning_effort: 'none' })
  })

  it('zai: thinking and reasoning_effort in the body', async () => {
    const request = await call('zai', 'glm-5.3', () => jsonResponse(chatCompletion('glm-5.3')), { effort: 'medium' })
    expect(request.url).toBe('https://api.z.ai/api/paas/v4/chat/completions')
    expect(request.body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'medium' })
  })

  it('deepseek: base URL without /v1', async () => {
    const request = await call('deepseek', 'deepseek-flash', () => jsonResponse(chatCompletion('deepseek-flash')))
    expect(request.url).toBe('https://api.deepseek.com/chat/completions')
    expect(request.headers.authorization).toBe('Bearer test-key')
  })
})
