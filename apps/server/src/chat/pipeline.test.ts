import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, HarnessUIMessagePart, MessageMetadata, SteerData } from '@harness-forge/shared'
import type { LanguageModelUsage, TextStreamPart, ToolSet, UIMessageChunk, UIMessageStreamWriter } from 'ai'
import type { ResolvedModel } from '../providers/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { AppDeps } from '../types.ts'
import type { AgentRunScope } from './agent-scope.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { RunEnding } from './history.ts'
import type { RunContext } from './pipeline.ts'
import type { PreparedRun } from './prepare.ts'
import { chatDetailSchema, createMessageId, HarnessError, taskResultText } from '@harness-forge/shared'
import { convertToModelMessages } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { agentScopeOf } from './agent-scope.ts'
import { createBackgroundTasks } from './background/index.ts'
import { assistant, seedChat, user } from './compaction/testing.ts'
import { COMPACT_INSTRUCTIONS_MARKER } from './markers.ts'
import { TODO_HINT } from './params.ts'
import { alreadyNoticed, catchStreamErrors, historyToolSet, keptUserMessage, launchRun, NOTICES, RunSession, TaskTracker, withNotices } from './pipeline.ts'
import { createChatQueue } from './queue.ts'
import { createRunRegistry } from './runs.ts'
import { SKILLS_UNAVAILABLE_TEXT } from './skills.ts'
import { stepInjector } from './steer.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      return values
    values.push(value)
  }
}

function streamOf<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const value of values)
        controller.enqueue(value)
      controller.close()
    },
  })
}

describe('notices', () => {
  it('injects data-notice chunks right after the start chunk', async () => {
    const notices = [NOTICES.contextTrimmed()]
    const chunks = await collect(withNotices(streamOf<UIMessageChunk>([{ type: 'start' }, { type: 'start-step' }, { type: 'finish' }]), () => notices))
    expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'data-notice', 'start-step', 'finish'])
    expect(chunks[1]).toEqual({ type: 'data-notice', data: notices[0] })
  })

  it('words the notices and shows a notice once per chat and model', () => {
    expect(NOTICES.superseded(1).message).toBe('A pending tool call was denied because a new message was sent.')
    expect(NOTICES.superseded(3).message).toBe('3 pending tool calls were denied because a new message was sent.')
    expect(NOTICES.filesNotSent(2).message).toBe('This model cannot read 2 of the attached files, so they were not sent.')
    expect(NOTICES.filesNotSent(1)).toEqual({ level: 'warning', code: 'attachments-unsupported', message: 'This model cannot read the attached file, so it was not sent.' })
    expect(NOTICES.toolsUnsupported().code).toBe('tools-unsupported')
    const notice = NOTICES.toolsUnsupported()
    const history: HarnessUIMessage[] = [
      { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'x' }] },
      { id: 'msg_a000000000000001', role: 'assistant', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'data-notice', data: notice }] },
      { id: 'msg_a000000000000002', role: 'assistant', metadata: { modelRef: 'mock:echo', startedAt: 2 }, parts: [] },
    ]
    expect(alreadyNoticed(history, notice, 'mock:echo')).toBe(true)
    expect(alreadyNoticed(history, notice, 'mock:reasoning')).toBe(false)
    expect(alreadyNoticed(history, NOTICES.contextTrimmed(), 'mock:echo')).toBe(false)
  })
})

describe('catchStreamErrors', () => {
  it('turns a stream error into an error part and ends the stream', async () => {
    let pulls = 0
    const failing = new ReadableStream<TextStreamPart<ToolSet>>({
      pull(controller) {
        pulls += 1
        if (pulls === 1)
          controller.enqueue({ type: 'start' })
        else
          controller.error(new Error('reset'))
      },
    })
    const parts = await collect(catchStreamErrors(failing))
    expect(parts.map(part => part.type)).toEqual(['start', 'error'])
    expect(parts[1]?.type === 'error' ? (parts[1].error as Error).message : '').toBe('reset')
  })
})

describe('taskTracker', () => {
  it('waits for tracked tasks, failures included', async () => {
    const tasks = new TaskTracker()
    let done = false
    tasks.track(new Promise(resolve => setTimeout(resolve, 5)).then(() => {
      done = true
    }))
    tasks.track(Promise.reject(new Error('ignored')))
    await tasks.idle()
    expect(done).toBe(true)
  })
})

function usage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
    totalTokens: input + output,
  }
}

/** The fakes `RunSession` persistence reaches (`#persist`): stored messages, emitted events, chat touches. */
interface PersistFakes {
  stored: HarnessUIMessage[]
  events: { type: string, data: unknown }[]
  touches?: { chatId: string, patch: unknown }[]
}

interface SessionExtra {
  onReleased?: RunContext['onReleased']
  fakes?: PersistFakes
  /** Fields that replace those of the minimal prepared run (Phase 10). */
  prepared?: Record<string, unknown>
  origin?: RunContext['origin']
}

