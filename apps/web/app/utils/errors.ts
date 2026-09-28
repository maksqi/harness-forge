// Error helpers of the web app (docs/UI.md 7.4, docs/API.md section 2). Auto-imported by Nuxt (utils/).
import type { HarnessErrorCode } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'

/**
 * Normalizes anything thrown or stored as an error (API client errors, `useChat` errors, envelopes, envelope JSON,
 * `metadata.error`) into a `HarnessError`: a thin wrapper over `HarnessError.from()`. Unknown values become
 * `internal_error` with a generic message, so raw exception text never reaches the UI.
 */
export function toHarnessError(input: unknown): HarnessError {
  return HarnessError.from(input)
}

/** True when `error` normalizes to one of `codes`. */
export function hasErrorCode(error: unknown, ...codes: HarnessErrorCode[]): boolean {
  return codes.includes(toHarnessError(error).code)
}

/** True for an aborted request (`AbortController`); aborts are cancellations, not errors to show. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Awaits `task` and rethrows every failure as a `HarnessError` (aborts pass through unchanged). Stores wrap their
 * API calls with it so callers can rely on the error type.
 */
export async function withHarnessErrors<T>(task: Promise<T>): Promise<T> {
  try {
    return await task
  }
  catch (error) {
    throw isAbortError(error) ? error : toHarnessError(error)
  }
}
