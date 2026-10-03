// The automatic file sweep (Phase 8, ADR-039, ARCHITECTURE.md 6.15 "Automatic sweep"). Owner: W8.7 (W8.7-T1, T2, T4).
//
// - `nextSweepAt(state, mode, bootAt)` (pure): when the next automatic run is due, `max(bootAt + 24 h, lastCleanup +
//   interval, a failed or skipped lastAutoSweep.at + interval)` with interval 24 h (`daily`) or 7 days (`weekly`); null
//   while `off`. A manual cleanup sets `lastCleanup`, so it pushes the next run back; a failed or skipped attempt waits
//   a full interval, so it cannot loop.
// - `createAutoSweep(options)`: the timer, like the catalog's `scheduleCycle` (a chained `setTimeout(...).unref()` plus
//   a `stopped` flag). `start()` records the boot time and schedules the first check at `bootAt + bootDelayMs` (24 h,
//   or `Env.testFileSweepDelayMs`), then one check every `checkIntervalMs` (1 h, or the same test delay). Each check
//   reads the `fileSweep` setting and `_files` again (a settings change applies at the next check, no subscription) and
//   runs a sweep when one is due. A busy maintenance lock retries after `busyRetryMs` (10 min, never later than the next
//   regular check) with nothing stored. `stop()` clears the timer, aborts a sweep in flight and waits until it settled;
//   no check runs after it. Without `background` (Vitest) `start()` only records the boot time.
// - `attemptAutoSweep(context, signal)`: one run under `maintenance.exclusive('file-cleanup', ...)` (no `blockRuns`):
//   `runAutoCleanup` of ./cleanup.ts (`done` or `skipped`, stored and logged there); a failure is stored as `failed` /
//   `error` with a warning (the error code, never a path); `busy` and `aborted` store nothing (debug logs).
import type { FileSweepMode, FileSweepStatus } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { CleanupContext, FileSweepState } from './cleanup.ts'
import { HarnessError } from '@harness-forge/shared'
import { FILE_CLEANUP_GRACE_MS } from '../files/pins.ts'
import { runAutoCleanup, updateFileState } from './cleanup.ts'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The interval of each mode (`off` has none). */
export const SWEEP_INTERVAL_MS: Readonly<Record<Exclude<FileSweepMode, 'off'>, number>> = Object.freeze({
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
})

/** The first check after boot (the grace period, so the in-memory pins lost at a restart never matter). */
export const SWEEP_BOOT_DELAY_MS = FILE_CLEANUP_GRACE_MS

/** Between two checks. */
export const SWEEP_CHECK_INTERVAL_MS = HOUR_MS

/** The retry after another maintenance operation held the lock. */
export const SWEEP_BUSY_RETRY_MS = 10 * MINUTE_MS

/**
 * When the next automatic run is due (ms), or null while `mode` is `off`. `bootDelayMs` replaces the 24 h after boot
 * (`Env.testFileSweepDelayMs`).
 */
export function nextSweepAt(state: FileSweepState, mode: FileSweepMode, bootAt: number, bootDelayMs: number = SWEEP_BOOT_DELAY_MS): number | null {
  if (mode === 'off')
    return null
  const interval = SWEEP_INTERVAL_MS[mode]
  let due = bootAt + bootDelayMs
  if (state.lastCleanup !== null)
    due = Math.max(due, state.lastCleanup + interval)
  const last = state.lastAutoSweep
  if (last !== null && last.status !== 'done')
    due = Math.max(due, last.at + interval)
  return due
}

/** What one check's run did. */
export type AutoSweepOutcome = 'done' | 'skipped' | 'failed' | 'busy' | 'aborted'

export interface AutoSweepOptions {
  readonly now: () => number
  /** Schedule the checks after `start()`; false (Vitest default): `start()` only records the boot time. */
  readonly background: boolean
  /** The first check after `start()`. */
  readonly bootDelayMs: number
  /** Between checks. */
  readonly checkIntervalMs: number
  /** After a `busy` outcome (capped at `checkIntervalMs`). */
  readonly busyRetryMs: number
  /** The `fileSweep` setting, read at every check. */
  readonly readMode: () => Promise<FileSweepMode>
  /** The `_files` state, read at every check. */
  readonly readState: () => Promise<FileSweepState>
  /** One automatic run (`attemptAutoSweep`); `signal` is aborted by `stop()`. Should not reject. */
  readonly run: (signal: AbortSignal) => Promise<AutoSweepOutcome>
  readonly logger: Logger
}

export interface AutoSweep {
  /** Records the boot time and schedules the first check (with `background`). Idempotent; a no-op after `stop()`. */
  readonly start: () => void
  /** Clears the timer, aborts a run in flight and resolves once the check settled. Idempotent. */
  readonly stop: () => Promise<void>
  /**
   * `FileSweepStatus` (cheap: the setting and `_files`, no scan). While the timer runs, `nextRunAt` is the first
   * scheduled check at or after the due time; otherwise the due time itself.
   */
  readonly status: () => Promise<FileSweepStatus>
  /** Resolves when no check is running (tests). */
  readonly idle: () => Promise<void>
  /** When the next check fires (ms); null when none is scheduled (tests). */
  readonly nextCheckAt: () => number | null
}

