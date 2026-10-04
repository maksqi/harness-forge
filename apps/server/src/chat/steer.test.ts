// Steering (Phase 9, C26-T5 / W9.2-T3): `stepInjector` is complete (chunks injected at a step boundary land right before
// that step's `start-step`, in order, also when the consumer falls whole steps behind, and the rest is flushed when the
// stream ends); `createSteerStep` takes the steerable queued items synchronously, injects their `data-steer` chunks for
// the step and appends them as user model messages (files loaded for the model like the saved history's). The run-level
// round trips (placement in the stored reply, the model history after a reload) are in `index.test.ts`.
import type { QueueItem, TaskResultData } from '@harness-forge/shared'
import type { ResolvedModel } from '../providers/types.ts'
import type { BackgroundTasks } from './background/types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { HarnessDataChunk, RunSession } from './pipeline.ts'
import type { ChatQueue } from './queue.ts'
import type { StepInjectionSource } from './steer.ts'
import { Buffer } from 'node:buffer'
import { taskResultText } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../logger.ts'
import { UNREADABLE_ATTACHMENTS_TEXT } from './files.ts'
import { createSteerStep, steerChunk as itemSteerChunk, steerUIMessage, stepInjector, taskResultChunk, taskResultModelMessage } from './steer.ts'

/** The injection queue of `RunSession`, standing alone. */
function injections(): StepInjectionSource & { inject: (chunk: HarnessUIMessageChunk, step: number) => void } {
  let pending: { chunk: HarnessUIMessageChunk, step: number }[] = []
  return {
    inject: (chunk, step) => {
      pending.push({ chunk, step })
    },
    takeInjections: (finishedSteps) => {
      const ready = pending.filter(entry => entry.step <= finishedSteps).map(entry => entry.chunk)
      pending = pending.filter(entry => entry.step > finishedSteps)
      return ready
    },
  }
}

function steerChunk(n: number): HarnessUIMessageChunk {
  return { type: 'data-steer', data: { id: `msg_s00000000000000${n}`, parts: [{ type: 'text', text: `steer ${n}` }], queuedAt: 1, deliveredAt: 2 } }
}

function label(chunk: HarnessUIMessageChunk): string {
  return chunk.type === 'data-steer' ? `steer:${chunk.data.parts[0]?.type === 'text' ? chunk.data.parts[0].text : ''}` : chunk.type
}

async function readAll(stream: ReadableStream<HarnessUIMessageChunk>): Promise<string[]> {
  const labels: string[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      return labels
    labels.push(label(value))
  }
}

/** A source stream the test writes to; nothing reads it until the test does (a slow consumer). */
function controlledSource(): { stream: ReadableStream<HarnessUIMessageChunk>, write: (...chunks: HarnessUIMessageChunk[]) => void, close: () => void } {
  let controller!: ReadableStreamDefaultController<HarnessUIMessageChunk>
  const stream = new ReadableStream<HarnessUIMessageChunk>({
    start(c) {
      controller = c
    },
  })
  return { stream, write: (...chunks) => chunks.forEach(chunk => controller.enqueue(chunk)), close: () => controller.close() }
}

