// Chat runs (W2.1): implements `ChatRunner` (./types.ts) behind `createChatRunner(deps)`. `POST /chat` acquires the
// chat (one run per chat), prepares and commits the history (./prepare.ts), then streams (./pipeline.ts; image turns:
// ./images.ts).
// `GET /chat/:id/stream` replays the run buffer; `POST /chat/:id/stop` aborts the run into the normal persistence path
// and waits for it; shutdown stops every run the same way.
// Phase 7 (C16-T1): while a maintenance operation with `blockRuns` holds the lock (the key rotation), `POST /chat`
// answers `409 conflict` (`reason: 'busy'`) before the chat is acquired.
// Phase 9 (ADR-042, ARCHITECTURE.md 6.20, W9.2): one steer queue per runner (`queue.ts`); the `ChatRunner` queue members
// delegate to it; `stop` empties the chat's queue before it stops the run and `stopAll` empties every queue before it
// aborts the runs; every run gets the queue and the release callback `onRunReleased`, the queue's run end:
// - completed without a pending approval: the oldest item becomes the next turn, started by the server
//   (`startQueuedTurn`: `start` with the item's message and composer state, request id `queue_…`, the response body
//   cancelled at once: the tee keeps filling the replay buffer, so tabs resume it); its `run.started` carries
//   `origin: 'queue'` and `userMessageId` (`RunContext.origin`; `launchRun` emits them). A start that loses the chat to
//   a user's `POST /chat` (409 `run-active`) puts the item back at the head (that run steers it in); any other failure
//   reports it `failed` (with the error message);
// - awaiting an approval: the items wait for the next run (its step 0 takes them);
// - aborted / failed: every item is removed (`stopped` / `failed`).
// `run.started` of user requests carries `origin: 'request'`.
// Phase 10 (C31 wiring, ADR-046; W10.4 implements the manager): the runner creates one background manager
// (`ChatRunnerOptions.backgroundTasks`, default `createBackgroundTasks` of `background/index.ts`) with the host
// `{ hasRun, startTaskTurn }` (`startTaskTurn` = `start` with `origin: 'task'` and `prepareRun(…, { serverMessage: true
// })`); every run gets it (`RunContext.background`); `boot`, `taskList`, `stopTask`, `stopTasks` and `hasTasks` delegate
// to it; a completed run without a pending approval whose chat has no queued message to start calls
// `background.onChatIdle(chatId)`; `stopAll` clears the queues, then stops the background tasks, then the runs. The chat's
// `stop` never stops a background task.
// Phase 11 (C37 seams, ADR-048; W11.2 implements the hook turn): every run gets its origin in `prepareRun`
// (`PrepareRunOptions.origin`, the prompt hooks); `onRunReleased(…, followUp)` receives what a released run asks for
// (`RunReleaseFollowUp`: a blocking `Stop` hook) and the priority is: a queued item, then the hook turn
// (`startHookTurn`: `start` with `origin: 'hook'` and `prepareRun(…, { serverMessage: true })` from a carrier user
// message holding the record), then `background.onChatIdle`.
// W11.2 (P11-A):
// - `startHookTurn` builds the carrier (a new user message whose only part is the `Stop` record, outcome `continued`)
//   and calls `start(body, …, 'hook', { serverMessage: true })` with the ended run's model, effort and mode (request id
//   `hook_…`, the response body cancelled at once like a queued turn); only a `Stop` record starts a turn. A start that
//   loses the chat (409 `run-active`) drops the turn (the run that holds the chat goes on); any other failure ends the
//   chain (logged). `run.started` carries `origin: 'hook'` and the carrier's id; the hook turn's step 0 takes the
//   background inbox like any turn; its `Stop` hooks get `stop_hook_active`, and the gate stops the chain after
//   `LIMITS.hookContinuationsMax` hook turns in a row (`hookChainLength`, the notice `hook-continuation-limit`).
// - A hook turn that fails before its stream starts leaves the chat idle: the queued items start (as before) and, when
//   none waits, `background.onChatIdle` runs (the turn would have delivered them).
// - The queue runs `UserPromptSubmit` at enqueue through `runQueuedPromptHooks` (`hooks-prompt.ts`, the runner's
//   lifecycle signal: shutdown kills the hooks); a queued turn hands the item's records to `prepareRun`
//   (`PrepareRunOptions.hookRecords`).
import type { ChatRequestBody, HarnessUIMessage, HookData, QueueChangedData, RunOrigin } from '@harness-forge/shared'
import type { EventBus } from '../services/events/types.ts'
import type { AppDeps } from '../types.ts'
import type { BackgroundTasks, BackgroundTasksFactory } from './background/types.ts'
import type { RunEnding } from './history.ts'
import type { PrepareRunOptions } from './prepare.ts'
import type { ChatQueue, QueueEntry } from './queue.ts'
import type { Run } from './runs.ts'
import type { ChatRunner, ChatRunOptions, RunReleaseFollowUp } from './types.ts'
import { createMessageId, HOOK_PART_TYPE, isHarnessError } from '@harness-forge/shared'
import { assertRunsAllowed } from '../services/maintenance/index.ts'
import { createBackgroundTasks } from './background/index.ts'
import { abortReason, preStreamError } from './errors.ts'
import { runQueuedPromptHooks } from './hooks-prompt.ts'
import { launchRun, TaskTracker } from './pipeline.ts'
import { commitHistory, prepareRun, stoppedBeforeStart } from './prepare.ts'
import { createChatQueue } from './queue.ts'
import { createRunRegistry, toActiveRun } from './runs.ts'
import { TITLE_TIMEOUT_MS } from './title.ts'