/** The error's code (a `HarnessError` code or a Node error code) and class name: never its message (paths). */
export function describeError(error: unknown): { code?: string, errorName?: string } {
  const code = (error as { code?: unknown } | null)?.code
  const name = (error as { name?: unknown } | null)?.name
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof name === 'string' ? { errorName: name } : {}),
  }
}

/** `409 conflict` (`reason: 'busy'`) of the maintenance lock. */
function isBusy(error: unknown): boolean {
  if (!(error instanceof HarnessError) || error.code !== 'conflict')
    return false
  const details = error.details
  return typeof details === 'object' && details !== null && (details as { reason?: unknown }).reason === 'busy'
}

export function createAutoSweep(options: AutoSweepOptions): AutoSweep {
  const { logger } = options
  let bootAt = options.now()
  let started = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextCheck: number | null = null
  let inFlight: Promise<void> | null = null
  let controller: AbortController | null = null

  function schedule(delayMs: number): void {
    if (stopped || !options.background)
      return
    nextCheck = options.now() + delayMs
    timer = setTimeout(() => {
      timer = undefined
      nextCheck = null
      const running = check()
      inFlight = running
      void running.finally(() => {
        if (inFlight === running)
          inFlight = null
      })
    }, delayMs)
    timer.unref?.()
  }

  /** One check: never rejects; always schedules the next one (unless stopped). */
  async function check(): Promise<void> {
    let delay = options.checkIntervalMs
    try {
      const mode = await options.readMode()
      const state = await options.readState()
      const due = nextSweepAt(state, mode, bootAt, options.bootDelayMs)
      if (stopped || due === null || options.now() < due)
        return
      controller = new AbortController()
      const outcome = await options.run(controller.signal)
      if (outcome === 'busy')
        delay = Math.min(options.busyRetryMs, options.checkIntervalMs)
    }
    catch (error) {
      logger.warn('automatic file sweep check failed', describeError(error))
    }
    finally {
      controller = null
      schedule(delay)
    }
  }

  /** The first scheduled check at or after `due` (checks repeat every `checkIntervalMs` from the next one). */
  function estimate(due: number): number {
    if (nextCheck === null || stopped)
      return due
    if (due <= nextCheck)
      return nextCheck
    return nextCheck + Math.ceil((due - nextCheck) / options.checkIntervalMs) * options.checkIntervalMs
  }

  /** Waits for the check in flight, and for one that a settling check may have started meanwhile. */
  async function idle(): Promise<void> {
    for (let current = inFlight; current !== null; current = inFlight)
      await current
  }

  return {
    start: () => {
      if (started || stopped)
        return
      started = true
      bootAt = options.now()
      schedule(options.bootDelayMs)
    },

    stop: async () => {
      if (!stopped) {
        stopped = true
        if (timer !== undefined)
          clearTimeout(timer)
        timer = undefined
        nextCheck = null
        controller?.abort()
      }
      await idle()
    },

    status: async () => {
      const [mode, state] = await Promise.all([options.readMode(), options.readState()])
      const due = nextSweepAt(state, mode, bootAt, options.bootDelayMs)
      return { mode, lastAttempt: state.lastAutoSweep, nextRunAt: due === null ? null : estimate(due) }
    },

    idle,

    nextCheckAt: () => nextCheck,
  }
}

/**
 * One automatic run under the maintenance lock (`file-cleanup`, runs not blocked): `done` / `skipped` (stored and logged
 * by `runAutoCleanup`), `failed` (stored as `failed` / `error`, warned), `busy` (another maintenance operation holds
 * the lock: nothing stored), `aborted` (`stop()`: nothing stored). Rejects only when the failure itself cannot be
 * stored.
 */
export async function attemptAutoSweep(context: CleanupContext, signal: AbortSignal): Promise<AutoSweepOutcome> {
  const { deps, logger, now } = context
  let entered = false
  try {
    return await deps.maintenance.exclusive('file-cleanup', async (): Promise<AutoSweepOutcome> => {
      entered = true
      try {
        return (await runAutoCleanup(context, signal)).status
      }
      catch (error) {
        if (signal.aborted)
          throw error
        logger.warn('automatic file sweep failed', { trigger: 'auto', ...describeError(error) })
        await updateFileState(deps, { lastAutoSweep: { at: now(), status: 'failed', reason: 'error', files: 0, diskBytes: 0 } })
        return 'failed'
      }
    })
  }
  catch (error) {
    if (!entered && isBusy(error)) {
      logger.debug('automatic file sweep postponed: another data task is running')
      return 'busy'
    }
    if (signal.aborted) {
      logger.debug('automatic file sweep stopped')
      return 'aborted'
    }
    throw error
  }
}
