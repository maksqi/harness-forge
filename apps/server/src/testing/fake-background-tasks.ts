// Test double of `BackgroundTasks` (Phase 10, C30-T8), so the sub-agent runner, the steer step, the chat routes and the
// project-busy guards can be tested without detached children:
//
//   const t = await createTestApp({ backgroundTasks: 'fake' })      // the runner's manager is this fake
//   const tasks = t.backgroundTasks as FakeBackgroundTasks            // or pass createFakeBackgroundTasks({ launch })
//   const output = await tasks.launch(input)                         // { status: 'background', taskId, ... }
//   tasks.finish(output.taskId!, { report: 'Done.' })                 // completed; the result waits in the inbox
//   tasks.takeResults(chatId, messageId)                              // [TaskResultData], delivered once
//
// Tasks live in memory (`tasks`, by id); nothing runs: a launch creates a `running` task (or answers the scripted
// output of `options.launch`), `finish` ends it and puts its result into the chat's inbox, `stop` / `stopChat` /
// `stopAll` abort running tasks with `BACKGROUND_STOPPED_TEXT` (their results go to the inbox too, as in the real
// manager; `stopChat` drops the chat's inbox). Every change emits `task.changed` on `options.events`. Every call is
// counted and the launch inputs and idle chats are recorded.
import type { BackgroundTask, BackgroundTaskStatus, TaskOutput, TaskResultData } from '@harness-forge/shared'
import type { BackgroundLaunchInput, BackgroundTasks } from '../chat/background/types.ts'
import type { EventBus } from '../services/events/types.ts'
import { createBackgroundTaskId } from '@harness-forge/shared'
import { BACKGROUND_STOPPED_TEXT } from '../chat/background/types.ts'

/** A final status of a task (`finish`). */
export type FakeTaskEnding = Exclude<BackgroundTaskStatus, 'running'>