function session(previous?: MessageMetadata, clock = { now: 1000 }, extra: SessionExtra = {}): RunSession {
  const registry = createRunRegistry()
  const run = registry.acquire('chat', 'prov:model')
  const resolved = { modelRef: 'prov:model', providerId: 'prov', modelId: 'model', entry: { cost: { input: 1, output: 2 } } } as unknown as ResolvedModel
  const continued: HarnessUIMessage | null = previous === undefined ? null : { id: 'msg_a000000000000001', role: 'assistant', metadata: previous, parts: [{ type: 'step-start' }] }
  const prepared = { resolved, continued, assistantId: continued?.id ?? 'msg_a000000000000009', history: continued === null ? [] : [continued], replyParentId: null, requestModelRef: 'prov:model', ...extra.prepared } as unknown as PreparedRun
  const fakes = extra.fakes ?? { stored: [], events: [] }
  const deps = {
    redactor: createRedactor(),
    providers: { mapError: (_id: string, error: unknown) => HarnessError.from(error), recordOutcome: async () => {} },
    chats: {
      transaction: async (fn: (store: unknown) => Promise<unknown>) => fn({
        upsertMessage: async (_chatId: string, message: HarnessUIMessage) => {
          fakes.stored.push(message)
        },
        setActiveLeaf: async () => true,
      }),
      touch: async (chatId: string, patch: unknown) => {
        fakes.touches?.push({ chatId, patch })
      },
      addUsage: async () => {},
    },
    events: { emit: (type: string, data: unknown) => fakes.events.push({ type, data }) },
    registry: { hooks: { run: async () => {} } },
  } as unknown as AppDeps
  const ctx: RunContext = {
    deps,
    registry,
    run,
    prepared,
    toolMode: 'ask',
    reasoningEffort: 'auto',
    logger: createSilentLogger(),
    now: () => clock.now,
    tasks: new TaskTracker(),
    titleTimeoutMs: 10_000,
    lifecycle: new AbortController().signal,
    queue: createChatQueue(deps, { hasRun: () => false, now: () => clock.now }),
    onReleased: extra.onReleased ?? (() => {}),
    background: createBackgroundTasks(deps, { hasRun: () => false, startTaskTurn: async () => new Response(null) }),
    ...(extra.origin === undefined ? {} : { origin: extra.origin }),
  }
  return new RunSession(ctx)
}

describe('runSession metadata', () => {
  it('sends start metadata and complete finish metadata', () => {
    const clock = { now: 1000 }
    const s = session(undefined, clock)
    expect(s.observe({ type: 'start' })).toEqual({ modelRef: 'prov:model', startedAt: 1000 })
    expect(s.observe({ type: 'text-delta', id: 't', text: 'x' })).toBeUndefined()
    s.observe({ type: 'finish-step', usage: usage(10, 5), finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined, response: {} as never, performance: {} as never })
    clock.now = 1250
    const finish = s.observe({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage(10, 5) })
    expect(finish).toEqual({
      modelRef: 'prov:model',
      startedAt: 1000,
      finishedAt: 1250,
      durationMs: 250,
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, contextTokens: 15 },
      costUsd: 0.00002,
      finishReason: 'stop',
    })
  })

  it('extends the metadata of a continued message', () => {
    const previous: MessageMetadata = {
      modelRef: 'prov:model',
      startedAt: 100,
      finishedAt: 200,
      durationMs: 100,
      reasoningMs: 40,
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, contextTokens: 6 },
      costUsd: 0.5,
      finishReason: 'tool-calls',
    }
    const clock = { now: 1000 }
    const s = session(previous, clock)
    expect(s.observe({ type: 'start' })).toEqual({ modelRef: 'prov:model', startedAt: 100 })
    s.observe({ type: 'finish-step', usage: usage(10, 5), finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined, response: {} as never, performance: {} as never })
    clock.now = 1300
    expect(s.observe({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage(10, 5) })).toMatchObject({
      startedAt: 100,
      finishedAt: 1300,
      durationMs: 400,
      reasoningMs: 40,
      usage: { inputTokens: 15, outputTokens: 6, totalTokens: 21, contextTokens: 15 },
      costUsd: 0.50002,
      finishReason: 'stop',
    })
  })

  it('marks aborted and failed endings', () => {
    const s = session()
    const aborted = s.buildFinishMetadata(1500, 'aborted')
    expect(aborted).toMatchObject({ aborted: true, finishedAt: 1500 })
    expect(aborted.finishReason).toBeUndefined()
    s.recordFatal(new HarnessError({ code: 'auth_invalid', message: 'Bad key' }))
    expect(s.buildFinishMetadata(1500, 'failed')).toMatchObject({ finishReason: 'error', error: { code: 'auth_invalid', message: 'Bad key' } })
  })

  it('formats tool errors as text and run errors as envelopes', () => {
    const s = session()
    expect(s.errorText(new DOMException('x', 'AbortError'))).toBe('The run was stopped.')
    expect(JSON.parse(s.errorText(new HarnessError({ code: 'rate_limited', message: 'Slow down', retryAfterMs: 1000 })))).toEqual({ error: { code: 'rate_limited', message: 'Slow down', retryAfterMs: 1000 } })
  })
})

