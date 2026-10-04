// The background manager (Phase 10, W10.4-T1 … T5): launch caps, the detached child (a scripted fake behind
// `runChild`; W10.3's `runDetachedChild` is covered in `subagent/`), rows, `task.changed` throttling, the deadline (fake
// timers), the inbox and exactly-once delivery (`takeResults`, idle turns through a recording host), the chain rule,
// the stops (Stop, chat delete, key rotation, shutdown) and the boot sweep. Real database (`createTestApp`), mock models
// only; nothing here starts a real turn (the host records the carrier).
import type { BackgroundTask, ServerEvent, TaskOutput, TaskStatus } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { DetachedChildInput } from '../subagent/index.ts'
import type { BackgroundTasksOptions } from './index.ts'
import type { RecordingHost, ScriptedChild, ScriptedChildren } from './testing.ts'
import type { BackgroundLaunchInput, BackgroundTasks } from './types.ts'
import { backgroundTaskSchema, createMessageId, DEFAULT_SETTINGS, HarnessError, LIMITS, taskOutputSchema, taskResultDataSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundTasks } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { runConflict } from '../runs.ts'
import { testCatalog, testChatId } from '../testing.ts'
import {
  BACKGROUND_FAILED_TEXT,
  BACKGROUND_NO_RESULT_TEXT,
  BACKGROUND_SHUTDOWN_TEXT,
  backgroundDeadlineText,
  carrierMessage,
  createBackgroundTasks,
  failedLaunchOutput,
  perChatLimitText,
  serverLimitText,
} from './index.ts'
import { childSnapshot, recordingHost, scriptedChildren } from './testing.ts'
import { BACKGROUND_RESTARTED_TEXT, BACKGROUND_STOPPED_TEXT, BACKGROUND_UNAVAILABLE_TEXT } from './types.ts'

const PROMPT_SECRET = 'bg-prompt-sentinel-5d1e'
const REPORT_SECRET = 'bg-report-sentinel-77aa'

let t: TestApp
let events: ServerEvent[]
let nextChat = 0xB000

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  t.deps.events.subscribe(event => events.push(event))
})

beforeEach(() => {
  events = []
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await t.close()
})

// ---------- helpers ----------

async function newChat(settings: Record<string, unknown> = {}, modelRef = 'mock:background'): Promise<string> {
  nextChat += 1
  const id = testChatId(nextChat)
  await t.deps.chats.create({ id, modelRef, settings })
  return id
}

function launchInput(chatId: string, overrides: Partial<BackgroundLaunchInput> = {}): BackgroundLaunchInput {
  return {
    chatId,
    messageId: 'msg_aaaaaaaaaaaaaaaa',
    toolCallId: 'call_1',
    task: { description: 'Look around', prompt: `List the files. ${PROMPT_SECRET}`, type: 'explore', background: true },
    origin: 'request',
    model: { modelRef: 'mock:background' } as BackgroundLaunchInput['model'],
    toolMode: 'auto',
    workspace: null,
    scope: null,
    settings: DEFAULT_SETTINGS,
    reasoningEffort: 'high',
    chatInstructions: 'Be brief.',
    catalog: testCatalog(),
    logger: t.deps.logger,
    ...overrides,
  }
}

const snapshot = childSnapshot
type Child = ScriptedChild

interface Harness {
  tasks: BackgroundTasks
  host: RecordingHost
  kids: ScriptedChildren
}

function manager(options: BackgroundTasksOptions = {}, kids: ScriptedChildren = scriptedChildren()): Harness {
  const host = recordingHost()
  const tasks = createBackgroundTasks(t.deps, host, { runChild: kids.runChild, ...options })
  return { tasks, host, kids }
}

async function rowOf(taskId: string): Promise<typeof backgroundTasks.$inferSelect | undefined> {
  const [row] = await t.db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId))
  return row
}

function changes(taskId: string): BackgroundTask[] {
  return events.flatMap(event => (event.type === 'task.changed' && event.data.task.id === taskId ? [event.data.task] : []))
}

/** Waits until the task's row reached a final status. */
async function ended(taskId: string): Promise<BackgroundTask> {
  await vi.waitFor(async () => {
    expect((await rowOf(taskId))?.status).not.toBe('running')
    expect(changes(taskId).at(-1)?.status).not.toBe('running')
  }, { timeout: 5000, interval: 5 })
  return changes(taskId).at(-1)!
}

