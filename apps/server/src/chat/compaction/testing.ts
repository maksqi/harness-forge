// Test helpers of the compaction tests (W9.1): a `RunSession` over a minimal run context (recorded usage rows, resolved
// refs, transient chunks), resolved mock models and summarizer doubles built on `MockLanguageModelV4` (only mock
// models: nothing here resolves a real provider).
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import type { HarnessUIMessage, Settings } from '@harness-forge/shared'
import type { UIMessageStreamWriter } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { UsageInput } from '../../services/chats/types.ts'
import type { AppDeps } from '../../types.ts'
import type { BackgroundTasks } from '../background/types.ts'
import type { HarnessDataChunk, RunContext } from '../pipeline.ts'
import type { PreparedRun } from '../prepare.ts'
import type { ChatQueue } from '../queue.ts'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { createSilentLogger } from '../../logger.ts'
import { createRedactor } from '../../security/redact.ts'
import { RunSession, TaskTracker } from '../pipeline.ts'
import { createRunRegistry } from '../runs.ts'

/** A generate result with `text` and the given token counts. */
export function generated(text: string, input = 10, output = 4): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
    warnings: [],
  }
}

/** A summarizer double: answers every `generateText` call with `text` (calls recorded). */
export function summaryModel(text: string | ((options: LanguageModelV4CallOptions) => string), calls: LanguageModelV4CallOptions[] = []): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options)
      return generated(typeof text === 'string' ? text : text(options))
    },
  })
}

/** A model whose `generateText` call rejects with `error`. */
export function failingModel(error: unknown = new Error('summarizer down')): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error
    },
  })
}

/** A model that answers only when its call is aborted (then it rejects with the abort reason). */
export function hangingModel(started?: () => void): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: options => new Promise((_resolve, reject) => {
      started?.()
      options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true })
    }),
  })
}

/** A resolved chat model around `model` (catalog entry: the window, a price, no reasoning). */
export function resolvedModel(modelRef: string, model: LanguageModelV4, contextWindow: number | null = 1000): ResolvedModel {
  const [providerId = '', modelId = ''] = modelRef.split(':')
  return {
    modelRef,
    providerId,
    modelId,
    model,
    info: { id: modelId },
    entry: { ref: modelRef, contextWindow, cost: { input: 1, output: 2 }, capabilities: { tools: true, vision: false, pdf: false, reasoning: false }, reasoningEfforts: [] },
    provider: { pluginId: 'test', definition: { id: providerId, name: providerId, credentials: [], createLanguageModel: () => model } },
  } as unknown as ResolvedModel
}

export interface FakeSessionOptions {
  settings?: Partial<Settings>
  history?: HarnessUIMessage[]
  continued?: HarnessUIMessage | null
  /** Models `deps.providers.resolveModel` resolves (`compactModelRef`); anything else is `not_found`. */
  models?: Record<string, ResolvedModel>
  logger?: Logger
  now?: () => number
  /** `deps.chats.addUsage` rejects. */
  usageFails?: boolean
  /** The run's chat model (`prepared.target`); default none. */
  target?: ResolvedModel
}

export interface FakeSession {
  session: RunSession
  /** Usage rows written through `deps.chats.addUsage`. */
  usage: UsageInput[]
  /** Model refs `deps.providers.resolveModel` was asked for. */
  resolved: string[]
  /** Transient chunks written through the bound writer. */
  transient: HarnessDataChunk[]
  /** The run's abort controller. */
  controller: AbortController
}

/** A `RunSession` of chat `chat` (reply `msg_a000000000000009`) over fakes (see `FakeSessionOptions`). */
export function fakeSession(options: FakeSessionOptions = {}): FakeSession {
  const usage: UsageInput[] = []
  const resolved: string[] = []
  const transient: HarnessDataChunk[] = []
  const registry = createRunRegistry()
  const run = registry.acquire('chat', 'mock:run')
  const history = options.history ?? []
  const prepared = {
    resolved: { modelRef: 'mock:run', providerId: 'mock', modelId: 'run', entry: { cost: { input: 1, output: 2 } } },
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    history,
    continued: options.continued ?? null,
    userMessage: null,
    assistantId: options.continued?.id ?? 'msg_a000000000000009',
    replyParentId: null,
    command: null,
    requestModelRef: 'mock:run',
    ...(options.target === undefined ? {} : { target: { kind: 'chat', model: options.target } }),
  } as unknown as PreparedRun
  const deps = {
    redactor: createRedactor(),
    providers: {
      mapError: (_id: string, error: unknown) => (error instanceof HarnessError ? error : new HarnessError({ code: 'provider_error', message: error instanceof Error ? error.message : 'failed' })),
      recordOutcome: async () => {},
      resolveModel: async (ref: string) => {
        resolved.push(ref)
        const model = options.models?.[ref]
        if (model === undefined)
          throw new HarnessError({ code: 'not_found', message: `Unknown model ${ref}.` })
        return model
      },
    },
    chats: {
      addUsage: async (input: UsageInput) => {
        if (options.usageFails)
          throw new Error('database is locked')
        usage.push(input)
      },
    },
    events: { emit: () => {} },
    registry: { hooks: { run: async () => {} }, tools: { list: () => [] } },
    plugins: { guard: async <T>(_pluginId: string, fn: (signal: AbortSignal) => Promise<T> | T) => fn(new AbortController().signal) },
  } as unknown as AppDeps
  const now = options.now ?? (() => 5000)
  const ctx: RunContext = {
    deps,
    registry,
    run,
    prepared,
    toolMode: 'ask',
    reasoningEffort: 'auto',
    logger: options.logger ?? createSilentLogger(),
    now,
    tasks: new TaskTracker(),
    titleTimeoutMs: 10_000,
    lifecycle: new AbortController().signal,
    // The steer queue and the background manager are not used by the compaction code.
    queue: {} as ChatQueue,
    onReleased: () => {},
    background: {} as BackgroundTasks,
  }
  const session = new RunSession(ctx)
  const writer = {
    write: (chunk: HarnessDataChunk) => transient.push(chunk),
    merge: () => {},
    onError: undefined,
  } as unknown as UIMessageStreamWriter<HarnessUIMessage>
  session.bindWriter(writer)
  return { session, usage, resolved, transient, controller: run.controller }
}

/** A user UI message. */
export function user(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

/** An assistant UI message with text parts. */
export function assistant(id: string, ...texts: string[]): HarnessUIMessage {
  return { id, role: 'assistant', parts: texts.map(text => ({ type: 'text' as const, text, state: 'done' as const })) }
}

/** `mock:compact`'s echo of a turn: the text and 150 filler words (what a streamed turn would have stored). */
export function mockCompactReply(id: string, text: string): HarnessUIMessage {
  return assistant(id, `${text} ${Array.from({ length: 150 }).fill('filler').join(' ')}`)
}

/**
 * Appends `messages` (each the parent of the next) to chat `chatId` under its active leaf (the chat is created with
 * `modelRef` when it does not exist) and moves the leaf to the last one: a history without streaming turns.
 */
export async function seedChat(deps: Pick<AppDeps, 'chats'>, chatId: string, messages: readonly HarnessUIMessage[], modelRef = 'mock:compact'): Promise<void> {
  const { chat } = await deps.chats.ensure(chatId, { modelRef, settings: { toolMode: 'ask', reasoningEffort: 'auto' } })
  await deps.chats.transaction(async (store) => {
    let parent = chat.activeLeafId
    for (const message of messages) {
      await store.appendMessage(chatId, message, parent)
      parent = message.id
    }
    if (parent !== null)
      await store.setActiveLeaf(chatId, parent)
  })
}