describe('runSession: images (ADR-028)', () => {
  function imageSession(options: { n?: number, aspectRatio?: '16:9', inputs?: number } = {}): RunSession {
    const s = session()
    const target = {
      kind: 'image',
      model: s.ctx.prepared.resolved,
      options: { prompt: 'fox', n: options.n ?? 2, ...(options.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio }), inputFileIds: Array.from({ length: options.inputs ?? 0 }, (_, i) => `file_${i}`), dropped: 0 },
    }
    Object.assign(s.ctx.prepared, { target })
    return s
  }

  it('adds the image request to the start metadata of an image turn only', () => {
    const s = imageSession({ aspectRatio: '16:9', inputs: 2 })
    expect(s.startMetadata().image).toBeUndefined()
    s.mode = 'image'
    expect(s.startMetadata()).toEqual({ modelRef: 'prov:model', startedAt: 1000, image: { n: 2, aspectRatio: '16:9', inputs: 2 } })
  })

  it('finishes an image turn with its usage, estimated cost and revised prompt', () => {
    const s = imageSession()
    s.mode = 'image'
    s.image = { modelRef: 'prov:model', images: [], usage: { inputTokens: 3.4, outputTokens: 200, totalTokens: 203 }, costUsd: 0.0123456789012, revisedPrompt: `  ${'r'.repeat(40_000)}`, dropped: 0 }
    const metadata = s.buildFinishMetadata(1500, 'completed')
    expect(metadata).toMatchObject({ usage: { inputTokens: 3, outputTokens: 200, totalTokens: 203 }, costUsd: 0.0123456789, finishReason: 'stop', image: { n: 2, inputs: 0 } })
    expect(metadata.image?.revisedPrompt).toHaveLength(32_000)
    // Without usage or cost (xAI) the fields stay absent; a failure keeps the request.
    s.image = { modelRef: 'prov:model', images: [], usage: null, costUsd: null, dropped: 0 }
    const bare = s.buildFinishMetadata(1500, 'completed')
    expect(bare.usage).toBeUndefined()
    expect(bare.costUsd).toBeUndefined()
    expect(bare.image).toEqual({ n: 2, inputs: 0 })
    s.image = null
    s.recordFatal(new HarnessError({ code: 'provider_error', message: 'No image' }))
    expect(s.buildFinishMetadata(1500, 'failed')).toMatchObject({ finishReason: 'error', error: { code: 'provider_error' }, image: { n: 2, inputs: 0 } })
  })

  it('adds extra costs (generate_image outputs, compaction, sub-agents) to the message cost and rebuilds the finish metadata', () => {
    const clock = { now: 1000 }
    const s = session(undefined, clock)
    s.observe({ type: 'finish-step', usage: usage(10, 5), finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined, response: {} as never, performance: {} as never })
    clock.now = 1250
    const observed = s.observe({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage(10, 5) })
    expect(observed?.costUsd).toBe(0.00002)
    expect(s.finishWithExtraCost(observed)).toBe(observed)
    s.addExtraCost(0.04)
    s.addExtraCost(Number.NaN)
    s.addExtraCost(-1)
    clock.now = 9999
    const rebuilt = s.finishWithExtraCost(observed)
    expect(rebuilt).toEqual({ ...observed, costUsd: 0.04002 })
    expect(s.finishMetadata).toBe(rebuilt)
    expect(s.buildFinishMetadata(2000, 'aborted').costUsd).toBe(0.04002)
  })

  it('saves stored files with their names and never a data URL; notices go where the run content starts', () => {
    const s = session({ modelRef: 'prov:model', startedAt: 1 })
    const url = s.generated.add({ id: 'file_gen0000000000001', name: 'image-1.png' })
    s.notices.push(NOTICES.contextTrimmed())
    const continued = s.ctx.prepared.continued!
    const response: HarnessUIMessage = {
      ...continued,
      parts: [
        ...continued.parts,
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        { type: 'file', mediaType: 'image/png', url },
        { type: 'text', text: 'done', state: 'streaming' },
      ],
    }
    const saved = s.finalMessage(response, 'completed')
    expect(saved.parts).toEqual([
      { type: 'step-start' },
      { type: 'data-notice', data: NOTICES.contextTrimmed() },
      { type: 'file', mediaType: 'image/png', url, filename: 'image-1.png' },
      { type: 'text', text: 'done', state: 'done' },
    ])
  })
})

// ---------- Phase 9 seams (C26) ----------

function steer(id: string, text: string): SteerData {
  return { id, parts: [{ type: 'text', text }], queuedAt: 1, deliveredAt: 2 }
}

describe('runSession: step injections (Phase 9)', () => {
  it('places an injected chunk right before the start-step of its step through stepInjector', async () => {
    const s = session()
    const notice = { type: 'data-notice' as const, data: NOTICES.contextTrimmed() }
    const marker = { type: 'data-steer' as const, data: steer('msg_s000000000000001', 'also check b') }
    s.inject(notice, 0)
    s.inject(marker, 1)
    const source: HarnessUIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 't0' },
      { type: 'text-end', id: 't0' },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]
    const chunks = await collect(streamOf(source).pipeThrough(stepInjector(s)))
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'start',
      'data-notice',
      'start-step',
      'text-start',
      'text-end',
      'finish-step',
      'data-steer',
      'start-step',
      'finish-step',
      'finish',
    ])
    expect(s.takeInjections(Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('takes the injections of finished steps only, in injection order', () => {
    const s = session()
    const a = { type: 'data-steer' as const, data: steer('msg_s000000000000001', 'a') }
    const b = { type: 'data-steer' as const, data: steer('msg_s000000000000002', 'b') }
    const c = { type: 'data-steer' as const, data: steer('msg_s000000000000003', 'c') }
    s.inject(b, 2)
    s.inject(a, 1)
    s.inject(c, 2)
    expect(s.takeInjections(0)).toEqual([])
    expect(s.takeInjections(1)).toEqual([a])
    expect(s.takeInjections(Number.POSITIVE_INFINITY)).toEqual([b, c])
  })

  it('appends an injected steer the response lost when it saves the message, once', () => {
    const s = session()
    const placed = { type: 'data-steer' as const, data: steer('msg_s000000000000001', 'placed') }
    const lost = { type: 'data-steer' as const, id: 'steer-2', data: steer('msg_s000000000000002', 'lost') }
    s.inject(placed, 1)
    s.inject(lost, 2)
    const response: HarnessUIMessage = {
      id: s.assistantId,
      role: 'assistant',
      parts: [{ type: 'step-start' }, { type: 'text', text: 'one', state: 'done' }, { type: 'data-steer', data: placed.data }, { type: 'step-start' }],
    }
    const saved = s.finalMessage(response, 'aborted')
    expect(saved.parts).toEqual([...response.parts, { type: 'data-steer', id: 'steer-2', data: lost.data }])
    expect(s.finalMessage(saved, 'aborted').parts.filter(part => part.type === 'data-steer')).toHaveLength(2)
  })

  it('writes transient chunks through the bound writer only', () => {
    const s = session()
    const activity = { type: 'data-activity' as const, data: { kind: 'compacting' as const } }
    expect(() => s.writeTransient(activity)).not.toThrow()
    const written: unknown[] = []
    const writer = { write: (chunk: unknown) => written.push(chunk), merge: () => {}, onError: undefined } as unknown as UIMessageStreamWriter<HarnessUIMessage>
    s.bindWriter(writer)
    s.writeTransient(activity)
    expect(written).toEqual([{ type: 'data-activity', data: { kind: 'compacting' }, transient: true }])
  })
})

