// Checkpoints, rewind and the changes panel data (Phase 8, ADR-036 / ADR-037, ARCHITECTURE.md 6.16 / 6.17). Owner:
// W8.1. Implements `CheckpointService` (./types.ts) behind `createCheckpointService(deps)` by composing the modules: the
// store (./store.ts), journals, the row writer and the tool events (./journal-service.ts), prune (./prune.ts) of W8.1;
// the rewind, revert and undo (./rewind.ts, ./revert.ts, ./undo.ts over ./plan.ts and ./restore.ts) of W8.2; the
// changes list, the diffs and the git view (./changes.ts, ./git-changes.ts) of W8.3. Every module receives the same
// kind of `CheckpointContext` (`deps`, the blob store, the row writer, the clock).
//
// Lifecycle: `start()` creates `DataPaths.checkpoints` (0700) and runs one prune; with `background` (default, off under
// Vitest) it then prunes every 6 hours (a chained `setTimeout(...).unref()`, like the catalog cycle) and 60 s after the
// last of a burst of `chat.deleted` events (debounced: the cascade removed rows, so blobs may have become orphans).
// `stop()` clears the timers, drops the pending tool events, aborts a background prune between its steps and waits for
// every running prune. A failed prune is logged and never fails the boot. Logs: `checkpoints pruned` (info, counts
// only) when a prune removed or evicted anything; never a path, a sha or file content at info.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ServerEvent } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { CheckpointStore } from './store.ts'
import type { CheckpointContext, CheckpointService, PruneResult } from './types.ts'
import { chmod, mkdir } from 'node:fs/promises'
import process from 'node:process'
import { changesFileDiff, listChatChanges } from './changes.ts'
import { chatGitStatus } from './git-changes.ts'
import { createChangeRowWriter, createCheckpointJournal, createToolEventCoalescer, failureCode } from './journal-service.ts'
import { pruneCheckpoints, pruneFoundNothing } from './prune.ts'
import { revertFile } from './revert.ts'
import { rewindFiles, rewindPreview } from './rewind.ts'
import { createCheckpointStore } from './store.ts'
import { undoBatch } from './undo.ts'

/** Time between two background prunes (6 hours). */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Delay of the prune after the last `chat.deleted` of a burst (60 s, debounced). */
export const CHAT_DELETED_PRUNE_DELAY_MS = 60_000

export interface CheckpointServiceOptions {
  /** Clock of rows, batches and prune (default `Date.now`). */
  now?: () => number
  /** The store (default: `createCheckpointStore(deps.env.paths.checkpoints)`). */
  store?: CheckpointStore
  /**
   * Run the prune timers (every 6 hours, 60 s after a `chat.deleted`); default on, off under Vitest (tests call
   * `prune()` with fake timers or an injected `now`). The boot prune of `start()` runs either way.
   */
  background?: boolean
}

type PruneTrigger = 'boot' | 'interval' | 'chat-deleted' | 'manual'

function isVitest(): boolean {
  return process.env.VITEST !== undefined
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function createCheckpointService(deps: AppDeps, options: CheckpointServiceOptions = {}): CheckpointService {
  const now = options.now ?? Date.now
  const store = options.store ?? createCheckpointStore(deps.env.paths.checkpoints)
  const background = options.background ?? !isVitest()
  // Lazy: `deps.db`, `deps.events` and the logger are read when a member runs, never while the deps are being built.
  const context = (): CheckpointContext => ({ deps, blobs: store, rows: createChangeRowWriter(deps, now), now })
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= deps.logger.child({ component: 'checkpoints' }))
  let toolEvents = createToolEventCoalescer(data => deps.events.emit('workspace.changed', data))

  let started = false
  let stopController = new AbortController()
  let cycleTimer: ReturnType<typeof setTimeout> | undefined
  let deletedTimer: ReturnType<typeof setTimeout> | undefined
  let subscription: Disposable | undefined
  const running = new Set<Promise<unknown>>()

  function track<T>(operation: Promise<T>): Promise<T> {
    running.add(operation)
    void operation.then(() => running.delete(operation), () => running.delete(operation))
    return operation
  }

  function logResult(trigger: PruneTrigger, result: PruneResult): void {
    if (pruneFoundNothing(result))
      return
    log().info('checkpoints pruned', { trigger, ...result })
  }

  /** A prune of the schedule (boot, interval, chat deletion): never rejects, logs its outcome. */
  async function scheduledPrune(trigger: PruneTrigger): Promise<void> {
    try {
      logResult(trigger, await track(pruneCheckpoints(context(), store, { now: now(), signal: stopController.signal })))
    }
    catch (error) {
      if (isAbort(error)) {
        log().debug('checkpoint prune stopped', { trigger })
        return
      }
      log().warn('checkpoint prune failed', { trigger, code: failureCode(error) })
      log().debug('checkpoint prune failed (detail)', { trigger, err: error })
    }
  }

  function scheduleCycle(): void {
    if (!started || !background)
      return
    clearTimeout(cycleTimer)
    cycleTimer = setTimeout(() => {
      cycleTimer = undefined
      void scheduledPrune('interval').finally(scheduleCycle)
    }, PRUNE_INTERVAL_MS)
    cycleTimer.unref?.()
  }

  function onEvent(event: ServerEvent): void {
    if (event.type !== 'chat.deleted' || !started)
      return
    clearTimeout(deletedTimer)
    deletedTimer = setTimeout(() => {
      deletedTimer = undefined
      void scheduledPrune('chat-deleted')
    }, CHAT_DELETED_PRUNE_DELAY_MS)
    deletedTimer.unref?.()
  }

  return {
    journal: scope => createCheckpointJournal(context(), scope, { toolEvents }),
    listChanges: (chatId, readOptions) => listChatChanges(context(), chatId, readOptions),
    fileDiff: (chatId, query, readOptions) => changesFileDiff(context(), chatId, query, readOptions),
    gitStatus: (chatId, readOptions) => chatGitStatus(context(), chatId, readOptions),
    revert: (chatId, body) => revertFile(context(), chatId, body),
    undo: (chatId, body) => undoBatch(context(), chatId, body),
    rewindPreview: (chatId, messageId, readOptions) => rewindPreview(context(), chatId, messageId, readOptions),
    rewind: (chatId, body) => rewindFiles(context(), chatId, body),
    start: async () => {
      await mkdir(store.dir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32')
        await chmod(store.dir, 0o700)
      if (started)
        return
      started = true
      if (stopController.signal.aborted) {
        stopController = new AbortController()
        toolEvents = createToolEventCoalescer(data => deps.events.emit('workspace.changed', data))
      }
      await scheduledPrune('boot')
      if (background && started) {
        scheduleCycle()
        subscription = deps.events.subscribe(onEvent)
      }
    },
    stop: async () => {
      started = false
      clearTimeout(cycleTimer)
      clearTimeout(deletedTimer)
      cycleTimer = undefined
      deletedTimer = undefined
      subscription?.dispose()
      subscription = undefined
      toolEvents.stop()
      stopController.abort(new DOMException('The checkpoint store stopped.', 'AbortError'))
      await Promise.allSettled([...running])
    },
    prune: async (pruneOptions = {}) => {
      const result = await track(pruneCheckpoints(context(), store, { now: pruneOptions.now ?? now() }))
      logResult('manual', result)
      return result
    },
    purge: () => track(store.purge()),
    summary: () => store.summary(),
  }
}
