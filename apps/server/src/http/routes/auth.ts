// Auth routes (API.md 5.2, ARCHITECTURE.md 10.1). Owner: W1.1 (W1.1-T4). Keep the export name `createAuthRoutes`.
// `auth.status`, `auth.login` and `auth.logout` are public; `auth.setPassword` is fresh (enforced by the middleware).
//
// - `GET /auth/status`: the `AuthStatus` of the request (`c.var.auth`, set by the session middleware).
// - `POST /auth/login`: rate limited (5 failures / 15 min per client address, 50 globally); sets `hf_session` with
//   `authAt = now`, which also opens the 10-minute fresh-auth window. Without a password: `enabled: false`, no cookie.
//   The client address is the TCP peer, or the `X-Forwarded-For` client when the peer is a proxy trusted by
//   `HF_TRUST_PROXY` (ADR-026, `clientAddress`); failures log both the resolved `address` and the TCP `peer`.
// - `POST /auth/logout`: clears the cookie (sessions are stateless; changing the password ends all of them).
// - `PUT /auth/password`: set, change or remove the stored password (current password required when one is set);
//   every other session ends and the caller gets a new cookie.
import type { AuthStatus } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { LoginAttempt } from '../middleware/login-rate-limit.ts'
import type { AppContext, AppEnv, RequestAuth } from '../types.ts'
import { apiRoutes, HarnessError, loginBodySchema, passwordUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { isLoopbackHost } from '../../env.ts'
import { createLoginRateLimiter } from '../middleware/login-rate-limit.ts'
import { clientAddress, peerAddress } from '../middleware/request-info.ts'
import { AUTH_DISABLED, clearSessionCookie, setSessionCookie } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'
import { validate } from '../validate.ts'

/** Message of the `401` answered for a wrong password (API.md 5.2). */
export const INVALID_PASSWORD_MESSAGE = 'Invalid password'

/** The public `AuthStatus` of a request. */
export function authStatusOf(auth: RequestAuth): AuthStatus {
  return { enabled: auth.enabled, authenticated: auth.authenticated, source: auth.source, freshUntil: auth.freshUntil }
}

const DISABLED_STATUS: AuthStatus = authStatusOf(AUTH_DISABLED)

export function createAuthRoutes(deps: AppDeps): Hono<AppEnv> {
  const limiter = createLoginRateLimiter()
  const app = new Hono<AppEnv>()

  /**
   * Checks a password under the rate limit, keyed by the client address (behind a trusted proxy: the forwarded
   * client); resets that address on success.
   */
  async function checkPassword(c: AppContext, password: string): Promise<boolean> {
    const address = clientAddress(c, deps.env)
    const peer = peerAddress(c)
    let attempt: LoginAttempt
    try {
      attempt = limiter.attempt(address)
    }
    catch (error) {
      c.get('logger').warn('login rate limit reached', { address, peer })
      throw error
    }
    const valid = await deps.passwords.check(password)
    if (valid)
      attempt.succeeded()
    else
      c.get('logger').warn('password check failed', { address, peer })
    return valid
  }

  /** Starts a session whose password login happened now (fresh for `FRESH_AUTH_WINDOW_MS`). */
  async function startSession(c: AppContext, source: NonNullable<AuthStatus['source']>): Promise<AuthStatus> {
    const now = Date.now()
    setSessionCookie(c, await deps.sessions.issue({ authAt: now, now }), deps.env)
    return { enabled: true, authenticated: true, source, freshUntil: now + FRESH_AUTH_WINDOW_MS }
  }

  app.get(apiRoutes['auth.status'].path, c => c.json(authStatusOf(c.get('auth'))))

  app.post(apiRoutes['auth.login'].path, validate('json', loginBodySchema), async (c) => {
    const { password } = c.req.valid('json')
    const source = await deps.passwords.source()
    if (source === null)
      return c.json(DISABLED_STATUS)
    if (!(await checkPassword(c, password)))
      throw new HarnessError({ code: 'unauthorized', message: INVALID_PASSWORD_MESSAGE })
    return c.json(await startSession(c, source))
  })

  app.post(apiRoutes['auth.logout'].path, (c) => {
    clearSessionCookie(c, deps.env)
    return c.body(null, 204)
  })

  app.put(apiRoutes['auth.setPassword'].path, validate('json', passwordUpdateSchema), async (c) => {
    const { currentPassword, newPassword } = c.req.valid('json')
    const source = await deps.passwords.source()
    if (source === 'env') {
      throw new HarnessError({
        code: 'conflict',
        message: 'The password is set by HF_PASSWORD; change or remove it in the server environment.',
        details: { reason: 'env-password' },
      })
    }
    if (newPassword === null && !isLoopbackHost(deps.env.host) && !deps.env.insecure) {
      throw new HarnessError({
        code: 'conflict',
        message: `The password cannot be removed while the server listens on ${deps.env.host} (set HF_INSECURE=1 to allow it).`,
        details: { reason: 'insecure-bind' },
      })
    }
    if (source === 'settings') {
      if (currentPassword === undefined)
        throw new HarnessError({ code: 'forbidden', message: 'Enter the current password to change it.' })
      if (!(await checkPassword(c, currentPassword)))
        throw new HarnessError({ code: 'forbidden', message: 'The current password is incorrect.' })
    }

    await deps.passwords.set(newPassword)
    c.get('logger').info(newPassword === null ? 'password removed' : 'password changed')
    if (newPassword === null) {
      clearSessionCookie(c, deps.env)
      return c.json(DISABLED_STATUS)
    }
    return c.json(await startSession(c, 'settings'))
  })

  return app
}