describe('runSession: release callback (Phase 9)', () => {
  it('calls onReleased once, right after run.finished, with the ending and the approval state', async () => {
    const calls: { ending: RunEnding, awaitingApproval: boolean, eventsBefore: number }[] = []
    const fakes: PersistFakes = { stored: [], events: [] }
    const s = session(undefined, { now: 1000 }, {
      fakes,
      onReleased: (ending, awaitingApproval) => calls.push({ ending, awaitingApproval, eventsBefore: fakes.events.length }),
    })
    await s.finalize(undefined, false)
    await s.finalize(undefined, false)
    await s.ensureFinalized()
    expect(calls).toEqual([{ ending: 'completed', awaitingApproval: false, eventsBefore: 1 }])
    expect(fakes.events.map(event => event.type)).toEqual(['run.finished'])
    expect(fakes.stored).toHaveLength(1)
  })

  it('reports an aborted run and survives a throwing callback', async () => {
    const endings: RunEnding[] = []
    const s = session(undefined, { now: 1000 }, {
      onReleased: (ending) => {
        endings.push(ending)
        throw new Error('callback exploded')
      },
    })
    await expect(s.finalize(undefined, true)).resolves.toBeUndefined()
    expect(endings).toEqual(['aborted'])
  })

  it('does not call onReleased for a run released by a forced stop', async () => {
    const endings: RunEnding[] = []
    const s = session(undefined, { now: 1000 }, { onReleased: ending => endings.push(ending) })
    s.ctx.run.forceReleased = true
    s.ctx.registry.release(s.ctx.run)
    await s.finalize(undefined, true)
    expect(endings).toEqual([])
  })
})

// ---------- W9.1: compaction inside runs, the history tool set, the agent blocks, run.started ----------

/** Models of the `compactkit` provider (window 10 000, tools), set per test. */
const compactkit = new Map<string, LanguageModelV4>()
let app: TestApp

function streamFinish(input: number, output: number, reason: 'stop' | 'tool-calls'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

/** A text (and optionally one `current_time` call) as stream parts, reporting `input` prompt tokens. */
function stepParts(text: string, call: string | null, input = 10): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    ...(call === null ? [] : [{ type: 'tool-call' as const, toolCallId: call, toolName: 'current_time', input: '{}' }]),
    streamFinish(input, 5, call === null ? 'stop' : 'tool-calls'),
  ]
}

/** The texts of a provider prompt (system included), for "contains" checks. */
function promptText(call: LanguageModelV4CallOptions | undefined): string {
  return JSON.stringify(call?.prompt ?? [])
}

/** The first text part of the first user message of a provider prompt. */
function firstUserText(call: LanguageModelV4CallOptions | undefined): string {
  const message = call?.prompt.find(entry => entry.role === 'user')
  const part = message?.role === 'user' ? message.content[0] : undefined
  return part?.type === 'text' ? part.text : ''
}

