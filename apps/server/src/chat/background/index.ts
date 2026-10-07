import type { Disposable } from '@harness-forge/plugin-sdk'
// Background sub-agents (Phase 10, ADR-046; ARCHITECTURE.md 6.26, API.md 4.29 / 5.30 / 6.10): the per-runner manager
// behind `BackgroundTasks` (./types.ts), W10.4.
//
// - Launch (`launch`, called by the sub-agent runner for `task { background: true }`): the caps first (running tasks:
//   `LIMITS.backgroundTasksPerChatMax` per chat, `LIMITS.backgroundTasksMax` per server; past one the call ends `failed`
//   naming it), then the row (`bgt_` id, `running`, the launching run's origin) and the detached child: a
//   `createDetachedSession` host (`subagent/host.ts`) under the task's own signal (its Stop and the
//   `LIMITS.backgroundTaskTimeoutMs` deadline; never the run's signal or the 600 s tool guard) run by
//   `runDetachedChild` (`subagent/index.ts`, W10.3; `subagentMaxSteps` applies there). The launch answers at once with
//   `{ status: 'background', taskId }`. The slot is taken synchronously, so concurrent launches respect the caps.
// - Progress: the child's snapshots stay in memory (the row is written at the start and at the end) and go out as
//   `task.changed` at most once per `BACKGROUND_PROGRESS_INTERVAL_MS` per task (the latest one trails) plus at every
//   status change. The child's extra costs (`onExtraCost`) count toward the output's `costUsd` (one usage row per child,
//   purpose `subagent`, under the launching message: the child writes it).
// - The end: the final status (`completed`, `failed`, `limit` (the step limit or the deadline) or `aborted`) and output
//   are saved, then the result joins the chat's in-memory inbox and, after a natural ending (`completed`, `failed`,
//   `limit`), `deliver(chatId)` runs:
//   - a run holds the chat → nothing: the steer step takes the inbox at its next step boundary (`takeResults`) or the
//     run's release calls `onChatIdle`;
//   - else, when a result of the inbox may start a turn (a natural ending of a task launched by a `request` / `queue`
//     run: chain depth 1; never a stopped task, never one loaded at boot), no approval is pending, no maintenance
//     operation blocks runs and the chat's model is not an image model: the whole inbox is taken synchronously and
//     `host.startTaskTurn` starts a turn with `origin: 'task'` whose user-role carrier message holds one
//     `data-task-result` part per result; a lost race (`409 run-active`) puts the results back at the head of the inbox
//     (they may start a turn again), any other failure keeps them for the chat's next run (a warning);
//   - otherwise the results wait for the chat's next run (its step 0).
//   Each result is delivered exactly once: the take is synchronous and the row records `delivered_at` and
//   `delivered_message_id` (the reply or the carrier that holds the part).
// - Stopping: `stop` (the task's Stop route), `stopChat` (chat delete, delete-all, `chat.deleted`), a key rotation
//   (`key.rotated`: every task; the inboxes are kept) and shutdown (`stopAll`) abort the child (`aborted`, "The background
//   task was stopped."; the partial report kept) and wait until the row is saved (a child that does not end within
//   `BACKGROUND_STOP_WAIT_MS` is saved as it is). A stopped task's result is delivered at the chat's next run, never by
//   an automatic turn; `stopChat` and shutdown drop the results. The chat's own Stop never reaches this manager.
// - Boot (`start`, `ChatRunner.boot()`): rows still `running` become `aborted` ("The server restarted before the task
//   finished."), undelivered rows fill the inboxes (delivered at each chat's next run; no turn is started from them).
// - Rows are pruned per chat to `LIMITS.backgroundTasksKeptPerChat` (the oldest delivered ones, when a task starts).
// Prompts and reports are never logged (ids, types, statuses and counts only). Timers are `unref()`-ed.
// Phase 11 (ADR-048, W11.2): a launch takes one hook snapshot of the launching chat's scope (the launching run's project
// folder, mode, origin and model) and gives the detached host `detachedHooks(…)` over it: the child runs `PreToolUse`
// (an `ask` is denied), `PostToolUse` and `SubagentStop` (a block continues it, `subagent/index.ts`) like a foreground
// child; nothing of it is stored. A snapshot that cannot be taken runs the child without hooks (logged unless the task
// was stopped meanwhile). W11.17 (ADR-050): the launching run's project MCP result (`input.projectTools`) goes to the
// child's tool assembly (the shadowed global servers hidden, the project server tools under the child ceiling) and its
// server names to the task's hook matchers.
// Phase 12 (W12.6, ADR-057 / ADR-058): the detached child is the same child as a foreground one (`runDetachedChild`):
// `SubagentStart` before its step 0 (the context in its first user message), `SubagentStop` with its agent, and the
// agent keys of its definition (`maxTurns`, the `skills` preload from the launching run's catalog, `disallowedTools`, a
// Claude model name through `modelAliases`).
import type { BackgroundTask, BackgroundTaskStatus, ChatRequestBody, HarnessUIMessage, ReasoningEffort, TaskOutput, TaskResultData, ToolMode } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { ChildHooksSource } from '../hooks.ts'
import type { DetachedChildInput } from '../subagent/index.ts'
import type { BackgroundLaunchInput, BackgroundTasks, BackgroundTasksHost } from './types.ts'
import { AGENT_TYPE_ALIASES, createBackgroundTaskId, createMessageId, isHarnessError, LIMITS, safeParseModelRef } from '@harness-forge/shared'
import { abortReason } from '../errors.ts'
import { detachedHooks, hookMcpServerNames } from '../hooks.ts'
import { createDetachedSession } from '../subagent/host.ts'
import { runDetachedChild } from '../subagent/index.ts'
import { roundUsd } from '../usage.ts'
import {
  endedOutput,
  findTaskRow,
  insertTaskRow,
  listTaskRows,
  pruneTaskRows,
  runningTaskRows,
  saveTaskDelivery,
  saveTaskEnd,
  undeliveredTaskRows,
} from './store.ts'
import { BACKGROUND_RESTARTED_TEXT, BACKGROUND_STOPPED_TEXT } from './types.ts'

