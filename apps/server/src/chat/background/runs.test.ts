// Background tasks end to end through the chat runner (Phase 10, W10.4-T3 … T7): `createTestApp()` + `app.request()`,
// the real manager with scripted children (`./testing.ts`) behind the real `task` tool, mock models only. Covers the
// in-run delivery at a step boundary (the model history rebuilt from the saved reply equals the in-run messages), the
// idle path (`run.started { origin: 'task', userMessageId }` and the carrier message), the lost race, the approval wait,
// the chain rule, the stop paths (the chat's Stop never stops a task), the routes, every project-busy guard, chat
// delete, delete-all and the restart. One test runs the real detached child (`runDetachedChild`): its usage row and no
// approval.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { BackgroundTask, ChatDetail, HarnessUIMessage, ServerEvent } from '@harness-forge/shared'
import type { CheckpointContext } from '../../services/checkpoints/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { BackgroundLaunchInput, BackgroundTasks, BackgroundTasksHost } from './types.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backgroundTaskListSchema, backgroundTaskSchema, chatDetailSchema, DEFAULT_SETTINGS, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundTasks, usage } from '../../db/schema.ts'
import { assertProjectIdle } from '../../services/checkpoints/restore-scope.ts'
import { PROJECT_TASKS_MESSAGE } from '../../services/projects/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createChatRunnerWith } from '../index.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { answerApprovals, chatBody, messageText, nextEvent, postChat, readSse, runnerOf, testCatalog, testChatId } from '../testing.ts'
import { BACKGROUND_BUSY_MESSAGE } from './busy.ts'
import { createBackgroundTasks } from './index.ts'
import { scriptedChildren } from './testing.ts'
import { BACKGROUND_RESTARTED_TEXT, BACKGROUND_STOPPED_TEXT } from './types.ts'

const REPORT_SECRET = 'bg-run-report-sentinel-3e9f'

let t: TestApp
let root: string
let events: ServerEvent[]
let nextChat = 0xC000
let kids = scriptedChildren()
let manager: BackgroundTasks
/** Runs right before the real `startTaskTurn` (the lost race). */
let beforeTaskTurn: ((chatId: string) => Promise<void>) | null = null
let taskTurnFailures: unknown[] = []
const scripted = new Map<string, LanguageModelV4>()
const disposables: Disposable[] = []

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

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

/** The runner's manager with scripted children; the host runs `beforeTaskTurn` first (tests of the lost race). */
function runnerFactory(): (deps: TestApp['deps']) => ReturnType<typeof createChatRunnerWith> {
  return deps => createChatRunnerWith(deps, {
    backgroundTasks: (managerDeps, host: BackgroundTasksHost) => {
      manager = createBackgroundTasks(managerDeps, {
        hasRun: host.hasRun,
        startTaskTurn: async (body, options) => {
          await beforeTaskTurn?.(body.chatId)
          const failure = taskTurnFailures.shift()
          if (failure !== undefined)
            throw failure
          return host.startTaskTurn(body, options)
        },
      }, { runChild: input => kids.runChild(input) })
      return manager
    },
  })
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceRoots: [root], factories: { runs: runnerFactory() } })
  t.deps.events.subscribe(event => events.push(event))
  disposables.push(registerTestkit(t))
})

beforeEach(() => {
  events = []
  scripted.clear()
  kids = scriptedChildren()
  beforeTaskTurn = null
  taskTurnFailures = []
})

afterAll(async () => {
  for (const disposable of disposables)
    disposable.dispose()
  await t.close()
  await rm(root, { recursive: true, force: true })
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

function toolCall(id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }, finishPart('tool-calls')]
}

function backgroundCall(id: string, description = 'Look around'): LanguageModelV4StreamPart[] {
  return toolCall(id, 'task', { description, prompt: 'List the files.', type: 'explore', background: true })
}

interface ControlledModel {
  calls: LanguageModelV4CallOptions[]
  entered: (n: number) => Promise<void>
  hold: (n: number) => () => void
}