// ---------- launch, rows, progress ----------

describe('launch', () => {
  it('answers background with a task id at once, inserts the running row and runs the child on a detached host', async () => {
    const chatId = await newChat()
    const { tasks, kids, host } = manager()
    // A run holds the chat: the result waits in the inbox (no automatic turn here).
    host.held.add(chatId)
    const output = await tasks.launch(launchInput(chatId))
    expect(taskOutputSchema.parse(output)).toMatchObject({ status: 'background', type: 'explore', description: 'Look around', steps: [], report: '' })
    const taskId = output.taskId!
    expect(taskId).toMatch(/^bgt_[\dA-Za-z]{16}$/)

    const row = await rowOf(taskId)
    expect(row).toMatchObject({ chatId, messageId: 'msg_aaaaaaaaaaaaaaaa', toolCallId: 'call_1', type: 'explore', description: 'Look around', status: 'running', origin: 'request', finishedAt: null, deliveredAt: null })
    expect(changes(taskId).map(task => task.status)).toEqual(['running'])
    expect(backgroundTaskSchema.parse(changes(taskId)[0])).toMatchObject({ id: taskId, chatId, status: 'running', output: { taskId } })
    expect(tasks.hasRunning(chatId)).toBe(true)

    // The detached host: the launching message, the task's own signal and deadline, the launching run's values.
    const child = await kids.started(1)
    expect(child.input.session.chatId).toBe(chatId)
    expect(child.input.session.assistantId).toBe('msg_aaaaaaaaaaaaaaaa')
    expect(child.input.session.ctx.run.signal.aborted).toBe(false)
    expect(child.input.session.ctx.prepared).toMatchObject({ settings: DEFAULT_SETTINGS, chat: { settings: { instructions: 'Be brief.' } }, history: [], continued: null })
    expect(child.input.session.ctx.reasoningEffort).toBe('high')
    expect(child.input.deadline?.aborted).toBe(false)
    expect(child.input).toMatchObject({ toolMode: 'auto', toolCallId: 'call_1', workspace: null, scope: null, task: { type: 'explore', background: true } })

    child.end({ report: 'Found 3 files.' })
    const final = await ended(taskId)
    expect(final).toMatchObject({ status: 'completed', output: { status: 'completed', report: 'Found 3 files.', taskId }, deliveredAt: null })
    expect(final.finishedAt).toEqual(expect.any(Number))
    expect(await rowOf(taskId)).toMatchObject({ status: 'completed', output: { report: 'Found 3 files.' }, deliveredAt: null })
    expect(tasks.hasRunning(chatId)).toBe(false)
    const listed = await tasks.list(chatId)
    expect(listed).toHaveLength(1)
    expect(backgroundTaskSchema.parse(listed[0])).toMatchObject({ id: taskId, status: 'completed' })
    await tasks.stopAll()
  })

  it('caps: the fourth running task of a chat fails naming the limit (no row); the server cap counts every chat', async () => {
    const { tasks } = manager()
    const chatId = await newChat()
    const launched = await Promise.all([1, 2, 3, 4].map(n => tasks.launch(launchInput(chatId, { toolCallId: `call_${n}` }))))
    expect(launched.map(output => output.status)).toEqual(['background', 'background', 'background', 'failed'])
    expect(launched[3]).toMatchObject({ error: perChatLimitText(3), type: 'explore', description: 'Look around' })
    expect(launched[3]?.taskId).toBeUndefined()
    expect(perChatLimitText(3)).toBe('At most 3 background agents run per chat. Wait for one to finish.')
    const rows = await t.db.select().from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))
    expect(rows).toHaveLength(3)

    // Ten across the server: three more chats of three, then one more.
    const others = [await newChat(), await newChat(), await newChat()]
    for (const other of others.slice(0, 2)) {
      for (const n of [1, 2, 3])
        expect((await tasks.launch(launchInput(other, { toolCallId: `call_${n}` }))).status).toBe('background')
    }
    expect((await tasks.launch(launchInput(others[2]!))).status).toBe('background')
    const over = await tasks.launch(launchInput(others[2]!))
    expect(over).toMatchObject({ status: 'failed', error: serverLimitText(LIMITS.backgroundTasksMax) })
    expect(LIMITS.backgroundTasksMax).toBe(10)
    await tasks.stopAll()
  })

  it('a child that cannot start (the stub of runDetachedChild) fails the launch without a row', async () => {
    const chatId = await newChat()
    const tasks = createBackgroundTasks(t.deps, recordingHost(), {
      runChild: () => {
        throw new HarnessError({ code: 'not_implemented', message: BACKGROUND_UNAVAILABLE_TEXT })
      },
    })
    const output = await tasks.launch(launchInput(chatId))
    expect(output).toMatchObject({ status: 'failed', error: BACKGROUND_UNAVAILABLE_TEXT })
    expect(await t.db.select().from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))).toEqual([])
    expect(tasks.hasRunning(chatId)).toBe(false)
  })

  it('a child that throws ends failed; one without a final output ends failed', async () => {
    const chatId = await newChat()
    let call = 0
    const tasks = createBackgroundTasks(t.deps, recordingHost(), {
      runChild: (input) => {
        call += 1
        const first = call === 1
        return (async function* () {
          yield snapshot(input, 'running')
          if (first)
            throw new Error('child bug')
        })()
      },
    })
    const thrown = (await tasks.launch(launchInput(chatId))).taskId!
    expect(await ended(thrown)).toMatchObject({ status: 'failed', output: { error: BACKGROUND_FAILED_TEXT } })
    const silent = (await tasks.launch(launchInput(chatId))).taskId!
    expect(await ended(silent)).toMatchObject({ status: 'failed', output: { error: BACKGROUND_NO_RESULT_TEXT } })
  })

  it('the deadline (fake timers) ends a task as limit; the child keeps its own limit text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chatId = await newChat()
    const { tasks, kids } = manager()
    const taskId = (await tasks.launch(launchInput(chatId))).taskId!
    const child = await kids.started(1)
    await vi.advanceTimersByTimeAsync(LIMITS.backgroundTaskTimeoutMs - 1)
    expect(child.input.deadline?.aborted).toBe(false)
    expect(child.input.session.ctx.run.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.input.deadline?.aborted).toBe(true)
    expect(child.input.session.ctx.run.signal.aborted).toBe(true)
    vi.useRealTimers()
    expect(await ended(taskId)).toMatchObject({ status: 'limit', output: { status: 'limit', report: 'partial', error: 'child deadline' } })

    // A child that ends at the deadline without a final output: the manager names the limit itself.
    let seen: DetachedChildInput | null = null
    const quietManager = createBackgroundTasks(t.deps, recordingHost(), {
      timeoutMs: 20,
      runChild: (input) => {
        seen = input
        return (async function* () {
          yield snapshot(input, 'running', { report: 'half way' })
          await new Promise(resolve => input.session.ctx.run.signal.addEventListener('abort', resolve, { once: true }))
        })()
      },
    })
    const quiet = (await quietManager.launch(launchInput(chatId))).taskId!
    expect(await ended(quiet)).toMatchObject({ status: 'limit', output: { status: 'limit', report: 'half way', error: backgroundDeadlineText(20) } })
    expect(seen!.deadline?.aborted).toBe(true)
    expect(backgroundDeadlineText(20)).toBe('The background agent reached its time limit (1 seconds).')
    expect(backgroundDeadlineText(LIMITS.backgroundTaskTimeoutMs)).toBe('The background agent reached its time limit (30 minutes).')
    await tasks.stopAll()
  })

  it('progress: at most one task.changed per second per task (the latest trails), plus every status change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = 10_000
    const chatId = await newChat()
    const { tasks, kids, host } = manager({ now: () => clock })
    host.held.add(chatId)
    const taskId = (await tasks.launch(launchInput(chatId))).taskId!
    const child = await kids.started(1)
    for (let step = 1; step <= 5; step += 1) {
      child.emit({ steps: [{ toolCallId: `c${step}`, toolName: 'current_time', summary: '', state: 'done' }] })
      clock += 100
      await vi.advanceTimersByTimeAsync(100)
    }
    // Launch event, then nothing more within the first second.
    expect(changes(taskId).map(task => task.output.steps.length)).toEqual([0])
    clock += 500
    await vi.advanceTimersByTimeAsync(500)
    // The trailing event carries the latest snapshot.
    expect(changes(taskId)).toHaveLength(2)
    expect(changes(taskId)[1]?.output.steps).toEqual([{ toolCallId: 'c5', toolName: 'current_time', summary: '', state: 'done' }])
    expect(changes(taskId)[1]?.status).toBe('running')
    // A snapshot after a quiet second goes out at once; the end goes out at once too.
    clock += 2000
    await vi.advanceTimersByTimeAsync(2000)
    child.emit({ report: 'half' })
    await vi.advanceTimersByTimeAsync(0)
    expect(changes(taskId)).toHaveLength(3)
    child.end({ report: REPORT_SECRET })
    vi.useRealTimers()
    const final = await ended(taskId)
    expect(changes(taskId)).toHaveLength(4)
    expect(final).toMatchObject({ status: 'completed', output: { report: REPORT_SECRET } })
    // The row is written at the start and the end only: progress stays in memory.
    expect(await rowOf(taskId)).toMatchObject({ status: 'completed', output: { report: REPORT_SECRET } })
    await tasks.stopAll()
  })

  it('the extra costs of the child (its usage row and summaries) count toward the output cost', async () => {
    const chatId = await newChat()
    const { tasks, kids } = manager()
    const taskId = (await tasks.launch(launchInput(chatId))).taskId!
    const child = await kids.started(1)
    child.input.session.addExtraCost(0.25)
    child.input.session.addExtraCost(0.5)
    child.input.session.addExtraCost(Number.NaN)
    child.end({ costUsd: 0.25 })
    expect(await ended(taskId)).toMatchObject({ output: { costUsd: 0.75 } })
  })

  it('rows are pruned per chat to the kept count (the oldest delivered ones; undelivered rows stay)', async () => {
    const chatId = await newChat()
    let clock = 1000
    const { tasks, kids, host } = manager({ keptPerChat: 2, now: () => (clock += 10) })
    host.held.add(chatId)
    const ids: string[] = []
    for (let n = 1; n <= 3; n += 1) {
      ids.push((await tasks.launch(launchInput(chatId, { toolCallId: `call_${n}` }))).taskId!)
      ;(await kids.started(n)).end()
      await ended(ids.at(-1)!)
    }
    // Nothing delivered yet: every row stays.
    expect(await t.db.select().from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))).toHaveLength(3)
    expect(tasks.takeResults(chatId, 'msg_bbbbbbbbbbbbbbbb').map(result => result.taskId)).toEqual(ids)
    ids.push((await tasks.launch(launchInput(chatId, { toolCallId: 'call_4' }))).taskId!)
    await vi.waitFor(async () => {
      const left = await t.db.select({ id: backgroundTasks.id }).from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))
      expect(left.map(row => row.id).sort()).toEqual([ids[2], ids[3]].sort())
    })
    expect((await tasks.list(chatId)).map(task => task.id)).toEqual([ids[3], ids[2]])
    await tasks.stopAll()
  })
})

