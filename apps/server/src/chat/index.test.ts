// Chat runner (C16-T1, W9.2): `POST /chat` and the maintenance lock (409 busy while a key rotation blocks runs; a file
// cleanup never blocks runs), and the steer queue end to end through `createTestApp()` + `app.request()` (ADR-042,
// ARCHITECTURE.md 6.20): a message queued during a step is steered at the next boundary (stored as `data-steer` between
// the steps; the model history rebuilt from the saved reply equals the in-run prompt); one queued during the last step
// becomes the next turn started by the server (`run.started` origin `queue`, the path reads U/A/U/A, its files kept);
// the 409 race with a user's `POST /chat`; items wait while an approval is pending; an abort, a failure, shutdown, chat
// delete and key rotation clear the queue with their reasons; `mock:steer` end to end.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessErrorInit, HarnessUIMessage, QueueChangedData, QueueItem, ServerEvent } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeBackgroundTasks } from '../testing/fake-background-tasks.ts'
import type { BackgroundTasksHost } from './background/types.ts'
import { chatDetailSchema, createMessageId, harnessErrorEnvelopeSchema, queueItemSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEY_ROTATION_RUNS_MESSAGE } from '../services/maintenance/index.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeBackgroundTasks } from '../testing/fake-background-tasks.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { createChatRunnerWith, queueRequestId, startQueuedTurn } from './index.ts'
import { createChatQueue } from './queue.ts'
import { runConflict } from './runs.ts'
import { answerApprovals, chatBody, messageText, nextEvent, postChat, readSse, readUntil, runnerOf, streamedText, testChatId } from './testing.ts'

let t: TestApp
let events: ServerEvent[]
let nextChat = 0x9000
const scripted = new Map<string, LanguageModelV4>()
const disposables: Disposable[] = []
const STEER_SECRET = 'steer-sentinel-c0ffee'

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

/** Registers the `testkit` provider (models from `scripted`) on an app. */
function registerTestkit(app: TestApp): Disposable {
  return app.deps.registry.providers.register('mock', {
    id: 'testkit',
    name: 'Test kit',
    credentials: [],
    seedModels: [{ id: 'tools', name: 'Tools', contextWindow: 32_000, capabilities: { tools: true }, cost: { input: 1, output: 2 } }],
    createLanguageModel: (modelId) => {
      const model = scripted.get(modelId)
      if (model === undefined)
        throw new Error(`No scripted model "${modelId}".`)
      return model
    },
  })
}

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  t.deps.events.subscribe(event => events.push(event))
  disposables.push(registerTestkit(t))
})

beforeEach(() => {
  events = []
  scripted.clear()
})

afterAll(async () => {
  for (const disposable of disposables)
    disposable.dispose()
  await t.close()
})

// ---------- helpers ----------

interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function timeCall(id: string): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId: id, toolName: 'current_time', input: '{}' }, finishPart('tool-calls')]
}

interface ControlledModel {
  calls: LanguageModelV4CallOptions[]
  /** Resolves once call `n` (1-based) started. */
  entered: (n: number) => Promise<void>
  /** Makes call `n` wait until the returned function runs. */
  hold: (n: number) => () => void
}

/** `testkit:tools`: answers from `script` (calls recorded); a held call waits before it streams anything. */
function controlledModel(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[] | ReadableStream<LanguageModelV4StreamPart>): ControlledModel {
  const calls: LanguageModelV4CallOptions[] = []
  const entries = new Map<number, Deferred>()
  const holds = new Map<number, Deferred>()
  const entry = (n: number): Deferred => {
    let value = entries.get(n)
    if (value === undefined) {
      value = deferred()
      entries.set(n, value)
    }
    return value
  }
  scripted.set('tools', new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'tools',
    doStream: async (options) => {
      calls.push(options)
      const n = calls.length
      entry(n).resolve()
      const held = holds.get(n)
      if (held !== undefined) {
        // A held call ends like a provider call when the run is aborted meanwhile.
        const signal = options.abortSignal
        await Promise.race([held.promise, new Promise<never>((_resolve, reject) => {
          if (signal?.aborted)
            reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })])
      }
      const answer = script(options, n)
      return { stream: Array.isArray(answer) ? convertArrayToReadableStream(answer) : answer }
    },
  }))
  return {
    calls,
    entered: n => entry(n).promise,
    hold: (n) => {
      const gate = deferred()
      holds.set(n, gate)
      return () => gate.resolve()
    },
  }
}