async function compactDetail(chatId: string): Promise<ChatDetail> {
  const response = await app.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

describe('compaction inside runs (W9.1-T5)', () => {
  let disposable: { dispose: () => void } | undefined

  beforeAll(async () => {
    app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    disposable = app.deps.registry.providers.register('mock', {
      id: 'compactkit',
      name: 'Compact kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 10_000, capabilities: { tools: true }, cost: { input: 1, output: 2 } }],
      createLanguageModel: (modelId) => {
        const model = compactkit.get(modelId)
        if (model === undefined)
          throw new Error(`No scripted model "${modelId}".`)
        return model
      },
    })
  })

  afterAll(async () => {
    disposable?.dispose()
    await app.close()
  })

  it('carries the summary into the later steps and equals buildModelHistory of the saved reply', async () => {
    const streamCalls: LanguageModelV4CallOptions[] = []
    const summarizerCalls: LanguageModelV4CallOptions[] = []
    // Calls 1-4 do a step with a `current_time` call; call 2 reports a context above 80 % of the window, so the guard
    // compacts before call 3 (step 2). Calls from 5 on answer with text.
    compactkit.set('agent', new MockLanguageModelV4({
      doStream: async (options) => {
        streamCalls.push(options)
        const n = streamCalls.length
        const parts = n <= 4 ? stepParts(`Step ${n} done.`, `call_${n}`, n === 2 ? 9500 : 10) : stepParts(n === 5 ? 'All done.' : 'Next answer.', null)
        return { stream: convertArrayToReadableStream(parts) }
      },
      doGenerate: async (options) => {
        // The chat title is asked for with `generateText` too: only the summarizer calls carry the marker.
        const summarizer = promptText(options).includes(COMPACT_INSTRUCTIONS_MARKER)
        if (summarizer)
          summarizerCalls.push(options)
        return {
          content: [{ type: 'text', text: summarizer ? 'SUMMARY-ONE of steps 1 and 2' : 'A title' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } },
          warnings: [],
        }
      },
    }))
    const chatId = testChatId(9150)
    const body = { ...chatBody(chatId, 'do the work OLD-9'), modelRef: 'compactkit:agent' }
    const { chunks } = await readSse(await postChat(app, body))
    await runnerOf(app).idle()
    expect(streamCalls).toHaveLength(5)
    expect(summarizerCalls).toHaveLength(1)
    expect(promptText(summarizerCalls[0])).toContain(COMPACT_INSTRUCTIONS_MARKER)

    // Steps 0 and 1 saw the original request; steps 2, 3 and 4 start with the summary, then the request.
    expect(firstUserText(streamCalls[0])).toBe('do the work OLD-9')
    expect(firstUserText(streamCalls[1])).toBe('do the work OLD-9')
    for (const call of streamCalls.slice(2)) {
      expect(firstUserText(call)).toContain('SUMMARY-ONE of steps 1 and 2')
      expect(promptText(call)).toContain('do the work OLD-9')
      expect(promptText(call)).not.toContain('Step 1 done.')
      expect(promptText(call)).not.toContain('Step 2 done.')
    }
    expect(promptText(streamCalls[3])).toContain('Step 3 done.')
    expect(promptText(streamCalls[4])).toContain('Step 4 done.')

    // The marker was streamed right before the start-step of step 2, with the activity around the summary.
    const types = chunks.map(chunk => chunk.type)
    const markerAt = types.indexOf('data-compaction')
    expect(markerAt).toBeGreaterThan(0)
    expect(types[markerAt + 1]).toBe('start-step')
    expect(chunks.filter(chunk => chunk.type === 'start-step').length).toBe(5)
    expect(types.slice(0, markerAt).filter(type => type === 'start-step')).toHaveLength(2)
    expect(chunks.filter(chunk => chunk.type === 'data-activity').map(chunk => (chunk as { data: unknown }).data)).toEqual([{ kind: 'compacting' }, { kind: 'idle' }])

    // The saved reply holds the marker exactly there; the usage row and the cost are recorded.
    const detail = await compactDetail(chatId)
    const reply = detail.messages.at(-1)!
    const markerIndex = reply.parts.findIndex(part => part.type === 'data-compaction')
    const marker = reply.parts[markerIndex]
    expect(marker?.type === 'data-compaction' ? marker.data : null).toMatchObject({ trigger: 'auto', keep: 'last-user', summary: 'SUMMARY-ONE of steps 1 and 2', modelRef: 'compactkit:agent', messagesCompacted: 1 })
    expect(reply.parts[markerIndex + 1]?.type).toBe('step-start')
    expect(JSON.stringify(reply.parts.slice(0, markerIndex))).toContain('Step 2 done.')
    const rows = await app.database.client.execute({ sql: 'SELECT purpose, message_id FROM usage WHERE chat_id = ? AND purpose IN (\'chat\', \'compact\') ORDER BY purpose', args: [chatId] })
    expect(rows.rows.map(row => [row.purpose, row.message_id])).toEqual([['chat', reply.id], ['compact', reply.id]])

    // Equivalence: the next turn's history (`buildModelHistory` of the saved path) starts with exactly the messages
    // the last in-run step saw, followed by that step's answer.
    await readSse(await postChat(app, { ...chatBody(chatId, 'and now?'), modelRef: 'compactkit:agent' }))
    await runnerOf(app).idle()
    const lastInRun = streamCalls[4]!.prompt
    const nextTurn = streamCalls[5]!.prompt
    expect(nextTurn.slice(0, lastInRun.length)).toEqual(lastInRun)
    expect(nextTurn.slice(lastInRun.length)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ])
    // The summary is never logged at info.
    expect(app.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record)).join('\n')).not.toContain('SUMMARY-ONE')
  })

  it('a stop while the summary is written ends the run aborted, without a marker', async () => {
    let started!: () => void
    const summarizing = new Promise<void>((resolve) => {
      started = resolve
    })
    let streamCalls = 0
    compactkit.set('agent', new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1
        return { stream: convertArrayToReadableStream(stepParts(`Step ${streamCalls} done.`, `call_${streamCalls}`, 9500)) }
      },
      doGenerate: options => new Promise((_resolve, reject) => {
        if (!promptText(options).includes(COMPACT_INSTRUCTIONS_MARKER)) {
          reject(new Error('no title'))
          return
        }
        started()
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true })
      }),
    }))
    const chatId = testChatId(9154)
    const response = await postChat(app, { ...chatBody(chatId, 'work'), modelRef: 'compactkit:agent' })
    const reading = readSse(response)
    await summarizing
    expect(await runnerOf(app).stop(chatId)).toBe(true)
    const { chunks } = await reading
    await runnerOf(app).idle()
    expect(streamCalls).toBe(1)
    expect(chunks.some(chunk => chunk.type === 'data-compaction')).toBe(false)
    const reply = (await compactDetail(chatId)).messages.at(-1)!
    expect(reply.metadata?.aborted).toBe(true)
    expect(reply.metadata?.error).toBeUndefined()
    expect(reply.parts.some(part => part.type === 'data-compaction' || part.type === 'data-notice')).toBe(false)
  })

  it('without compaction the history goes to the model unchanged', async () => {
    const streamCalls: LanguageModelV4CallOptions[] = []
    compactkit.set('agent', new MockLanguageModelV4({
      doStream: async (options) => {
        streamCalls.push(options)
        return { stream: convertArrayToReadableStream(stepParts('plain', null)) }
      },
    }))
    const chatId = testChatId(9151)
    await readSse(await postChat(app, { ...chatBody(chatId, 'hello'), modelRef: 'compactkit:agent' }))
    await runnerOf(app).idle()
    expect(firstUserText(streamCalls[0])).toBe('hello')
    expect((await compactDetail(chatId)).messages.at(-1)?.parts.some(part => part.type === 'data-compaction')).toBe(false)
  })

  it('sends the agent blocks of the offered core-agent tools in the instructions', async () => {
    const streamCalls: LanguageModelV4CallOptions[] = []
    compactkit.set('agent', new MockLanguageModelV4({
      doStream: async (options) => {
        streamCalls.push(options)
        return { stream: convertArrayToReadableStream(stepParts('ok', null)) }
      },
    }))
    const chatId = testChatId(9152)
    await readSse(await postChat(app, { ...chatBody(chatId, 'hi'), modelRef: 'compactkit:agent' }))
    await runnerOf(app).idle()
    const offered = (streamCalls[0]?.tools ?? []).map(entry => entry.name)
    expect(offered).toContain('todo_write')
    const system = streamCalls[0]?.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n') ?? ''
    expect(system).toContain(TODO_HINT)
  })

  it('emits run.started with origin request', async () => {
    compactkit.set('agent', new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(stepParts('ok', null)) }) }))
    const chatId = testChatId(9153)
    const started = new Promise<unknown>((resolve) => {
      const subscription = app.deps.events.subscribe((event) => {
        if (event.type === 'run.started' && event.data.chatId === chatId) {
          subscription.dispose()
          resolve(event.data)
        }
      })
    })
    await readSse(await postChat(app, { ...chatBody(chatId, 'hi'), modelRef: 'compactkit:agent' }))
    await runnerOf(app).idle()
    const data = await started as Record<string, unknown>
    expect(data).toMatchObject({ chatId, modelRef: 'compactkit:agent', origin: 'request' })
    expect(data.userMessageId).toBeUndefined()
  })
})