// ---------- delivery ----------

describe('delivery', () => {
  async function finishedTask(h: Harness, chatId: string, overrides: Partial<BackgroundLaunchInput> = {}, end: Parameters<Child['end']>[0] = {}): Promise<string> {
    const before = h.kids.list.length
    const taskId = (await h.tasks.launch(launchInput(chatId, overrides))).taskId!
    ;(await h.kids.started(before + 1)).end(end)
    await ended(taskId)
    return taskId
  }

  it('takeResults removes the inbox once, oldest first, and records delivered_at / delivered_message_id', async () => {
    const chatId = await newChat()
    let clock = 70_000
    const h = manager({ now: () => clock })
    h.host.held.add(chatId)
    const first = await finishedTask(h, chatId, { toolCallId: 'call_a' }, { report: 'first' })
    clock += 1000
    const second = await finishedTask(h, chatId, { toolCallId: 'call_b' }, { status: 'failed', error: 'boom' })
    clock = 77_000
    expect(h.host.turns).toEqual([])
    const results = h.tasks.takeResults(chatId, 'msg_cccccccccccccccc')
    expect(results.map(result => taskResultDataSchema.parse(result))).toMatchObject([
      { taskId: first, toolCallId: 'call_a', messageId: 'msg_aaaaaaaaaaaaaaaa', output: { status: 'completed', report: 'first' }, deliveredAt: 77_000 },
      { taskId: second, toolCallId: 'call_b', output: { status: 'failed', error: 'boom' }, deliveredAt: 77_000 },
    ])
    expect(h.tasks.takeResults(chatId, 'msg_dddddddddddddddd')).toEqual([])
    expect(changes(first).at(-1)).toMatchObject({ deliveredAt: 77_000, deliveredMessageId: 'msg_cccccccccccccccc' })
    const listed = await h.tasks.list(chatId)
    expect(listed.map(task => [task.id, task.deliveredMessageId])).toEqual([[second, 'msg_cccccccccccccccc'], [first, 'msg_cccccccccccccccc']])
    expect(await rowOf(first)).toMatchObject({ deliveredAt: 77_000, deliveredMessageId: 'msg_cccccccccccccccc' })
  })

  it('an idle chat after a natural ending gets a task turn: a user-role carrier of data-task-result parts', async () => {
    const chatId = await newChat({ toolMode: 'edits' }, 'mock:background')
    const h = manager({ now: () => 88_000 })
    const taskId = await finishedTask(h, chatId, { reasoningEffort: 'low' }, { report: REPORT_SECRET })
    await vi.waitFor(() => expect(h.host.turns).toHaveLength(1))
    const { body, options } = h.host.turns[0]!
    expect(body).toMatchObject({ chatId, trigger: 'submit-message', modelRef: 'mock:background', toolMode: 'edits', reasoningEffort: 'low' })
    expect(body.parentId).toBeUndefined()
    expect(body.message.role).toBe('user')
    expect(body.message.id).toMatch(/^msg_/)
    expect(body.message.parts).toEqual([{ type: 'data-task-result', data: { taskId, toolCallId: 'call_1', messageId: 'msg_aaaaaaaaaaaaaaaa', output: expect.objectContaining({ status: 'completed', report: REPORT_SECRET }), deliveredAt: 88_000 } }])
    expect(options.requestId).toMatch(/^task_/)
    await vi.waitFor(async () => expect(await rowOf(taskId)).toMatchObject({ deliveredAt: 88_000, deliveredMessageId: body.message.id }))
    // Delivered once: nothing is left to take.
    expect(h.tasks.takeResults(chatId, 'msg_eeeeeeeeeeeeeeee')).toEqual([])
    expect(carrierMessage([], 'msg_ffffffffffffffff')).toEqual({ id: 'msg_ffffffffffffffff', role: 'user', parts: [] })
  })

  it('the turn takes the chat settings, else the launching run, else the defaults', async () => {
    const chatId = await newChat({}, 'mock:echo')
    const h = manager()
    await finishedTask(h, chatId, { toolMode: 'plan', reasoningEffort: 'medium' })
    await vi.waitFor(() => expect(h.host.turns).toHaveLength(1))
    expect(h.host.turns[0]!.body).toMatchObject({ modelRef: 'mock:echo', toolMode: 'plan', reasoningEffort: 'medium' })
  })

  it('no automatic turn while a run holds the chat, an approval is pending, runs are blocked or the model makes images', async () => {
    const h = manager()
    // A run holds the chat: its step boundaries take the result.
    const held = await newChat()
    h.host.held.add(held)
    const heldTask = await finishedTask(h, held)
    // A pending approval: its continuation's step 0 takes it.
    const waiting = await newChat()
    await t.deps.chats.touch(waiting, { pendingApproval: true })
    const waitingTask = await finishedTask(h, waiting)
    // An image chat model.
    const image = await newChat({}, 'mock:image')
    const imageTask = await finishedTask(h, image)
    // A maintenance operation that blocks runs.
    const blocked = await newChat()
    let release!: () => void
    const lock = t.deps.maintenance.exclusive('key-rotation', () => new Promise<void>((resolve) => {
      release = resolve
    }), { blockRuns: true })
    const blockedTask = await finishedTask(h, blocked)
    await new Promise(resolve => setTimeout(resolve, 30))
    release()
    await lock
    expect(h.host.turns).toEqual([])
    for (const [chatId, taskId] of [[held, heldTask], [waiting, waitingTask], [image, imageTask], [blocked, blockedTask]] as const)
      expect(h.tasks.takeResults(chatId, 'msg_1111111111111111').map(result => result.taskId)).toEqual([taskId])
  })

  it('chain depth 1: a task launched by a task turn, a stopped task and a result loaded at boot never start a turn', async () => {
    const h = manager()
    const chained = await newChat()
    const chainedTask = await finishedTask(h, chained, { origin: 'task' })
    const stopped = await newChat()
    const stoppedTask = (await h.tasks.launch(launchInput(stopped))).taskId!
    await h.kids.started(h.kids.list.length)
    expect(await h.tasks.stop(stopped, stoppedTask)).toMatchObject({ status: 'aborted' })
    h.tasks.onChatIdle(chained)
    h.tasks.onChatIdle(stopped)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.host.turns).toEqual([])
    // A later natural result of a request run starts a turn that carries every waiting result.
    const next = await finishedTask(h, chained, { origin: 'queue' })
    await vi.waitFor(() => expect(h.host.turns).toHaveLength(1))
    expect(h.host.turns[0]!.body.message.parts.map(part => (part.type === 'data-task-result' ? part.data.taskId : ''))).toEqual([chainedTask, next])
    expect(h.tasks.takeResults(stopped, 'msg_2222222222222222').map(result => result.taskId)).toEqual([stoppedTask])
  })

  it('a lost race (409 run-active) puts the results back at the head; another error keeps them for the next run', async () => {
    const h = manager()
    const chatId = await newChat()
    h.host.failures.push(runConflict(chatId))
    const first = await finishedTask(h, chatId)
    await vi.waitFor(async () => expect((await rowOf(first))?.status).toBe('completed'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.host.turns).toEqual([])
    // Still eligible: the next idle chat starts the turn with it first.
    h.host.held.add(chatId)
    const second = await finishedTask(h, chatId)
    h.host.held.delete(chatId)
    h.tasks.onChatIdle(chatId)
    await vi.waitFor(() => expect(h.host.turns).toHaveLength(1))
    expect(h.host.turns[0]!.body.message.parts.map(part => (part.type === 'data-task-result' ? part.data.taskId : ''))).toEqual([first, second])
    expect((await rowOf(first))?.deliveredAt).not.toBeNull()

    const other = await newChat()
    h.host.failures.push(new HarnessError({ code: 'provider_not_configured', message: 'No provider.' }))
    const kept = await finishedTask(h, other)
    await new Promise(resolve => setTimeout(resolve, 30))
    h.tasks.onChatIdle(other)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.host.turns).toHaveLength(1)
    expect((await rowOf(kept))?.deliveredAt).toBeNull()
    expect(t.logs.records.some(record => record.level === 'warn' && record.msg.includes('could not start a turn'))).toBe(true)
    expect(h.tasks.takeResults(other, 'msg_3333333333333333').map(result => result.taskId)).toEqual([kept])
  })

  it('onChatIdle starts a turn only for results that may start one (never twice)', async () => {
    const h = manager()
    const chatId = await newChat()
    h.host.held.add(chatId)
    const taskId = await finishedTask(h, chatId)
    h.host.held.delete(chatId)
    h.tasks.onChatIdle(chatId)
    h.tasks.onChatIdle(chatId)
    await vi.waitFor(() => expect(h.host.turns).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.host.turns).toHaveLength(1)
    expect(h.host.turns[0]!.body.message.parts).toHaveLength(1)
    expect((h.host.turns[0]!.body.message.parts[0] as { data: { taskId: string } }).data.taskId).toBe(taskId)
    h.tasks.onChatIdle(await newChat())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.host.turns).toHaveLength(1)
  })
})