/** How long `stop` waits for a run to persist before force-releasing it. */
export const STOP_WAIT_MS = 15_000
/** The same wait at shutdown (the whole shutdown has 10 s, `main.ts`). */
export const SHUTDOWN_STOP_WAIT_MS = 5000

export interface ChatRunnerOptions {
  now?: () => number
  titleTimeoutMs?: number
  stopWaitMs?: number
  shutdownStopWaitMs?: number
  /** Interval of the `message-metadata` keep-alive of image turns (default `IMAGE_KEEPALIVE_MS`, 15 s). */
  imageKeepAliveMs?: number
  /** Creates the runner's background manager (Phase 10; default `createBackgroundTasks`; tests pass a fake). */
  backgroundTasks?: BackgroundTasksFactory
}

/** `ChatRunner` plus test and shutdown helpers. */
export interface ChatRunnerInternal extends ChatRunner {
  /** Resolves when no tracked work of the runs (titles, `message.completed` hooks) is pending. */
  readonly idle: () => Promise<void>
  /** The runner's background manager (Phase 10; tests). */
  readonly background: BackgroundTasks
}

export function createChatRunner(deps: AppDeps): ChatRunner {
  return createChatRunnerWith(deps)
}

let queueRequestCounter = 0

/** The request id of a turn the server starts from the queue (`queue_…`). */
export function queueRequestId(): string {
  queueRequestCounter += 1
  return `queue_${Date.now().toString(36)}_${queueRequestCounter.toString(36)}`
}

/** What `startQueuedTurn` needs (the runner's internals; replaceable in tests). */
export interface QueuedTurnInput {
  chatId: string
  entry: QueueEntry
  queue: ChatQueue
  events: Pick<EventBus, 'emit'>
  /** The runner's start with the origin of the run (and, Phase 10, the options of `prepareRun`). */
  start: (body: Parameters<ChatRunner['start']>[0], options: ChatRunOptions, origin: RunOrigin, prepareOptions?: PrepareRunOptions) => Promise<Response>
}

/**
 * Starts the next turn from a queued item taken with `takeNext` (reported `started`). The synchronous part of `start`
 * acquires the chat at once, so no request can come between the run end and this turn. The response body is cancelled
 * (nobody reads it; the replay buffer keeps the run). A 409 `run-active` puts the item back at the head of the queue (the
 * run that holds the chat steers it in); any other failure is reported as a `failed` removal with the error message.
 */
export async function startQueuedTurn(input: QueuedTurnInput): Promise<void> {
  const { chatId, entry, queue, events, start } = input
  const { item } = entry
  const requestId = queueRequestId()
  // The logger of the request that queued the item, with the id of this turn (and the queuing request's id).
  const logger = entry.options.logger.child({ reqId: requestId, queuedBy: entry.options.requestId, chatId })
  try {
    const body: ChatRequestBody = { chatId, message: { id: item.message.id, role: 'user', parts: item.message.parts }, trigger: 'submit-message', modelRef: item.modelRef, reasoningEffort: item.reasoningEffort, toolMode: item.toolMode }
    // Phase 11: the item's `UserPromptSubmit` records (run at enqueue) go onto the turn's user message.
    const records = entry.hookRecords ?? []
    const response = records.length === 0
      ? await start(body, { logger, requestId }, 'queue')
      : await start(body, { logger, requestId }, 'queue', { hookRecords: records })
    logger.info('next turn started from the queue', { itemId: item.id })
    await response.body?.cancel().catch(() => {})
  }
  catch (error) {
    const details = isHarnessError(error) ? error.details as { reason?: unknown } | undefined : undefined
    if (isHarnessError(error) && error.code === 'conflict' && details?.reason === 'run-active') {
      logger.debug('the next turn lost the chat to another request; the item goes back to the queue', { itemId: item.id })
      queue.requeue(chatId, entry)
      return
    }
    const code = isHarnessError(error) ? error.code : 'internal_error'
    logger.warn('a queued message could not start the next turn', { itemId: item.id, code, err: error })
    const message = isHarnessError(error) ? error.message : 'The next turn could not start.'
    const data: QueueChangedData = { chatId, items: queue.list(chatId), removed: [{ id: item.id, reason: 'failed', error: message.slice(0, 2000) }] }
    events.emit('queue.changed', data)
  }
}

