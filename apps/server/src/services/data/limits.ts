// Limits and shared errors of bulk data (ADR-024, API.md 5.19). `LIMITS` of `@harness-forge/shared` holds the
// documented per-request limits; these are the service's own, overridable in tests (`createDataService(deps, { limits })`).
import { HarnessError, LIMITS } from '@harness-forge/shared'

const GIB = 1024 * 1024 * 1024

export interface DataLimits {
  /**
   * Largest backup zip the export writes: fflate cannot write zip64, so every offset must stay below 4 GiB; the
   * pre-check refuses an estimate above this with room to spare.
   */
  backupBytes: number
  /** Most entries of a backup zip, and items of its `files/index.json` (export pre-check and import). */
  backupEntries: number
  /** Sum of the declared sizes of a backup's entries (import; zip bomb guard, independent of the per-entry caps). */
  expandedBytes: number
}

export const DATA_LIMITS: Readonly<DataLimits> = Object.freeze({
  backupBytes: 3.5 * GIB,
  backupEntries: LIMITS.backupEntriesMax,
  expandedBytes: 8 * GIB,
})

/** `1.5 GB`, `250 MB`: sizes in messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB)
    return `${Math.round((bytes / GIB) * 10) / 10} GB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

/** `payload_too_large` with `details.limitBytes`. */
export function payloadTooLarge(message: string, limitBytes: number): HarnessError {
  return new HarnessError({ code: 'payload_too_large', message, details: { limitBytes } })
}

/** `413 payload_too_large` because a backup would hold more entries than `limitEntries` (no zip64). */
export function tooManyEntries(message: string, limitEntries: number): HarnessError {
  return new HarnessError({ code: 'payload_too_large', message, details: { limitEntries } })
}