// ---------- stops and boot ----------

describe('stopping', () => {
  it('stop aborts a running task, answers once its row is saved and never starts a turn; ended and foreign tasks', async () => {
    const h = manager()
    const chatId = await newChat()
    const taskId = (await h.tasks.launch(launchInput(chatId))).taskId!
    await h.kids.started(1)
    const stopped = await h.tasks.stop(chatId, taskId)
    expect(stopped).toMatchObject({ id: taskId, status: 'aborted', output: { status: 'aborted', report: 'partial', error: BACKGROUND_STOPPED_TEXT } })
    expect(await rowOf(taskId)).toMatchObject({ status: 'aborted' })
    expect(h.tasks.hasRunning(chatId)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.host.turns).toEqual([])
    // Ended: answered as it is; another chat or an unknown task: null.
    expect(await h.tasks.stop(chatId, taskId)).toMatchObject({ id: taskId, status: 'aborted' })
    expect(await h.tasks.stop(await newChat(), taskId)).toBeNull()
    expect(await h.tasks.stop(chatId, 'bgt_0000000000000000')).toBeNull()
    // The stopped result is delivered at the next run.
    expect(h.tasks.takeResults(chatId, 'msg_4444444444444444').map(result => result.output.status)).toEqual(['aborted'])
  })

  it('a child that ignores the stop is saved as it is after the wait', async () => {
    const h = manager({ stopWaitMs: 30 }, scriptedChildren({ ignoreAbort: true }))
    const chatId = await newChat()
    const taskId = (await h.tasks.launch(launchInput(chatId))).taskId!
    const child = await h.kids.started(1)
    child.emit({ report: 'so far' })
    await vi.waitFor(() => expect(child.input.session.ctx.run.signal.aborted).toBe(false))
    const stopped = await h.tasks.stop(chatId, taskId)
    expect(stopped).toMatchObject({ status: 'aborted', output: { error: BACKGROUND_STOPPED_TEXT } })
    expect(h.tasks.hasRunning(chatId)).toBe(false)
    // Late snapshots of the stuck child change nothing.
    child.end({ report: 'too late' })
    await child.closed
    expect(await rowOf(taskId)).toMatchObject({ status: 'aborted' })
  })

  it('stopChat aborts the chat\'s tasks, waits for their rows and drops the inbox; chat.deleted does the same', async () => {
    const h = manager()
    const chatId = await newChat()
    h.host.held.add(chatId)
    const done = (await h.tasks.launch(launchInput(chatId))).taskId!
    ;(await h.kids.started(1)).end()
    await ended(done)
    const runningIds = [(await h.tasks.launch(launchInput(chatId))).taskId!, (await h.tasks.launch(launchInput(chatId))).taskId!]
    const other = await newChat()
    const otherTask = (await h.tasks.launch(launchInput(other))).taskId!
    await h.kids.started(4)
    expect(await h.tasks.stopChat(chatId)).toBe(2)
    for (const id of runningIds)
      expect(await rowOf(id)).toMatchObject({ status: 'aborted', output: { error: BACKGROUND_STOPPED_TEXT } })
    expect(h.tasks.hasRunning(chatId)).toBe(false)
    expect(h.tasks.takeResults(chatId, 'msg_5555555555555555')).toEqual([])
    expect(h.tasks.hasRunning(other)).toBe(true)

    // `chat.deleted` (e.g. a task launched while the chat was deleted) stops the chat's tasks too.
    t.deps.events.emit('chat.deleted', { id: other })
    await vi.waitFor(() => expect(h.tasks.hasRunning(other)).toBe(false))
    expect(await rowOf(otherTask)).toMatchObject({ status: 'aborted' })
    await h.tasks.stopAll()
  })

  it('key.rotated stops every task and keeps the results for the next run', async () => {
    const h = manager()
    const a = await newChat()
    const b = await newChat()
    const taskA = (await h.tasks.launch(launchInput(a))).taskId!
    const taskB = (await h.tasks.launch(launchInput(b))).taskId!
    await h.kids.started(2)
    t.deps.events.emit('key.rotated', { keyVersion: 2, rotatedAt: 1, chatIds: [] })
    await vi.waitFor(() => expect(h.tasks.hasRunning(a) || h.tasks.hasRunning(b)).toBe(false))
    expect(await ended(taskA)).toMatchObject({ status: 'aborted' })
    expect(await ended(taskB)).toMatchObject({ status: 'aborted' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.host.turns).toEqual([])
    expect(h.tasks.takeResults(a, 'msg_6666666666666666').map(result => result.taskId)).toEqual([taskA])
    // Launches keep working after a rotation.
    expect((await h.tasks.launch(launchInput(a))).status).toBe('background')
    await h.tasks.stopAll()
  })

  it('stopAll aborts every task, waits for the rows and clears the inboxes; idempotent; later launches fail', async () => {
    const h = manager()
    const chatId = await newChat()
    h.host.held.add(chatId)
    const finished = (await h.tasks.launch(launchInput(chatId))).taskId!
    ;(await h.kids.started(1)).end()
    await ended(finished)
    const live = (await h.tasks.launch(launchInput(chatId))).taskId!
    await h.kids.started(2)
    const subscribers = t.deps.events.subscriberCount()
    await Promise.all([h.tasks.stopAll(), h.tasks.stopAll()])
    await h.tasks.stopAll()
    expect(await rowOf(live)).toMatchObject({ status: 'aborted', output: { error: BACKGROUND_STOPPED_TEXT } })
    expect(t.deps.events.subscriberCount()).toBe(subscribers - 1)
    expect(h.tasks.takeResults(chatId, 'msg_7777777777777777')).toEqual([])
    expect(await h.tasks.launch(launchInput(chatId))).toMatchObject({ status: 'failed', error: BACKGROUND_SHUTDOWN_TEXT })
    h.host.held.delete(chatId)
    h.tasks.onChatIdle(chatId)
    expect(h.host.turns).toEqual([])
  })

  it('holds an event subscription only while a task runs', async () => {
    const base = t.deps.events.subscriberCount()
    const h = manager()
    const chatId = await newChat()
    expect(t.deps.events.subscriberCount()).toBe(base)
    const taskId = (await h.tasks.launch(launchInput(chatId))).taskId!
    expect(t.deps.events.subscriberCount()).toBe(base + 1)
    ;(await h.kids.started(1)).end()
    await ended(taskId)
    await vi.waitFor(() => expect(t.deps.events.subscriberCount()).toBe(base))
  })
})

describe('boot sweep', () => {
  it('turns running rows into aborted, fills the inbox with undelivered rows and starts no turn', async () => {
    const chatId = await newChat()
    const base = { chatId, messageId: 'msg_aaaaaaaaaaaaaaaa', toolCallId: 'call_1', type: 'explore', description: 'Look', origin: 'request' as const }
    const output = (status: TaskStatus): TaskOutput => ({ status, type: 'explore', description: 'Look', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: 'r', startedAt: 1 })
    await t.db.insert(backgroundTasks).values([
      { ...base, id: 'bgt_boot000000000001', status: 'running', output: output('running'), createdAt: 1 },
      { ...base, id: 'bgt_boot000000000002', status: 'completed', output: output('completed'), createdAt: 2, finishedAt: 3 },
      { ...base, id: 'bgt_boot000000000003', status: 'completed', output: output('completed'), createdAt: 4, finishedAt: 5, deliveredAt: 6, deliveredMessageId: 'msg_bbbbbbbbbbbbbbbb' },
    ])
    const h = manager({ now: () => 9000 })
    await h.tasks.start()
    expect(await rowOf('bgt_boot000000000001')).toMatchObject({ status: 'aborted', finishedAt: 9000, output: { status: 'aborted', error: BACKGROUND_RESTARTED_TEXT, report: 'r', finishedAt: 9000 } })
    expect(await rowOf('bgt_boot000000000002')).toMatchObject({ status: 'completed', deliveredAt: null })
    h.tasks.onChatIdle(chatId)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.host.turns).toEqual([])
    expect(h.tasks.hasRunning(chatId)).toBe(false)
    // Delivered at the chat's next run, oldest first; the delivered row is not taken again.
    expect(h.tasks.takeResults(chatId, 'msg_8888888888888888').map(result => [result.taskId, result.output.status])).toEqual([
      ['bgt_boot000000000001', 'aborted'],
      ['bgt_boot000000000002', 'completed'],
    ])
    // A second sweep finds nothing new.
    await h.tasks.start()
    expect(h.tasks.takeResults(chatId, 'msg_9999999999999999')).toEqual([])
  })
})

describe('texts and logs', () => {
  it('failedLaunchOutput and the contract texts', () => {
    const input = launchInput(testChatId(1))
    expect(failedLaunchOutput(input, 'At most 3 background agents run per chat.', 7)).toMatchObject({ status: 'failed', error: 'At most 3 background agents run per chat.', startedAt: 7, finishedAt: 7 })
    expect(BACKGROUND_STOPPED_TEXT).toBe('The background task was stopped.')
    expect(BACKGROUND_RESTARTED_TEXT).toBe('The server restarted before the task finished.')
    expect(createMessageId()).toMatch(/^msg_/)
  })

  it('prompts and reports are never logged', () => {
    const text = t.logs.text()
    expect(text).not.toContain(PROMPT_SECRET)
    expect(text).not.toContain(REPORT_SECRET)
  })
})