export interface FakeBackgroundTasksOptions {
  /**
   * Scripts a launch: a `TaskOutput` is answered as is (no task is created, e.g. a `failed` cap); `'background'` or
   * undefined creates a running task (the default for every launch).
   */
  launch?: (input: BackgroundLaunchInput, index: number) => TaskOutput | 'background' | undefined
  /** Receives `task.changed` on every change (default: no events). */
  events?: Pick<EventBus, 'emit'>
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

/** How `finish` ends a task. */
export interface FakeTaskFinish {
  /** Default `completed`. */
  status?: FakeTaskEnding
  /** Default `''`. */
  report?: string
  /** The error of a `failed` / `aborted` / `limit` task. */
  error?: string
}

export interface FakeBackgroundTasks extends BackgroundTasks {
  /** Every task by id, in launch order; tests may add or edit entries (no event then). */
  readonly tasks: Map<string, BackgroundTask>
  /** The undelivered results of each chat (task ids, oldest first); tests may edit them. */
  readonly inbox: Map<string, string[]>
  /** Every `launch` input, in order. */
  readonly launches: BackgroundLaunchInput[]
  /** Chat ids passed to `onChatIdle`, in order. */
  readonly idle: string[]
  /** Number of calls of each member. */
  readonly calls: Record<keyof BackgroundTasks, number>
  /** Ends a running task (`completed` by default) and puts its result into the chat's inbox; throws for an unknown id. */
  readonly finish: (taskId: string, result?: FakeTaskFinish) => BackgroundTask
}

/** The `running` snapshot of a launched task. */
function runningOutput(input: BackgroundLaunchInput, startedAt: number): TaskOutput {
  return {
    status: 'running',
    type: input.task.type,
    description: input.task.description,
    modelRef: input.model.modelRef,
    steps: [],
    stepsOmitted: 0,
    report: '',
    startedAt,
  }
}

export function createFakeBackgroundTasks(options: FakeBackgroundTasksOptions = {}): FakeBackgroundTasks {
  const now = options.now ?? Date.now
  const tasks = new Map<string, BackgroundTask>()
  const inbox = new Map<string, string[]>()
  const launches: BackgroundLaunchInput[] = []
  const idle: string[] = []
  const calls: Record<keyof BackgroundTasks, number> = {
    launch: 0,
    takeResults: 0,
    onChatIdle: 0,
    list: 0,
    stop: 0,
    stopChat: 0,
    hasRunning: 0,
    start: 0,
    stopAll: 0,
  }

  function save(task: BackgroundTask): BackgroundTask {
    tasks.set(task.id, task)
    options.events?.emit('task.changed', { chatId: task.chatId, task })
    return task
  }

  function end(task: BackgroundTask, result: FakeTaskFinish): BackgroundTask {
    const status = result.status ?? 'completed'
    const finishedAt = now()
    const output: TaskOutput = {
      ...task.output,
      status,
      report: result.report ?? task.output.report,
      finishedAt,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
    const ended = save({ ...task, status, output, finishedAt })
    inbox.set(task.chatId, [...(inbox.get(task.chatId) ?? []), task.id])
    return ended
  }

  const running = (chatId: string): BackgroundTask[] => [...tasks.values()].filter(task => task.chatId === chatId && task.status === 'running')

  return {
    tasks,
    inbox,
    launches,
    idle,
    calls,
    finish: (taskId, result = {}) => {
      const task = tasks.get(taskId)
      if (task === undefined)
        throw new Error(`Unknown fake background task ${taskId}.`)
      return end(task, result)
    },
    launch: async (input) => {
      calls.launch += 1
      launches.push(input)
      const scripted = options.launch?.(input, launches.length - 1)
      if (scripted !== undefined && scripted !== 'background')
        return scripted
      const createdAt = now()
      const task = save({
        id: createBackgroundTaskId(),
        chatId: input.chatId,
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        origin: input.origin,
        status: 'running',
        output: runningOutput(input, createdAt),
        createdAt,
        finishedAt: null,
        deliveredAt: null,
        deliveredMessageId: null,
      })
      return { ...runningOutput(input, createdAt), status: 'background', taskId: task.id }
    },
    takeResults: (chatId, messageId) => {
      calls.takeResults += 1
      const ids = inbox.get(chatId) ?? []
      inbox.delete(chatId)
      const deliveredAt = now()
      return ids.flatMap((id): TaskResultData[] => {
        const task = tasks.get(id)
        if (task === undefined || task.deliveredAt !== null)
          return []
        save({ ...task, deliveredAt, deliveredMessageId: messageId })
        return [{ taskId: task.id, toolCallId: task.toolCallId, messageId: task.messageId, output: task.output, deliveredAt }]
      })
    },
    onChatIdle: (chatId) => {
      calls.onChatIdle += 1
      idle.push(chatId)
    },
    list: async (chatId) => {
      calls.list += 1
      return [...tasks.values()].filter(task => task.chatId === chatId).reverse()
    },
    stop: async (chatId, taskId) => {
      calls.stop += 1
      const task = tasks.get(taskId)
      if (task === undefined || task.chatId !== chatId)
        return null
      return task.status === 'running' ? end(task, { status: 'aborted', error: BACKGROUND_STOPPED_TEXT }) : task
    },
    stopChat: async (chatId) => {
      calls.stopChat += 1
      const stopped = running(chatId)
      for (const task of stopped)
        end(task, { status: 'aborted', error: BACKGROUND_STOPPED_TEXT })
      inbox.delete(chatId)
      return stopped.length
    },
    hasRunning: (chatId) => {
      calls.hasRunning += 1
      return running(chatId).length > 0
    },
    start: async () => {
      calls.start += 1
    },
    stopAll: async () => {
      calls.stopAll += 1
      for (const task of [...tasks.values()].filter(entry => entry.status === 'running'))
        end(task, { status: 'aborted', error: BACKGROUND_STOPPED_TEXT })
      inbox.clear()
    },
  }
}