export { BACKGROUND_UNAVAILABLE_TEXT } from './types.ts'

/** At most one progress `task.changed` per task in this interval (status changes are sent at once). */
export const BACKGROUND_PROGRESS_INTERVAL_MS = 1000

/** How long a stop waits for a child to end before its row is saved as it is (shutdown: the whole wait). */
export const BACKGROUND_STOP_WAIT_MS = 5000

/** The error of a launch while the server shuts down. */
export const BACKGROUND_SHUTDOWN_TEXT = 'The server is shutting down.'

/** The error of a child that threw (a bug: `runDetachedChild` never throws for a failed child). */
export const BACKGROUND_FAILED_TEXT = 'The background agent failed.'

/** The error of a child that ended without a final output. */
export const BACKGROUND_NO_RESULT_TEXT = 'The background agent ended without a result.'

/** The error of a launch past the per-chat cap. */
export function perChatLimitText(max: number): string {
  return `At most ${max} background agents run per chat. Wait for one to finish.`
}

/** The error of a launch past the per-server cap. */
export function serverLimitText(max: number): string {
  return `At most ${max} background agents run on this server. Wait for one to finish.`
}

/** The error of a task its deadline ended. */
export function backgroundDeadlineText(timeoutMs: number): string {
  return timeoutMs >= 60_000
    ? `The background agent reached its time limit (${Math.round(timeoutMs / 60_000)} minutes).`
    : `The background agent reached its time limit (${Math.max(1, Math.round(timeoutMs / 1000))} seconds).`
}

/** Runs one detached child (`runDetachedChild` by default; tests pass a fake). */
export type DetachedChildRunner = (input: DetachedChildInput) => AsyncIterable<TaskOutput>

/** Test and wiring options of the manager (all optional; the defaults are the `LIMITS` values). */
export interface BackgroundTasksOptions {
  /** The clock (epoch ms); default `Date.now`. */
  readonly now?: () => number
  /** Runs a detached child (default `runDetachedChild`, W10.3). */
  readonly runChild?: DetachedChildRunner
  /** Running tasks per chat (`LIMITS.backgroundTasksPerChatMax`). */
  readonly perChatMax?: number
  /** Running tasks per server (`LIMITS.backgroundTasksMax`). */
  readonly serverMax?: number
  /** Deadline of one task (`LIMITS.backgroundTaskTimeoutMs`). */
  readonly timeoutMs?: number
  /** Rows kept per chat (`LIMITS.backgroundTasksKeptPerChat`). */
  readonly keptPerChat?: number
  /** Interval of progress events per task (`BACKGROUND_PROGRESS_INTERVAL_MS`). */
  readonly progressIntervalMs?: number
  /** How long a stop waits for a child (`BACKGROUND_STOP_WAIT_MS`). */
  readonly stopWaitMs?: number
}