/** The run that ended, for its follow-up turn (Phase 11: the hook turn keeps its model, effort and mode). */
interface ReleasedRun {
  body: ChatRequestBody
  options: ChatRunOptions
}

/** What `startHookTurn` needs (the runner's internals; replaceable in tests). */
export interface HookTurnInput {
  chatId: string
  /** The `Stop` record of the run that ended (outcome `continued`): the carrier message holds it. */
  data: HookData
  /** The request of the run that ended: the follow-up keeps its model, effort and mode. */
  previous: Pick<ChatRequestBody, 'modelRef' | 'reasoningEffort' | 'toolMode'>
  /** The logger and request id of the run that ended. */
  options: ChatRunOptions
  events: Pick<EventBus, 'emit'>
  /** The runner's start (origin `hook`, `prepareRun(…, { serverMessage: true })`). */
  start: QueuedTurnInput['start']
}

let hookRequestCounter = 0

/** The request id of a hook turn the server starts (`hook_…`). */
export function hookRequestId(): string {
  hookRequestCounter += 1
  return `hook_${Date.now().toString(36)}_${hookRequestCounter.toString(36)}`
}

/** The carrier of a hook turn: a new user message whose only part is the `Stop` record (Phase 11). */
export function hookCarrierMessage(data: HookData): HarnessUIMessage {
  return { id: createMessageId(), role: 'user', parts: [{ type: HOOK_PART_TYPE, data }] as HarnessUIMessage['parts'] }
}

/**
 * Starts the follow-up turn of a blocking `Stop` hook (Phase 11, ADR-048; W11.2): a carrier user message holding only
 * the `data-hook` record, `start(body, …, 'hook', { serverMessage: true })` (the chat is acquired synchronously, so
 * nothing comes between the run end and this turn); a lost start (409 `run-active`) drops it. True when a turn start
 * was initiated (the background delivery then waits for that turn's end); false for a record that is not a `Stop`
 * record (nothing starts).
 */
export function startHookTurn(input: HookTurnInput): boolean {
  const { chatId, data, previous, options, start } = input
  if (data.event !== 'Stop')
    return false
  const requestId = hookRequestId()
  const logger = options.logger.child({ reqId: requestId, startedBy: options.requestId, chatId })
  const message = hookCarrierMessage(data)
  const body: ChatRequestBody = {
    chatId,
    message: { id: message.id, role: 'user', parts: message.parts },
    trigger: 'submit-message',
    modelRef: previous.modelRef,
    reasoningEffort: previous.reasoningEffort,
    toolMode: previous.toolMode,
  }
  let started: Promise<Response>
  try {
    // `start` acquires the chat before its first await: nothing comes between the run end and this turn.
    started = start(body, { logger, requestId }, 'hook', { serverMessage: true })
  }
  catch (error) {
    logger.warn('a hook turn could not start', { code: isHarnessError(error) ? error.code : 'internal_error' })
    return false
  }
  void started.then(async (response) => {
    logger.info('hook turn started', { userMessageId: message.id })
    await response.body?.cancel().catch(() => {})
  }, (error: unknown) => {
    const details = isHarnessError(error) ? error.details as { reason?: unknown } | undefined : undefined
    if (isHarnessError(error) && error.code === 'conflict' && details?.reason === 'run-active') {
      logger.debug('the hook turn lost the chat to another request; it is dropped')
      return
    }
    logger.warn('a hook turn could not start; the hook chain ends', { code: isHarnessError(error) ? error.code : 'internal_error' })
  })
  return true
}

