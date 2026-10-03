// Chat runs (W2.1): implements `ChatRunner` (./types.ts) behind `createChatRunner(deps)`. `POST /chat` acquires the
// chat (one run per chat), prepares and commits the history (./prepare.ts), then streams (./pipeline.ts; image turns:
// ./images.ts).
// `GET /chat/:id/stream` replays the run buffer; `POST /chat/:id/stop` aborts the run into the normal persistence path
// and waits for it; shutdown stops every run the same way.
// Phase 7 (C16-T1): while a maintenance operation with `blockRuns` holds the lock (the key rotation), `POST /chat`
// answers `409 conflict` (`reason: 'busy'`) before the chat is acquired.
import type { AppDeps } from '../types.ts'
import type { Run } from './runs.ts'
import type { ChatRunner } from './types.ts'
import { isHarnessError } from '@harness-forge/shared'
import { assertRunsAllowed } from '../services/maintenance/index.ts'
import { abortReason, preStreamError } from './errors.ts'
import { launchRun, TaskTracker } from './pipeline.ts'
import { commitHistory, prepareRun, stoppedBeforeStart } from './prepare.ts'
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
}

/** `ChatRunner` plus test and shutdown helpers. */
export interface ChatRunnerInternal extends ChatRunner {
  /** Resolves when no background task (title, `message.completed` hooks) is pending. */
  readonly idle: () => Promise<void>
}

export function createChatRunner(deps: AppDeps): ChatRunner {
  return createChatRunnerWith(deps)
}

export function createChatRunnerWith(deps: AppDeps, options: ChatRunnerOptions = {}): ChatRunnerInternal {
  const now = options.now ?? Date.now
  const registry = createRunRegistry(now)
  const tasks = new TaskTracker()
  const lifecycle = new AbortController()
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
  const shutdownStopWaitMs = Math.min(stopWaitMs, options.shutdownStopWaitMs ?? SHUTDOWN_STOP_WAIT_MS)

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

  return {
    start: async (body, runOptions) => {
      const logger = runOptions.logger.child({ chatId: body.chatId })
      // Checked right before the chat is acquired (no await in between), so an operation that blocks runs and then
      // stops every registered run cannot miss one.
      assertRunsAllowed(deps.maintenance)
      const run = registry.acquire(body.chatId, body.modelRef)
      let launched = false
      try {
        const prepared = await prepareRun(deps, run, body, logger)
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
        })
      }
      catch (error) {
        // `launchRun` answers every failure with an in-stream error; this only guards against a bug there.
        if (registry.release(run) && launched && run.messageId !== null) {
          logger.error('run launch failed', { err: error })
          deps.events.emit('run.finished', { chatId: run.chatId, messageId: run.messageId, outcome: 'failed', awaitingApproval: false })
        }
        if (!launched && run.signal.aborted && !isHarnessError(error))
          throw stoppedBeforeStart(body.chatId)
        throw preStreamError(error, runOptions.requestId)
      }
    },

    resume: (chatId) => {
      const run = registry.get(chatId)
      if (run === undefined || run.phase !== 'streaming' || run.buffer === null)
        return null
      return run.buffer.toResponse()
    },

    stop: async (chatId) => {
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
      lifecycle.abort(abortReason('The server is shutting down.'))
      await Promise.all(registry.list().map(run => stopRun(run, 'The server is shutting down.', shutdownStopWaitMs)))
      await tasks.idle()
    },

    idle: () => tasks.idle(),
  }
}