/** The `failed` output of a launch that cannot run (`error` = why), with the call's description and type. */
export function failedLaunchOutput(input: BackgroundLaunchInput, error: string, now: number): TaskOutput {
  return {
    status: 'failed',
    type: input.task.type,
    description: input.task.description,
    modelRef: input.model.modelRef,
    steps: [],
    stepsOmitted: 0,
    report: '',
    startedAt: now,
    finishedAt: now,
    error,
  }
}

/** The `data-task-result` data of a finished task delivered at `deliveredAt`. */
export function taskResultOf(task: BackgroundTask, deliveredAt: number): TaskResultData {
  return { taskId: task.id, toolCallId: task.toolCallId, messageId: task.messageId, output: task.output, deliveredAt }
}

/** The user-role carrier message of a server-started `task` turn: one `data-task-result` part per result, nothing else. */
export function carrierMessage(results: readonly TaskResultData[], id: string = createMessageId()): HarnessUIMessage {
  return { id, role: 'user', parts: results.map(data => ({ type: 'data-task-result' as const, data })) }
}

let taskRequestCounter = 0

/** The request id of a turn the server starts for finished background tasks (`task_…`). */
export function taskRequestId(): string {
  taskRequestCounter += 1
  return `task_${Date.now().toString(36)}_${taskRequestCounter.toString(36)}`
}

/** Who stopped a task: its Stop, a chat delete (or delete-all), a key rotation, shutdown. */
type StopCause = 'stop' | 'chat' | 'rotation' | 'shutdown'

/** A task whose child runs (until its row is saved at the end). */
interface RunningTask {
  /** The latest state (status `running` and the latest snapshot; the final task once it ended). */
  task: BackgroundTask
  readonly controller: AbortController
  readonly deadline: AbortController
  deadlineTimer: ReturnType<typeof setTimeout> | null
  progressTimer: ReturnType<typeof setTimeout> | null
  lastEmitAt: number
  extraCostUsd: number
  stopCause: StopCause | null
  /** The end began (`finalize`): later snapshots are ignored. */
  ended: boolean
  readonly done: Promise<void>
  readonly resolveDone: () => void
  /** The launching run's mode and effort (a carrier turn's fallbacks). */
  readonly toolMode: ToolMode
  readonly reasoningEffort: ReasoningEffort
  readonly logger: Logger
}

/** A finished task whose result waits for delivery. */
interface InboxEntry {
  readonly task: BackgroundTask
  /** May start a turn (a natural ending of a task launched by a `request` / `queue` run; not loaded at boot). */
  autoTurn: boolean
  readonly toolMode?: ToolMode
  readonly reasoningEffort?: ReasoningEffort
}

const NATURAL_ENDINGS: ReadonlySet<BackgroundTaskStatus> = new Set(['completed', 'failed', 'limit'])
const FINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'limit', 'aborted'])

/** A snapshot of the task's child, stamped with the task id. */
function withTaskId(output: TaskOutput, taskId: string): TaskOutput {
  return output.taskId === taskId ? output : { ...output, taskId }
}

/** The output's error, cut to the schema's 2000 characters. */
function capError(output: TaskOutput): TaskOutput {
  return output.error !== undefined && output.error.length > 2000 ? { ...output, error: output.error.slice(0, 2000) } : output
}

function isRunActive(error: unknown): boolean {
  return isHarnessError(error) && error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'run-active'
}

/**
 * The background manager of one chat runner (created by `createChatRunnerWith`, `chat/index.ts`). `deps` and `host` are
 * read lazily (never while the manager is constructed).
 */