/** `testkit:tools`: answers from `script` (calls recorded); a held call waits before it streams anything. */
function controlledModel(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[]): ControlledModel {
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
        const signal = options.abortSignal
        await Promise.race([held.promise, new Promise<never>((_resolve, reject) => {
          if (signal?.aborted)
            reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })])
      }
      return { stream: convertArrayToReadableStream(script(options, n)) }
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

/** The prompt without the system message. */
function conversation(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  return prompt.filter(message => message.role !== 'system')
}

function lastUserText(prompt: LanguageModelV4Prompt): string {
  const last = prompt.at(-1)
  if (last?.role !== 'user')
    return ''
  return last.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
}

async function detailOf(chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

async function tasksOf(chatId: string): Promise<BackgroundTask[]> {
  const response = await t.request(`/api/chat/${chatId}/tasks`)
  expect(response.status).toBe(200)
  return backgroundTaskListSchema.parse(await response.json()).items
}

function runStarts(chatId: string): Extract<ServerEvent, { type: 'run.started' }>['data'][] {
  return events.flatMap(event => (event.type === 'run.started' && event.data.chatId === chatId ? [event.data] : []))
}

async function finishedRuns(chatId: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(events.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(count)
  }, { timeout: 10_000, interval: 10 })
}

async function rowsOf(chatId: string): Promise<Array<typeof backgroundTasks.$inferSelect>> {
  return t.db.select().from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))
}

/** Waits until the chat's task `taskId` has a final status in its row. */
async function endedRow(taskId: string): Promise<typeof backgroundTasks.$inferSelect> {
  let found: typeof backgroundTasks.$inferSelect | undefined
  await vi.waitFor(async () => {
    ;[found] = await t.db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId))
    expect(found?.status).not.toBe('running')
  }, { timeout: 5000, interval: 5 })
  return found!
}

function partTypes(message: HarnessUIMessage | undefined): string[] {
  return message?.parts.map(part => part.type) ?? []
}

function resultIds(message: HarnessUIMessage | undefined): string[] {
  return message?.parts.flatMap(part => (part.type === 'data-task-result' ? [part.data.taskId] : [])) ?? []
}

async function errorOf(response: Response): Promise<{ code: string, message: string, details?: unknown }> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error as { code: string, message: string, details?: unknown }
}

/** A first turn that launches one background task (testkit: call `n` is the `task` call, `n + 1` the text). */
async function launchTurn(chatId: string, model: ControlledModel, body: Partial<Parameters<typeof chatBody>[2]> = {}): Promise<{ replyId: string, taskId: string }> {
  const before = kids.list.length
  await readSse(await postChat(t, chatBody(chatId, 'start in background', { modelRef: 'testkit:tools', ...body })))
  await runnerOf(t).idle()
  await kids.started(before + 1)
  const detail = await detailOf(chatId)
  const reply = detail.messages.at(-1)!
  const [row] = (await rowsOf(chatId)).sort((a, b) => b.createdAt - a.createdAt)
  expect(model.calls.length).toBeGreaterThan(0)
  return { replyId: reply.id, taskId: row!.id }
}

// ---------- delivery ----------

