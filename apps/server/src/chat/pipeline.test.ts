import type { HarnessUIMessage, MessageMetadata } from '@harness-forge/shared'
import type { LanguageModelUsage, TextStreamPart, ToolSet, UIMessageChunk } from 'ai'
import type { ResolvedModel } from '../providers/types.ts'
import type { AppDeps } from '../types.ts'
import type { RunContext } from './pipeline.ts'
import type { PreparedRun } from './prepare.ts'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import { alreadyNoticed, catchStreamErrors, NOTICES, RunSession, TaskTracker, withNotices } from './pipeline.ts'
import { createRunRegistry } from './runs.ts'

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

function session(previous?: MessageMetadata, clock = { now: 1000 }): RunSession {
  const registry = createRunRegistry()
  const run = registry.acquire('chat', 'prov:model')
  const resolved = { modelRef: 'prov:model', providerId: 'prov', modelId: 'model', entry: { cost: { input: 1, output: 2 } } } as unknown as ResolvedModel
  const continued: HarnessUIMessage | null = previous === undefined ? null : { id: 'msg_a000000000000001', role: 'assistant', metadata: previous, parts: [{ type: 'step-start' }] }
  const prepared = { resolved, continued, assistantId: continued?.id ?? 'msg_a000000000000009', history: continued === null ? [] : [continued] } as unknown as PreparedRun
  const deps = { redactor: createRedactor(), providers: { mapError: (_id: string, error: unknown) => HarnessError.from(error) } } as unknown as AppDeps
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
