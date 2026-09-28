// Helpers for the Phase 0 service stubs. A stub factory returns an object that implements its frozen interface:
// operations throw (or reject with) `HarnessError('not_implemented')` (HTTP 501), while lifecycle hooks, event
// emission and change subscriptions are no-ops so the server boots and later waves can land one service at a time.
import type { Disposable } from '@harness-forge/plugin-sdk'
import { HarnessError } from '@harness-forge/shared'

/** The error thrown by every stubbed operation. */
export function notImplementedError(what: string): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: `${what} is not implemented yet.` })
}

/** A synchronous stub method that throws `not_implemented` (assignable to any method: it takes no parameters). */
export function throwsNotImplemented(what: string): () => never {
  return () => {
    throw notImplementedError(what)
  }
}

/** An async stub method that rejects with `not_implemented`. */
export function rejectsNotImplemented(what: string): () => Promise<never> {
  return () => Promise.reject(notImplementedError(what))
}

/** An async no-op (lifecycle hooks of stubs). */
export async function noopAsync(): Promise<void> {}

/** A `Disposable` that does nothing (subscriptions of stubs). */
export const noopDisposable: Disposable = Object.freeze({ dispose: () => {} })
