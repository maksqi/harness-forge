// Unit tests of the live provider suite's support code (ADR-027), part of `pnpm test`: the provider matrix, the summary
// table, the caps and the stream evaluation, plus a rehearsal of every check against a scripted in-process provider.
// No network, no real keys, and the repository `.env` is never read here.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable, HookMap, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { UIMessageChunk } from 'ai'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { LiveTarget } from './checks.ts'
import type { LiveProviderReport } from './summary.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { APICallError } from '@ai-sdk/provider'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_PLUGINS } from '../builtin-plugins/index.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import {
  capChatParams,
  chatCost,
  collectChunks,
  errorResult,
  FALLBACK_PRICE_PER_MILLION,
  LIVE_BAD_KEY,
  LIVE_CAPS,
  LIVE_TOOL,
  parseSseEvent,
  pickReasoningEffort,
  runProviderChecks,
  thrownResult,
} from './checks.ts'
import {
  buildLiveMatrix,
  DEFAULT_LIVE_BUDGET_USD,
  findKey,
  liveProviderSpecs,
  mergeEnv,
  ollamaModelNames,
  parseLiveBudget,
  parseProviderFilter,
  pickOllamaModel,
  probeOllama,
  readEnvFile,
  resolveLiveMatrix,
} from './matrix.ts'
import {
  checkStatus,
  createLiveBudget,
  failedChecks,
  formatLiveSummary,
  LIVE_CHECKS,
  maskSecrets,
  oneLine,
  skippedReport,
  writeLiveSummary,
} from './summary.ts'

const SPECS = liveProviderSpecs()
const PROVIDER_IDS = SPECS.map(spec => spec.providerId)

