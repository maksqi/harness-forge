// Rate limits of the public share routes (ARCHITECTURE.md 10.7, API.md 5.20). Owner: W5.4 (W5.4-T5).
//
// In memory, sliding windows: views 60 per minute per client address, files 600 per minute per address, 20 refused
// tokens per 10 minutes per address (the address is then refused on both routes until the oldest refusal leaves the
// window) and 6000 requests per minute over every address. A refused request answers `429 rate_limited` with
// `retryAfterMs` (the error handler adds `Retry-After`) and is not counted. The routes call `admit` before any work and
// `invalidToken` when the token named no live share. Memory stays bounded: only admitted requests are recorded (at most
// the global limit per minute) and idle addresses are swept once a minute.
import { HarnessError } from '@harness-forge/shared'

/** The public share routes. */
export type SharePublicRoute = 'view' | 'file'

export interface ShareRateLimitOptions {
  /** `GET /share/:token` per address per minute; default 60. */
  viewsPerMinute?: number
  /** `GET /share/:token/files/:fileId` per address per minute; default 600. */
  filesPerMinute?: number
  /** Refused tokens per address inside `invalidTokenWindowMs`; default 20. */
  invalidTokens?: number
  /** Default 10 minutes. */
  invalidTokenWindowMs?: number
  /** Requests of both routes over every address per minute; default 6000. */
  globalPerMinute?: number
  /** Clock (tests); default `Date.now`. */
  now?: () => number
}

export const SHARE_RATE_LIMIT_DEFAULTS = Object.freeze({
  viewsPerMinute: 60,
  filesPerMinute: 600,
  invalidTokens: 20,
  invalidTokenWindowMs: 10 * 60_000,
  globalPerMinute: 6000,
})

export interface ShareRateLimiter {
  /**
   * Admits one request of `route` from `address` and records it, or throws `rate_limited` (with `retryAfterMs`: the
   * longest wait of the limits reached) without recording it.
   */
  readonly admit: (route: SharePublicRoute, address: string) => void
  /** Records a request from `address` whose token named no live share (it counts against the invalid-token limit). */
  readonly invalidToken: (address: string) => void
}

const MINUTE_MS = 60_000
const GLOBAL_KEY = '*'
const SWEEP_INTERVAL_MS = MINUTE_MS

export const SHARE_RATE_LIMITED_MESSAGE = 'Too many requests for shared links. Try again later.'

export function shareRateLimitedError(retryAfterMs: number): HarnessError {
  return new HarnessError({
    code: 'rate_limited',
    message: SHARE_RATE_LIMITED_MESSAGE,
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
    action: 'retry',
  })
}

/** A sliding-window log per key: at most `limit` hits inside any `windowMs`. */
class SlidingWindow {
  readonly #limit: number
  readonly #windowMs: number
  /** Hit times per key, oldest first. */
  readonly #hits = new Map<string, number[]>()

  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Milliseconds until `key` may add a hit at `time`; 0 when it may now. */
  wait(key: string, time: number): number {
    const hits = this.#live(key, time)
    if (hits === undefined || hits.length < this.#limit)
      return 0
    // Possible again once enough of the oldest hits have left the window.
    return (hits[hits.length - this.#limit] ?? time) + this.#windowMs - time
  }

  add(key: string, time: number): void {
    const hits = this.#hits.get(key)
    if (hits === undefined)
      this.#hits.set(key, [time])
    else
      hits.push(time)
  }

  /** Drops expired hits and idle keys. */
  sweep(time: number): void {
    for (const key of [...this.#hits.keys()])
      this.#live(key, time)
  }

  /** Keys with hits inside the window (tests). */
  get size(): number {
    return this.#hits.size
  }

  #live(key: string, time: number): number[] | undefined {
    const hits = this.#hits.get(key)
    if (hits === undefined)
      return undefined
    const cutoff = time - this.#windowMs
    let expired = 0
    while (expired < hits.length && (hits[expired] ?? Infinity) <= cutoff)
      expired += 1
    if (expired === hits.length) {
      this.#hits.delete(key)
      return undefined
    }
    if (expired > 0)
      hits.splice(0, expired)
    return hits
  }
}

export interface ShareRateLimiterState {
  /** Addresses (plus the global key) with recorded hits in any window (tests: the sweep bounds memory). */
  readonly trackedKeys: () => number
}

export function createShareRateLimiter(options: ShareRateLimitOptions = {}): ShareRateLimiter & ShareRateLimiterState {
  const settings = { ...SHARE_RATE_LIMIT_DEFAULTS, ...options }
  const now = options.now ?? Date.now
  const global = new SlidingWindow(settings.globalPerMinute, MINUTE_MS)
  const views = new SlidingWindow(settings.viewsPerMinute, MINUTE_MS)
  const files = new SlidingWindow(settings.filesPerMinute, MINUTE_MS)
  const invalid = new SlidingWindow(settings.invalidTokens, settings.invalidTokenWindowMs)
  const windows = [global, views, files, invalid]
  let sweptAt = now()

  function maybeSweep(time: number): void {
    if (time - sweptAt < SWEEP_INTERVAL_MS)
      return
    sweptAt = time
    for (const window of windows)
      window.sweep(time)
  }

  return {
    admit: (route, address) => {
      const time = now()
      maybeSweep(time)
      const perAddress = route === 'view' ? views : files
      const wait = Math.max(global.wait(GLOBAL_KEY, time), invalid.wait(address, time), perAddress.wait(address, time))
      if (wait > 0)
        throw shareRateLimitedError(wait)
      global.add(GLOBAL_KEY, time)
      perAddress.add(address, time)
    },
    invalidToken: (address) => {
      invalid.add(address, now())
    },
    trackedKeys: () => windows.reduce((total, window) => total + window.size, 0),
  }
}
