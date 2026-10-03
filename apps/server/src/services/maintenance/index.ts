// Maintenance lock (Phase 7, ADR-034 / ADR-035, ARCHITECTURE.md 6.9, 6.14, 6.15). Owner: C16 (C16-T1). Implements
// `MaintenanceService` (./types.ts) behind `createMaintenanceService(deps)`.
//
// One import, delete-all, key rotation or file cleanup at a time per process: another one fails at once with `409
// conflict` (`reason: 'busy'`). An operation started with `blockRuns` also makes `POST /chat` answer `409 busy`
// (`assertRunsAllowed`, called by the chat runner before it acquires a chat).
import type { AppDeps } from '../../types.ts'
import type { MaintenanceKind, MaintenanceOperation, MaintenanceOptions, MaintenanceService } from './types.ts'
import { HarnessError } from '@harness-forge/shared'

/** Message of `busyError` (matches the Data page toast, UI.md 15). */
export const MAINTENANCE_BUSY_MESSAGE = 'Another data task is running. Try again when it finishes.'
/** Message of `runsBlockedError` during a key rotation (matches the chat toast, UI.md 15). */
export const KEY_ROTATION_RUNS_MESSAGE = 'The server is rotating its encryption key. Try again in a moment.'
/** Message of `runsBlockedError` for any other operation that blocks runs. */
export const MAINTENANCE_RUNS_MESSAGE = 'A maintenance task is running. Try again in a moment.'

/** `409 conflict` (`reason: 'busy'`): another maintenance operation holds the lock. */
export function busyError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: MAINTENANCE_BUSY_MESSAGE, details: { reason: 'busy' } })
}

/** `409 conflict` (`reason: 'busy'`) of `POST /chat` while `operation` blocks runs. */
export function runsBlockedError(operation: MaintenanceOperation): HarnessError {
  const message = operation.kind === 'key-rotation' ? KEY_ROTATION_RUNS_MESSAGE : MAINTENANCE_RUNS_MESSAGE
  return new HarnessError({ code: 'conflict', message, details: { reason: 'busy' } })
}

/** Throws `runsBlockedError` while an operation with `blockRuns` holds the lock. */
export function assertRunsAllowed(maintenance: MaintenanceService): void {
  const operation = maintenance.current()
  if (operation !== null && operation.blockRuns)
    throw runsBlockedError(operation)
}

export interface MaintenanceServiceOptions {
  /** Clock of `startedAt` (default `Date.now`). */
  now?: () => number
}

/** The lock without `deps` (tests and code that needs a standalone lock). */
export function createMaintenanceLock(options: MaintenanceServiceOptions & { onError?: (kind: MaintenanceKind, error: unknown) => void } = {}): MaintenanceService {
  const now = options.now ?? Date.now
  let holder: MaintenanceOperation | null = null

  return {
    exclusive: async <T>(kind: MaintenanceKind, operation: () => Promise<T>, settings: MaintenanceOptions = {}): Promise<T> => {
      if (holder !== null)
        throw busyError()
      const taken: MaintenanceOperation = Object.freeze({ kind, blockRuns: settings.blockRuns === true, startedAt: now() })
      holder = taken
      try {
        return await operation()
      }
      catch (error) {
        options.onError?.(kind, error)
        throw error
      }
      finally {
        if (holder === taken)
          holder = null
      }
    },
    current: () => holder,
  }
}

export function createMaintenanceService(deps: AppDeps, options: MaintenanceServiceOptions = {}): MaintenanceService {
  const logger = deps.logger.child({ component: 'maintenance' })
  return createMaintenanceLock({
    ...options,
    onError: (kind, error) => logger.debug('maintenance operation failed', { kind, err: error }),
  })
}
