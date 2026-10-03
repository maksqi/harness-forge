// Frozen interface of the maintenance lock (Phase 7, ADR-034 / ADR-035, ARCHITECTURE.md 6.9, 6.14, 6.15).
// Implementation: `createMaintenanceService(deps)` in `services/maintenance/index.ts` (C16, complete). Consumers: the
// data service (`import`, `delete-all`; W5.3, moved here by C16), the key service (`key-rotation`, W7.7), the data
// cleanup (`file-cleanup`, W7.8) and the chat runner (`POST /chat` refused while an operation with `blockRuns` runs).

/** The operations that exclude each other: one of them at a time per process. */
export type MaintenanceKind = 'import' | 'delete-all' | 'key-rotation' | 'file-cleanup'

export const MAINTENANCE_KINDS = ['import', 'delete-all', 'key-rotation', 'file-cleanup'] as const satisfies readonly MaintenanceKind[]

export interface MaintenanceOptions {
  /**
   * While the operation runs, new chat runs are refused: `POST /chat` answers `409 conflict` (`reason: 'busy'`).
   * Runs that already exist are the operation's business (the key rotation stops them). Default false.
   */
  blockRuns?: boolean
}

/** The operation holding the lock (`current()`). */
export interface MaintenanceOperation {
  readonly kind: MaintenanceKind
  readonly blockRuns: boolean
  /** When it took the lock (ms). */
  readonly startedAt: number
}

/**
 * One maintenance operation at a time per process (an in-process lock, not re-entrant). Summaries, exports, previews
 * of other data and normal requests never take it.
 */
export interface MaintenanceService {
  /**
   * Runs `operation` while holding the lock and returns its result. When another operation holds it, fails at once
   * (nothing waits) with `409 conflict` (`reason: 'busy'`). The lock is released when `operation` settles, also when
   * it throws (the error is rethrown unchanged). Calling `exclusive` from inside an operation is `busy` too.
   */
  readonly exclusive: <T>(kind: MaintenanceKind, operation: () => Promise<T>, options?: MaintenanceOptions) => Promise<T>
  /** The operation holding the lock, or null. */
  readonly current: () => MaintenanceOperation | null
}