describe('live matrix', () => {
  it('reads the key variables (aliases in order) and the model of every builtin provider', () => {
    expect(Object.fromEntries(SPECS.map(spec => [spec.providerId, spec.envVars]))).toEqual({
      anthropic: ['ANTHROPIC_API_KEY'],
      openai: ['OPENAI_API_KEY'],
      google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      xai: ['XAI_API_KEY'],
      deepseek: ['DEEPSEEK_API_KEY'],
      moonshotai: ['MOONSHOT_API_KEY'],
      alibaba: ['ALIBABA_API_KEY', 'DASHSCOPE_API_KEY'],
      zai: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
      minimax: ['MINIMAX_API_KEY'],
      mistral: ['MISTRAL_API_KEY'],
      groq: ['GROQ_API_KEY'],
      openrouter: ['OPENROUTER_API_KEY'],
      ollama: [],
    })
    expect(Object.fromEntries(SPECS.map(spec => [spec.providerId, spec.modelId]))).toEqual({
      anthropic: 'claude-haiku-4-5',
      openai: 'gpt-6-luna',
      google: 'gemini-3.5-flash-lite',
      xai: 'grok-4.3',
      deepseek: 'deepseek-flash',
      moonshotai: 'kimi-k2.6',
      alibaba: 'qwen3.8-flash',
      zai: 'glm-5.3-flash',
      minimax: 'MiniMax-M3',
      mistral: 'mistral-small-latest',
      groq: 'openai/gpt-oss-20b',
      openrouter: 'openai/gpt-6-luna',
      ollama: null,
    })
    expect(SPECS.filter(spec => spec.keyField !== 'apiKey').map(spec => spec.providerId)).toEqual(['ollama'])
    expect(SPECS.find(spec => spec.providerId === 'ollama')?.keyField).toBeNull()
  })

  it('takes the first non-empty key variable', () => {
    const names = ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
    expect(findKey(names, { GOOGLE_GENERATIVE_AI_API_KEY: '  ', GEMINI_API_KEY: ' gem-key ', GOOGLE_API_KEY: 'other' })).toEqual({ name: 'GEMINI_API_KEY', value: 'gem-key' })
    expect(findKey(names, { GOOGLE_GENERATIVE_AI_API_KEY: 'first', GOOGLE_API_KEY: 'other' })).toEqual({ name: 'GOOGLE_GENERATIVE_AI_API_KEY', value: 'first' })
    expect(findKey(names, { GOOGLE_GENERATIVE_AI_API_KEY: '' })).toBeNull()
    expect(findKey([], { ANY: 'value' })).toBeNull()
  })

  it('parses HF_LIVE_PROVIDERS: unset means every provider, none means none, unknown ids throw', () => {
    expect(parseProviderFilter(undefined, PROVIDER_IDS)).toBeNull()
    expect(parseProviderFilter(' , ', PROVIDER_IDS)).toBeNull()
    expect([...parseProviderFilter(' Anthropic, openai ,', PROVIDER_IDS)!]).toEqual(['anthropic', 'openai'])
    expect(parseProviderFilter('none', PROVIDER_IDS)?.size).toBe(0)
    expect(() => parseProviderFilter('anthropic,antropic', PROVIDER_IDS)).toThrow('HF_LIVE_PROVIDERS: unknown provider id "antropic"')
    expect(() => parseProviderFilter('none,openai', PROVIDER_IDS)).toThrow('unknown provider id "none"')
  })

  it('parses HF_LIVE_MAX_COST_USD with a 0.50 default', () => {
    expect(DEFAULT_LIVE_BUDGET_USD).toBe(0.5)
    expect(parseLiveBudget(undefined)).toBe(0.5)
    expect(parseLiveBudget(' ')).toBe(0.5)
    expect(parseLiveBudget('0.20')).toBe(0.2)
    expect(parseLiveBudget('0')).toBe(0)
    expect(parseLiveBudget('3')).toBe(3)
    for (const value of ['-1', 'abc', '1e3', '$1', '0.5.1'])
      expect(() => parseLiveBudget(value), value).toThrow('HF_LIVE_MAX_COST_USD must be a non-negative number')
  })

  it('runs providers with a key, skips the others with the variable names, and uses the alias that is set', () => {
    const entries = buildLiveMatrix({
      specs: SPECS,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'gem-test', OPENAI_API_KEY: '   ' },
      filter: null,
      ollama: { reachable: false, reason: 'no answer' },
    })
    expect(entries.map(entry => entry.providerId)).toEqual(PROVIDER_IDS)
    expect(entries.filter(entry => entry.status === 'run')).toEqual([
      { status: 'run', providerId: 'anthropic', keyField: 'apiKey', envVars: ['ANTHROPIC_API_KEY'], envVar: 'ANTHROPIC_API_KEY', key: 'sk-ant-test', modelId: 'claude-haiku-4-5' },
      { status: 'run', providerId: 'google', keyField: 'apiKey', envVars: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'], envVar: 'GEMINI_API_KEY', key: 'gem-test', modelId: 'gemini-3.5-flash-lite' },
    ])
    const reasons = Object.fromEntries(entries.flatMap(entry => (entry.status === 'skip' ? [[entry.providerId, entry.reason]] : [])))
    expect(reasons.openai).toBe('no key (set OPENAI_API_KEY)')
    expect(reasons.alibaba).toBe('no key (set ALIBABA_API_KEY or DASHSCOPE_API_KEY)')
    expect(reasons.ollama).toBe('Ollama is not running (no answer)')
  })

  it('applies the filter and runs Ollama on the first chat model of its local listing', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test', GROQ_API_KEY: 'gsk-test' }
    const entries = buildLiveMatrix({ specs: SPECS, env, filter: new Set(['groq', 'ollama']), ollama: { reachable: true, models: ['nomic-embed-text:latest', 'llama3.2:3b', 'qwen3:8b'] } })
    const byId = new Map(entries.map(entry => [entry.providerId, entry]))
    expect(byId.get('anthropic')).toMatchObject({ status: 'skip', reason: 'not selected by HF_LIVE_PROVIDERS' })
    expect(byId.get('groq')).toMatchObject({ status: 'run', envVar: 'GROQ_API_KEY', modelId: 'openai/gpt-oss-20b' })
    expect(byId.get('ollama')).toEqual({ status: 'run', providerId: 'ollama', keyField: null, envVars: [], envVar: null, key: null, modelId: 'llama3.2:3b' })
    const embedOnly = buildLiveMatrix({ specs: SPECS, env: {}, filter: new Set(['ollama']), ollama: { reachable: true, models: ['nomic-embed-text'] } })
    expect(embedOnly.find(entry => entry.providerId === 'ollama')).toMatchObject({ status: 'skip', reason: expect.stringContaining('no chat model') })
    const none = buildLiveMatrix({ specs: SPECS, env, filter: new Set(), ollama: null })
    expect(none.every(entry => entry.status === 'skip')).toBe(true)
  })

  it('probes Ollama only when it is selected', async () => {
    const probe = vi.fn(async () => ({ reachable: true as const, models: ['llama3.2:3b'] }))
    const selected = await resolveLiveMatrix({ HF_LIVE_PROVIDERS: 'ollama' }, { probe })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(selected.find(entry => entry.providerId === 'ollama')).toMatchObject({ status: 'run', modelId: 'llama3.2:3b' })
    probe.mockClear()
    const others = await resolveLiveMatrix({ HF_LIVE_PROVIDERS: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' }, { probe })
    expect(probe).not.toHaveBeenCalled()
    expect(others.filter(entry => entry.status === 'run').map(entry => entry.providerId)).toEqual(['anthropic'])
    await expect(resolveLiveMatrix({ HF_LIVE_PROVIDERS: 'nope' }, { probe })).rejects.toThrow('unknown provider id "nope"')
  })

  it('reads the Ollama listing and gives up after the timeout', async () => {
    const listing = { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }, { model: 'qwen3:8b' }, { name: '' }, 'junk'] }
    expect(ollamaModelNames(listing)).toEqual(['llama3.2:3b', 'qwen3:8b'])
    expect(ollamaModelNames({ models: 'nope' })).toEqual([])
    expect(pickOllamaModel(['bge-m3-embed', 'whisper-small', 'mistral:7b'])).toBe('mistral:7b')
    expect(pickOllamaModel([])).toBeNull()

    const requested: string[] = []
    const answering: typeof globalThis.fetch = async (input) => {
      requested.push(String(input))
      return new Response(JSON.stringify(listing), { headers: { 'content-type': 'application/json' } })
    }
    expect(await probeOllama({ fetch: answering })).toEqual({ reachable: true, models: ['llama3.2:3b', 'qwen3:8b'] })
    expect(requested).toEqual(['http://localhost:11434/api/tags'])

    const failing: typeof globalThis.fetch = async () => new Response('down', { status: 503 })
    expect(await probeOllama({ fetch: failing })).toEqual({ reachable: false, reason: 'Ollama answered HTTP 503 at http://localhost:11434/api/tags' })

    const hanging: typeof globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    const started = performance.now()
    expect(await probeOllama({ fetch: hanging, timeoutMs: 30 })).toEqual({ reachable: false, reason: 'no answer from http://localhost:11434/api/tags within 30 ms' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('reads a .env file without touching process.env; variables already set win, even when empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-live-env-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, '# keys\nFROM_FILE_ONLY=file-value\nALREADY_SET=file-value\nEMPTY_IN_SHELL="quoted value"\n')
      const parsed = readEnvFile(file)
      expect(parsed).toEqual({ FROM_FILE_ONLY: 'file-value', ALREADY_SET: 'file-value', EMPTY_IN_SHELL: 'quoted value' })
      expect(process.env.FROM_FILE_ONLY).toBeUndefined()
      expect(mergeEnv({ ALREADY_SET: 'shell-value', EMPTY_IN_SHELL: '' }, parsed)).toEqual({ FROM_FILE_ONLY: 'file-value', ALREADY_SET: 'shell-value', EMPTY_IN_SHELL: '' })
      expect(readEnvFile(join(dir, 'missing.env'))).toEqual({})
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('live summary', () => {
  const SECRET = 'sk-live-secret-value-123456'

  function reportsFixture(): LiveProviderReport[] {
    return [
      {
        providerId: 'anthropic',
        envVars: ['ANTHROPIC_API_KEY'],
        envVar: 'ANTHROPIC_API_KEY',
        modelId: 'claude-haiku-4-5',
        checks: {
          test: { status: 'PASS', detail: '9 models, 210 ms' },
          models: { status: 'PASS' },
          chat: { status: 'PASS', detail: 'in 14 / out 2 tokens' },
          reasoning: { status: 'FAIL', detail: `auth_invalid: the key ${SECRET} was\nrejected` },
          tools: { status: 'SKIP', detail: 'rate limited' },
          badKey: { status: 'PASS' },
          logs: { status: 'PASS' },
        },
        costUsd: 0.0012,
        costEstimated: true,
      },
      skippedReport({ providerId: 'google', envVars: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'], modelId: 'gemini-3.5-flash-lite', reason: 'no key' }),
      skippedReport({ providerId: 'ollama', envVars: [], modelId: null, reason: 'Ollama is not running' }),
    ]
  }

  it('renders one row per provider with variable names, statuses and cost, and masks key values', () => {
    const markdown = formatLiveSummary(reportsFixture(), { budget: { limitUsd: 0.5, spentUsd: 0.0012, estimated: true }, secrets: [SECRET, null] })
    const lines = markdown.split('\n')
    expect(lines).toContain('| Provider | Key variable | Model | Test | Models | Chat | Reasoning | Tools | Bad key | Key not logged | Cost (USD) |')
    expect(lines).toContain('| anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | PASS | PASS | PASS | FAIL | SKIP | PASS | PASS | ~0.0012 |')
    expect(lines).toContain('| google | `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-3.5-flash-lite` | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | - |')
    expect(lines).toContain('| ollama | none (local) | - | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | - |')
    expect(lines).toContain('Providers: 1 run, 2 skipped. Checks: 5 PASS, 1 FAIL, 1 SKIP. Spent $0.0012 of $0.5000 (HF_LIVE_MAX_COST_USD), partly estimated (~).')
    expect(lines).toContain('  - Reasoning: FAIL (auth_invalid: the key [redacted] was rejected)')
    expect(lines).toContain('  - Models: PASS')
    expect(lines).toContain('- **google**: SKIP (no key)')
    expect(markdown).not.toContain(SECRET)
    expect(LIVE_CHECKS.map(check => check.id)).toEqual(['test', 'models', 'chat', 'reasoning', 'tools', 'badKey', 'logs'])
  })

  it('lists failed checks and treats a missing check as SKIP', () => {
    const [report] = reportsFixture()
    expect(failedChecks(report!)).toEqual([`Reasoning: auth_invalid: the key ${SECRET} was\nrejected`])
    expect(checkStatus({ ...report!, checks: {} }, 'chat')).toBe('SKIP')
  })

  it('masks secrets of six or more characters and keeps details on one line', () => {
    expect(maskSecrets('a sk-123456 b sk-123456', ['sk-123456'])).toBe('a [redacted] b [redacted]')
    expect(maskSecrets('short abc', ['abc', '', null, undefined])).toBe('short abc')
    expect(oneLine('  a\n\tb  ')).toBe('a b')
    expect(oneLine('x'.repeat(250))).toHaveLength(200)
  })

  it('prints the summary and appends it to GITHUB_STEP_SUMMARY when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-live-summary-'))
    try {
      const file = join(dir, 'summary.md')
      const printed: string[] = []
      writeLiveSummary('## one', { GITHUB_STEP_SUMMARY: file }, text => void printed.push(text))
      writeLiveSummary('## two', { GITHUB_STEP_SUMMARY: file }, text => void printed.push(text))
      expect(readFileSync(file, 'utf8')).toBe('## one\n## two\n')
      writeLiveSummary('## three', {}, text => void printed.push(text))
      expect(printed).toEqual(['## one', '## two', '## three'])
      expect(existsSync(join(dir, 'other.md'))).toBe(false)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tracks the budget', () => {
    const budget = createLiveBudget(0.25)
    expect(budget).toEqual({ limitUsd: 0.25, spentUsd: 0, estimated: false })
  })
})

describe('live checks: caps, results and stream parsing', () => {
  function paramsFor(reasoning: boolean, effort: HookMap['chat.params'][0]['reasoningEffort'], output: Partial<HookMap['chat.params'][1]> = {}): HookMap['chat.params'][1] {
    const draft: HookMap['chat.params'][1] = { instructions: '', maxSteps: 20, providerOptions: {}, ...output }
    capChatParams({ chatId: 'c', modelRef: 'p:m', model: { id: 'm', capabilities: { reasoning } }, reasoningEffort: effort, toolMode: 'auto' }, draft)
    return draft
  }

  it('caps the output at 256 tokens (2048 when the model reasons) and the steps at 3', () => {
    expect(LIVE_CAPS).toEqual({ outputTokens: 256, reasoningOutputTokens: 2048, maxSteps: 3 })
    expect(paramsFor(false, 'auto')).toMatchObject({ maxOutputTokens: 256, maxSteps: 3 })
    expect(paramsFor(true, 'auto')).toMatchObject({ maxOutputTokens: 2048, maxSteps: 3 })
    expect(paramsFor(true, 'low')).toMatchObject({ maxOutputTokens: 2048 })
    expect(paramsFor(true, 'off')).toMatchObject({ maxOutputTokens: 256 })
    expect(paramsFor(true, 'high', { maxOutputTokens: 100_000 })).toMatchObject({ maxOutputTokens: 2048 })
    expect(paramsFor(false, 'auto', { maxOutputTokens: 64, maxSteps: 1 })).toMatchObject({ maxOutputTokens: 64, maxSteps: 1 })
  })

  it('picks effort low, else the lowest offered effort, only for reasoning models', () => {
    const model = (reasoning: boolean, efforts: string[]) => ({ capabilities: { tools: false, vision: false, pdf: false, reasoning, structuredOutput: false }, reasoningEfforts: efforts as never })
    expect(pickReasoningEffort(model(true, ['auto', 'off', 'low', 'high']))).toBe('low')
    expect(pickReasoningEffort(model(true, ['auto', 'off', 'high']))).toBe('high')
    expect(pickReasoningEffort(model(true, ['auto', 'medium', 'max']))).toBe('medium')
    expect(pickReasoningEffort(model(true, ['auto', 'off']))).toBeNull()
    expect(pickReasoningEffort(model(true, []))).toBeNull()
    expect(pickReasoningEffort(model(false, ['auto', 'low']))).toBeNull()
  })

  it('reports a rate limit (429) as SKIP and every other error as FAIL', () => {
    expect(errorResult({ code: 'rate_limited', message: 'Slow down.', status: 429 })).toEqual({ status: 'SKIP', detail: 'rate limited, rate_limited (HTTP 429): Slow down.' })
    expect(errorResult({ code: 'provider_error', message: 'Busy.', status: 429 }).status).toBe('SKIP')
    expect(errorResult({ code: 'auth_invalid', message: 'Invalid key.', status: 401 })).toEqual({ status: 'FAIL', detail: 'auth_invalid (HTTP 401): Invalid key.' })
    expect(thrownResult(new Error('boom'))).toEqual({ status: 'FAIL', detail: 'Error: boom' })
    expect(thrownResult('text')).toEqual({ status: 'FAIL', detail: 'text' })
  })

  it('parses SSE events and folds the chunks of a UI message stream', () => {
    expect(parseSseEvent('data: [DONE]')).toBeNull()
    expect(parseSseEvent(': keep-alive')).toBeNull()
    expect(parseSseEvent('data: {not json')).toBeNull()
    expect(parseSseEvent('data: {"type":"text-delta","id":"t","delta":"hi"}')).toEqual({ type: 'text-delta', id: 't', delta: 'hi' })
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'msg_a000000000000001', messageMetadata: { modelRef: 'p:m', startedAt: 1 } },
      { type: 'reasoning-delta', id: 'r', delta: 'Thinking.' },
      { type: 'tool-input-available', toolCallId: 'call_1', toolName: LIVE_TOOL, input: {} },
      { type: 'tool-output-available', toolCallId: 'call_1', output: { iso: 'x' } },
      { type: 'text-delta', id: 't', delta: 'po' },
      { type: 'text-delta', id: 't', delta: 'ng' },
      { type: 'error', errorText: JSON.stringify({ error: { code: 'rate_limited', message: 'Later.', status: 429 } }) },
      { type: 'error', errorText: 'second error is ignored' },
      { type: 'finish', finishReason: 'stop', messageMetadata: { modelRef: 'p:m', startedAt: 1, usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'stop' } },
    ]
    const result = collectChunks(chunks)
    expect(result).toMatchObject({
      messageId: 'msg_a000000000000001',
      text: 'pong',
      reasoning: 'Thinking.',
      toolCalls: [{ toolCallId: 'call_1', toolName: LIVE_TOOL }],
      toolOutputs: ['call_1'],
      error: { code: 'rate_limited', message: 'Later.', status: 429 },
      finished: true,
      metadata: { usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'stop' },
    })
    expect(collectChunks([{ type: 'error', errorText: 'plain text' }]).error).toEqual({ code: 'internal_error', message: 'plain text' })
  })

  it('counts the recorded cost, else estimates it with the fallback prices', () => {
    expect(FALLBACK_PRICE_PER_MILLION).toEqual({ input: 3, output: 15 })
    expect(chatCost({ inputTokens: 100, outputTokens: 10, costUsd: 0.0001 })).toEqual({ usd: 0.0001, estimated: false })
    expect(chatCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: null })).toEqual({ usd: 18, estimated: true })
    expect(chatCost({ inputTokens: 0, outputTokens: 0, costUsd: null })).toEqual({ usd: 0, estimated: false })
  })
})

// ---------- rehearsal: every check against a scripted provider (no network) ----------

const REHEARSAL_KEY = 'rehearsal-key-7f3a9c1e5b2d'
const REHEARSAL_TARGET: LiveTarget = {
  providerId: 'rehearsal',
  keyField: 'apiKey',
  envVars: ['REHEARSAL_API_KEY'],
  envVar: 'REHEARSAL_API_KEY',
  key: REHEARSAL_KEY,
  modelId: 'small',
}

/** An empty `mock` builtin that owns the rehearsal provider (as in the chat route tests). */
const OWNER: BuiltinPlugin = {
  id: 'mock',
  manifest: { manifestVersion: 1, id: 'mock', name: 'Mock', version: '1.0.0', engines: { harness: '^1.0.0' } },
  module: { setup: () => {} },
}

interface RehearsalState {
  calls: LanguageModelV4CallOptions[]
  rateLimited: boolean
}

function finishPart(reason: 'stop' | 'tool-calls'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

/** Calls `current_time` when it is offered and the prompt does not end with its result; else answers (with reasoning). */
function rehearsalModel(state: RehearsalState): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'rehearsal',
    modelId: 'small',
    doStream: async (options) => {
      state.calls.push(options)
      if (state.rateLimited)
        throw new APICallError({ message: 'Too many requests', url: 'https://rehearsal.invalid/v1/chat', requestBodyValues: {}, statusCode: 429, isRetryable: false })
      const lastRole = options.prompt.at(-1)?.role
      if ((options.tools ?? []).some(tool => tool.name === LIVE_TOOL) && lastRole !== 'tool') {
        return { stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'tool-call', toolCallId: `call_${state.calls.length}`, toolName: LIVE_TOOL, input: '{"timezone":"UTC"}' },
          finishPart('tool-calls'),
        ]) }
      }
      const parts: LanguageModelV4StreamPart[] = []
      if (options.reasoning !== undefined && options.reasoning !== 'none' && options.reasoning !== 'provider-default')
        parts.push({ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'Adding the numbers.' }, { type: 'reasoning-end', id: 'r' })
      const answer = lastRole === 'tool' ? '2026-09-28' : 'pong'
      parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: answer }, { type: 'text-end', id: 't' }, finishPart('stop'))
      return { stream: convertArrayToReadableStream(parts) }
    },
  })
}