describe('mock:compact runs (W9.1-T3 / T5)', () => {
  let loopApp: TestApp

  beforeAll(async () => {
    loopApp = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  })

  afterAll(async () => {
    await loopApp.close()
  })

  /** A chat whose history (eight turns with sentinels, about 2300 tokens) is above the 2000-token window. */
  async function oversized(chatId: string): Promise<void> {
    const turns = [1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => [user(createMessageId(), `old turn OLD-${n}`), assistant(createMessageId(), `answer ${n} ${'filler '.repeat(150)}`)])
    await seedChat(loopApp.deps, chatId, turns)
  }

  async function seen(chatId: string): Promise<{ text: string, reply: HarnessUIMessage }> {
    const { chunks } = await readSse(await postChat(loopApp, { ...chatBody(chatId, 'seen?'), modelRef: 'mock:compact' }))
    await runnerOf(loopApp).idle()
    const detail = chatDetailSchema.parse(await (await loopApp.request(`/api/chats/${chatId}`)).json())
    return { text: streamedText(chunks), reply: detail.messages.at(-1)! }
  }

  it('compacts an oversized history before the first step (the marker opens the reply)', async () => {
    const chatId = testChatId(9156)
    await oversized(chatId)
    const { text, reply } = await seen(chatId)
    expect(text).toBe('summary:yes seen:none')
    expect(reply.parts[0]?.type).toBe('data-compaction')
    expect(reply.parts[0]?.type === 'data-compaction' ? reply.parts[0].data : null).toMatchObject({ trigger: 'auto', keep: 'last-user', messagesCompacted: 16 })
    expect(reply.parts.some(part => part.type === 'data-notice')).toBe(false)
  })

  it('autoCompact off: no marker, the oldest turns trimmed with context-trimmed', async () => {
    const chatId = testChatId(9157)
    await oversized(chatId)
    await loopApp.deps.settings.update({ autoCompact: false })
    try {
      const { text, reply } = await seen(chatId)
      expect(text).toMatch(/^summary:no seen:OLD-\d/)
      expect(text).not.toContain('OLD-1,')
      expect(reply.parts.some(part => part.type === 'data-compaction')).toBe(false)
      expect(reply.parts.filter(part => part.type === 'data-notice').map(part => part.type === 'data-notice' ? part.data.code : null)).toEqual(['context-trimmed'])
    }
    finally {
      await loopApp.deps.settings.update({ autoCompact: true })
    }
  })

  it('a failing summarizer: the run still answers, trimmed, with compaction-failed; the stored history is unchanged', async () => {
    const chatId = testChatId(9158)
    await oversized(chatId)
    const before = chatDetailSchema.parse(await (await loopApp.request(`/api/chats/${chatId}`)).json()).messages
    await loopApp.deps.settings.update({ compactModelRef: 'mock:error' })
    try {
      const { text, reply } = await seen(chatId)
      expect(text).toMatch(/^summary:no seen:OLD-\d/)
      expect(reply.parts.some(part => part.type === 'data-compaction')).toBe(false)
      expect(reply.parts.filter(part => part.type === 'data-notice').map(part => part.type === 'data-notice' ? part.data.code : null)).toEqual(['compaction-failed'])
      const after = chatDetailSchema.parse(await (await loopApp.request(`/api/chats/${chatId}`)).json()).messages
      expect(after.slice(0, before.length)).toEqual(before)
    }
    finally {
      await loopApp.deps.settings.update({ compactModelRef: null })
    }
  })

  it('a loop run compacts between two steps and finishes', async () => {
    const chatId = testChatId(9155)
    // A long earlier conversation (about 1200 tokens), so the second step of the loop passes 80 % of the window.
    const seeded = [1, 2, 3, 4].flatMap(n => [user(createMessageId(), `seed turn ${n}`), assistant(createMessageId(), `seed answer ${n} ${'filler '.repeat(170)}`)])
    await seedChat(loopApp.deps, chatId, seeded)
    const { chunks } = await readSse(await postChat(loopApp, { ...chatBody(chatId, 'loop 2'), modelRef: 'mock:compact' }))
    await runnerOf(loopApp).idle()
    expect(streamedText(chunks)).toContain('Loop finished after 2 steps.')
    const reply = (await chatDetailSchema.parse(await (await loopApp.request(`/api/chats/${chatId}`)).json())).messages.at(-1)!
    const markerIndex = reply.parts.findIndex(part => part.type === 'data-compaction')
    expect(markerIndex).toBeGreaterThan(0)
    // Between the steps: step 1 before the marker, step 2 after it.
    expect(JSON.stringify(reply.parts.slice(0, markerIndex))).toContain('Step 1 done.')
    expect(JSON.stringify(reply.parts.slice(markerIndex))).toContain('Step 2 done.')
    const marker = reply.parts[markerIndex]
    expect(marker?.type === 'data-compaction' ? marker.data : null).toMatchObject({ trigger: 'auto', keep: 'last-user', todos: [{ id: 'loop', status: 'in_progress' }] })
    expect(marker?.type === 'data-compaction' ? marker.data.summary : '').toContain('steps-done=1')
  }, 30_000)
})

