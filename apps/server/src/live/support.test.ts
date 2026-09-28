// Unit tests of the live provider suite's support code (ADR-027), part of `pnpm test`: the provider matrix, the media
// matrix and its caps, the summary table, the caps and the stream evaluation, plus a rehearsal of every check (the
// media checks included) against scripted in-process providers. No network, no real keys, and the repository `.env` is
// never read here.
import type {
  ImageModelV4CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  SpeechModelV4CallOptions,
  TranscriptionModelV4CallOptions,
} from '@ai-sdk/provider'
import type { Disposable, HookMap, ModelInfo, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { ChatStreamResult, LiveTarget } from './checks.ts'
import type { LiveImageSource } from './matrix.ts'
import type { LiveMediaTarget, LiveSpeechClip } from './media.ts'
import type { LiveMediaCheckId, LiveProviderReport } from './summary.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { APICallError } from '@ai-sdk/provider'
import { imageOptionsSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockImageModelV4, MockLanguageModelV4, MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { BUILTIN_PLUGINS } from '../builtin-plugins/index.ts'
import { createMockWav } from '../builtin-plugins/mock/index.ts'
import { encodeSolidPng } from '../builtin-plugins/mock/png.ts'
import { providerServesKind } from '../catalog/classify.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import {
  capChatParams,
  chatCost,
  collectChunks,
  emptyStreamResult,
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
  buildLiveMediaMatrix,
  DEFAULT_LIVE_BUDGET_USD,
  findKey,
  LIVE_MEDIA_MODELS,
  LIVE_MEDIA_RUN_ORDER,
  liveMediaChecks,
  liveMediaSpecs,
  liveProviderSpecs,
  mergeEnv,
  ollamaModelNames,
  parseLiveBudget,
  parseLiveMediaFlag,
  parseProviderFilter,
  pickOllamaModel,
  probeOllama,
  readEnvFile,
  resolveLiveMatrix,
  resolveLiveMediaMatrix,
} from './matrix.ts'
import {
  capImageOutputParams,
  combineResults,
  createLiveMediaResults,
  evaluateImageReply,
  evaluateSpeech,
  evaluateTranscription,
  formatBytes,
  imageDimensions,
  LIVE_MEDIA_CAPS,
  LIVE_MEDIA_PROMPTS,
  LIVE_TRANSCRIPT_PHRASE,
  LIVE_TRANSCRIPTION_LANGUAGE,
  liveImageOptions,
  mediaCost,
  mediaReportOf,
  pickSpeechClip,
  recognizedWords,
  recordMediaOutcome,
  requestedImageSize,
  runMediaCheck,
  transcriptMatches,
} from './media.ts'
import {
  checkStatus,
  createLiveBudget,
  failedChecks,
  formatLiveSummary,
  LIVE_CHECKS,
  LIVE_MEDIA_CHECKS,
  LIVE_MEDIA_ESTIMATES_USD,
  maskSecrets,
  mediaStatus,
  oneLine,
  skippedReport,
  withMediaResults,
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
    const model = (reasoning: boolean, efforts: string[]) => ({ capabilities: { tools: false, vision: false, pdf: false, reasoning, structuredOutput: false, imageOutput: false }, reasoningEfforts: efforts as never })
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

// ---------- media checks (HF_LIVE_MEDIA=1): the matrix, the caps and the evaluation ----------

const MEDIA_SPECS = liveMediaSpecs()
const DEFINITIONS = new Map(PROVIDER_DEFINITIONS.map(definition => [definition.id, definition]))

function seedIds(providerId: string, kind: string): string[] {
  return (DEFINITIONS.get(providerId)?.seedModels ?? []).filter(model => model.kind === kind).map(model => model.id)
}

describe('live media matrix', () => {
  it('picks the cheapest image seed, one speech model and every transcription seed of each provider', () => {
    expect(MEDIA_SPECS.map(spec => spec.providerId)).toEqual(PROVIDER_IDS)
    expect(MEDIA_SPECS.filter(spec => spec.image !== null || spec.speech !== null || spec.transcription.length > 0)).toEqual([
      { providerId: 'openai', image: { modelId: 'gpt-image-1-mini', source: 'image-model' }, speech: 'gpt-4o-mini-tts', transcription: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] },
      { providerId: 'google', image: { modelId: 'gemini-2.5-flash-image', source: 'image-output' }, speech: 'gemini-2.5-flash-preview-tts', transcription: [] },
      { providerId: 'xai', image: { modelId: 'grok-imagine-image', source: 'image-model' }, speech: 'tts', transcription: ['stt'] },
      { providerId: 'mistral', image: null, speech: 'voxtral-mini-tts-latest', transcription: ['voxtral-mini-latest'] },
      { providerId: 'groq', image: null, speech: null, transcription: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
      { providerId: 'openrouter', image: { modelId: 'google/gemini-2.5-flash-image', source: 'image-output' }, speech: null, transcription: [] },
    ])
  })

  it('uses models the provider serves and covers every builtin provider that can make images or speech', () => {
    for (const spec of MEDIA_SPECS) {
      const definition = DEFINITIONS.get(spec.providerId)!
      const imageModels = providerServesKind(definition, 'image')
      if (spec.image?.source === 'image-model')
        expect(seedIds(spec.providerId, 'image'), spec.providerId).toContain(spec.image.modelId)
      if (spec.image?.source === 'image-output')
        expect({ imageParams: typeof definition.imageParams, imageModels }, spec.providerId).toEqual({ imageParams: 'function', imageModels: false })
      if (spec.speech !== null)
        expect(seedIds(spec.providerId, 'speech'), spec.providerId).toContain(spec.speech)
      expect(spec.transcription, spec.providerId).toEqual(providerServesKind(definition, 'transcription') ? seedIds(spec.providerId, 'transcription') : [])
      // Coverage: image models, image output (a provider with `imageParams` but no image models) and speech seeds.
      if (imageModels && seedIds(spec.providerId, 'image').length > 0)
        expect(spec.image?.source, spec.providerId).toBe('image-model')
      if (!imageModels && definition.imageParams !== undefined)
        expect(spec.image?.source, spec.providerId).toBe('image-output')
      if (providerServesKind(definition, 'speech') && seedIds(spec.providerId, 'speech').length > 0)
        expect(spec.speech, spec.providerId).not.toBeNull()
    }
    expect(Object.keys(LIVE_MEDIA_MODELS).every(id => DEFINITIONS.has(id))).toBe(true)
  })

  it('drops a chosen model whose provider lacks the factory', () => {
    const plain: ProviderDefinition = {
      id: 'plain',
      name: 'Plain',
      credentials: [],
      seedModels: [{ id: 'pix', kind: 'image' }, { id: 'voice', kind: 'speech' }, { id: 'ears', kind: 'transcription' }],
      createLanguageModel: () => new MockLanguageModelV4(),
    }
    const choices = { plain: { image: { modelId: 'pix', source: 'image-model' as const }, speech: 'voice' } }
    expect(liveMediaSpecs([plain], choices)).toEqual([{ providerId: 'plain', image: null, speech: null, transcription: [] }])
    const painter = { ...plain, imageParams: () => undefined }
    expect(liveMediaSpecs([painter], { plain: { image: { modelId: 'painter', source: 'image-output' } } })[0]?.image).toEqual({ modelId: 'painter', source: 'image-output' })
    expect(liveMediaChecks(liveMediaSpecs([plain], choices))).toEqual([])
  })

  it('runs speech first (its clips are transcribed), then transcription, then the images', () => {
    expect(LIVE_MEDIA_RUN_ORDER).toEqual(['speech', 'transcription', 'image'])
    expect(liveMediaChecks().map(check => `${check.kind}: ${check.providerId}`)).toEqual([
      'speech: openai',
      'speech: google',
      'speech: xai',
      'speech: mistral',
      'transcription: openai',
      'transcription: xai',
      'transcription: mistral',
      'transcription: groq',
      'image: openai',
      'image: google',
      'image: xai',
      'image: openrouter',
    ])
  })

  it('parses HF_LIVE_MEDIA like the server flags: 1 adds the media checks, unset or 0 does not, anything else throws', () => {
    for (const value of [undefined, '', ' ', '0', 'off', 'false', 'No'])
      expect(parseLiveMediaFlag(value), String(value)).toBe(false)
    for (const value of ['1', ' true ', 'ON', 'yes'])
      expect(parseLiveMediaFlag(value), value).toBe(true)
    for (const value of ['2', 'media', 'y'])
      expect(() => parseLiveMediaFlag(value), value).toThrow('HF_LIVE_MEDIA must be 1 (add the image and voice checks) or 0 (chat checks only).')
  })

  it('runs a media check only with HF_LIVE_MEDIA=1, the provider selected and its key set', () => {
    const env = { OPENAI_API_KEY: 'sk-openai-test', GEMINI_API_KEY: 'gem-test', GROQ_API_KEY: '  ' }
    const off = buildLiveMediaMatrix({ media: MEDIA_SPECS, providers: SPECS, env, filter: null, enabled: false })
    expect(off).toHaveLength(12)
    expect(off.every(entry => entry.status === 'skip' && entry.reason === 'media checks are off (set HF_LIVE_MEDIA=1)')).toBe(true)

    const on = buildLiveMediaMatrix({ media: MEDIA_SPECS, providers: SPECS, env, filter: null, enabled: true })
    expect(on.filter(entry => entry.status === 'run').map(entry => `${entry.kind}: ${entry.providerId}`)).toEqual([
      'speech: openai',
      'speech: google',
      'transcription: openai',
      'image: openai',
      'image: google',
    ])
    expect(on.find(entry => entry.kind === 'image' && entry.providerId === 'google')).toEqual({
      status: 'run',
      kind: 'image',
      providerId: 'google',
      envVars: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      modelIds: ['gemini-2.5-flash-image'],
      imageSource: 'image-output',
      keyField: 'apiKey',
      envVar: 'GEMINI_API_KEY',
      key: 'gem-test',
    })
    expect(on.find(entry => entry.kind === 'transcription' && entry.providerId === 'openai')).toMatchObject({ status: 'run', modelIds: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], imageSource: null })
    const reasons = Object.fromEntries(on.flatMap(entry => (entry.status === 'skip' ? [[`${entry.kind}: ${entry.providerId}`, entry.reason]] : [])))
    expect(reasons['transcription: groq']).toBe('no key (set GROQ_API_KEY)')
    expect(reasons['speech: mistral']).toBe('no key (set MISTRAL_API_KEY)')

    const selected = buildLiveMediaMatrix({ media: MEDIA_SPECS, providers: SPECS, env, filter: new Set(['google']), enabled: true })
    expect(selected.filter(entry => entry.status === 'run').map(entry => `${entry.kind}: ${entry.providerId}`)).toEqual(['speech: google', 'image: google'])
    expect(selected.find(entry => entry.providerId === 'openai')).toMatchObject({ status: 'skip', reason: 'not selected by HF_LIVE_PROVIDERS' })
    const none = buildLiveMediaMatrix({ media: MEDIA_SPECS, providers: SPECS, env, filter: new Set(), enabled: true })
    expect(none.every(entry => entry.status === 'skip')).toBe(true)
  })

  it('resolves the media matrix from the environment and rejects bad values before any request', () => {
    const xai = resolveLiveMediaMatrix({ HF_LIVE_MEDIA: '1', HF_LIVE_PROVIDERS: 'xai', XAI_API_KEY: 'xai-test' })
    expect(xai.filter(entry => entry.status === 'run').map(entry => `${entry.kind}: ${entry.providerId}`)).toEqual(['speech: xai', 'transcription: xai', 'image: xai'])
    expect(resolveLiveMediaMatrix({ XAI_API_KEY: 'xai-test' }).every(entry => entry.status === 'skip')).toBe(true)
    expect(resolveLiveMediaMatrix({ HF_LIVE_MEDIA: '1', HF_LIVE_PROVIDERS: 'none', XAI_API_KEY: 'xai-test' }).every(entry => entry.status === 'skip')).toBe(true)
    expect(() => resolveLiveMediaMatrix({ HF_LIVE_MEDIA: 'maybe' })).toThrow('HF_LIVE_MEDIA must be 1')
    expect(() => resolveLiveMediaMatrix({ HF_LIVE_MEDIA: '1', HF_LIVE_PROVIDERS: 'opneai' })).toThrow('unknown provider id "opneai"')
  })

  it('caps every media check: one square image (1024x1024 at OpenAI), 4096 output tokens and one step for image output', () => {
    expect(LIVE_MEDIA_CAPS).toEqual({ images: 1, aspectRatio: '1:1', imageOutputTokens: 4096, imageOutputSteps: 1, speechMinBytes: 1024 })
    expect(liveImageOptions('image-model')).toEqual({ n: 1, aspectRatio: '1:1' })
    expect(liveImageOptions('image-output')).toEqual({ aspectRatio: '1:1' })
    for (const source of ['image-model', 'image-output'] as const)
      expect(imageOptionsSchema.safeParse(liveImageOptions(source)).success).toBe(true)
    expect(requestedImageSize(DEFINITIONS.get('openai'), 'gpt-image-1-mini')).toBe('1024x1024')
    expect(requestedImageSize(DEFINITIONS.get('xai'), 'grok-imagine-image')).toBeUndefined()
    expect(requestedImageSize(DEFINITIONS.get('anthropic'), 'claude-haiku-4-5')).toBeUndefined()
    const broken: ProviderDefinition = {
      ...DEFINITIONS.get('openai')!,
      imageParams: () => {
        throw new Error('broken')
      },
    }
    expect(requestedImageSize(broken, 'x')).toBeUndefined()

    const input: HookMap['chat.params'][0] = { chatId: 'c', modelRef: 'google:gemini-2.5-flash-image', model: { id: 'gemini-2.5-flash-image' }, reasoningEffort: 'auto', toolMode: 'off' }
    const capped = (output: Partial<HookMap['chat.params'][1]>): HookMap['chat.params'][1] => {
      const draft: HookMap['chat.params'][1] = { instructions: '', maxSteps: 20, providerOptions: {}, ...output }
      capImageOutputParams(input, draft)
      return draft
    }
    expect(capped({})).toMatchObject({ maxOutputTokens: 4096, maxSteps: 1 })
    expect(capped({ maxOutputTokens: 65_536 })).toMatchObject({ maxOutputTokens: 4096 })
    expect(capped({ maxOutputTokens: 100, maxSteps: 1 })).toMatchObject({ maxOutputTokens: 100, maxSteps: 1 })
    expect(LIVE_MEDIA_PROMPTS.speech).toBe('The quick brown fox jumps over the lazy dog.')
  })

  it('counts a recorded media cost, else the fixed estimate of its kind', () => {
    expect(LIVE_MEDIA_ESTIMATES_USD).toEqual({ image: 0.05, speech: 0.01, transcription: 0.01 })
    expect(mediaCost('image', 0.039)).toEqual({ usd: 0.039, estimated: false })
    expect(mediaCost('image', null)).toEqual({ usd: 0.05, estimated: true })
    expect(mediaCost('image', 0)).toEqual({ usd: 0.05, estimated: true })
    expect(mediaCost('speech', null)).toEqual({ usd: 0.01, estimated: true })
    expect(mediaCost('transcription', null)).toEqual({ usd: 0.01, estimated: true })
  })
})

describe('live media checks: evaluation', () => {
  const WAV = new Uint8Array(createMockWav(LIVE_MEDIA_PROMPTS.speech))
  const FILE_URL = '/api/files/file_0000000000000001'
  const PNG_FILE = { url: FILE_URL, partMediaType: 'image/png', status: 200, bytes: 3000, sniffed: 'image/png', width: 1024, height: 1024 }

  function speechHeaders(type: string, length: number, extra: Record<string, string> = {}): Headers {
    return new Headers({ 'content-type': type, 'content-length': String(length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
  }

  function imageStream(files: { url: string, mediaType: string }[], extra: Partial<ChatStreamResult> = {}): ChatStreamResult {
    return { ...emptyStreamResult(), messageId: 'msg_a000000000000001', files, finished: true, metadata: { modelRef: 'p:pix', startedAt: 1, finishReason: 'stop' }, ...extra }
  }

  function reply(parts: HarnessUIMessage['parts']): HarnessUIMessage {
    return { id: 'msg_a000000000000001', role: 'assistant', parts }
  }

  it('evaluates a speech answer: an allowlisted type matching the bytes, no-store, nosniff, the length, a real body', () => {
    const answer = (headers: Headers, bytes: Uint8Array = WAV, status = 200) => evaluateSpeech({ modelId: 'voice', status, headers, bytes })
    expect(answer(speechHeaders('audio/wav', WAV.byteLength))).toEqual({ status: 'PASS', detail: `voice: audio/wav, ${formatBytes(WAV.byteLength)}, the provider's default voice` })
    expect(answer(speechHeaders('audio/x-unknown', WAV.byteLength)).detail).toBe('Content-Type audio/x-unknown is not an allowlisted audio type')
    expect(answer(speechHeaders('audio/wav', WAV.byteLength, { 'cache-control': 'private' })).detail).toBe('the answer lacks Cache-Control: no-store')
    expect(answer(speechHeaders('audio/wav', WAV.byteLength, { 'x-content-type-options': 'none' })).detail).toBe('the answer lacks X-Content-Type-Options: nosniff')
    expect(answer(speechHeaders('audio/wav', 12)).detail).toBe(`Content-Length 12 does not match the ${WAV.byteLength} bytes of the body`)
    expect(answer(speechHeaders('audio/wav', 100), WAV.subarray(0, 100)).detail).toBe('only 100 bytes of audio')
    expect(answer(speechHeaders('audio/mpeg', WAV.byteLength)).detail).toBe('the audio does not match its type (audio/mpeg)')
    // AAC is allowlisted for playback but cannot be sniffed (nor transcribed): its bytes are not checked.
    expect(answer(speechHeaders('audio/aac', 2048), new Uint8Array(2048)).status).toBe('PASS')
    const limited = new TextEncoder().encode(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down.', status: 429 } }))
    expect(answer(new Headers(), limited, 429)).toEqual({ status: 'SKIP', detail: 'rate limited, rate_limited (HTTP 429): Slow down.' })
    expect(answer(new Headers(), new TextEncoder().encode('gateway down'), 502)).toEqual({ status: 'FAIL', detail: 'internal_error: HTTP 502 without an error envelope' })
  })

  it('evaluates a transcription: no-store, the requested model and the spoken words', () => {
    const answer = (body: unknown, headers = new Headers({ 'cache-control': 'no-store' }), status = 200) =>
      evaluateTranscription({ modelRef: 'p:ears', status, headers, text: typeof body === 'string' ? body : JSON.stringify(body) })
    const transcription = (text: string, extra: Record<string, unknown> = {}) => ({ text, language: 'english', durationSec: 2.5, modelRef: 'p:ears', ...extra })
    expect(answer(transcription('The quick brown fox jumps over the lazy dog.'))).toEqual({ status: 'PASS', detail: '8/8 words, language english' })
    expect(answer(transcription('QUICK, brown... fox!', { language: null }))).toEqual({ status: 'PASS', detail: '3/8 words' })
    expect(answer(transcription('The quick brown cat.'))).toEqual({ status: 'FAIL', detail: 'the transcript "The quick brown cat." lacks "quick brown fox"' })
    expect(answer(transcription('The quick brown fox', { modelRef: 'p:other' }))).toEqual({ status: 'FAIL', detail: 'answered by p:other, not p:ears' })
    expect(answer(transcription('The quick brown fox'), new Headers()).detail).toBe('the answer lacks Cache-Control: no-store')
    expect(answer('not json').detail).toBe('the answer is not JSON')
    expect(answer({ text: 1 }).detail).toBe('the answer is not an AudioTranscription')
    expect(answer({ error: { code: 'rate_limited', message: 'Later.', status: 429 } }, new Headers(), 429).status).toBe('SKIP')
    expect(answer({ error: { code: 'validation_error', message: 'The recording is empty.' } }, new Headers(), 400)).toEqual({ status: 'FAIL', detail: 'validation_error: The recording is empty.' })
  })

  it('matches transcripts case-insensitively without punctuation and counts the words heard', () => {
    expect(LIVE_TRANSCRIPT_PHRASE).toBe('quick brown fox')
    expect(transcriptMatches('THE QUICK BROWN FOX JUMPED')).toBe(true)
    expect(transcriptMatches('quick-brown fox')).toBe(true)
    expect(transcriptMatches('the quickbrown fox')).toBe(false)
    expect(transcriptMatches('a quick brown foxes')).toBe(false)
    expect(recognizedWords('')).toEqual({ found: 0, total: 8 })
    expect(recognizedWords('the quick brown fox jumps over the lazy dog')).toEqual({ found: 8, total: 8 })
  })

  it('transcribes the provider\'s own speech when it has one, else the first clip of the run', () => {
    const clip = (providerId: string, mediaType = 'audio/wav', bytes: Uint8Array<ArrayBuffer> = WAV): LiveSpeechClip => ({ providerId, modelRef: `${providerId}:voice`, mediaType, bytes })
    const aac = clip('aac-maker', 'audio/aac', new Uint8Array(4096))
    const openai = clip('openai')
    const xai = clip('xai')
    expect(pickSpeechClip([aac, openai, xai], 'xai')).toBe(xai)
    expect(pickSpeechClip([aac, openai, xai], 'groq')).toBe(openai)
    expect(pickSpeechClip([aac], 'aac-maker')).toBeNull()
    expect(pickSpeechClip([], 'openai')).toBeNull()
  })

  it('reads the size of PNG, GIF and JPEG images', () => {
    expect(imageDimensions(encodeSolidPng(1024, 768, [1, 2, 3]))).toEqual({ width: 1024, height: 768 })
    const gif = Uint8Array.from([...'GIF89a'].map(char => char.charCodeAt(0)).concat([0x40, 0x01, 0xF0, 0x00, 0, 0, 0]))
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 })
    // SOI, an APP0 segment, then SOF0 with height 600 and width 800.
    const jpeg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00])
    expect(imageDimensions(jpeg)).toEqual({ width: 800, height: 600 })
    expect(imageDimensions(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
    expect(imageDimensions(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBeNull()
    expect(imageDimensions(new Uint8Array(0))).toBeNull()
  })

  it('evaluates an image reply: images streamed and saved as files, raster content, the requested size, no data: URL', () => {
    const part = { type: 'file' as const, mediaType: 'image/png', url: FILE_URL }
    const streamed = [{ url: FILE_URL, mediaType: 'image/png' }]
    const input = { modelId: 'pix', source: 'image-model' as const, stream: imageStream(streamed), stored: reply([part]), files: [PNG_FILE], requestedSize: '1024x1024' }
    expect(evaluateImageReply(input)).toEqual({ status: 'PASS', detail: 'pix: 1 image/png 1024x1024 (2.9 KB), size 1024x1024 requested' })
    expect(evaluateImageReply({ ...input, stream: imageStream([...streamed, ...streamed]) }).detail).toBe('2 image(s) streamed, expected exactly 1 (finish reason: stop)')
    expect(evaluateImageReply({ ...input, stream: imageStream([], { notices: ['generated-file-dropped'] }) }).detail)
      .toBe('0 image(s) streamed, expected exactly 1; the server dropped 1 generated file(s) (finish reason: stop)')
    expect(evaluateImageReply({ ...input, stream: imageStream([{ url: 'data:image/png;base64,AA==', mediaType: 'image/png' }]) }).detail).toBe('a streamed image is not an /api/files/ URL')
    expect(evaluateImageReply({ ...input, stored: undefined }).detail).toBe('the reply was not persisted')
    expect(evaluateImageReply({ ...input, stored: reply([part, { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }]) }).detail).toBe('the saved reply holds a data: URL')
    expect(evaluateImageReply({ ...input, stored: reply([]) }).detail).toBe('the saved reply has 0 file part(s), expected exactly 1')
    expect(evaluateImageReply({ ...input, files: [{ ...PNG_FILE, status: 404 }] }).detail).toBe(`GET ${FILE_URL} answered HTTP 404`)
    expect(evaluateImageReply({ ...input, files: [{ ...PNG_FILE, sniffed: null }] }).detail).toBe(`${FILE_URL} is not a raster image (unknown content)`)
    expect(evaluateImageReply({ ...input, files: [{ ...PNG_FILE, sniffed: 'image/jpeg' }] }).detail).toBe(`${FILE_URL} holds image/jpeg, the saved part says image/png`)
    expect(evaluateImageReply({ ...input, files: [{ ...PNG_FILE, width: 512, height: 512 }] }).detail).toBe('the image is 512x512, imageParams asked for 1024x1024')
    const limited = imageStream(streamed, { error: { code: 'rate_limited', message: 'Later.', status: 429 } })
    expect(evaluateImageReply({ ...input, stream: limited }).status).toBe('SKIP')

    const second = '/api/files/file_0000000000000002'
    const output = {
      modelId: 'painter',
      source: 'image-output' as const,
      stream: imageStream([...streamed, { url: second, mediaType: 'image/png' }], { text: 'Here it is.' }),
      stored: reply([{ type: 'text', text: 'Here it is.' }, part, { ...part, url: second }]),
      files: [PNG_FILE, { ...PNG_FILE, url: second }],
    }
    expect(evaluateImageReply(output)).toEqual({ status: 'PASS', detail: 'painter: 2 image/png 1024x1024 (5.9 KB), with text' })
    expect(evaluateImageReply({ ...output, stream: imageStream([]) }).detail).toBe('0 image(s) streamed, expected at least 1 (finish reason: stop)')
  })

  it('combines the results of several models: FAIL wins, then PASS, else SKIP', () => {
    const pass = { modelId: 'a', result: { status: 'PASS' as const, detail: '8/8 words' } }
    const skip = { modelId: 'b', result: { status: 'SKIP' as const, detail: 'budget' } }
    const fail = { modelId: 'c', result: { status: 'FAIL' as const } }
    expect(combineResults([pass, skip], 'clip from p:voice')).toEqual({ status: 'PASS', detail: 'clip from p:voice; a PASS (8/8 words); b SKIP (budget)' })
    expect(combineResults([pass, fail], 'clip').status).toBe('FAIL')
    expect(combineResults([skip], 'clip').status).toBe('SKIP')
    expect(formatBytes(1000)).toBe('1000 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('live summary with media checks', () => {
  const SECRET = 'sk-live-media-secret-654321'
  const ALL_PASS = Object.fromEntries(LIVE_CHECKS.map(({ id }) => [id, { status: 'PASS' as const }]))

  function mediaFixture(): LiveProviderReport[] {
    const openai = withMediaResults({ providerId: 'openai', envVars: ['OPENAI_API_KEY'], envVar: 'OPENAI_API_KEY', modelId: 'gpt-6-luna', checks: ALL_PASS, costUsd: 0.001, costEstimated: false }, {
      checks: {
        image: { status: 'PASS', detail: 'gpt-image-1-mini: 1 image/png 1024x1024 (1.2 MB); ~$0.0500' },
        speech: { status: 'PASS' },
        transcription: { status: 'FAIL', detail: `whisper-1 FAIL (key ${SECRET})` },
      },
      costUsd: 0.07,
      costEstimated: true,
    })
    const google = withMediaResults(skippedReport({ providerId: 'google', envVars: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'], modelId: 'gemini-3.5-flash-lite', reason: 'no key' }), {
      checks: { image: { status: 'SKIP', detail: 'no key' }, speech: { status: 'SKIP', detail: 'no key' } },
      costUsd: 0,
      costEstimated: false,
    })
    const groq = withMediaResults({ providerId: 'groq', envVars: ['GROQ_API_KEY'], envVar: 'GROQ_API_KEY', modelId: 'openai/gpt-oss-20b', checks: ALL_PASS, costUsd: 0.0002, costEstimated: false }, {
      checks: { transcription: { status: 'SKIP', detail: 'no speech clip' } },
      costUsd: 0,
      costEstimated: false,
    })
    return [openai, google, groq]
  }

  it('adds the columns Image, Speech and Transcription ("-" without a model) and counts the media checks', () => {
    const markdown = formatLiveSummary(mediaFixture(), { budget: { limitUsd: 0.5, spentUsd: 0.0712, estimated: true }, secrets: [SECRET], media: true })
    const lines = markdown.split('\n')
    expect(lines).toContain('| Provider | Key variable | Model | Test | Models | Chat | Reasoning | Tools | Bad key | Key not logged | Image | Speech | Transcription | Cost (USD) |')
    expect(lines).toContain('| openai | `OPENAI_API_KEY` | `gpt-6-luna` | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | FAIL | ~0.0710 |')
    expect(lines).toContain('| google | `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-3.5-flash-lite` | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | SKIP | - | - |')
    expect(lines).toContain('| groq | `GROQ_API_KEY` | `openai/gpt-oss-20b` | PASS | PASS | PASS | PASS | PASS | PASS | PASS | - | - | SKIP | 0.0002 |')
    expect(lines).toContain('Providers: 2 run, 1 skipped. Checks: 16 PASS, 1 FAIL, 1 SKIP. Spent $0.0712 of $0.5000 (HF_LIVE_MAX_COST_USD), partly estimated (~).')
    expect(lines).toContain('Media checks on (HF_LIVE_MEDIA=1). A media cost the provider does not report counts at a fixed estimate (~): $0.0500 per image, $0.0100 per speech call, $0.0100 per transcription call.')
    expect(lines).toContain('  - Image: PASS (gpt-image-1-mini: 1 image/png 1024x1024 (1.2 MB); ~$0.0500)')
    expect(lines).toContain('  - Speech: PASS')
    expect(lines).toContain('  - Transcription: FAIL (whisper-1 FAIL (key [redacted]))')
    expect(lines).toContain('- **google**: SKIP (no key)')
    expect(lines.filter(line => line.startsWith('  - Image:'))).toHaveLength(1)
    expect(markdown).not.toContain(SECRET)
    expect(LIVE_MEDIA_CHECKS.map(check => check.id)).toEqual(['image', 'speech', 'transcription'])
  })

  it('keeps the chat-only table when HF_LIVE_MEDIA is off', () => {
    const markdown = formatLiveSummary(mediaFixture(), { budget: createLiveBudget(0.5), secrets: [SECRET] })
    expect(markdown.split('\n')).toContain('| Provider | Key variable | Model | Test | Models | Chat | Reasoning | Tools | Bad key | Key not logged | Cost (USD) |')
    expect(markdown).toContain('Checks: 14 PASS, 0 FAIL, 0 SKIP.')
    expect(markdown).not.toContain('| Image |')
    expect(markdown).not.toContain('  - Image:')
    expect(markdown).not.toContain('Media checks on')
  })

  it('merges the media results into the provider report: statuses, failures and cost', () => {
    const [openai, google, groq] = mediaFixture()
    expect(openai!.costUsd).toBeCloseTo(0.071, 10)
    expect(openai!.costEstimated).toBe(true)
    expect([mediaStatus(openai!, 'image'), mediaStatus(groq!, 'image'), mediaStatus(google!, 'speech')]).toEqual(['PASS', '-', 'SKIP'])
    expect(failedChecks(openai!)).toEqual([`Transcription: whisper-1 FAIL (key ${SECRET})`])
    expect(failedChecks(groq!)).toEqual([])
    expect(withMediaResults(groq!, undefined)).toBe(groq)
  })

  it('records media outcomes by provider, with their cost and the speech clips', () => {
    const results = createLiveMediaResults()
    const clip: LiveSpeechClip = { providerId: 'openai', modelRef: 'openai:gpt-4o-mini-tts', mediaType: 'audio/wav', bytes: new Uint8Array(createMockWav('x')) }
    recordMediaOutcome(results, { kind: 'speech', providerId: 'openai' }, { result: { status: 'PASS' }, cost: { usd: 0.01, estimated: true }, clip })
    recordMediaOutcome(results, { kind: 'transcription', providerId: 'openai' }, { result: { status: 'PASS' }, cost: { usd: 0.03, estimated: true } })
    recordMediaOutcome(results, { kind: 'image', providerId: 'google' }, { result: { status: 'SKIP', detail: 'no key' } })
    expect(results.clips).toEqual([clip])
    const openai = mediaReportOf(results, 'openai')
    expect(openai?.checks).toEqual({ speech: { status: 'PASS' }, transcription: { status: 'PASS' } })
    expect(openai?.costUsd).toBeCloseTo(0.04, 10)
    expect(openai?.costEstimated).toBe(true)
    expect(mediaReportOf(results, 'google')).toEqual({ checks: { image: { status: 'SKIP', detail: 'no key' } }, costUsd: 0, costEstimated: false })
    expect(mediaReportOf(results, 'groq')).toBeUndefined()
  })
})

// ---------- rehearsal: every media check against a scripted media provider (no network) ----------

const MEDIA_KEY = 'rehearsal-media-key-9d2c7e4b1a6f'
const MEDIA_PROVIDER_ID = 'rehearsal-media'
/** A clip of the scripted speech model (a silent WAV the length of the sentence). */
const WAV_CLIP = new Uint8Array(createMockWav(LIVE_MEDIA_PROMPTS.speech))

interface MediaRehearsalState {
  image: ImageModelV4CallOptions[]
  chat: LanguageModelV4CallOptions[]
  speech: SpeechModelV4CallOptions[]
  transcription: TranscriptionModelV4CallOptions[]
  listings: number
  rateLimited: boolean
  transcript: string
}

function tooManyRequests(path: string): APICallError {
  return new APICallError({ message: 'Too many requests', url: `https://rehearsal-media.invalid/v1/${path}`, requestBodyValues: {}, statusCode: 429, isRetryable: false })
}

/** Image models with and without a price, a chat model with image output, a speech model and two transcription models. */
function mediaRehearsalModels(): ModelInfo[] {
  return [
    { id: 'pix', name: 'Pix', kind: 'image', capabilities: { vision: true } },
    { id: 'pix-priced', name: 'Pix priced', kind: 'image', capabilities: { vision: true }, cost: { input: 1, output: 2 } },
    { id: 'painter', name: 'Painter', kind: 'chat', contextWindow: 32_000, capabilities: { imageOutput: true }, cost: { input: 1, output: 2 } },
    { id: 'voice', name: 'Voice', kind: 'speech' },
    { id: 'ears-a', name: 'Ears A', kind: 'transcription' },
    { id: 'ears-b', name: 'Ears B', kind: 'transcription' },
  ]
}

function mediaRehearsalProvider(state: MediaRehearsalState): ProviderDefinition {
  return {
    id: MEDIA_PROVIDER_ID,
    name: 'Rehearsal media',
    credentials: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'REHEARSAL_MEDIA_API_KEY' }],
    seedModels: mediaRehearsalModels(),
    async listModels() {
      state.listings += 1
      return mediaRehearsalModels()
    },
    // `painter`: a line of text, then one generated PNG.
    createLanguageModel: modelId => new MockLanguageModelV4({
      provider: MEDIA_PROVIDER_ID,
      modelId,
      doStream: async (options) => {
        state.chat.push(options)
        if (state.rateLimited)
          throw tooManyRequests('chat')
        return { stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Here is the circle.' },
          { type: 'text-end', id: 't' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: encodeSolidPng(1024, 1024, [220, 30, 30]) } },
          {
            type: 'finish',
            usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1300, text: 10, reasoning: 0 } },
            finishReason: { unified: 'stop', raw: 'STOP' },
          },
        ]) }
      },
    }),
    // Images of the requested size (256 px squares without one).
    createImageModel: modelId => new MockImageModelV4({
      provider: MEDIA_PROVIDER_ID,
      modelId,
      maxImagesPerCall: 4,
      doGenerate: async (options) => {
        state.image.push(options)
        if (state.rateLimited)
          throw tooManyRequests('images')
        const [width, height] = (options.size ?? '256x256').split('x').map(Number) as [number, number]
        return {
          images: Array.from({ length: options.n }, () => encodeSolidPng(width, height, [220, 30, 30])),
          warnings: [],
          response: { timestamp: new Date(0), modelId, headers: undefined },
          usage: { inputTokens: 20, outputTokens: 1056, totalTokens: 1076 },
        }
      },
    }),
    // Like OpenAI: a square is `1024x1024`; the aspect ratio also goes to the chat model with image output.
    imageParams: request => (request.aspectRatio === '1:1' ? { size: '1024x1024', providerOptions: { rehearsal: { aspectRatio: '1:1' } } } : undefined),
    createSpeechModel: modelId => new MockSpeechModelV4({
      provider: MEDIA_PROVIDER_ID,
      modelId,
      doGenerate: async (options) => {
        state.speech.push(options)
        if (state.rateLimited)
          throw tooManyRequests('speech')
        return { audio: createMockWav(options.text), warnings: [], response: { timestamp: new Date(0), modelId } }
      },
    }),
    createTranscriptionModel: modelId => new MockTranscriptionModelV4({
      provider: MEDIA_PROVIDER_ID,
      modelId,
      doGenerate: async (options) => {
        state.transcription.push(options)
        if (state.rateLimited)
          throw tooManyRequests('transcriptions')
        return { text: state.transcript, segments: [], language: 'en', durationInSeconds: 3.6, warnings: [], response: { timestamp: new Date(0), modelId } }
      },
    }),
    transcriptionOptions: hints => (hints.language === undefined || hints.language === 'auto' ? undefined : { rehearsal: { language: hints.language } }),
  }
}

describe('live media checks: rehearsal against a scripted media provider', () => {
  let t: TestApp
  let registration: Disposable
  const state: MediaRehearsalState = { image: [], chat: [], speech: [], transcription: [], listings: 0, rateLimited: false, transcript: '' }
  const target = (kind: LiveMediaCheckId, modelIds: string[], imageSource: LiveImageSource | null = null): LiveMediaTarget => ({
    kind,
    providerId: MEDIA_PROVIDER_ID,
    envVars: ['REHEARSAL_MEDIA_API_KEY'],
    modelIds,
    imageSource,
    keyField: 'apiKey',
    envVar: 'REHEARSAL_MEDIA_API_KEY',
    key: MEDIA_KEY,
  })
  const calls = (): number[] => [state.image.length, state.chat.length, state.speech.length, state.transcription.length]

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_OFFLINE: '1', REHEARSAL_MEDIA_API_KEY: MEDIA_KEY }, builtins: [OWNER] })
    registration = t.deps.registry.providers.register('mock', mediaRehearsalProvider(state))
  })

  beforeEach(() => {
    for (const list of [state.image, state.chat, state.speech, state.transcription])
      list.length = 0
    state.listings = 0
    state.rateLimited = false
    state.transcript = LIVE_MEDIA_PROMPTS.speech
  })

  afterAll(async () => {
    registration.dispose()
    await t.close()
  })

  async function speechClip(): Promise<LiveSpeechClip> {
    const outcome = await runMediaCheck(t, target('speech', ['voice']), createLiveBudget(1))
    expect(outcome.result.status, outcome.result.detail).toBe('PASS')
    return outcome.clip!
  }

  it('speech: reads the sentence with the default voice and keeps the audio as a clip', async () => {
    const budget = createLiveBudget(0.5)
    const outcome = await runMediaCheck(t, target('speech', ['voice']), budget)
    expect(outcome.result.status, outcome.result.detail).toBe('PASS')
    expect(outcome.result.detail).toMatch(/^voice: audio\/wav, [\d.]+ KB, the provider's default voice; ~\$0\.0100$/)
    expect(outcome.cost).toEqual({ usd: 0.01, estimated: true })
    expect(budget).toMatchObject({ spentUsd: 0.01, estimated: true })
    expect(state.speech).toHaveLength(1)
    expect(state.speech[0]?.text).toBe(LIVE_MEDIA_PROMPTS.speech)
    expect(state.speech[0]?.voice).toBeUndefined()
    expect(outcome.clip).toMatchObject({ providerId: MEDIA_PROVIDER_ID, modelRef: 'rehearsal-media:voice', mediaType: 'audio/wav' })
    expect(outcome.clip!.bytes.byteLength).toBeGreaterThan(LIVE_MEDIA_CAPS.speechMinBytes)
  })

  it('transcription: every model transcribes the clip once with the language hint and must hear the phrase', async () => {
    const clip = await speechClip()
    const budget = createLiveBudget(0.5)
    const outcome = await runMediaCheck(t, target('transcription', ['ears-a', 'ears-b']), budget, [clip])
    expect(outcome.result).toEqual({
      status: 'PASS',
      detail: `clip from rehearsal-media:voice (audio/wav, ${formatBytes(clip.bytes.byteLength)}); ears-a PASS (8/8 words, language en); ears-b PASS (8/8 words, language en); ~$0.0200`,
    })
    expect(outcome.cost).toEqual({ usd: 0.02, estimated: true })
    expect(budget.spentUsd).toBeCloseTo(0.02, 10)
    expect(LIVE_TRANSCRIPTION_LANGUAGE).toBe('en')
    expect(state.transcription.map(call => call.providerOptions)).toEqual([{ rehearsal: { language: 'en' } }, { rehearsal: { language: 'en' } }])
    expect(state.transcription.map(call => call.mediaType)).toEqual(['audio/wav', 'audio/wav'])

    state.transcript = 'Something else entirely.'
    const wrong = await runMediaCheck(t, target('transcription', ['ears-a']), createLiveBudget(0.5), [clip])
    expect(wrong.result.status).toBe('FAIL')
    expect(wrong.result.detail).toContain('ears-a FAIL (the transcript "Something else entirely." lacks "quick brown fox")')
  })

  it('transcription: SKIP without a clip; a model that is not listed fails without a call', async () => {
    const none = await runMediaCheck(t, target('transcription', ['ears-a']), createLiveBudget(0.5), [])
    expect(none.result.status).toBe('SKIP')
    expect(none.result.detail).toContain('no speech clip to transcribe')
    expect(none.cost).toEqual({ usd: 0, estimated: false })
    const clip = await speechClip()
    const missing = await runMediaCheck(t, target('transcription', ['ears-x', 'ears-a']), createLiveBudget(0.5), [clip])
    expect(missing.result.status).toBe('FAIL')
    expect(missing.result.detail).toContain('ears-x FAIL ("ears-x" is not in the catalog)')
    expect(missing.result.detail).toContain('ears-a PASS (8/8 words, language en)')
    expect(state.transcription).toHaveLength(1)
  })

  it('image model: one image of the size imageParams asked for, stored as a file, at the estimate without a price', async () => {
    const budget = createLiveBudget(0.5)
    const outcome = await runMediaCheck(t, target('image', ['pix'], 'image-model'), budget)
    expect(outcome.result.status, outcome.result.detail).toBe('PASS')
    expect(outcome.result.detail).toMatch(/^pix: 1 image\/png 1024x1024 \([\d.]+ KB\), size 1024x1024 requested; ~\$0\.0500$/)
    expect(outcome.cost).toEqual({ usd: 0.05, estimated: true })
    expect(state.image).toHaveLength(1)
    expect(state.image[0]).toMatchObject({ n: 1, size: '1024x1024', prompt: LIVE_MEDIA_PROMPTS.image })
    expect(state.chat).toHaveLength(0)

    const priced = await runMediaCheck(t, target('image', ['pix-priced'], 'image-model'), budget)
    expect(priced.result.status, priced.result.detail).toBe('PASS')
    expect(priced.cost.usd).toBeCloseTo((20 * 1 + 1056 * 2) / 1_000_000, 10)
    expect(priced.cost.estimated).toBe(false)
    expect(budget.spentUsd).toBeCloseTo(0.05 + priced.cost.usd, 10)
  })

  it('image output: refreshes the listing, caps the call and keeps the generated image as a file', async () => {
    const outcome = await runMediaCheck(t, target('image', ['painter'], 'image-output'), createLiveBudget(0.5))
    expect(outcome.result.status, outcome.result.detail).toBe('PASS')
    expect(outcome.result.detail).toMatch(/^painter: 1 image\/png 1024x1024 \([\d.]+ KB\), with text; \$0\.0026$/)
    expect(outcome.cost.usd).toBeCloseTo((20 * 1 + 1300 * 2) / 1_000_000, 10)
    expect(outcome.cost.estimated).toBe(false)
    expect(state.listings).toBe(1)
    expect(state.chat).toHaveLength(1)
    expect(state.chat[0]).toMatchObject({ maxOutputTokens: LIVE_MEDIA_CAPS.imageOutputTokens, providerOptions: { rehearsal: { aspectRatio: '1:1' } } })
    expect(state.chat[0]?.tools ?? []).toEqual([])
    expect(state.image).toHaveLength(0)
  })

  it('reports a rate limit (429) as SKIP', async () => {
    state.rateLimited = true
    const speech = await runMediaCheck(t, target('speech', ['voice']), createLiveBudget(0.5))
    expect(speech.result.status, speech.result.detail).toBe('SKIP')
    expect(speech.result.detail).toContain('rate limited, rate_limited')
    expect(speech.clip).toBeUndefined()
    const image = await runMediaCheck(t, target('image', ['pix'], 'image-model'), createLiveBudget(0.5))
    expect(image.result.status, image.result.detail).toBe('SKIP')
    const clip: LiveSpeechClip = { providerId: MEDIA_PROVIDER_ID, modelRef: 'rehearsal-media:voice', mediaType: 'audio/wav', bytes: WAV_CLIP }
    const transcription = await runMediaCheck(t, target('transcription', ['ears-a']), createLiveBudget(0.5), [clip])
    expect(transcription.result.status, transcription.result.detail).toBe('SKIP')
  })

  it('skips every media check once the budget is spent, without calling a model', async () => {
    const clip: LiveSpeechClip = { providerId: MEDIA_PROVIDER_ID, modelRef: 'rehearsal-media:voice', mediaType: 'audio/wav', bytes: WAV_CLIP }
    const budget = createLiveBudget(0)
    const checks: [LiveMediaCheckId, string[], LiveImageSource | null][] = [
      ['speech', ['voice'], null],
      ['transcription', ['ears-a', 'ears-b'], null],
      ['image', ['pix'], 'image-model'],
      ['image', ['painter'], 'image-output'],
    ]
    for (const [kind, models, source] of checks) {
      const outcome = await runMediaCheck(t, target(kind, models, source), budget, [clip])
      expect(outcome.result.status, `${kind} ${models.join(', ')}`).toBe('SKIP')
      expect(outcome.result.detail).toContain('the budget of $0.0000 is spent (HF_LIVE_MAX_COST_USD)')
      expect(outcome.cost).toEqual({ usd: 0, estimated: false })
    }
    expect(calls()).toEqual([0, 0, 0, 0])
    expect(budget.spentUsd).toBe(0)
  })

  it('fails a check whose model is missing or of another kind, without calling a model', async () => {
    expect((await runMediaCheck(t, target('speech', ['nope']), createLiveBudget(0.5))).result).toEqual({ status: 'FAIL', detail: '"nope" is not in the catalog' })
    expect((await runMediaCheck(t, target('image', ['voice'], 'image-model'), createLiveBudget(0.5))).result)
      .toEqual({ status: 'FAIL', detail: '"voice" is listed as a speech model, not as an image model' })
    expect((await runMediaCheck(t, target('image', ['pix'], 'image-output'), createLiveBudget(0.5))).result)
      .toEqual({ status: 'FAIL', detail: '"pix" is not listed as a chat model with image output (kind image)' })
    expect(calls()).toEqual([0, 0, 0, 0])
  })

  it('fails a check when a log record contains the key, and never logs the real key', async () => {
    // The audio log line names the provider: taken as the "key", it shows that the log check covers the media checks.
    const outcome = await runMediaCheck(t, { ...target('speech', ['voice']), key: MEDIA_PROVIDER_ID }, createLiveBudget(0.5))
    expect(outcome.result).toEqual({ status: 'FAIL', detail: 'a log record contains the key' })
    expect(outcome.clip).toBeUndefined()
    expect(t.logs.text()).not.toContain(MEDIA_KEY)
  })
})