export function createBackgroundTasks(deps: AppDeps, host: BackgroundTasksHost, options: BackgroundTasksOptions = {}): BackgroundTasks {
  const now = options.now ?? Date.now
  const runChild = options.runChild ?? runDetachedChild
  const perChatMax = options.perChatMax ?? LIMITS.backgroundTasksPerChatMax
  const serverMax = options.serverMax ?? LIMITS.backgroundTasksMax
  const timeoutMs = options.timeoutMs ?? LIMITS.backgroundTaskTimeoutMs
  const keptPerChat = options.keptPerChat ?? LIMITS.backgroundTasksKeptPerChat
  const progressIntervalMs = options.progressIntervalMs ?? BACKGROUND_PROGRESS_INTERVAL_MS
  const stopWaitMs = options.stopWaitMs ?? BACKGROUND_STOP_WAIT_MS

  /** Running tasks by id. */
  const running = new Map<string, RunningTask>()
  /** Undelivered results by chat, oldest first. */
  const inboxes = new Map<string, InboxEntry[]>()
  /** Row writes still in flight, by chat (reads wait for them). */
  const writes = new Map<string, Set<Promise<void>>>()
  /** Chats whose delivery runs now, and those to try again once it ended. */
  const delivering = new Set<string>()
  const deliverAgain = new Set<string>()
  /** Chats whose tasks are being stopped for good (`stopChat`): no delivery starts meanwhile. */
  const stopping = new Set<string>()
  let subscription: Disposable | null = null
  let closed = false
  let stopAllDone: Promise<void> | null = null

  const log = (): Logger => deps.logger.child({ component: 'background-tasks' })

  // ---------- helpers ----------

  function runningOf(chatId: string): RunningTask[] {
    return [...running.values()].filter(entry => entry.task.chatId === chatId)
  }

  function emit(task: BackgroundTask): void {
    try {
      deps.events.emit('task.changed', { chatId: task.chatId, task })
    }
    catch (error) {
      log().warn('task.changed was not emitted', { taskId: task.id, err: error })
    }
  }

  /** Tracks a row write of the chat (reads of the chat wait for it); never rejects (a failure is logged). */
  function track(chatId: string, write: Promise<unknown>, what: string): Promise<void> {
    const set = writes.get(chatId) ?? new Set<Promise<void>>()
    writes.set(chatId, set)
    const tracked: Promise<void> = write.then(() => {}, (error: unknown) => {
      log().error(`background task row: ${what} failed`, { chatId, err: error })
    }).finally(() => {
      set.delete(tracked)
      if (set.size === 0 && writes.get(chatId) === set)
        writes.delete(chatId)
    })
    set.add(tracked)
    return tracked
  }

  async function writesOf(chatId: string): Promise<void> {
    const set = writes.get(chatId)
    if (set !== undefined && set.size > 0)
      await Promise.allSettled([...set])
  }

  async function allWrites(): Promise<void> {
    await Promise.allSettled([...writes.values()].flatMap(set => [...set]))
  }

  function inboxOf(chatId: string): InboxEntry[] {
    return inboxes.get(chatId) ?? []
  }

  /** Appends results to the chat's inbox (at most `LIMITS.backgroundTasksKeptPerChat`; the oldest drop out). */
  function pushInbox(chatId: string, entries: readonly InboxEntry[], atHead = false): void {
    const queued = new Set(inboxOf(chatId).map(entry => entry.task.id))
    const fresh = entries.filter(entry => !queued.has(entry.task.id))
    let next = atHead ? [...fresh, ...inboxOf(chatId)] : [...inboxOf(chatId), ...fresh]
    if (next.length > LIMITS.backgroundTasksKeptPerChat) {
      log().warn('too many undelivered background results; the oldest wait for a restart', { chatId, dropped: next.length - LIMITS.backgroundTasksKeptPerChat })
      next = next.slice(next.length - LIMITS.backgroundTasksKeptPerChat)
    }
    if (next.length === 0)
      inboxes.delete(chatId)
    else
      inboxes.set(chatId, next)
  }

  /** Marks taken results delivered into `messageId` at `deliveredAt`: `task.changed` now, the row in the background. */
  function markDelivered(entries: readonly InboxEntry[], deliveredAt: number, messageId: string): void {
    for (const entry of entries) {
      emit({ ...entry.task, deliveredAt, deliveredMessageId: messageId })
      void track(entry.task.chatId, saveTaskDelivery(deps.db, entry.task.id, deliveredAt, messageId), 'delivery')
    }
  }

  /**
   * Listens for chat deletions and key rotations only while a task runs (subscribed with the first running task,
   * disposed when the last one ended): an idle manager holds no subscription.
   */
  function ensureSubscribed(): void {
    if (subscription !== null || closed)
      return
    subscription = deps.events.subscribe((event) => {
      if (event.type === 'chat.deleted') {
        stopChat(event.data.id).catch((error: unknown) => log().warn('cannot stop the background tasks of a deleted chat', { chatId: event.data.id, err: error }))
      }
      else if (event.type === 'key.rotated') {
        stopEvery('rotation').catch((error: unknown) => log().warn('cannot stop the background tasks after a key rotation', { err: error }))
      }
    })
  }

  function unsubscribeWhenIdle(): void {
    if (running.size > 0 || subscription === null)
      return
    subscription.dispose()
    subscription = null
  }

  // ---------- the run of a task ----------

  function abortTask(entry: RunningTask, cause: StopCause): void {
    if (!entry.ended && entry.stopCause === null)
      entry.stopCause = cause
    if (!entry.controller.signal.aborted)
      entry.controller.abort(abortReason(BACKGROUND_STOPPED_TEXT))
  }

  /** Emits the latest snapshot of a running task, at most once per interval (the latest one trails). */
  function progress(entry: RunningTask, snapshot: TaskOutput): void {
    if (entry.ended)
      return
    entry.task = { ...entry.task, output: withTaskId(snapshot, entry.task.id) }
    if (entry.progressTimer !== null)
      return
    const elapsed = now() - entry.lastEmitAt
    if (elapsed >= progressIntervalMs) {
      entry.lastEmitAt = now()
      emit(entry.task)
      return
    }
    entry.progressTimer = setTimeout(() => {
      entry.progressTimer = null
      if (entry.ended)
        return
      entry.lastEmitAt = now()
      emit(entry.task)
    }, progressIntervalMs - elapsed)
    entry.progressTimer.unref?.()
  }

  /** How a task ended: our stop wins, then the deadline, then the child's own final status. */
  function endingOf(entry: RunningTask, last: TaskOutput, failure: unknown): { status: BackgroundTaskStatus, error?: string } {
    if (entry.stopCause !== null)
      return { status: 'aborted', error: BACKGROUND_STOPPED_TEXT }
    if (entry.deadline.signal.aborted) {
      if (last.status === 'completed' || last.status === 'limit')
        return { status: last.status }
      return { status: 'limit', error: backgroundDeadlineText(timeoutMs) }
    }
    if (failure !== null)
      return { status: 'failed', error: BACKGROUND_FAILED_TEXT }
    if (FINAL_STATUSES.has(last.status))
      return { status: last.status as BackgroundTaskStatus }
    return { status: 'failed', error: BACKGROUND_NO_RESULT_TEXT }
  }

  /** The end of a task (once): the row saved, `task.changed`, the result into the inbox, then the delivery. */
  async function finalize(entry: RunningTask, last: TaskOutput, failure: unknown): Promise<void> {
    if (entry.ended)
      return entry.done
    entry.ended = true
    if (entry.deadlineTimer !== null)
      clearTimeout(entry.deadlineTimer)
    if (entry.progressTimer !== null)
      clearTimeout(entry.progressTimer)
    entry.deadlineTimer = null
    entry.progressTimer = null
    const { chatId } = entry.task
    try {
      const finishedAt = now()
      const ending = endingOf(entry, last, failure)
      let output = capError(endedOutput(withTaskId(last, entry.task.id), ending.status, finishedAt, ending.error))
      if (entry.extraCostUsd > (output.costUsd ?? 0))
        output = { ...output, costUsd: roundUsd(entry.extraCostUsd) }
      const task: BackgroundTask = { ...entry.task, status: ending.status, output, finishedAt }
      entry.task = task
      await track(chatId, saveTaskEnd(deps.db, task), 'end')
      running.delete(task.id)
      emit(task)
      entry.logger.info('background agent ended', { status: task.status, steps: output.steps.length + output.stepsOmitted, cause: entry.stopCause })
      // A deleted chat and shutdown drop the result; every other ending waits in the inbox.
      if (entry.stopCause === 'chat' || entry.stopCause === 'shutdown' || closed)
        return
      const natural = entry.stopCause === null && NATURAL_ENDINGS.has(task.status)
      pushInbox(chatId, [{ task, autoTurn: natural && task.origin !== 'task', toolMode: entry.toolMode, reasoningEffort: entry.reasoningEffort }])
      if (natural)
        deliver(chatId)
    }
    finally {
      running.delete(entry.task.id)
      unsubscribeWhenIdle()
      entry.resolveDone()
    }
  }

  /** Iterates the child; every snapshot is progress, the last one the final output. */
  async function drive(entry: RunningTask, child: AsyncIterable<TaskOutput>): Promise<void> {
    let last = entry.task.output
    let failure: unknown = null
    try {
      for await (const snapshot of child) {
        if (entry.ended)
          break
        last = snapshot
        progress(entry, snapshot)
      }
    }
    catch (error) {
      if (!entry.ended) {
        failure = error
        entry.logger.warn('a background agent threw', { ...(isHarnessError(error) ? { code: error.code } : {}) })
      }
    }
    await finalize(entry, last, failure)
  }

  /** Waits until a stopped task saved its row; a child that does not end within the wait is saved as it is. */
  async function settle(entry: RunningTask, waitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      entry.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, waitMs, false)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    if (!settled) {
      entry.logger.warn('a background agent did not end after a stop; its row is saved as it is')
      await finalize(entry, entry.task.output, null)
    }
  }

  // ---------- delivery ----------

  /** The chat's inbox may start a turn now (checked again synchronously right before the start). */
  function mayStartTurn(chatId: string): boolean {
    if (closed || stopping.has(chatId) || !inboxOf(chatId).some(entry => entry.autoTurn))
      return false
    if (host.hasRun(chatId))
      return false
    const operation = deps.maintenance.current()
    return operation === null || !operation.blockRuns
  }

  async function isImageModel(modelRef: string): Promise<boolean> {
    const parts = safeParseModelRef(modelRef)
    if (parts === null)
      return false
    const entry = await deps.catalog.get(parts.providerId, parts.modelId).catch(() => null)
    return entry?.kind === 'image'
  }

  /** The newest value of the inbox entries (the launching runs' mode or effort). */
  function newest<K extends 'toolMode' | 'reasoningEffort'>(entries: readonly InboxEntry[], key: K): InboxEntry[K] {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const value = entries[index]?.[key]
      if (value !== undefined)
        return value
    }
    return undefined
  }

  /** Starts a `task` turn for the chat's inbox when the rules allow it (see the module comment). */
  async function attemptDelivery(chatId: string): Promise<void> {
    if (!mayStartTurn(chatId))
      return
    const chat = await deps.chats.find(chatId)
    if (chat === null) {
      inboxes.delete(chatId)
      return
    }
    // A pending approval: the results wait for its continuation (step 0).
    if (chat.pendingApproval)
      return
    const settings = await deps.settings.get()
    const modelRef = chat.modelRef ?? settings.defaultModelRef
    if (modelRef === null || await isImageModel(modelRef))
      return
    // Synchronous from here: the take and the start (which acquires the chat before its first await).
    if (!mayStartTurn(chatId))
      return
    const taken = inboxOf(chatId)
    inboxes.delete(chatId)
    const deliveredAt = now()
    const message = carrierMessage(taken.map(entry => taskResultOf(entry.task, deliveredAt)))
    const body: ChatRequestBody = {
      chatId,
      message,
      trigger: 'submit-message',
      modelRef,
      reasoningEffort: chat.settings.reasoningEffort ?? newest(taken, 'reasoningEffort') ?? settings.defaultReasoningEffort,
      toolMode: chat.settings.toolMode ?? newest(taken, 'toolMode') ?? settings.defaultToolMode,
    }
    const requestId = taskRequestId()
    const logger = deps.logger.child({ reqId: requestId, chatId })
    let response: Response
    try {
      response = await host.startTaskTurn(body, { logger, requestId })
    }
    catch (error) {
      if (isRunActive(error)) {
        // A request won the chat: back to the head of the inbox (that run's step boundaries take them).
        logger.debug('a task turn lost the chat to another request; the results go back to the inbox', { count: taken.length })
        pushInbox(chatId, taken, true)
      }
      else {
        logger.warn('finished background agents could not start a turn; their results wait for the next run', {
          count: taken.length,
          code: isHarnessError(error) ? error.code : 'internal_error',
        })
        pushInbox(chatId, taken.map(entry => ({ ...entry, autoTurn: false })), true)
      }
      return
    }
    markDelivered(taken, deliveredAt, message.id)
    logger.info('a turn started for finished background agents', { count: taken.length, userMessageId: message.id })
    await response.body?.cancel().catch(() => {})
  }

  function deliver(chatId: string): void {
    if (closed)
      return
    if (delivering.has(chatId)) {
      deliverAgain.add(chatId)
      return
    }
    delivering.add(chatId)
    attemptDelivery(chatId)
      .catch((error: unknown) => log().warn('the delivery of background results failed', { chatId, err: error }))
      .finally(() => {
        delivering.delete(chatId)
        if (deliverAgain.delete(chatId))
          deliver(chatId)
      })
  }

  // ---------- stopping ----------

  async function stopChat(chatId: string): Promise<number> {
    stopping.add(chatId)
    try {
      const entries = runningOf(chatId)
      for (const entry of entries)
        abortTask(entry, 'chat')
      await Promise.all(entries.map(entry => settle(entry, stopWaitMs)))
      inboxes.delete(chatId)
      if (entries.length > 0)
        log().info('background agents of a chat stopped', { chatId, count: entries.length })
      return entries.length
    }
    finally {
      stopping.delete(chatId)
    }
  }

  async function stopEvery(cause: 'rotation' | 'shutdown'): Promise<void> {
    const entries = [...running.values()]
    for (const entry of entries)
      abortTask(entry, cause)
    await Promise.all(entries.map(entry => settle(entry, stopWaitMs)))
    if (entries.length > 0)
      log().info('background agents stopped', { count: entries.length, cause })
  }

  // ---------- launch ----------

  /** The hooks of a task's child (Phase 11): one snapshot of the launching chat's scope; null when it cannot be taken. */
  async function taskHooks(input: BackgroundLaunchInput, signal: AbortSignal, logger: Logger): Promise<ChildHooksSource | null> {
    try {
      const snapshot = await deps.hooks.snapshot({
        chatId: input.chatId,
        projectId: input.workspace?.projectId ?? null,
        workspace: input.workspace,
        toolMode: input.toolMode,
        origin: input.origin,
        modelRef: input.model.modelRef,
      }, { signal })
      // Phase 12: the Claude names of plugin MCP servers too (`mcp__plugin_<name>_<server>__*`), then the project names.
      const mcpServerNames = hookMcpServerNames(deps.registry ?? null, input.projectTools?.names)
      return detachedHooks({ snapshot, messageId: input.messageId, logger, mcpServerNames })
    }
    catch (error) {
      // A stop during the snapshot: the child ends at once anyway (its signal aborted).
      if (!signal.aborted)
        logger.warn('the hooks of a background agent could not be read; it runs without them', { err: error })
      return null
    }
  }

  async function launch(input: BackgroundLaunchInput): Promise<TaskOutput> {
    const startedAt = now()
    if (closed)
      return failedLaunchOutput(input, BACKGROUND_SHUTDOWN_TEXT, startedAt)
    if (runningOf(input.chatId).length >= perChatMax)
      return failedLaunchOutput(input, perChatLimitText(perChatMax), startedAt)
    if (running.size >= serverMax)
      return failedLaunchOutput(input, serverLimitText(serverMax), startedAt)

    const id = createBackgroundTaskId()
    const output: TaskOutput = {
      status: 'running',
      type: AGENT_TYPE_ALIASES[input.task.type] ?? input.task.type,
      description: input.task.description,
      modelRef: input.settings.subagentModelRef ?? input.model.modelRef,
      steps: [],
      stepsOmitted: 0,
      report: '',
      startedAt,
      taskId: id,
    }
    const task: BackgroundTask = {
      id,
      chatId: input.chatId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      origin: input.origin,
      status: 'running',
      output,
      createdAt: startedAt,
      finishedAt: null,
      deliveredAt: null,
      deliveredMessageId: null,
    }
    const controller = new AbortController()
    const deadline = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const entry: RunningTask = {
      task,
      controller,
      deadline,
      deadlineTimer: null,
      progressTimer: null,
      lastEmitAt: startedAt,
      extraCostUsd: 0,
      stopCause: null,
      ended: false,
      done,
      resolveDone,
      toolMode: input.toolMode,
      reasoningEffort: input.reasoningEffort,
      logger: input.logger.child({ taskId: id }),
    }
    // The slot is taken before the first await: concurrent launches see it.
    running.set(id, entry)
    ensureSubscribed()

    let child: AsyncIterable<TaskOutput>
    try {
      const signal = AbortSignal.any([controller.signal, deadline.signal])
      const hooks = await taskHooks(input, signal, entry.logger)
      const session = createDetachedSession({
        deps,
        chatId: input.chatId,
        messageId: input.messageId,
        settings: input.settings,
        chatInstructions: input.chatInstructions,
        reasoningEffort: input.reasoningEffort,
        signal,
        logger: entry.logger,
        now,
        onExtraCost: (usd) => {
          entry.extraCostUsd = roundUsd(entry.extraCostUsd + usd)
        },
        hooks,
      })
      child = runChild({
        session,
        model: input.model,
        toolMode: input.toolMode,
        workspace: input.workspace,
        scope: input.scope,
        catalog: input.catalog,
        task: input.task,
        toolCallId: input.toolCallId,
        deadline: deadline.signal,
        projectTools: input.projectTools ?? null,
      })
      await insertTaskRow(deps.db, task)
    }
    catch (error) {
      running.delete(id)
      unsubscribeWhenIdle()
      resolveDone()
      entry.logger.warn('a background agent could not start', { ...(isHarnessError(error) ? { code: error.code } : {}), err: isHarnessError(error) ? undefined : error })
      return failedLaunchOutput(input, isHarnessError(error) ? error.message : 'The background agent could not start.', now())
    }

    entry.deadlineTimer = setTimeout(() => deadline.abort(abortReason(backgroundDeadlineText(timeoutMs))), timeoutMs)
    entry.deadlineTimer.unref?.()
    void track(input.chatId, pruneTaskRows(deps.db, input.chatId, keptPerChat), 'prune')
    emit(task)
    entry.logger.info('background agent started', { type: output.type, origin: input.origin })
    // A stop that came while the row was written already aborted the signal: the child ends at once.
    void drive(entry, child)
    return { ...output, status: 'background' }
  }

  // ---------- the interface ----------

  return {
    launch,

    takeResults: (chatId, messageId) => {
      const taken = inboxOf(chatId)
      if (taken.length === 0)
        return []
      inboxes.delete(chatId)
      const deliveredAt = now()
      markDelivered(taken, deliveredAt, messageId)
      return taken.map(entry => taskResultOf(entry.task, deliveredAt))
    },

    onChatIdle: (chatId) => {
      try {
        if (inboxOf(chatId).some(entry => entry.autoTurn))
          deliver(chatId)
      }
      catch (error) {
        log().warn('the background manager failed on an idle chat', { chatId, err: error })
      }
    },

    list: async (chatId) => {
      await writesOf(chatId)
      const rows = await listTaskRows(deps.db, chatId, LIMITS.backgroundTasksKeptPerChat)
      return rows.map(row => running.get(row.id)?.task ?? row)
    },

    stop: async (chatId, taskId) => {
      const entry = running.get(taskId)
      if (entry !== undefined && entry.task.chatId !== chatId)
        return null
      if (entry !== undefined) {
        abortTask(entry, 'stop')
        await settle(entry, stopWaitMs)
      }
      await writesOf(chatId)
      return (await findTaskRow(deps.db, chatId, taskId)) ?? entry?.task ?? null
    },

    stopChat,

    hasRunning: chatId => runningOf(chatId).length > 0,

    start: async () => {
      const finishedAt = now()
      let aborted = 0
      for (const task of await runningTaskRows(deps.db)) {
        if (running.has(task.id))
          continue
        const output = endedOutput(task.output, 'aborted', finishedAt, BACKGROUND_RESTARTED_TEXT)
        await saveTaskEnd(deps.db, { ...task, status: 'aborted', output, finishedAt })
        aborted += 1
      }
      const queued = new Set([...inboxes.values()].flatMap(entries => entries.map(entry => entry.task.id)))
      let waiting = 0
      for (const task of await undeliveredTaskRows(deps.db)) {
        if (queued.has(task.id) || running.has(task.id))
          continue
        pushInbox(task.chatId, [{ task, autoTurn: false }])
        waiting += 1
      }
      if (aborted > 0 || waiting > 0)
        log().info('background tasks after the restart', { aborted, undelivered: waiting })
    },

    stopAll: () => {
      stopAllDone ??= (async () => {
        closed = true
        try {
          await stopEvery('shutdown')
          await allWrites()
        }
        catch (error) {
          log().error('shutdown: the background tasks did not stop cleanly', { err: error })
        }
        finally {
          inboxes.clear()
          delivering.clear()
          deliverAgain.clear()
          subscription?.dispose()
          subscription = null
        }
      })()
      return stopAllDone
    },
  }
}