describe('delivery through the runner', () => {
  it('in-run: a result reaches the next model call as a user message, is stored between the steps and delivered once', async () => {
    const answers: Record<number, LanguageModelV4StreamPart[]> = {
      1: backgroundCall('call_bg'),
      2: textParts('launched'),
      3: toolCall('call_time', 'current_time', {}),
      4: textParts('done'),
      5: textParts('next'),
    }
    const model = controlledModel((_options, call) => answers[call] ?? textParts('extra'))
    const chatId = newChatId()
    const launched = await launchTurn(chatId, model)
    const child = kids.list.at(-1)!
    expect(child.input.session.assistantId).toBe(launched.replyId)
    // The launch output of the tool part: `background` with the task id.
    const first = (await detailOf(chatId)).messages[1]
    expect(first?.parts.find(part => part.type === 'tool-task')).toMatchObject({ state: 'output-available', output: { status: 'background', taskId: launched.taskId } })
    expect((await tasksOf(chatId)).map(task => [task.id, task.status, task.origin])).toEqual([[launched.taskId, 'running', 'request']])

    // The second turn: the result arrives while its first call runs.
    const release = model.hold(3)
    const response = await postChat(t, chatBody(chatId, 'go on', { modelRef: 'testkit:tools' }))
    const reading = readSse(response)
    await model.entered(3)
    child.end({ report: REPORT_SECRET })
    await endedRow(launched.taskId)
    release()
    const { chunks } = await reading
    await finishedRuns(chatId, 2)
    await runnerOf(t).idle()

    // The model saw the result after the tool result of step 0, as one user message.
    expect(model.calls).toHaveLength(4)
    const inRun = conversation(model.calls[3]!.prompt)
    expect(inRun.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'user'])
    expect(lastUserText(model.calls[3]!.prompt)).toContain(`<background-task id="${launched.taskId}" type="explore" status="completed"`)
    expect(lastUserText(model.calls[3]!.prompt)).toContain(REPORT_SECRET)
    // Streamed right before the second start-step, once.
    const types = chunks.map(chunk => chunk.type)
    expect(types.filter(type => type === 'data-task-result')).toHaveLength(1)
    const at = types.indexOf('data-task-result')
    expect(types.slice(at - 1, at + 2)).toEqual(['finish-step', 'data-task-result', 'start-step'])

    const detail = await detailOf(chatId)
    const reply = detail.messages[3]
    expect(partTypes(reply)).toEqual(['step-start', 'tool-current_time', 'data-task-result', 'step-start', 'text'])
    expect(reply?.parts[2]).toMatchObject({ data: { taskId: launched.taskId, toolCallId: 'call_bg', messageId: launched.replyId, output: { status: 'completed', report: REPORT_SECRET } } })
    const [task] = await tasksOf(chatId)
    expect(task).toMatchObject({ id: launched.taskId, status: 'completed', deliveredMessageId: reply!.id })
    expect(task?.deliveredAt).toEqual(expect.any(Number))
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'request'])

    // The model history rebuilt from the saved reply (`splitTaskResults`) equals what the model saw in the run.
    await readSse(await postChat(t, chatBody(chatId, 'after', { modelRef: 'testkit:tools' })))
    const rebuilt = conversation(model.calls[4]!.prompt)
    expect(rebuilt.slice(0, inRun.length)).toEqual(inRun)
    // Delivered exactly once: the next turn takes nothing more.
    expect(partTypes((await detailOf(chatId)).messages[5])).not.toContain('data-task-result')
    expect(t.logs.text()).not.toContain(REPORT_SECRET)
    await runnerOf(t).idle()
  })

  it('idle: a finished task of an idle chat starts a task turn from a user-role carrier of its result', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'bg', { modelRef: 'mock:background' })))
    await runnerOf(t).idle()
    const child = await kids.started(1)
    const [row] = await rowsOf(chatId)
    expect(messageText((await detailOf(chatId)).messages[1])).toBe(`Started in background: ${row!.id}`)

    const started = nextEvent(t, 'run.started', event => event.data.chatId === chatId && event.data.origin === 'task')
    child.end({ report: 'Report: background done' })
    const run = (await started).data
    expect(run).toMatchObject({ chatId, origin: 'task', modelRef: 'mock:background', userMessageId: expect.stringMatching(/^msg_/) })
    await finishedRuns(chatId, 2)
    await runnerOf(t).idle()

    const detail = await detailOf(chatId)
    expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const carrier = detail.messages[2]!
    expect(carrier.id).toBe(run.userMessageId)
    expect(partTypes(carrier)).toEqual(['data-task-result'])
    expect(carrier.parts[0]).toMatchObject({ data: { taskId: row!.id, output: { status: 'completed', report: 'Report: background done' } } })
    expect(messageText(detail.messages[3])).toBe('Background result: completed | Report: background done')
    const [task] = await tasksOf(chatId)
    expect(task).toMatchObject({ status: 'completed', deliveredMessageId: carrier.id })
    expect(detail.pendingApproval).toBe(false)
  })

  it('the lost race: a request that takes the chat first gets the result at its step boundary (no task turn)', async () => {
    const answers: Record<number, LanguageModelV4StreamPart[]> = {
      1: backgroundCall('call_bg'),
      2: textParts('launched'),
      3: toolCall('call_time', 'current_time', {}),
      4: textParts('got it'),
    }
    const model = controlledModel((_options, call) => answers[call] ?? textParts('extra'))
    const chatId = newChatId()
    const launched = await launchTurn(chatId, model)
    const release = model.hold(3)
    let user: Promise<unknown> | null = null
    const raced = deferred()
    beforeTaskTurn = async (target) => {
      beforeTaskTurn = null
      // A user's request takes the chat between the delivery's checks and its start.
      user = postChat(t, chatBody(target, 'me first', { modelRef: 'testkit:tools' })).then(readSse)
      await vi.waitFor(() => expect(t.deps.runs.hasRun(target)).toBe(true))
      raced.resolve()
    }
    kids.list.at(-1)!.end({ report: 'raced' })
    await raced.promise
    await endedRow(launched.taskId)
    release()
    await user
    await finishedRuns(chatId, 2)
    await runnerOf(t).idle()

    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'request'])
    const detail = await detailOf(chatId)
    expect(detail.messages).toHaveLength(4)
    expect(resultIds(detail.messages[3])).toEqual([launched.taskId])
    expect(lastUserText(model.calls.at(-1)!.prompt)).toContain('raced')
    expect((await tasksOf(chatId))[0]).toMatchObject({ deliveredMessageId: detail.messages[3]!.id })
  })

  it('a pending approval holds the result until its continuation takes it at step 0', async () => {
    const answers: Record<number, LanguageModelV4StreamPart[]> = {
      1: backgroundCall('call_bg'),
      2: toolCall('call_ask', 'mock_approval_tool', { text: 'hi' }),
      3: textParts('continued'),
    }
    const model = controlledModel((_options, call) => answers[call] ?? textParts('extra'))
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'launch then ask', { modelRef: 'testkit:tools' })))
    await runnerOf(t).idle()
    const pending = await detailOf(chatId)
    expect(pending.pendingApproval).toBe(true)
    const child = await kids.started(1)
    child.end({ report: 'waited' })
    const [row] = await rowsOf(chatId)
    await endedRow(row!.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runStarts(chatId)).toHaveLength(1)
    expect((await tasksOf(chatId))[0]?.deliveredAt).toBeNull()

    const assistant = pending.messages[1]!
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'testkit:tools' }), message: answerApprovals(assistant, true) }))
    await runnerOf(t).idle()
    const types = chunks.map(chunk => chunk.type)
    expect(types.indexOf('data-task-result')).toBeGreaterThan(types.indexOf('tool-output-available'))
    expect(types[types.indexOf('data-task-result') + 1]).toBe('start-step')
    expect(model.calls).toHaveLength(3)
    expect(lastUserText(model.calls[2]!.prompt)).toContain('waited')
    const reply = (await detailOf(chatId)).messages[1]
    expect(resultIds(reply)).toEqual([row!.id])
    expect((await tasksOf(chatId))[0]).toMatchObject({ deliveredMessageId: assistant.id })
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'request'])
  })

  it('chain depth 1: a task launched by a task turn starts no turn; its result opens the next user turn', async () => {
    const model = controlledModel((options, call) => {
      if (call === 1)
        return backgroundCall('call_a', 'First agent')
      const text = lastUserText(options.prompt)
      if (text.includes('<background-task') && !conversation(options.prompt).some(message => message.role === 'tool' && JSON.stringify(message).includes('call_b')))
        return backgroundCall('call_b', 'Second agent')
      return textParts(`answer ${call}`)
    })
    const chatId = newChatId()
    const launched = await launchTurn(chatId, model)
    const taskTurn = nextEvent(t, 'run.started', event => event.data.chatId === chatId && event.data.origin === 'task')
    kids.list.at(-1)!.end({ report: 'first' })
    await taskTurn
    await finishedRuns(chatId, 2)
    await runnerOf(t).idle()
    const second = await kids.started(2)
    const rows = await rowsOf(chatId)
    const secondRow = rows.find(row => row.id !== launched.taskId)!
    expect(secondRow.origin).toBe('task')
    second.end({ report: 'second' })
    await endedRow(secondRow.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'task'])
    expect((await tasksOf(chatId)).find(task => task.id === secondRow.id)?.deliveredAt).toBeNull()

    await readSse(await postChat(t, chatBody(chatId, 'next', { modelRef: 'testkit:tools' })))
    await runnerOf(t).idle()
    const detail = await detailOf(chatId)
    expect(resultIds(detail.messages.at(-1))).toEqual([secondRow.id])
    expect(partTypes(detail.messages.at(-1))[0]).toBe('data-task-result')
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'task', 'request'])
  })
})