export function createChatRunnerWith(deps: AppDeps, options: ChatRunnerOptions = {}): ChatRunnerInternal {
  const now = options.now ?? Date.now
  const registry = createRunRegistry(now)
  const tasks = new TaskTracker()
  const lifecycle = new AbortController()
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
  const shutdownStopWaitMs = Math.min(stopWaitMs, options.shutdownStopWaitMs ?? SHUTDOWN_STOP_WAIT_MS)
  // The services are read lazily inside the queue's methods (the runner is built inside the deps factory).
  const queue = createChatQueue(deps, {
    hasRun: chatId => registry.get(chatId) !== undefined,
    now,
    // Phase 11 (W11.2): `UserPromptSubmit` at enqueue (shutdown kills the hooks through the lifecycle signal).
    promptHooks: ({ chat, body, parts, turnOnly, options: runOptions }) => runQueuedPromptHooks({
      deps,
      chat,
      body,
      parts,
      turnOnly,
      signal: lifecycle.signal,
      logger: runOptions.logger.child({ chatId: chat.id }),
    }),
  })
  // The background manager (Phase 10): reads `deps` and its host lazily, like the queue.
  const background = (options.backgroundTasks ?? createBackgroundTasks)(deps, {
    hasRun: chatId => registry.get(chatId) !== undefined,
    startTaskTurn: (body, runOptions) => startRun(body, runOptions, 'task', { serverMessage: true }),
  })

  /** The chat is idle after a natural ending (Phase 10): the background manager may deliver waiting results. */
  function chatIdle(chatId: string): void {
    try {
      background.onChatIdle(chatId)
    }
    catch (error) {
      deps.logger.warn('the background manager failed on an idle chat', { chatId, err: error })
    }
  }

  /**
   * A run of `chatId` left the registry (Phase 9, `RunContext.onReleased`): completed without a pending approval → the
   * oldest queued item becomes the next turn, else (Phase 11) the hook turn of a `followUp` (`startHookTurn`), else
   * (Phase 10) `background.onChatIdle`; awaiting an approval → the items wait; aborted / failed → every item is removed
   * (`stopped` / `failed`; the background results wait for the next run). At shutdown nothing starts (the queues were
   * emptied first anyway).
   */
  function onRunReleased(chatId: string, ending: RunEnding, awaitingApproval: boolean, followUp?: RunReleaseFollowUp, released?: ReleasedRun): void {
    if (ending === 'aborted' || lifecycle.signal.aborted) {
      queue.clear(chatId, 'stopped')
      return
    }
    if (ending === 'failed') {
      queue.clear(chatId, 'failed')
      return
    }
    if (awaitingApproval)
      return
    const entry = queue.takeNext(chatId)
    if (entry !== null) {
      void startQueuedTurn({ chatId, entry, queue, events: deps.events, start: startRun })
      return
    }
    if (followUp?.kind === 'hook' && released !== undefined) {
      const { modelRef, reasoningEffort, toolMode } = released.body
      if (startHookTurn({ chatId, data: followUp.data, previous: { modelRef, reasoningEffort, toolMode }, options: released.options, events: deps.events, start: startRun }))
        return
    }
    chatIdle(chatId)
  }

  /** Releases a run that did not settle after a stop; its late end callback stores nothing. */
  function forceRelease(run: Run): void {
    run.forceReleased = true
    if (!registry.release(run))
      return
    deps.logger.warn('run did not end after a stop; released', { chatId: run.chatId, runId: run.runId })
    if (run.messageId !== null)
      deps.events.emit('run.finished', { chatId: run.chatId, messageId: run.messageId, outcome: 'aborted', awaitingApproval: false })
  }

  async function waitSettled(run: Run, waitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      run.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, waitMs, false)
      }),
    ])
    clearTimeout(timer)
    if (!settled)
      forceRelease(run)
  }

  async function stopRun(run: Run, reason: string, waitMs: number): Promise<boolean> {
    const wasRunning = run.phase !== 'finishing'
    if (wasRunning && !run.signal.aborted)
      run.controller.abort(abortReason(reason))
    await waitSettled(run, waitMs)
    return wasRunning
  }

  /**
   * A run released before its stream started (the request failed while it was prepared) while messages were queued
   * for it: they become the next turn once the chat is idle and waits for no approval (a pending approval keeps them
   * for the next run). Phase 11: a server-started hook turn that failed this way leaves the chat idle, so the
   * background results it would have taken are delivered (`onChatIdle`) when nothing is queued.
   */
  function releasedBeforeLaunch(chatId: string, origin: RunOrigin): void {
    const queued = queue.list(chatId).length > 0
    if (!queued && origin !== 'hook')
      return
    deps.chats.find(chatId).then((chat) => {
      if (chat === null || chat.pendingApproval || registry.get(chatId) !== undefined || lifecycle.signal.aborted)
        return
      if (queue.list(chatId).length > 0)
        onRunReleased(chatId, 'completed', false)
      else if (origin === 'hook')
        chatIdle(chatId)
    }).catch((error: unknown) => deps.logger.warn('cannot check the queue of a chat whose request failed', { chatId, err: error }))
  }

  /**
   * `start` with the origin of the run (`run.started`) and the options of `prepareRun` (Phase 10: the carrier message of
   * a `task` turn). The chat is acquired synchronously (before the first await).
   */
  async function startRun(body: Parameters<ChatRunner['start']>[0], runOptions: ChatRunOptions, origin: RunOrigin, prepareOptions: PrepareRunOptions = {}): Promise<Response> {
    const logger = runOptions.logger.child({ chatId: body.chatId })
    // Checked right before the chat is acquired (no await in between), so an operation that blocks runs and then
    // stops every registered run cannot miss one.
    assertRunsAllowed(deps.maintenance)
    const run = registry.acquire(body.chatId, body.modelRef)
    let launched = false
    try {
      const prepared = await prepareRun(deps, run, body, logger, { ...prepareOptions, origin })
      if (run.signal.aborted)
        throw stoppedBeforeStart(body.chatId)
      await commitHistory(deps, body.chatId, prepared.writes)
      launched = true
      return await launchRun({
        deps,
        registry,
        run,
        prepared,
        toolMode: body.toolMode,
        reasoningEffort: body.reasoningEffort,
        logger: logger.child({ runId: run.runId }),
        now,
        tasks,
        titleTimeoutMs: options.titleTimeoutMs ?? TITLE_TIMEOUT_MS,
        lifecycle: lifecycle.signal,
        ...(options.imageKeepAliveMs === undefined ? {} : { imageKeepAliveMs: options.imageKeepAliveMs }),
        queue,
        onReleased: (ending, awaitingApproval, followUp) => onRunReleased(body.chatId, ending, awaitingApproval, followUp, { body, options: runOptions }),
        origin,
        background,
      })
    }
    catch (error) {
      // `launchRun` answers every failure with an in-stream error; this only guards against a bug there.
      const released = registry.release(run)
      if (released && launched && run.messageId !== null) {
        logger.error('run launch failed', { err: error })
        deps.events.emit('run.finished', { chatId: run.chatId, messageId: run.messageId, outcome: 'failed', awaitingApproval: false })
        onRunReleased(body.chatId, 'failed', false)
      }
      else if (released && !launched) {
        releasedBeforeLaunch(body.chatId, origin)
      }
      if (!launched && run.signal.aborted && !isHarnessError(error))
        throw stoppedBeforeStart(body.chatId)
      throw preStreamError(error, runOptions.requestId)
    }
  }

  return {
    start: (body, runOptions) => startRun(body, runOptions, 'request'),

    resume: (chatId) => {
      const run = registry.get(chatId)
      if (run === undefined || run.phase !== 'streaming' || run.buffer === null)
        return null
      return run.buffer.toResponse()
    },

    stop: async (chatId) => {
      // The queue first (also without a run: a chat waiting for an approval), so no queued message starts a turn.
      queue.clear(chatId, 'stopped')
      const run = registry.get(chatId)
      if (run === undefined)
        return false
      return stopRun(run, 'The run was stopped.', stopWaitMs)
    },

    isActive: chatId => registry.get(chatId)?.phase === 'streaming',

    hasRun: chatId => registry.get(chatId) !== undefined,

    active: () => registry.list().flatMap((run) => {
      const active = toActiveRun(run)
      return active === null ? [] : [active]
    }),

    stopAll: async () => {
      // The queues, then the background tasks, then the runs (`ChatRunner.stopAll`); nothing starts once the lifecycle
      // signal aborted.
      queue.clearAll('stopped')
      lifecycle.abort(abortReason('The server is shutting down.'))
      try {
        await background.stopAll()
      }
      catch (error) {
        deps.logger.error('shutdown: the background tasks did not stop', { err: error })
      }
      await Promise.all(registry.list().map(run => stopRun(run, 'The server is shutting down.', shutdownStopWaitMs)))
      await tasks.idle()
    },

    queueList: chatId => queue.list(chatId),

    enqueue: (chatId, body, runOptions) => queue.add(chatId, body, runOptions),

    dequeue: (chatId, itemId) => queue.remove(chatId, itemId),

    clearQueue: (chatId, reason) => queue.clear(chatId, reason),

    boot: () => background.start(),

    taskList: chatId => background.list(chatId),

    stopTask: (chatId, taskId) => background.stop(chatId, taskId),

    stopTasks: chatId => background.stopChat(chatId),

    hasTasks: chatId => background.hasRunning(chatId),

    idle: () => tasks.idle(),

    background,
  }
}
