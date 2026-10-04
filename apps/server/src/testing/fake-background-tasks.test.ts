// The fake background manager (Phase 10, C30-T8) follows the `BackgroundTasks` contract where callers can see it:
// launches (default and scripted), finish into the inbox, exactly-once delivery, stops, `task.changed`.
import type { TaskInput } from '@harness-forge/shared'
import type { BackgroundLaunchInput } from '../chat/background/types.ts'
import type { ResolvedModel } from '../providers/types.ts'
import { BACKGROUND_TASK_ID_PATTERN, backgroundTaskSchema, DEFAULT_SETTINGS, taskOutputSchema, taskResultDataSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { BACKGROUND_STOPPED_TEXT } from '../chat/background/types.ts'
import { createMemoryLogger } from '../logger.ts'
import { createFakeBackgroundTasks } from './fake-background-tasks.ts'
import { createRecordingEventBus } from './fakes.ts'

const CHAT = '0199a8f0-0000-7000-8000-00000000d001'
const OTHER = '0199a8f0-0000-7000-8000-00000000d002'
const TASK: TaskInput = { description: 'Look around', prompt: 'List the files.', type: 'reviewer', background: true }

function input(chatId = CHAT, toolCallId = 'call_1'): BackgroundLaunchInput {
  return {
    chatId,
    messageId: 'msg_aaaaaaaaaaaaaaaa',
    toolCallId,
    task: TASK,
    origin: 'request',
    model: { modelRef: 'mock:background' } as ResolvedModel,
    toolMode: 'auto',
    workspace: null,
    scope: null,
    settings: DEFAULT_SETTINGS,
    reasoningEffort: 'auto',
    chatInstructions: undefined,
    catalog: {} as BackgroundLaunchInput['catalog'],
    logger: createMemoryLogger().logger,
  }
}

describe('createFakeBackgroundTasks', () => {
  it('a launch creates a running task and answers { status: background, taskId } at once; task.changed is emitted', async () => {
    const events = createRecordingEventBus()
    let clock = 100
    const tasks = createFakeBackgroundTasks({ events, now: () => clock++ })
    const output = await tasks.launch(input())
    expect(taskOutputSchema.parse(output)).toEqual(output)
    expect(output).toMatchObject({ status: 'background', type: 'reviewer', description: 'Look around', modelRef: 'mock:background', report: '' })
    expect(output.taskId).toMatch(BACKGROUND_TASK_ID_PATTERN)
    const task = tasks.tasks.get(output.taskId!)!
    expect(backgroundTaskSchema.parse(task)).toEqual(task)
    expect(task).toMatchObject({ chatId: CHAT, messageId: 'msg_aaaaaaaaaaaaaaaa', toolCallId: 'call_1', origin: 'request', status: 'running', finishedAt: null, deliveredAt: null })
    expect(tasks.hasRunning(CHAT)).toBe(true)
    expect(tasks.hasRunning(OTHER)).toBe(false)
    expect(tasks.launches).toHaveLength(1)
    expect(events.ofType('task.changed').map(event => event.data.task.status)).toEqual(['running'])
  })

  it('scripted launches answer their output without a task (a cap); finish fills the inbox; takeResults delivers once', async () => {
    const tasks = createFakeBackgroundTasks({
      now: () => 7,
      launch: (_launch, index) => index === 1
        ? { status: 'failed', type: 'reviewer', description: 'Look around', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: '', startedAt: 7, finishedAt: 7, error: 'At most 3 background tasks per chat.' }
        : undefined,
    })
    const first = await tasks.launch(input())
    const capped = await tasks.launch(input(CHAT, 'call_2'))
    expect(capped).toMatchObject({ status: 'failed', error: 'At most 3 background tasks per chat.' })
    expect(tasks.tasks.size).toBe(1)

    const ended = tasks.finish(first.taskId!, { report: 'Found 3 files.' })
    expect(ended).toMatchObject({ status: 'completed', finishedAt: 7, output: { status: 'completed', report: 'Found 3 files.', finishedAt: 7 } })
    expect(tasks.hasRunning(CHAT)).toBe(false)
    expect(tasks.inbox.get(CHAT)).toEqual([first.taskId])

    const results = tasks.takeResults(CHAT, 'msg_bbbbbbbbbbbbbbbb')
    expect(results).toHaveLength(1)
    expect(taskResultDataSchema.parse(results[0])).toEqual(results[0])
    expect(results[0]).toMatchObject({ taskId: first.taskId, toolCallId: 'call_1', messageId: 'msg_aaaaaaaaaaaaaaaa', deliveredAt: 7, output: { report: 'Found 3 files.' } })
    expect(tasks.tasks.get(first.taskId!)).toMatchObject({ deliveredAt: 7, deliveredMessageId: 'msg_bbbbbbbbbbbbbbbb' })
    expect(tasks.takeResults(CHAT, 'msg_cccccccccccccccc')).toEqual([])
    expect(() => tasks.finish('bgt_AAAAAAAAAAAAAAAA')).toThrow('Unknown fake background task')
  })

  it('stop aborts a running task (its result still waits), answers an ended one as it is, null for another chat', async () => {
    const tasks = createFakeBackgroundTasks()
    const { taskId } = await tasks.launch(input())
    expect(await tasks.stop(OTHER, taskId!)).toBeNull()
    expect(await tasks.stop(CHAT, 'bgt_AAAAAAAAAAAAAAAA')).toBeNull()
    const stopped = await tasks.stop(CHAT, taskId!)
    expect(stopped).toMatchObject({ status: 'aborted', output: { status: 'aborted', error: BACKGROUND_STOPPED_TEXT } })
    expect(await tasks.stop(CHAT, taskId!)).toEqual(stopped)
    expect(tasks.inbox.get(CHAT)).toEqual([taskId])
    expect((await tasks.list(CHAT)).map(task => task.id)).toEqual([taskId])
  })

  it('stopChat aborts the running tasks of the chat and drops its inbox; stopAll every chat; list is newest first', async () => {
    const tasks = createFakeBackgroundTasks()
    const a = await tasks.launch(input(CHAT, 'call_a'))
    const b = await tasks.launch(input(CHAT, 'call_b'))
    const c = await tasks.launch(input(OTHER, 'call_c'))
    expect((await tasks.list(CHAT)).map(task => task.id)).toEqual([b.taskId, a.taskId])
    expect(await tasks.stopChat(CHAT)).toBe(2)
    expect(tasks.inbox.has(CHAT)).toBe(false)
    expect(await tasks.stopChat(CHAT)).toBe(0)
    await tasks.stopAll()
    expect(tasks.tasks.get(c.taskId!)?.status).toBe('aborted')
    expect(tasks.inbox.size).toBe(0)
    tasks.onChatIdle(CHAT)
    await tasks.start()
    expect(tasks.idle).toEqual([CHAT])
    expect(tasks.calls).toMatchObject({ launch: 3, stopChat: 2, stopAll: 1, onChatIdle: 1, start: 1, list: 1 })
  })
})
