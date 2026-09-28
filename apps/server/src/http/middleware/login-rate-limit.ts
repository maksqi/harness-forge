// Login rate limit (ARCHITECTURE.md 10.1): at most 5 failed password checks per 15 minutes per remote address and 50
// per 15 minutes globally, then `429 rate_limited` with `retryAfterMs` (the error handler adds `Retry-After`). A
// successful check resets the address. Used by `POST /auth/login` and the current-password check of
// `PUT /auth/password`. Owner: W1.1 (W1.1-T4).
//
// Every attempt counts as a failure from the moment it starts (a reservation) and is released when the password turns
// out to be correct, so concurrent attempts cannot outrun the limit while their scrypt checks are still running. The
// global limit also bounds the memory: at most `globalLimit` timestamps are kept inside the window.
import { HarnessError } from '@harness-forge/shared'

export interface LoginRateLimitOptions {
  /** Failures per address inside the window; default 5. */
  perAddressLimit?: number
  /** Failures over all addresses inside the window; default 50. */
  globalLimit?: number
  /** Default 15 minutes. */
  windowMs?: number
  /** Clock (tests); default `Date.now`. */
  now?: () => number
}

/** A started password check; call `succeeded()` when the password was correct. */
export interface LoginAttempt {
  readonly succeeded: () => void
}

export interface LoginRateLimiter {
  /** Starts an attempt from `address`; throws `rate_limited` (with `retryAfterMs`) when a limit is reached. */
  readonly attempt: (address: string) => LoginAttempt
  /** Remaining attempts for `address` before a limit is reached (diagnostics and tests). */
  readonly remaining: (address: string) => number
}

export const LOGIN_RATE_LIMIT_DEFAULTS = Object.freeze({ perAddressLimit: 5, globalLimit: 50, windowMs: 15 * 60 * 1000 })

/** Addresses are swept for expired entries once the map grows beyond this. */
const SWEEP_THRESHOLD = 256

interface Failure {
  readonly at: number
}

export function rateLimitedError(retryAfterMs: number): HarnessError {
  return new HarnessError({
    code: 'rate_limited',
    message: 'Too many failed login attempts. Try again later.',
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
    action: 'retry',
  })
}

export function createLoginRateLimiter(options: LoginRateLimitOptions = {}): LoginRateLimiter {
  const perAddressLimit = options.perAddressLimit ?? LOGIN_RATE_LIMIT_DEFAULTS.perAddressLimit
  const globalLimit = options.globalLimit ?? LOGIN_RATE_LIMIT_DEFAULTS.globalLimit
  const windowMs = options.windowMs ?? LOGIN_RATE_LIMIT_DEFAULTS.windowMs
  const now = options.now ?? Date.now

  /** Failures in time order. */
  const global: Failure[] = []
  const byAddress = new Map<string, Failure[]>()

  function prune(list: Failure[], cutoff: number): void {
    let expired = 0
    while (expired < list.length && (list[expired]?.at ?? Infinity) <= cutoff)
      expired += 1
    if (expired > 0)
      list.splice(0, expired)
  }

  function removeFailure(list: Failure[] | undefined, failure: Failure): void {
    const index = list?.indexOf(failure) ?? -1
    if (index !== -1)
      list?.splice(index, 1)
  }

  function sweep(cutoff: number): void {
    prune(global, cutoff)
    if (byAddress.size <= SWEEP_THRESHOLD)
      return
    for (const [address, list] of byAddress) {
      prune(list, cutoff)
      if (list.length === 0)
        byAddress.delete(address)
    }
  }

  function retryAfter(list: Failure[], limit: number, time: number): number | null {
    if (list.length < limit)
      return null
    // The attempt becomes possible when enough of the oldest failures have left the window.
    const freeing = list[list.length - limit]
    return (freeing?.at ?? time) + windowMs - time
  }

  function remaining(address: string): number {
    const cutoff = now() - windowMs
    sweep(cutoff)
    const list = byAddress.get(address) ?? []
    prune(list, cutoff)
    return Math.max(0, Math.min(perAddressLimit - list.length, globalLimit - global.length))
  }

  function attempt(address: string): LoginAttempt {
    const time = now()
    const cutoff = time - windowMs
    sweep(cutoff)
    let list = byAddress.get(address)
    if (list !== undefined)
      prune(list, cutoff)
    const waitMs = retryAfter(list ?? [], perAddressLimit, time) ?? retryAfter(global, globalLimit, time)
    if (waitMs !== null)
      throw rateLimitedError(waitMs)

    const failure: Failure = { at: time }
    global.push(failure)
    if (list === undefined) {
      list = []
      byAddress.set(address, list)
    }
    list.push(failure)

    let settled = false
    return {
      succeeded: () => {
        if (settled)
          return
        settled = true
        // Not a failure after all; a successful login also resets the address.
        removeFailure(global, failure)
        byAddress.delete(address)
      },
    }
  }

  return { attempt, remaining }
}
