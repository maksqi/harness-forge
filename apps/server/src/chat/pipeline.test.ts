import type { HarnessUIMessage, MessageMetadata, SteerData } from '@harness-forge/shared'
import type { LanguageModelUsage, TextStreamPart, ToolSet, UIMessageChunk, UIMessageStreamWriter } from 'ai'
import type { ResolvedModel } from '../providers/types.ts'
import type { AppDeps } from '../types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { RunEnding } from './history.ts'
import type { RunContext } from './pipeline.ts'
import type { PreparedRun } from './prepare.ts'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import { alreadyNoticed, catchStreamErrors, NOTICES, RunSession, TaskTracker, withNotices } from './pipeline.ts'
import { createChatQueue } from './queue.ts'
import { createRunRegistry } from './runs.ts'
import { stepInjector } from './steer.ts'

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

/** The fakes `RunSession` persistence reaches (`#persist`): stored messages, emitted events. */
interface PersistFakes {
  stored: HarnessUIMessage[]
  events: { type: string, data: unknown }[]
}

function session(previous?: MessageMetadata, clock = { now: 1000 }, extra: { onReleased?: RunContext['onReleased'], fakes?: PersistFakes } = {}): RunSession {
  const registry = createRunRegistry()
  const run = registry.acquire('chat', 'prov:model')
  const resolved = { modelRef: 'prov:model', providerId: 'prov', modelId: 'model', entry: { cost: { input: 1, output: 2 } } } as unknown as ResolvedModel
  const continued: HarnessUIMessage | null = previous === undefined ? null : { id: 'msg_a000000000000001', role: 'assistant', metadata: previous, parts: [{ type: 'step-start' }] }
  const prepared = { resolved, continued, assistantId: continued?.id ?? 'msg_a000000000000009', history: continued === null ? [] : [continued], replyParentId: null } as unknown as PreparedRun
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
      touch: async () => {},
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