function queueBody(text: string, extra: { id?: string, modelRef?: string, parts?: QueueItem['message']['parts'] } = {}): Record<string, unknown> {
  const id = extra.id ?? createMessageId()
  return { message: { id, role: 'user', parts: extra.parts ?? [{ type: 'text', text }] }, modelRef: extra.modelRef ?? 'testkit:tools', reasoningEffort: 'auto', toolMode: 'ask' }
}

async function enqueue(app: TestApp, chatId: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`/api/chat/${chatId}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function enqueued(app: TestApp, chatId: string, text: string, extra: Parameters<typeof queueBody>[1] = {}): Promise<QueueItem> {
  const response = await enqueue(app, chatId, queueBody(text, extra))
  expect(response.status).toBe(201)
  return queueItemSchema.parse(await response.json())
}

async function detailOf(app: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await app.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

function queueChanges(chatId: string, list: readonly ServerEvent[] = events): QueueChangedData[] {
  return list.flatMap(event => (event.type === 'queue.changed' && event.data.chatId === chatId ? [event.data] : []))
}

function removals(chatId: string, list: readonly ServerEvent[] = events): string[] {
  return queueChanges(chatId, list).flatMap(change => (change.removed ?? []).map(removal => `${removal.reason}:${removal.id}`))
}

function runStarts(chatId: string): Extract<ServerEvent, { type: 'run.started' }>['data'][] {
  return events.flatMap(event => (event.type === 'run.started' && event.data.chatId === chatId ? [event.data] : []))
}

function waitFinished(app: TestApp, chatId: string, messageId?: string): Promise<Extract<ServerEvent, { type: 'run.finished' }>> {
  return nextEvent(app, 'run.finished', event => event.data.chatId === chatId && (messageId === undefined || event.data.messageId === messageId), 15_000)
}

/** Waits until `count` `run.finished` events of the chat were seen (they may come before a subscription could). */
async function finishedRuns(chatId: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(events.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(count)
  }, { timeout: 10_000, interval: 10 })
}

function partTypes(message: HarnessUIMessage | undefined): string[] {
  return message?.parts.map(part => part.type) ?? []
}

/** The prompt without the system message (the instructions), for comparisons across runs. */
function conversation(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  return prompt.filter(message => message.role !== 'system')
}

async function errorOf(response: Response): Promise<HarnessErrorInit> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

// ---------- maintenance (C16-T1) ----------

/** Holds the maintenance lock until the returned `finish()` runs. */
function hold(kind: 'key-rotation' | 'file-cleanup', blockRuns: boolean): { finish: () => void, done: Promise<void> } {
  let finish!: () => void
  const done = t.deps.maintenance.exclusive(kind, () => new Promise<void>((resolve) => {
    finish = resolve
  }), { blockRuns })
  return { finish, done }
}

describe('pOST /api/chat during maintenance', () => {
  it('answers 409 busy while a key rotation blocks runs, stores nothing, and runs again afterwards', async () => {
    const chatId = testChatId(901)
    const rotation = hold('key-rotation', true)
    const refused = await postChat(t, chatBody(chatId, 'hello during rotation'))
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toEqual({ code: 'conflict', message: KEY_ROTATION_RUNS_MESSAGE, details: { reason: 'busy' } })
    expect(await t.deps.chats.find(chatId)).toBeNull()
    expect(t.deps.runs.hasRun(chatId)).toBe(false)
    rotation.finish()
    await rotation.done

    const response = await postChat(t, chatBody(chatId, 'hello after rotation'))
    expect(response.status).toBe(200)
    const { chunks, done } = await readSse(response)
    expect(done).toBe(true)
    expect(streamedText(chunks)).toContain('hello after rotation')
  })

  it('keeps running chats while an operation without blockRuns holds the lock', async () => {
    const cleanup = hold('file-cleanup', false)
    try {
      const response = await postChat(t, chatBody(testChatId(902), 'hello during cleanup'))
      expect(response.status).toBe(200)
      expect((await readSse(response)).done).toBe(true)
    }
    finally {
      cleanup.finish()
      await cleanup.done
    }
  })
})

// ---------- steering ----------

describe('steering at step boundaries', () => {
  it('a message queued during a step reaches the next calls as a user message; the stored reply holds data-steer between the steps', async () => {
    const answers: Record<number, LanguageModelV4StreamPart[]> = { 1: timeCall('call_1'), 2: timeCall('call_2'), 3: textParts('done'), 4: textParts('next') }
    const model = controlledModel((_options, call) => answers[call] ?? textParts('extra'))
    const release = model.hold(1)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'start', { modelRef: 'testkit:tools' }))
    expect(response.status).toBe(200)
    const reading = readSse(response)
    await model.entered(1)
    const item = await enqueued(t, chatId, STEER_SECRET)
    expect(item).toMatchObject({ turnOnly: false, modelRef: 'testkit:tools' })
    const finished = waitFinished(t, chatId)
    release()
    const { chunks } = await reading
    await finished

    // The model saw the steer after the tool result of step 0, in that call and in every later one.
    expect(model.calls).toHaveLength(3)
    const steerMessage = { role: 'user', content: [{ type: 'text', text: STEER_SECRET }], providerOptions: undefined }
    expect(conversation(model.calls[1]!.prompt).map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(model.calls[1]!.prompt.at(-1)).toEqual(steerMessage)
    expect(conversation(model.calls[2]!.prompt).map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool'])
    expect(conversation(model.calls[2]!.prompt)[3]).toEqual(steerMessage)
    // Streamed between the steps: right before the second start-step, once.
    const types = chunks.map(chunk => chunk.type)
    const steerAt = types.indexOf('data-steer')
    expect(types.filter(type => type === 'data-steer')).toHaveLength(1)
    expect(steerAt).toBeGreaterThan(types.indexOf('tool-output-available'))
    expect(types.slice(steerAt - 1, steerAt + 2)).toEqual(['finish-step', 'data-steer', 'start-step'])
    expect(chunks[steerAt]).toMatchObject({ data: { id: item.id, parts: [{ type: 'text', text: STEER_SECRET }], queuedAt: item.createdAt } })

    const detail = await detailOf(t, chatId)
    expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    const reply = detail.messages[1]
    expect(partTypes(reply)).toEqual(['step-start', 'tool-current_time', 'data-steer', 'step-start', 'tool-current_time', 'step-start', 'text'])
    expect(messageText(reply)).toBe('done')
    expect(queueChanges(chatId)).toEqual([
      { chatId, items: [item] },
      { chatId, items: [], removed: [{ id: item.id, reason: 'delivered' }] },
    ])
    expect(t.deps.runs.queueList(chatId)).toEqual([])

    // The model history rebuilt from the saved reply (splitSteers) equals what the model saw in the run.
    const next = await readSse(await postChat(t, chatBody(chatId, 'after', { modelRef: 'testkit:tools' })))
    expect(streamedText(next.chunks)).toBe('next')
    const inRun = conversation(model.calls[2]!.prompt)
    const rebuilt = conversation(model.calls[3]!.prompt)
    expect(rebuilt.slice(0, inRun.length)).toEqual(inRun)
    expect(rebuilt.slice(inRun.length).map(message => message.role)).toEqual(['assistant', 'user'])
    expect(t.logs.text()).not.toContain(STEER_SECRET)
    await runnerOf(t).idle()
  })

  it('a cancel before the boundary wins: nothing is steered and no turn starts; after the boundary it answers 404', async () => {
    const model = controlledModel((_options, call) => (call === 1 ? timeCall('call_1') : textParts('done')))
    const release = model.hold(1)
    const chatId = newChatId()
    const finished = waitFinished(t, chatId)
    const reading = postChat(t, chatBody(chatId, 'start', { modelRef: 'testkit:tools' })).then(readSse)
    await model.entered(1)
    const cancelled = await enqueued(t, chatId, 'never mind')
    expect((await t.request(`/api/chat/${chatId}/queue/${cancelled.id}`, { method: 'DELETE' })).status).toBe(204)
    release()
    const { chunks } = await reading
    await finished
    expect(chunks.some(chunk => chunk.type === 'data-steer')).toBe(false)
    expect(conversation(model.calls[1]!.prompt).map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(removals(chatId)).toEqual([`cancelled:${cancelled.id}`])
    expect((await t.request(`/api/chat/${chatId}/queue/${cancelled.id}`, { method: 'DELETE' })).status).toBe(404)
    expect(runStarts(chatId)).toHaveLength(1)
    await runnerOf(t).idle()
  })

  it('a turnOnly item (/compact) is never steered: it waits for the next turn', async () => {
    const model = controlledModel((_options, call) => (call === 1 ? timeCall('call_1') : textParts(`answer ${call}`)))
    const release = model.hold(1)
    const chatId = newChatId()
    const reading = postChat(t, chatBody(chatId, 'start', { modelRef: 'testkit:tools' })).then(readSse)
    await model.entered(1)
    const compact = await enqueued(t, chatId, '/compact')
    expect(compact.turnOnly).toBe(true)
    const second = nextEvent(t, 'run.started', event => event.data.chatId === chatId && event.data.origin === 'queue', 15_000)
    release()
    const { chunks } = await reading
    expect(chunks.some(chunk => chunk.type === 'data-steer')).toBe(false)
    expect((await second).data.userMessageId).toBe(compact.id)
    await finishedRuns(chatId, 2)
    const detail = await detailOf(t, chatId)
    expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(detail.messages[2]?.metadata?.command).toMatchObject({ name: 'compact', type: 'compact' })
    await runnerOf(t).idle()
  })

  it('mock:steer end to end: a message queued during step 1 is steered and listed in the final text', async () => {
    const chatId = newChatId()
    const finished = waitFinished(t, chatId)
    const response = await postChat(t, chatBody(chatId, 'steps 2', { modelRef: 'mock:steer' }))
    await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'tool-output-available'))
    const item = await enqueued(t, chatId, 'mid run note', { modelRef: 'mock:steer' })
    expect((await finished).data.outcome).toBe('completed')
    const reply = (await detailOf(t, chatId)).messages[1]
    expect(messageText(reply)).toContain('Steered: mid run note.')
    expect(messageText(reply)).toContain('Finished 2 steps. Steers: mid run note')
    const types = partTypes(reply)
    const steerAt = types.indexOf('data-steer')
    expect(types[steerAt - 1]).toBe('tool-current_time')
    expect(types[steerAt + 1]).toBe('step-start')
    expect(removals(chatId)).toEqual([`delivered:${item.id}`])
    expect(runStarts(chatId).filter(start => start.origin === 'queue')).toEqual([])
    await runnerOf(t).idle()
  })
})

// ---------- the run end ----------

describe('the run end', () => {
  it('a message queued during the last step becomes the next turn started by the server (U/A/U/A, files kept)', async () => {
    const model = controlledModel((options, call) => {
      if (call === 1)
        return textParts('first answer')
      const last = options.prompt.at(-1)
      const text = last?.role === 'user' ? last.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join(' | ') : ''
      return textParts(`second answer: ${text}`)
    })
    const release = model.hold(1)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'question', { modelRef: 'testkit:tools' }))
    await model.entered(1)
    const file = await t.deps.files.upload(new File(['queued file body'], 'later.txt', { type: 'text/plain' }))
    const item = await enqueued(t, chatId, 'follow up', { parts: [{ type: 'text', text: 'follow up' }, { type: 'file', mediaType: 'text/plain', filename: 'x.txt', url: file.url }] })
    const queued = nextEvent(t, 'run.started', event => event.data.chatId === chatId && event.data.origin === 'queue', 15_000)
    release()
    await readSse(response)
    const started = (await queued).data
    expect(started).toMatchObject({ origin: 'queue', userMessageId: item.id, modelRef: 'testkit:tools' })
    await waitFinished(t, chatId, started.messageId)

    const [first, second] = runStarts(chatId)
    expect(first).toMatchObject({ origin: 'request' })
    expect(first?.userMessageId).toBeUndefined()
    expect(second).toEqual(started)
    const detail = await detailOf(t, chatId)
    expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(detail.messages[2]?.id).toBe(item.id)
    expect(detail.messages[2]?.parts).toEqual([{ type: 'text', text: 'follow up' }, { type: 'file', mediaType: 'text/plain', filename: 'later.txt', url: file.url }])
    expect(detail.messages[3]?.id).toBe(started.messageId)
    expect(messageText(detail.messages[3])).toBe('second answer: follow up | Attached file "later.txt":\n\nqueued file body')
    expect((await t.deps.chats.find(chatId))?.activeLeafId).toBe(started.messageId)
    expect(removals(chatId)).toEqual([`started:${item.id}`])
    expect(t.logs.records.some(record => record.msg === 'next turn started from the queue' && String(record.reqId).startsWith('queue_'))).toBe(true)
    // Nothing is left to resume once it finished.
    expect((await t.request(`/api/chat/${chatId}/stream`)).status).toBe(204)
    await runnerOf(t).idle()
  })

  it('the next turn loses the race to a user POST /chat (409): the item goes back to the head and is steered into that run', async () => {
    const model = controlledModel(() => textParts('first answer'))
    const release = model.hold(1)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'question', { modelRef: 'testkit:tools' }))
    await model.entered(1)
    const item = await enqueued(t, chatId, 'queued text')
    // The user's request takes the chat the moment the first run is released, before the queue can start its turn.
    let userRun: Promise<Response> | null = null
    const subscription = t.deps.events.subscribe((event) => {
      if (event.type === 'run.finished' && event.data.chatId === chatId && userRun === null) {
        subscription.dispose()
        userRun = t.deps.runs.start(chatBody(chatId, 'user wins'), { logger: t.deps.logger, requestId: 'req_race' })
      }
    })
    release()
    await readSse(response)
    expect(userRun).not.toBeNull()
    const { chunks } = await readSse(await userRun!)
    expect(chunks.find(chunk => chunk.type === 'data-steer')).toMatchObject({ data: { id: item.id } })
    expect(streamedText(chunks)).toBe('queued text')
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'request'])
    expect(removals(chatId)).toEqual([`started:${item.id}`, `delivered:${item.id}`])
    const detail = await detailOf(t, chatId)
    expect(detail.messages.map(message => messageText(message))).toEqual(['question', 'first answer', 'user wins', 'queued text'])
    // Delivered at step 0: before the first step (after the tools-unsupported notice of mock:echo).
    const userReply = partTypes(detail.messages[3])
    expect(userReply.indexOf('data-steer')).toBeLessThan(userReply.indexOf('step-start'))
    await runnerOf(t).idle()
  })

  it('while an approval is pending the items wait; the continuation delivers them at its step 0', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
    const pending = await detailOf(t, chatId)
    expect(pending.pendingApproval).toBe(true)
    expect(t.deps.runs.hasRun(chatId)).toBe(false)
    const item = await enqueued(t, chatId, 'while waiting', { modelRef: 'mock:tool-approval' })
    expect(t.deps.runs.queueList(chatId)).toEqual([item])
    expect(runStarts(chatId)).toHaveLength(1)

    const assistant = pending.messages[1]!
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: answerApprovals(assistant, true) }))
    const types = chunks.map(chunk => chunk.type)
    expect(types.indexOf('data-steer')).toBeGreaterThan(types.indexOf('tool-output-available'))
    expect(types[types.indexOf('data-steer') + 1]).toBe('start-step')
    expect(removals(chatId)).toEqual([`delivered:${item.id}`])
    const reply = (await detailOf(t, chatId)).messages[1]
    expect(reply?.parts.find(part => part.type === 'data-steer')).toMatchObject({ data: { id: item.id } })
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'request'])
    await runnerOf(t).idle()
  })

  it('a failed run removes every queued item (failed) and starts nothing', async () => {
    const model = controlledModel(() => [{ type: 'error', error: new Error('upstream broke') }])
    const release = model.hold(1)
    const chatId = newChatId()
    const finished = waitFinished(t, chatId)
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'testkit:tools' }))
    await model.entered(1)
    const a = await enqueued(t, chatId, 'a')
    const b = await enqueued(t, chatId, '/compact')
    release()
    await response.text()
    expect((await finished).data.outcome).toBe('failed')
    expect(removals(chatId)).toEqual([`failed:${a.id}`, `failed:${b.id}`])
    expect(t.deps.runs.queueList(chatId)).toEqual([])
    expect(runStarts(chatId)).toHaveLength(1)
  })

  it('an aborted run removes what was queued after the stop emptied the queue (stopped)', async () => {
    // A stream that ignores the abort until the test ends it, so the run stays registered after the stop.
    let streamController!: ReadableStreamDefaultController<LanguageModelV4StreamPart>
    const model = controlledModel(() => new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        streamController = controller
      },
    }))
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'testkit:tools' }))
    await model.entered(1)
    const before = await enqueued(t, chatId, 'before the stop')
    const stopping = t.deps.runs.stop(chatId)
    expect(t.deps.runs.queueList(chatId)).toEqual([])
    expect(t.deps.runs.hasRun(chatId)).toBe(true)
    const late = await enqueued(t, chatId, 'after the stop')
    streamController.close()
    expect(await stopping).toBe(true)
    void response.body?.cancel()
    expect(removals(chatId)).toEqual([`stopped:${before.id}`, `stopped:${late.id}`])
    expect(t.deps.runs.queueList(chatId)).toEqual([])
    expect(runStarts(chatId)).toHaveLength(1)
  })

  it('a next turn that cannot start is reported failed with its error', async () => {
    const model = controlledModel(() => textParts('first answer'))
    const release = model.hold(1)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'question', { modelRef: 'testkit:tools' }))
    await model.entered(1)
    const item = await enqueued(t, chatId, 'needs a missing provider', { modelRef: 'nosuchprovider:model' })
    const failed = nextEvent(t, 'queue.changed', event => event.data.chatId === chatId && event.data.removed?.[0]?.reason === 'failed', 15_000)
    release()
    await readSse(response)
    expect((await failed).data.removed).toEqual([{ id: item.id, reason: 'failed', error: expect.stringContaining('nosuchprovider') }])
    expect(removals(chatId)).toEqual([`started:${item.id}`, `failed:${item.id}`])
    expect((await detailOf(t, chatId)).messages).toHaveLength(2)
  })

  it('items queued while a request was prepared start the next turn when that request fails before streaming', async () => {
    const gate = deferred()
    const entered = deferred()
    const registration = t.deps.registry.commands.register('mock', {
      name: 'hugecmd',
      description: 'Waits, then expands beyond the 64 KB cap',
      run: async () => {
        entered.resolve()
        await gate.promise
        return { type: 'prompt', text: 'x'.repeat(70_000) }
      },
    })
    try {
      const chatId = newChatId()
      const pending = postChat(t, chatBody(chatId, '/hugecmd'))
      await entered.promise
      const item = await enqueued(t, chatId, 'queued meanwhile', { modelRef: 'mock:echo' })
      const queued = nextEvent(t, 'run.started', event => event.data.chatId === chatId && event.data.origin === 'queue', 15_000)
      gate.resolve()
      expect((await pending).status).toBe(400)
      const started = (await queued).data
      expect(started.userMessageId).toBe(item.id)
      await waitFinished(t, chatId, started.messageId)
      expect((await detailOf(t, chatId)).messages.map(message => messageText(message))).toEqual(['queued meanwhile', 'queued meanwhile'])
    }
    finally {
      registration.dispose()
    }
    await runnerOf(t).idle()
  })
})

// ---------- clearing ----------

describe('clearing the queue', () => {
  it('deleting a chat that waits for an approval drops its queue', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
    const item = await enqueued(t, chatId, 'doomed', { modelRef: 'mock:tool-approval' })
    expect((await t.request(`/api/chats/${chatId}`, { method: 'DELETE' })).status).toBe(204)
    expect(t.deps.runs.queueList(chatId)).toEqual([])
    expect(removals(chatId)).toEqual([`stopped:${item.id}`])
    expect((await t.request(`/api/chat/${chatId}/queue`)).status).toBe(404)
  })

  it('shutdown (stopAll) empties every queue before it aborts the runs: no queued turn starts', async () => {
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    const testkit = registerTestkit(app)
    const seen: ServerEvent[] = []
    app.deps.events.subscribe(event => seen.push(event))
    try {
      const model = controlledModel(() => textParts('never'))
      model.hold(1)
      const chatId = testChatId(0x9F01)
      const response = await postChat(app, chatBody(chatId, 'go', { modelRef: 'testkit:tools' }))
      await model.entered(1)
      const item = await enqueued(app, chatId, 'queued before shutdown')
      void response.body?.cancel()
      await app.deps.runs.stopAll()
      expect(app.deps.runs.queueList(chatId)).toEqual([])
      expect(removals(chatId, seen)).toEqual([`stopped:${item.id}`])
      const started = seen.filter(event => event.type === 'run.started')
      expect(started).toHaveLength(1)
      expect(seen.findIndex(event => event.type === 'queue.changed')).toBeLessThan(seen.findIndex(event => event.type === 'run.finished'))
    }
    finally {
      testkit.dispose()
      await app.close()
    }
  })

  it('a key rotation empties the queue of a chat that waits for an approval (no run to stop)', async () => {
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    const seen: ServerEvent[] = []
    app.deps.events.subscribe(event => seen.push(event))
    try {
      const chatId = testChatId(0x9F02)
      await readSse(await postChat(app, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
      const item = await enqueued(app, chatId, 'before the rotation', { modelRef: 'mock:tool-approval' })
      const result = await app.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {} })
      expect(result.runsStopped).toBe(0)
      expect(app.deps.runs.queueList(chatId)).toEqual([])
      expect(removals(chatId, seen)).toEqual([`stopped:${item.id}`])
    }
    finally {
      await app.close()
    }
  })
})

// ---------- helpers of the runner ----------

describe('startQueuedTurn', () => {
  it('re-queues on 409 run-active and reports any other failure; request ids start with queue_', async () => {
    expect(queueRequestId()).toMatch(/^queue_[\da-z]+_[\da-z]+$/)
    expect(queueRequestId()).not.toBe(queueRequestId())
    const bus = createRecordingEventBus()
    const chatId = testChatId(0x9F03)
    const queue = createChatQueue({ ...t.deps, events: bus }, { hasRun: () => true, now: () => 1 })
    await t.deps.chats.ensure(chatId, { modelRef: 'mock:echo', settings: {} })
    const options = { logger: t.deps.logger, requestId: 'req_x' }
    await queue.add(chatId, { message: { id: 'msg_r000000000000001', role: 'user', parts: [{ type: 'text', text: 'a' }] }, modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }, options)
    const entry = queue.takeNext(chatId)!
    let calls = 0
    await startQueuedTurn({
      chatId,
      entry,
      queue,
      events: bus,
      start: async (body, runOptions, origin) => {
        calls += 1
        expect(body).toMatchObject({ chatId, trigger: 'submit-message', message: { id: entry.item.id, role: 'user' }, modelRef: 'mock:echo', toolMode: 'ask' })
        expect(runOptions.requestId).toMatch(/^queue_/)
        expect(origin).toBe('queue')
        throw runConflict(chatId)
      },
    })
    expect(calls).toBe(1)
    expect(queue.list(chatId).map(item => item.id)).toEqual([entry.item.id])
    const again = queue.takeNext(chatId)!
    await startQueuedTurn({ chatId, entry: again, queue, events: bus, start: async () => {
      throw new Error('not a harness error')
    } })
    expect(bus.ofType('queue.changed').at(-1)?.data).toEqual({ chatId, items: [], removed: [{ id: again.item.id, reason: 'failed', error: 'The next turn could not start.' }] })
  })
})

// ---------- Phase 10 (C31-T6): the background wiring of the runner ----------

describe('the background manager of the runner (Phase 10)', () => {
  it('delegates the task members, calls onChatIdle after a completed run with nothing queued, never after an abort', async () => {
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, backgroundTasks: 'fake' })
    const testkit = registerTestkit(app)
    const fake = app.backgroundTasks as FakeBackgroundTasks
    try {
      // `startDeps` ran the boot sweep once.
      expect(fake.calls.start).toBe(1)
      const runner = app.deps.runs
      const chatId = testChatId(0x9F10)
      expect(await runner.taskList(chatId)).toEqual([])
      expect(await runner.stopTask(chatId, 'bgt_0000000000000001')).toBeNull()
      expect(await runner.stopTasks(chatId)).toBe(0)
      expect(runner.hasTasks(chatId)).toBe(false)
      expect(fake.calls).toMatchObject({ list: 1, stop: 1, stopChat: 1, hasRunning: 1 })
      await runner.boot()
      expect(fake.calls.start).toBe(2)

      await readSse(await postChat(app, chatBody(chatId, 'hello')))
      await runnerOf(app).idle()
      expect(fake.idle).toEqual([chatId])

      // A stopped run keeps the inbox for the next run: no idle delivery.
      const model = controlledModel(() => textParts('never'))
      model.hold(1)
      const stopped = testChatId(0x9F11)
      const response = await postChat(app, chatBody(stopped, 'go', { modelRef: 'testkit:tools' }))
      await model.entered(1)
      void response.body?.cancel()
      expect(await runner.stop(stopped)).toBe(true)
      expect(fake.idle).toEqual([chatId])
      // The chat's Stop never stops a background task.
      expect(fake.calls.stopChat).toBe(1)
    }
    finally {
      testkit.dispose()
      await app.close()
    }
  })

  it('a run awaiting an approval does not call onChatIdle', async () => {
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, backgroundTasks: 'fake' })
    const fake = app.backgroundTasks as FakeBackgroundTasks
    try {
      await readSse(await postChat(app, chatBody(testChatId(0x9F12), 'echo me', { modelRef: 'mock:tool-approval' })))
      await runnerOf(app).idle()
      expect(fake.idle).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('stopAll clears the queues, then stops the background tasks, then the runs', async () => {
    const order: string[] = []
    const fake = createFakeBackgroundTasks()
    const app = await createTestApp({
      env: { HF_MOCK_PROVIDER: '1' },
      backgroundTasks: { ...fake, stopAll: async () => {
        order.push('background')
        await fake.stopAll()
      } },
    })
    const testkit = registerTestkit(app)
    app.deps.events.subscribe((event) => {
      if (event.type === 'queue.changed' || event.type === 'run.finished')
        order.push(event.type)
    })
    try {
      const model = controlledModel(() => textParts('never'))
      model.hold(1)
      const chatId = testChatId(0x9F13)
      const response = await postChat(app, chatBody(chatId, 'go', { modelRef: 'testkit:tools' }))
      await model.entered(1)
      await enqueued(app, chatId, 'queued before shutdown')
      void response.body?.cancel()
      order.length = 0
      await app.deps.runs.stopAll()
      expect(order).toEqual(['queue.changed', 'background', 'run.finished'])
    }
    finally {
      testkit.dispose()
      await app.close()
    }
  })

  it('the host starts a task turn with origin task (run.started carries the user message id) and tells whether a run holds the chat', async () => {
    let host: BackgroundTasksHost | null = null
    const runner = createChatRunnerWith(t.deps, {
      backgroundTasks: (_deps, given) => {
        host = given
        return createFakeBackgroundTasks()
      },
    })
    const chatId = newChatId()
    const body = chatBody(chatId, 'results arrived')
    const started = nextEvent(t, 'run.started', event => event.data.chatId === chatId)
    const response = await host!.startTaskTurn(body, { logger: t.deps.logger, requestId: 'task_1' })
    expect(host!.hasRun(chatId)).toBe(true)
    await response.text()
    await runner.idle()
    expect((await started).data).toMatchObject({ chatId, origin: 'task', userMessageId: body.message.id })
    expect(host!.hasRun(chatId)).toBe(false)
    await runner.stopAll()
  })
})