describe('stepInjector', () => {
  it('places the chunks of step N right before the start-step of step N, in order, while the consumer lags whole steps', async () => {
    const queue = injections()
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    // The SDK side runs ahead: step 0, the boundary of step 1, step 1, the boundary of step 2, step 2.
    source.write({ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't0' }, { type: 'text-end', id: 't0' }, { type: 'finish-step' })
    queue.inject(steerChunk(1), 1)
    source.write({ type: 'start-step' }, { type: 'tool-input-available', toolCallId: 'c1', toolName: 'noop', input: {} }, { type: 'finish-step' })
    queue.inject(steerChunk(2), 2)
    queue.inject(steerChunk(3), 2)
    source.write({ type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-end',
      'finish-step',
      'steer:steer 1',
      'start-step',
      'tool-input-available',
      'finish-step',
      'steer:steer 2',
      'steer:steer 3',
      'start-step',
      'finish-step',
      'finish',
    ])
  })

  it('places step 0 chunks before the first start-step (after the tools an approval continuation runs first)', async () => {
    const queue = injections()
    queue.inject(steerChunk(1), 0)
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    source.write({ type: 'start' }, { type: 'tool-output-available', toolCallId: 'c0', output: 'ok' }, { type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual(['start', 'tool-output-available', 'steer:steer 1', 'start-step', 'finish-step', 'finish'])
  })

  it('emits what is left before the finish chunk, or when the stream closes without one', async () => {
    const queue = injections()
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    source.write({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' })
    // Step 1 failed before its start-step.
    queue.inject(steerChunk(1), 1)
    source.write({ type: 'error', errorText: 'boom' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual(['start', 'start-step', 'finish-step', 'error', 'steer:steer 1', 'finish'])

    const aborted = injections()
    const cut = controlledSource()
    const rest = cut.stream.pipeThrough(stepInjector(aborted))
    cut.write({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' })
    aborted.inject(steerChunk(2), 1)
    aborted.inject(steerChunk(3), 5)
    cut.close()
    expect(await readAll(rest)).toEqual(['start', 'start-step', 'finish-step', 'steer:steer 2', 'steer:steer 3'])
    expect(aborted.takeInjections(Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('passes a stream without injections through unchanged', async () => {
    const queue = injections()
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    source.write({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' }, { type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual(['start', 'start-step', 'finish-step', 'start-step', 'finish-step', 'finish'])
  })
})

// ---------- createSteerStep ----------

const CHAT = '0199a8f0-0000-7000-8000-000000000001'
const TEXT_FILE = 'file_TTTTTTTTTTTTTTTT'
const IMAGE_FILE = 'file_IIIIIIIIIIIIIIII'
const STEER_SECRET = 'steer-sentinel-91c2'

function item(n: number, parts: QueueItem['message']['parts'], turnOnly = false): QueueItem {
  const id = `msg_s${n.toString().padStart(15, '0')}`
  return { id, message: { id, role: 'user', parts }, modelRef: 'mock:steer', reasoningEffort: 'auto', toolMode: 'ask', createdAt: 100 + n, turnOnly }
}

/** A queue that only knows the takes the steer step uses. */
function fakeQueue(items: QueueItem[]): ChatQueue & { items: QueueItem[], takes: number } {
  const state = {
    items: [...items],
    takes: 0,
    takeSteerable: (chatId: string) => {
      expect(chatId).toBe(CHAT)
      state.takes += 1
      const taken = state.items.filter(entry => !entry.turnOnly)
      state.items = state.items.filter(entry => entry.turnOnly)
      return taken
    },
  }
  return state as unknown as ChatQueue & { items: QueueItem[], takes: number }
}

const REPLY = 'msg_rrrrrrrrrrrrrrrr'
const REPORT_SECRET = 'task-report-sentinel-4b1d'

/** The background inbox of the steer step (Phase 10): `takeResults` empties it once and records the calls. */
function fakeBackground(results: TaskResultData[] = []): Pick<BackgroundTasks, 'takeResults'> & { inbox: TaskResultData[], takes: Array<[string, string]>, order: string[] } {
  const state = {
    inbox: [...results],
    takes: [] as Array<[string, string]>,
    order: [] as string[],
    takeResults: (chatId: string, messageId: string) => {
      state.takes.push([chatId, messageId])
      state.order.push('results')
      const taken = state.inbox
      state.inbox = []
      return taken
    },
  }
  return state
}

interface SteerHarness {
  session: RunSession
  queue: ReturnType<typeof fakeQueue>
  background: ReturnType<typeof fakeBackground>
  injected: Array<{ chunk: HarnessDataChunk, step: number }>
  controller: AbortController
  logs: ReturnType<typeof createMemoryLogger>
  model: ResolvedModel
}

function steerHarness(items: QueueItem[], capabilities: { vision: boolean, pdf: boolean } = { vision: false, pdf: false }, results: TaskResultData[] = []): SteerHarness {
  const queue = fakeQueue(items)
  const background = fakeBackground(results)
  const injected: SteerHarness['injected'] = []
  const controller = new AbortController()
  const logs = createMemoryLogger()
  const files = {
    idFromUrl: (url: string) => (url.startsWith('/api/files/') ? url.slice('/api/files/'.length) : null),
    read: async (id: string) => {
      if (id === TEXT_FILE)
        return { file: { id, mime: 'text/plain', name: 'notes.txt' }, data: new Uint8Array(Buffer.from('file body')) }
      if (id === IMAGE_FILE)
        return { file: { id, mime: 'image/png', name: 'shot.png' }, data: new Uint8Array([1, 2, 3]) }
      throw new Error('missing')
    },
  }
  const session = {
    chatId: CHAT,
    assistantId: REPLY,
    ctx: { run: { signal: controller.signal }, queue, background, now: () => 5000, deps: { files }, logger: logs.logger },
    inject: (chunk: HarnessDataChunk, step: number) => injected.push({ chunk, step }),
  } as unknown as RunSession
  const model = { entry: { capabilities: { tools: true, ...capabilities } } } as unknown as ResolvedModel
  return { session, queue, background, injected, controller, logs, model }
}

function taskResult(n: number, report: string = `report ${n}`): TaskResultData {
  return {
    taskId: `bgt_${n.toString().padStart(16, '0')}`,
    toolCallId: `call_${n}`,
    messageId: 'msg_llllllllllllllll',
    output: { status: 'completed', type: 'explore', description: `Task ${n}`, modelRef: 'mock:background', steps: [], stepsOmitted: 0, report, startedAt: 1, finishedAt: 2 },
    deliveredAt: 5000,
  }
}

const BEFORE = [{ role: 'user' as const, content: 'steps 3' }]

describe('createSteerStep', () => {
  it('takes the steerable items synchronously, injects one data-steer per item for the step and appends user messages', async () => {
    const first = item(1, [{ type: 'text', text: 'also check the tests' }])
    const compact = item(2, [{ type: 'text', text: '/compact' }], true)
    const second = item(3, [{ type: 'text', text: 'and the docs' }])
    const h = steerHarness([first, compact, second])
    const piece = createSteerStep({ session: h.session, model: h.model, tools: {} })
    const pending = piece({ stepNumber: 2, messages: BEFORE, instructions: undefined, steps: [] })
    // Before any await: the take and the injection happened (a DELETE now loses).
    expect(h.queue.takes).toBe(1)
    expect(h.queue.items).toEqual([compact])
    expect(h.injected).toEqual([
      { chunk: itemSteerChunk(first, 5000), step: 2 },
      { chunk: itemSteerChunk(second, 5000), step: 2 },
    ])
    expect(h.injected[0]?.chunk).toEqual({ type: 'data-steer', data: { id: first.id, parts: first.message.parts, queuedAt: 101, deliveredAt: 5000 } })
    const result = await pending
    expect(result?.messages).toEqual([
      ...BEFORE,
      { role: 'user', content: [{ type: 'text', text: 'also check the tests' }] },
      { role: 'user', content: [{ type: 'text', text: 'and the docs' }] },
    ])
  })

  it('step 0 counts (the first call of a turn or a continuation)', async () => {
    const h = steerHarness([item(1, [{ type: 'text', text: 'waited' }])])
    const result = await createSteerStep({ session: h.session, model: h.model, tools: {} })({ stepNumber: 0, messages: [], instructions: undefined, steps: [] })
    expect(h.injected.map(entry => entry.step)).toEqual([0])
    expect(result?.messages).toHaveLength(1)
  })

  it('changes nothing without steerable items, and takes nothing once the run is aborted', async () => {
    const h = steerHarness([item(1, [{ type: 'text', text: '/compact' }], true)])
    const piece = createSteerStep({ session: h.session, model: h.model, tools: {} })
    expect(await piece({ stepNumber: 1, messages: BEFORE, instructions: undefined, steps: [] })).toBeUndefined()
    const aborted = steerHarness([item(1, [{ type: 'text', text: 'late' }])])
    aborted.controller.abort()
    expect(await createSteerStep({ session: aborted.session, model: aborted.model, tools: {} })({ stepNumber: 1, messages: BEFORE, instructions: undefined, steps: [] })).toBeUndefined()
    expect(aborted.queue.takes).toBe(0)
    expect(aborted.injected).toEqual([])
  })

  it('loads files for the run model like the saved history (text inlined; images only for vision models)', async () => {
    const parts: QueueItem['message']['parts'] = [
      { type: 'text', text: 'see these' },
      { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: `/api/files/${TEXT_FILE}` },
      { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: `/api/files/${IMAGE_FILE}` },
    ]
    const plain = steerHarness([item(1, parts)])
    const result = await createSteerStep({ session: plain.session, model: plain.model, tools: {} })({ stepNumber: 1, messages: [], instructions: undefined, steps: [] })
    expect(result?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'see these' }, { type: 'text', text: 'Attached file "notes.txt":\n\nfile body' }] }])
    // The injected part keeps the stored file references (never data URLs).
    expect(plain.injected[0]?.chunk.data).toMatchObject({ parts })

    const vision = steerHarness([item(1, parts)], { vision: true, pdf: false })
    const seen = await createSteerStep({ session: vision.session, model: vision.model, tools: {} })({ stepNumber: 1, messages: [], instructions: undefined, steps: [] })
    const content = (seen?.messages?.[0] as { content: Array<{ type: string, mediaType?: string }> }).content
    expect(content.map(part => part.type)).toEqual(['text', 'text', 'file'])
    expect(content[2]).toMatchObject({ type: 'file', mediaType: 'image/png' })

    const unreadable = steerHarness([item(1, [{ type: 'file', mediaType: 'image/png', url: `/api/files/${IMAGE_FILE}` }])])
    const only = await createSteerStep({ session: unreadable.session, model: unreadable.model, tools: {} })({ stepNumber: 1, messages: [], instructions: undefined, steps: [] })
    expect(only?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: UNREADABLE_ATTACHMENTS_TEXT }] }])
  })

  it('steerUIMessage is the user message splitSteers rebuilds; texts are never logged', async () => {
    const steer = item(1, [{ type: 'text', text: STEER_SECRET }])
    expect(steerUIMessage(steer)).toEqual({ id: steer.id, role: 'user', parts: steer.message.parts })
    const h = steerHarness([steer])
    await createSteerStep({ session: h.session, model: h.model, tools: {} })({ stepNumber: 1, messages: [], instructions: undefined, steps: [] })
    expect(h.logs.records.length).toBeGreaterThan(0)
    expect(h.logs.text()).not.toContain(STEER_SECRET)
  })

  it('takes the finished background results synchronously after the queue, into this reply, and appends them as user messages', async () => {
    const steer = item(1, [{ type: 'text', text: 'and the docs' }])
    const first = taskResult(1)
    const second = taskResult(2, '')
    const h = steerHarness([steer], undefined, [first, { ...second, output: { ...second.output, status: 'failed', error: 'boom' } }])
    const pending = createSteerStep({ session: h.session, model: h.model, tools: {} })({ stepNumber: 3, messages: BEFORE, instructions: undefined, steps: [] })
    // Before any await: both takes happened (the inbox is empty now) and every chunk is injected for the step, steers first.
    expect(h.background.takes).toEqual([[CHAT, REPLY]])
    expect(h.background.inbox).toEqual([])
    expect(h.injected.map(entry => [entry.chunk.type, entry.step])).toEqual([['data-steer', 3], ['data-task-result', 3], ['data-task-result', 3]])
    expect(h.injected[1]?.chunk).toEqual({ type: 'data-task-result', data: first })
    const result = await pending
    expect(result?.messages).toEqual([
      ...BEFORE,
      { role: 'user', content: [{ type: 'text', text: 'and the docs' }] },
      { role: 'user', content: [{ type: 'text', text: taskResultText(first) }] },
      { role: 'user', content: [{ type: 'text', text: expect.stringContaining('Error: boom') }] },
    ])
    expect(taskResultChunk(first)).toEqual({ type: 'data-task-result', data: first })
    expect(taskResultModelMessage(first)).toEqual({ role: 'user', content: [{ type: 'text', text: taskResultText(first) }] })
  })

  it('results alone count; step 0 takes them; an aborted run takes nothing; a failing manager is logged', async () => {
    const h = steerHarness([], undefined, [taskResult(1, REPORT_SECRET)])
    const result = await createSteerStep({ session: h.session, model: h.model, tools: {} })({ stepNumber: 0, messages: [], instructions: undefined, steps: [] })
    expect(h.injected.map(entry => [entry.chunk.type, entry.step])).toEqual([['data-task-result', 0]])
    expect(result?.messages).toHaveLength(1)
    expect(h.logs.text()).not.toContain(REPORT_SECRET)

    const empty = steerHarness([])
    expect(await createSteerStep({ session: empty.session, model: empty.model, tools: {} })({ stepNumber: 1, messages: BEFORE, instructions: undefined, steps: [] })).toBeUndefined()
    expect(empty.background.takes).toEqual([[CHAT, REPLY]])

    const aborted = steerHarness([], undefined, [taskResult(1)])
    aborted.controller.abort()
    expect(await createSteerStep({ session: aborted.session, model: aborted.model, tools: {} })({ stepNumber: 1, messages: BEFORE, instructions: undefined, steps: [] })).toBeUndefined()
    expect(aborted.background.takes).toEqual([])
    expect(aborted.background.inbox).toHaveLength(1)

    const broken = steerHarness([item(1, [{ type: 'text', text: 'still steered' }])])
    ;(broken.session.ctx as unknown as { background: Pick<BackgroundTasks, 'takeResults'> }).background = {
      takeResults: () => {
        throw new Error('manager broke')
      },
    }
    const steered = await createSteerStep({ session: broken.session, model: broken.model, tools: {} })({ stepNumber: 1, messages: [], instructions: undefined, steps: [] })
    expect(steered?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'still steered' }] }])
    expect(broken.logs.records.some(record => record.level === 'warn' && record.msg.includes('background'))).toBe(true)
  })
})