describe('historyToolSet (W9.1, from W9.3)', () => {
  it('converts earlier outputs of tools the run does not offer with their toModelOutput', async () => {
    const plugins = { guard: async <T>(_pluginId: string, fn: (signal: AbortSignal) => Promise<T> | T) => fn(new AbortController().signal) } as never
    const writeTool = {
      pluginId: 'core-workspace',
      mcpServerId: null,
      title: null,
      definition: { name: 'write_file', description: 'w', inputSchema: z.object({ path: z.string() }), toModelOutput: () => ({ type: 'text' as const, value: 'Wrote notes.txt.' }), execute: async () => ({ diff: 'RAW-DIFF' }) },
    }
    const plain = { pluginId: 'x', mcpServerId: null, title: null, definition: { name: 'plain', description: 'p', inputSchema: z.object({}), execute: async () => 1 } }
    const set = historyToolSet({}, [writeTool, plain] as never, plugins)
    expect(Object.keys(set)).toEqual(['write_file'])
    const history: HarnessUIMessage[] = [
      { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'plan it' }] },
      { id: 'msg_a000000000000001', role: 'assistant', parts: [{ type: 'tool-write_file', toolCallId: 'w1', state: 'output-available', input: { path: 'notes.txt' }, output: { diff: 'RAW-DIFF' } } as unknown as HarnessUIMessagePart] },
    ]
    const converted = JSON.stringify(await convertToModelMessages(history, { tools: set }))
    expect(converted).toContain('Wrote notes.txt.')
    expect(converted).not.toContain('RAW-DIFF')
    // The run's own tools win over the registry entries.
    const own = { write_file: { inputSchema: z.object({}), toModelOutput: () => ({ type: 'text' as const, value: 'own' }) } } as never
    expect(historyToolSet(own, [writeTool] as never, plugins).write_file).toBe((own as Record<string, unknown>).write_file)
  })
})

// ---------- Phase 10 (C31-T1): the chat keeps its model, task results tracked like steers, the run's seams ----------