function rehearsalProvider(state: RehearsalState): ProviderDefinition {
  return {
    id: 'rehearsal',
    name: 'Rehearsal',
    credentials: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'REHEARSAL_API_KEY' }],
    smallModelId: 'small',
    async listModels(rt) {
      if (rt.credentials.apiKey !== REHEARSAL_KEY)
        throw new APICallError({ message: 'Invalid API key', url: 'https://rehearsal.invalid/v1/models', requestBodyValues: {}, statusCode: 401, isRetryable: false })
      return [{ id: 'small', name: 'Small', contextWindow: 32_000, capabilities: { tools: true, reasoning: true }, reasoningEfforts: ['off', 'low', 'medium', 'high'], cost: { input: 1, output: 2 } }]
    },
    reasoning: effort => (effort === 'auto' ? undefined : { reasoning: effort === 'off' ? 'none' : effort === 'max' ? 'xhigh' : effort }),
    createLanguageModel: () => rehearsalModel(state),
  }
}

describe('live checks: rehearsal against a scripted provider', () => {
  let t: TestApp
  let registration: Disposable
  const state: RehearsalState = { calls: [], rateLimited: false }

  beforeAll(async () => {
    const coreTools = BUILTIN_PLUGINS.find(plugin => plugin.id === 'core-tools')!
    t = await createTestApp({ env: { HF_OFFLINE: '1', REHEARSAL_API_KEY: REHEARSAL_KEY }, builtins: [coreTools, OWNER] })
    registration = t.deps.registry.providers.register('mock', rehearsalProvider(state))
  })

  beforeEach(() => {
    state.calls.length = 0
    state.rateLimited = false
  })

  afterAll(async () => {
    registration.dispose()
    await t.close()
  })

  it('passes every check against a well-behaved provider, with the caps and only current_time applied', async () => {
    const budget = createLiveBudget(0.5)
    const report = await runProviderChecks(t, REHEARSAL_TARGET, budget)
    expect(Object.fromEntries(LIVE_CHECKS.map(({ id }) => [id, report.checks[id]?.status])), JSON.stringify(report.checks, null, 2)).toEqual({
      test: 'PASS',
      models: 'PASS',
      chat: 'PASS',
      reasoning: 'PASS',
      tools: 'PASS',
      badKey: 'PASS',
      logs: 'PASS',
    })
    expect(report.checks.chat?.detail).toContain('in 12 / out 3 tokens, answer "pong"')
    expect(report.checks.reasoning?.detail).toContain('effort low')
    expect(report.checks.tools?.detail).toContain(`1 ${LIVE_TOOL} call(s), answer "2026-09-28"`)
    expect(report.checks.badKey?.detail).toBe('auth_invalid (HTTP 401)')
    expect(report).toMatchObject({ providerId: 'rehearsal', envVar: 'REHEARSAL_API_KEY', modelId: 'small', costEstimated: false })
    expect(report.costUsd).toBeGreaterThan(0)
    expect(budget.spentUsd).toBeCloseTo(report.costUsd, 10)

    // chat (1 call), reasoning (1 call), tools (2 calls: the tool call, then the answer).
    expect(state.calls).toHaveLength(4)
    expect(state.calls.every(call => call.maxOutputTokens === LIVE_CAPS.reasoningOutputTokens)).toBe(true)
    expect(state.calls.map(call => call.reasoning ?? null)).toEqual([null, 'low', null, null])
    expect(state.calls.map(call => call.tools?.map(tool => tool.name) ?? [])).toEqual([[], [], [LIVE_TOOL], [LIVE_TOOL]])
    // The bad key never reached the stored credentials: the provider still tests fine.
    expect(await t.client.providers.test({ params: { id: 'rehearsal' } })).toMatchObject({ ok: true })
    expect(t.logs.text()).not.toContain(REHEARSAL_KEY)
    expect(LIVE_BAD_KEY).not.toBe(REHEARSAL_KEY)
  })

  it('reports rate-limited model calls as SKIP', async () => {
    state.rateLimited = true
    const report = await runProviderChecks(t, REHEARSAL_TARGET, createLiveBudget(0.5))
    expect(LIVE_CHECKS.map(({ id }) => checkStatus(report, id))).toEqual(['PASS', 'PASS', 'SKIP', 'SKIP', 'SKIP', 'PASS', 'PASS'])
    expect(report.checks.chat?.detail).toContain('rate limited, rate_limited')
    expect(failedChecks(report)).toEqual([])
  })

  it('skips the paid checks once the budget is spent, without calling the model', async () => {
    const report = await runProviderChecks(t, REHEARSAL_TARGET, createLiveBudget(0))
    expect(LIVE_CHECKS.map(({ id }) => checkStatus(report, id))).toEqual(['PASS', 'PASS', 'SKIP', 'SKIP', 'SKIP', 'PASS', 'PASS'])
    expect(report.checks.tools?.detail).toBe('the budget of $0.0000 is spent (HF_LIVE_MAX_COST_USD)')
    expect(state.calls).toHaveLength(0)
    expect(report.costUsd).toBe(0)
  })

  it('fails the model checks of a model that is not in the listing', async () => {
    const report = await runProviderChecks(t, { ...REHEARSAL_TARGET, modelId: 'missing-model' }, createLiveBudget(0.5))
    expect(report.checks.models).toEqual({ status: 'FAIL', detail: '"missing-model" is not in the listing (1 visible models)' })
    expect(LIVE_CHECKS.map(({ id }) => checkStatus(report, id))).toEqual(['PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'PASS', 'PASS'])
    expect(state.calls).toHaveLength(0)
  })
})