// ---------- stops and routes ----------

describe('stopping and the chat tasks routes', () => {
  it('the chat\'s Stop never stops a task; its Stop route does, and the result opens the next user turn', async () => {
    const answers: Record<number, LanguageModelV4StreamPart[]> = { 1: backgroundCall('call_bg'), 2: textParts('launched'), 3: textParts('never'), 4: textParts('next turn') }
    const model = controlledModel((_options, call) => answers[call] ?? textParts('extra'))
    const chatId = newChatId()
    const launched = await launchTurn(chatId, model)
    model.hold(3)
    const response = await postChat(t, chatBody(chatId, 'busy', { modelRef: 'testkit:tools' }))
    await model.entered(3)
    void response.body?.cancel()
    const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
    expect(await stop.json()).toEqual({ stopped: true })
    expect(t.deps.runs.hasTasks(chatId)).toBe(true)
    expect((await tasksOf(chatId))[0]?.status).toBe('running')

    const stopped = await t.request(`/api/chat/${chatId}/tasks/${launched.taskId}/stop`, { method: 'POST' })
    expect(stopped.status).toBe(200)
    expect(backgroundTaskSchema.parse(await stopped.json())).toMatchObject({ id: launched.taskId, status: 'aborted', output: { error: BACKGROUND_STOPPED_TEXT, report: 'partial' }, deliveredAt: null })
    expect(events.some(event => event.type === 'task.changed' && event.data.task.status === 'aborted')).toBe(true)
    expect(t.deps.runs.hasTasks(chatId)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runStarts(chatId).map(start => start.origin)).toEqual(['request', 'request'])
    // Stopping it again answers the ended task.
    const again = await t.request(`/api/chat/${chatId}/tasks/${launched.taskId}/stop`, { method: 'POST' })
    expect(await again.json()).toMatchObject({ status: 'aborted' })

    await readSse(await postChat(t, chatBody(chatId, 'and now?', { modelRef: 'testkit:tools' })))
    await runnerOf(t).idle()
    const reply = (await detailOf(chatId)).messages.at(-1)
    expect(resultIds(reply)).toEqual([launched.taskId])
    expect(lastUserText(model.calls.at(-1)!.prompt)).toContain('status="aborted"')
  })

  it('answers 404 for an unknown chat or a task of another chat, 400 for invalid ids', async () => {
    const model = controlledModel((_options, call) => (call === 1 ? backgroundCall('call_bg') : textParts('ok')))
    const chatId = newChatId()
    const launched = await launchTurn(chatId, model)
    const other = newChatId()
    await t.deps.chats.create({ id: other })
    expect((await t.request(`/api/chat/${newChatId()}/tasks`)).status).toBe(404)
    expect(await tasksOf(other)).toEqual([])
    const foreign = await t.request(`/api/chat/${other}/tasks/${launched.taskId}/stop`, { method: 'POST' })
    expect(foreign.status).toBe(404)
    expect((await errorOf(foreign)).code).toBe('not_found')
    expect((await t.request(`/api/chat/${chatId}/tasks/bgt_0000000000000000/stop`, { method: 'POST' })).status).toBe(404)
    expect((await t.request(`/api/chat/${chatId}/tasks/nope/stop`, { method: 'POST' })).status).toBe(400)
    expect((await t.request('/api/chat/nope/tasks')).status).toBe(400)
    expect(t.deps.runs.hasTasks(chatId)).toBe(true)
    await t.deps.runs.stopTasks(chatId)
  })

  it('deleting a chat stops its tasks first and removes their rows; delete-all stops every task', async () => {
    const model = controlledModel((_options, call) => (call % 2 === 1 ? backgroundCall(`call_${call}`) : textParts('ok')))
    const chatId = newChatId()
    const launched = await launchTurn(chatId, model)
    const child = kids.list.at(-1)!
    const removed = await t.request(`/api/chats/${chatId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    await child.closed
    expect(child.input.session.ctx.run.signal.aborted).toBe(true)
    expect(t.deps.runs.hasTasks(chatId)).toBe(false)
    expect(await rowsOf(chatId)).toEqual([])
    expect(events.some(event => event.type === 'task.changed' && event.data.task.id === launched.taskId && event.data.task.status === 'aborted')).toBe(true)

    const a = newChatId()
    const b = newChatId()
    await launchTurn(a, model)
    await launchTurn(b, model)
    const [childA, childB] = kids.list.slice(-2)
    await t.deps.data.deleteAll({ confirm: 'DELETE' })
    await Promise.all([childA!.closed, childB!.closed])
    expect(t.deps.runs.hasTasks(a) || t.deps.runs.hasTasks(b)).toBe(false)
    expect(await t.db.select().from(backgroundTasks)).toEqual([])
  })
})

// ---------- guards ----------

describe('a running task makes its project busy', () => {
  it('rewind, revert / undo, project delete, chat move and version delete answer 409 run-active; a branch switch works', async () => {
    const project = await t.deps.projects.create({ name: 'Busy', path: root, newFolder: `busy-${nextChat}` })
    const chatId = newChatId()
    const created = await t.request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chatId, projectId: project.id }) })
    expect(created.status).toBe(201)
    await readSse(await postChat(t, chatBody(chatId, 'hello')))
    await runnerOf(t).idle()
    const [userMessage, reply] = (await detailOf(chatId)).messages
    const launch: BackgroundLaunchInput = {
      chatId,
      messageId: reply!.id,
      toolCallId: 'call_bg',
      task: { description: 'Look around', prompt: 'look', type: 'explore', background: true },
      origin: 'request',
      model: { modelRef: 'mock:echo' } as BackgroundLaunchInput['model'],
      toolMode: 'ask',
      workspace: null,
      scope: null,
      settings: DEFAULT_SETTINGS,
      reasoningEffort: 'auto',
      chatInstructions: undefined,
      catalog: testCatalog(),
      logger: t.deps.logger,
    }
    const output = await manager.launch(launch)
    expect(output.status).toBe('background')
    expect(t.deps.runs.hasTasks(chatId)).toBe(true)
    expect(t.deps.runs.hasRun(chatId)).toBe(false)

    const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const rewind = await t.request(`/api/chats/${chatId}/rewind`, json({ messageId: userMessage!.id, conflicts: 'skip' }))
    expect(rewind.status).toBe(409)
    expect(await errorOf(rewind)).toMatchObject({ code: 'conflict', message: PROJECT_TASKS_MESSAGE, details: { reason: 'run-active', chatId } })
    // Revert and undo share the check.
    await expect(assertProjectIdle({ deps: t.deps } as CheckpointContext, project.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId } })
    const projectDelete = await t.request(`/api/projects/${project.id}`, { method: 'DELETE' })
    expect(projectDelete.status).toBe(409)
    expect(await errorOf(projectDelete)).toMatchObject({ code: 'conflict', message: PROJECT_TASKS_MESSAGE, details: { reason: 'run-active' } })
    const move = await t.request(`/api/chats/${chatId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: null }) })
    expect(move.status).toBe(409)
    expect(await errorOf(move)).toMatchObject({ code: 'conflict', message: BACKGROUND_BUSY_MESSAGE, details: { reason: 'run-active', chatId } })
    const versionDelete = await t.request(`/api/chats/${chatId}/messages/${reply!.id}`, { method: 'DELETE' })
    expect(versionDelete.status).toBe(409)
    expect(await errorOf(versionDelete)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId } })
    const branch = await t.request(`/api/chats/${chatId}/branch`, json({ messageId: reply!.id }))
    expect(branch.status).toBe(200)

    // Once stopped, the project is idle again.
    await t.request(`/api/chat/${chatId}/tasks/${output.taskId}/stop`, { method: 'POST' })
    await expect(assertProjectIdle({ deps: t.deps } as CheckpointContext, project.id)).resolves.toBeUndefined()
    expect((await t.request(`/api/chats/${chatId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: null }) })).status).toBe(200)
    expect((await t.request(`/api/projects/${project.id}`, { method: 'DELETE' })).status).toBe(204)
  })
})

// ---------- restart ----------

describe('restart', () => {
  it('a running row becomes aborted and an undelivered row is delivered at the chat\'s next run (no turn at boot)', async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    const databasePath = join(dataDir, 'harness.db')
    const chatId = newChatId()
    try {
      const first = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, dataDir, databasePath })
      try {
        await readSse(await postChat(first, chatBody(chatId, 'hello', { modelRef: 'mock:background' })))
        await runnerOf(first).idle()
        const reply = (await first.client.chats.get({ params: { id: chatId } })).messages[1]!
        const output = { type: 'explore', description: 'Look', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: 'kept report', startedAt: 1 }
        const base = { chatId, messageId: reply.id, toolCallId: 'call_1', type: 'explore', description: 'Look', origin: 'request' as const }
        // A crash leaves a running row and a finished, undelivered one.
        await first.db.insert(backgroundTasks).values([
          { ...base, id: 'bgt_restart000000001', status: 'running', output: { ...output, status: 'running' }, createdAt: 10 },
          { ...base, id: 'bgt_restart000000002', status: 'completed', output: { ...output, status: 'completed', finishedAt: 12 }, createdAt: 11, finishedAt: 12 },
        ])
      }
      finally {
        await first.close()
      }
      const second = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, dataDir, databasePath })
      const seen: ServerEvent[] = []
      second.deps.events.subscribe(event => seen.push(event))
      try {
        const [running] = await second.db.select().from(backgroundTasks).where(eq(backgroundTasks.id, 'bgt_restart000000001'))
        expect(running).toMatchObject({ status: 'aborted', output: { status: 'aborted', error: BACKGROUND_RESTARTED_TEXT, report: 'kept report' } })
        expect(running?.finishedAt).toEqual(expect.any(Number))
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(seen.filter(event => event.type === 'run.started')).toEqual([])

        await readSse(await postChat(second, chatBody(chatId, 'what happened?', { modelRef: 'mock:background' })))
        await runnerOf(second).idle()
        const detail = await second.client.chats.get({ params: { id: chatId } })
        const reply = detail.messages.at(-1)
        expect(resultIds(reply)).toEqual(['bgt_restart000000001', 'bgt_restart000000002'])
        expect(messageText(reply)).toMatch(/^Background result: (aborted|completed) \| kept report$/)
        const tasks = await second.client.chatTasks.list({ params: { id: chatId } })
        expect(tasks.items.map(task => [task.id, task.deliveredMessageId])).toEqual([
          ['bgt_restart000000002', reply!.id],
          ['bgt_restart000000001', reply!.id],
        ])
      }
      finally {
        await second.close()
      }
    }
    finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('shutdown saves a running task as aborted (stopped)', async () => {
    const own = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { runs: runnerFactory() } })
    const testkit = registerTestkit(own)
    try {
      const model = controlledModel((_options, call) => (call === 1 ? backgroundCall('call_bg') : textParts('ok')))
      const chatId = newChatId()
      await readSse(await postChat(own, chatBody(chatId, 'go', { modelRef: 'testkit:tools' })))
      await runnerOf(own).idle()
      expect(model.calls).toHaveLength(2)
      await kids.started(1)
      await own.deps.runs.stopAll()
      const [row] = await own.db.select().from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))
      expect(row).toMatchObject({ status: 'aborted', output: { error: BACKGROUND_STOPPED_TEXT } })
    }
    finally {
      testkit.dispose()
      await own.close()
    }
  })
})

// ---------- the real detached child ----------

describe('the real detached child (runDetachedChild)', () => {
  it('writes one subagent usage row under the launching reply, never asks for approval and reports through the inbox', async () => {
    const own = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    const testkit = registerTestkit(own)
    try {
      // The parent launches; the child (its instructions carry the sub-agent marker) tries a tool that would ask, then
      // reports.
      controlledModel((options, call) => {
        const system = options.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n')
        if (system.includes(SUBAGENT_INSTRUCTIONS_MARKER)) {
          const tried = options.prompt.some(message => message.role === 'tool')
          return tried ? textParts(`child report ${call}`) : toolCall('child_ask', 'mock_approval_tool', { text: 'x' })
        }
        if (call === 1)
          return backgroundCall('call_bg')
        return textParts(lastUserText(options.prompt).includes('<background-task') ? 'parent saw the result' : 'parent launched')
      })
      const chatId = newChatId()
      const ownEvents: ServerEvent[] = []
      own.deps.events.subscribe(event => ownEvents.push(event))
      await readSse(await postChat(own, chatBody(chatId, 'go', { modelRef: 'testkit:tools', toolMode: 'ask' })))
      await runnerOf(own).idle()
      // The child ends, then the idle chat gets its task turn (wait for it: the in-memory test database has one
      // connection, so nothing reads while that turn's transactions run).
      await vi.waitFor(() => {
        expect(ownEvents.some(event => event.type === 'task.changed' && event.data.task.status !== 'running')).toBe(true)
        expect(ownEvents.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(2)
      }, { timeout: 10_000, interval: 10 })
      await runnerOf(own).idle()
      const final = ownEvents.flatMap(event => (event.type === 'task.changed' ? [event.data.task] : [])).find(task => task.status !== 'running')!
      expect(final.status).toBe('completed')
      expect(ownEvents.flatMap(event => (event.type === 'run.started' ? [event.data.origin] : []))).toEqual(['request', 'task'])
      const detail = await own.client.chats.get({ params: { id: chatId } })
      const launchReply = detail.messages[1]!
      expect(messageText(detail.messages[3])).toBe('parent saw the result')
      expect(final.output.steps.map(step => step.state)).not.toContain('running')
      const rows = await own.db.select().from(usage).where(eq(usage.chatId, chatId))
      const children = rows.filter(row => row.purpose === 'subagent')
      expect(children).toHaveLength(1)
      expect(children[0]?.messageId).toBe(launchReply.id)
      await vi.waitFor(async () => {
        const detail = await own.client.chats.get({ params: { id: chatId } })
        expect(detail.pendingApproval).toBe(false)
        expect(JSON.stringify(detail.messages)).not.toContain('approval-requested')
      }, { timeout: 10_000, interval: 20 })
      await runnerOf(own).idle()
    }
    finally {
      testkit.dispose()
      await own.close()
    }
  })
})