describe('runSession: Phase 10 seams', () => {
  const taskId = 'bgt_0000000000000001'
  function taskResult(id: string = taskId) {
    return {
      taskId: id,
      toolCallId: 'call_bg',
      messageId: 'msg_a000000000000001',
      output: { status: 'completed' as const, type: 'explore', description: 'Look around', modelRef: 'prov:model', steps: [], stepsOmitted: 0, report: 'Found it.', startedAt: 1, finishedAt: 2, taskId: id },
      deliveredAt: 3,
    }
  }

  it('appends an injected task result the response lost when it saves the message, once', () => {
    const s = session()
    const placed = { type: 'data-task-result' as const, data: taskResult() }
    const steered = { type: 'data-steer' as const, data: steer('msg_s000000000000001', 'lost steer') }
    const lost = { type: 'data-task-result' as const, id: 'result-2', data: taskResult('bgt_0000000000000002') }
    s.inject(placed, 1)
    s.inject(steered, 2)
    s.inject(lost, 2)
    const response: HarnessUIMessage = {
      id: s.assistantId,
      role: 'assistant',
      parts: [{ type: 'step-start' }, { type: 'text', text: 'one', state: 'done' }, { type: 'data-task-result', data: placed.data }, { type: 'step-start' }],
    }
    const saved = s.finalMessage(response, 'aborted')
    expect(saved.parts).toEqual([
      ...response.parts,
      { type: 'data-steer', data: steered.data },
      { type: 'data-task-result', id: 'result-2', data: lost.data },
    ])
    const again = s.finalMessage(saved, 'aborted')
    expect(again.parts.filter(part => part.type === 'data-task-result')).toHaveLength(2)
    expect(again.parts.filter(part => part.type === 'data-steer')).toHaveLength(1)
  })

  it('the guard\'s kept user message of a task turn is its carrier read as the result text', async () => {
    const carrier: HarnessUIMessage = { id: 'msg_c000000000000001', role: 'user', parts: [{ type: 'data-task-result', data: taskResult() }] }
    const s = session(undefined, { now: 1000 }, { prepared: { history: [carrier] } })
    const model = { entry: { capabilities: { tools: true, vision: false, pdf: false } } } as unknown as ResolvedModel
    const kept = await keptUserMessage(s, model, {})()
    expect(kept).toEqual({ role: 'user', content: [{ type: 'text', text: taskResultText(taskResult()) }] })
    const plain = session(undefined, { now: 1000 }, { prepared: { history: [{ id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] } })
    expect(await keptUserMessage(plain, model, {})()).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    expect(await keptUserMessage(session(), model, {})()).toBeNull()
  })

  it('touches the chat with the request\'s model when a command model ran the turn; run.started and the reply name the model that ran', async () => {
    const fakes: PersistFakes = { stored: [], events: [], touches: [] }
    const userMessageId = 'msg_u000000000000001'
    const s = session(undefined, { now: 1000 }, {
      fakes,
      origin: 'task',
      prepared: {
        requestModelRef: 'mock:echo',
        command: { kind: 'reply', invocation: { name: 'note', input: '', type: 'reply' }, markdown: 'Done.' },
        chat: { titleSource: 'user', settings: {} },
        notices: [],
        superseded: 0,
        userMessage: { id: userMessageId, role: 'user', parts: [] },
        target: { kind: 'chat', model: {} },
      },
    })
    const response = await launchRun(s.ctx)
    await response.text()
    await s.ctx.run.settled
    expect(fakes.touches).toEqual([
      { chatId: 'chat', patch: { pendingApproval: false, modelRef: 'mock:echo' } },
      { chatId: 'chat', patch: { pendingApproval: false, modelRef: 'mock:echo' } },
    ])
    expect(fakes.events.find(event => event.type === 'run.started')?.data).toEqual({
      chatId: 'chat',
      messageId: 'msg_a000000000000009',
      modelRef: 'prov:model',
      origin: 'task',
      userMessageId,
    })
    expect(fakes.stored.at(-1)?.metadata?.modelRef).toBe('prov:model')
  })
})

describe('modelStream: Phase 10 seams (C31-T1)', () => {
  const kit = new Map<string, LanguageModelV4>()
  let seamApp: TestApp
  let disposables: { dispose: () => void }[] = []

  beforeAll(async () => {
    seamApp = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    disposables.push(seamApp.deps.registry.providers.register('mock', {
      id: 'seamkit',
      name: 'Seam kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 32_000, capabilities: { tools: true }, cost: { input: 1, output: 2 } }],
      createLanguageModel: (modelId) => {
        const model = kit.get(modelId)
        if (model === undefined)
          throw new Error(`No scripted model "${modelId}".`)
        return model
      },
    }))
  })

  afterAll(async () => {
    for (const disposable of disposables)
      disposable.dispose()
    disposables = []
    await seamApp.close()
  })

  /** A model that calls `toolName` with `input` in its first step and answers "done" afterwards. */
  function callingModel(toolName: string, input: unknown, calls: LanguageModelV4CallOptions[] = []): LanguageModelV4 {
    return new MockLanguageModelV4({
      doStream: async (options) => {
        calls.push(options)
        const parts: LanguageModelV4StreamPart[] = calls.length === 1
          ? [{ type: 'tool-call', toolCallId: 'call_1', toolName, input: JSON.stringify(input) }, streamFinish(10, 5, 'tool-calls')]
          : stepParts('done', null)
        return { stream: convertArrayToReadableStream(parts) }
      },
    })
  }

  it('a background task call yields one failed output "Background agents are not available yet." (C30 stub)', async () => {
    kit.set('agent', callingModel('task', { description: 'Look around', prompt: 'Find the config.', type: 'explore', background: true }))
    const chatId = testChatId(10_001)
    const { chunks } = await readSse(await postChat(seamApp, { ...chatBody(chatId, 'go'), modelRef: 'seamkit:agent' }))
    await runnerOf(seamApp).idle()
    // The runner yields one output; the streaming tool wrapper sends it as its preliminary and its final value.
    const outputs = chunks.filter(chunk => chunk.type === 'tool-output-available' && chunk.toolCallId === 'call_1') as { output: unknown, preliminary?: boolean }[]
    const final = outputs.filter(chunk => chunk.preliminary !== true)
    expect(final).toHaveLength(1)
    expect(new Set(outputs.map(chunk => JSON.stringify(chunk.output))).size).toBe(1)
    const detail = chatDetailSchema.parse(await (await seamApp.request(`/api/chats/${chatId}`)).json())
    const part = detail.messages.at(-1)?.parts.find(entry => entry.type === 'tool-task') as { output?: { status?: string, error?: string } } | undefined
    expect(part?.output).toMatchObject({ status: 'failed', error: 'Background agents are not available yet.', type: 'explore', description: 'Look around' })
  })

  it('binds loadSkill and savePlan into the agent scope of every call (stubs until W10.5); skill is not offered without skills', async () => {
    const seen: (AgentRunScope | null)[] = []
    const contexts: ToolCallContext[] = []
    disposables.push(seamApp.deps.registry.tools.register('mock', {
      name: 'scope_probe',
      description: 'Records the agent scope.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async (_input, c) => {
        seen.push(agentScopeOf(c))
        contexts.push(c)
        return 'ok'
      },
    }))
    const calls: LanguageModelV4CallOptions[] = []
    kit.set('agent', callingModel('scope_probe', {}, calls))
    const chatId = testChatId(10_002)
    await readSse(await postChat(seamApp, { ...chatBody(chatId, 'probe'), modelRef: 'seamkit:agent' }))
    await runnerOf(seamApp).idle()
    const scope = seen[0]
    expect(scope).toMatchObject({ chatId, toolMode: 'ask' })
    await expect(scope!.loadSkill('release-notes', new AbortController().signal)).rejects.toMatchObject({ code: 'not_found', message: SKILLS_UNAVAILABLE_TEXT })
    expect(await scope!.savePlan('# Plan', contexts[0]!)).toEqual({})
    // The plugin's context carries no scope member.
    expect(Object.keys(contexts[0]!).sort()).toEqual(['chatId', 'messages', 'modelRef', 'signal', 'toolCallId'])
    expect((calls[0]?.tools ?? []).map(entry => entry.name)).not.toContain('skill')
  })

  it('offers skill when the run catalog has skills', async () => {
    const skillApp = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake' })
    const provider = skillApp.deps.registry.providers.register('mock', {
      id: 'seamkit',
      name: 'Seam kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 32_000, capabilities: { tools: true }, cost: { input: 1, output: 2 } }],
      createLanguageModel: () => kit.get('agent')!,
    })
    try {
      const fake = skillApp.deps.customizations as FakeCustomizationService
      fake.entries.set('', [fakeCatalogEntry('skill', 'release-notes', { source: 'plugin', pluginId: 'mock' })])
      const calls: LanguageModelV4CallOptions[] = []
      kit.set('agent', new MockLanguageModelV4({
        doStream: async (options) => {
          calls.push(options)
          return { stream: convertArrayToReadableStream(stepParts('ok', null)) }
        },
      }))
      await readSse(await postChat(skillApp, { ...chatBody(testChatId(10_003), 'hi'), modelRef: 'seamkit:agent' }))
      await runnerOf(skillApp).idle()
      expect((calls[0]?.tools ?? []).map(entry => entry.name)).toContain('skill')
    }
    finally {
      provider.dispose()
      await skillApp.close()
    }
  })
})
