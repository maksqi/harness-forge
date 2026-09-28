// Login page rules (docs/UI.md 9.7, 15; docs/API.md 5.2): wrong password and rate-limit messages.
import { toHarnessError } from '~/utils/errors'

export interface LoginFailure {
  /** Shown as is; empty for a rate limit (the countdown text is built from `retryAt`). */
  message: string
  /** Epoch ms after which another attempt is accepted (rate limit), else null. */
  retryAt: number | null
}

/** "Too many attempts. Try again in 30s." */
export function rateLimitMessage(seconds: number): string {
  return `Too many attempts. Try again in ${Math.max(1, Math.ceil(seconds))}s.`
}

/** `POST /auth/login` failures: 401 -> "Wrong password", 429 -> a countdown, anything else -> the server message. */
export function loginFailure(error: unknown, now: number = Date.now()): LoginFailure {
  const failure = toHarnessError(error)
  if (failure.code === 'unauthorized')
    return { message: 'Wrong password', retryAt: null }
  if (failure.code === 'rate_limited')
    return { message: '', retryAt: now + Math.max(1000, failure.retryAfterMs ?? 1000) }
  return { message: failure.message, retryAt: null }
}

/** Whole seconds left before `retryAt` (0 when it passed or there is none). */
export function secondsUntil(retryAt: number | null, now: number): number {
  return retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000))
}
