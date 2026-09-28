// Session authentication (ARCHITECTURE.md 10.1, API.md 1 "Auth"). Owner: W1.1 (W1.1-T5).
//
// Second `/api` middleware; sets `c.var.auth` (`RequestAuth`) for every `/api` request. Without a password
// (`deps.passwords.source()` is null) every request is authenticated. With a password the `hf_session` cookie is
// verified (`deps.sessions.verify`: signature, expiry, epoch); every route that is not `public` in the route table
// (unknown routes count as non-public) answers `401 unauthorized` (action `login`) without a valid session. A session
// older than 24 h is re-issued with the same `authAt` (rolling), unless the route set or cleared the cookie itself.
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppMiddleware, RequestAuth } from '../types.ts'
import { HarnessError } from '@harness-forge/shared'
import { getCookie } from 'hono/cookie'
import { getApiRoute } from '../route-match.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'
import { isHttpsRequest } from './request-info.ts'
import { updateResponseHeaders } from './response-headers.ts'

/** Name of the session cookie (DECISIONS.md "Identifiers"). */
export const SESSION_COOKIE_NAME = 'hf_session'
/** Cookie `Max-Age`: 30 days, the token lifetime. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
/** Sessions older than this are re-issued on use (rolling). */
export const SESSION_ROLL_AFTER_MS = 24 * 60 * 60 * 1000

/** `RequestAuth` when no password is configured. */
export const AUTH_DISABLED: Readonly<RequestAuth> = Object.freeze({
  enabled: false,
  authenticated: true,
  source: null,
  session: null,
  freshUntil: null,
})

/** Message of the `401 unauthorized` answered to requests without a valid session. */
export const UNAUTHORIZED_MESSAGE = 'Log in to continue.'

/** `Set-Cookie` value of the session cookie; an empty token with `maxAgeSeconds` 0 clears it. */
export function sessionCookieHeader(token: string, options: { secure: boolean, maxAgeSeconds?: number }): string {
  const maxAge = options.maxAgeSeconds ?? SESSION_COOKIE_MAX_AGE_SECONDS
  const attributes = [`${SESSION_COOKIE_NAME}=${token}`, `Max-Age=${maxAge}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (options.secure)
    attributes.push('Secure')
  return attributes.join('; ')
}

/** Adds the session cookie to the response (`Secure` over HTTPS). Call before the response is built, or after `next()`. */
export function setSessionCookie(c: AppContext, token: string): void {
  c.header('Set-Cookie', sessionCookieHeader(token, { secure: isHttpsRequest(c) }), { append: true })
}

/** Clears the session cookie (`Max-Age=0`). */
export function clearSessionCookie(c: AppContext): void {
  c.header('Set-Cookie', sessionCookieHeader('', { secure: isHttpsRequest(c), maxAgeSeconds: 0 }), { append: true })
}

function setsSessionCookie(headers: Headers): boolean {
  return headers.getSetCookie().some(cookie => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))
}

/** The `AuthStatus` fields derived from a verified session. */
export function sessionAuth(source: RequestAuth['source'], session: RequestAuth['session']): RequestAuth {
  return {
    enabled: true,
    authenticated: session !== null,
    source,
    session,
    freshUntil: session === null ? null : session.authAt + FRESH_AUTH_WINDOW_MS,
  }
}

export function sessionAuthMiddleware(deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    const source = await deps.passwords.source()
    if (source === null) {
      c.set('auth', { ...AUTH_DISABLED })
      await next()
      return
    }

    const now = Date.now()
    const token = getCookie(c, SESSION_COOKIE_NAME)
    const session = token === undefined || token === '' ? null : await deps.sessions.verify(token, now)
    c.set('auth', sessionAuth(source, session))
    if (session === null && getApiRoute(c)?.route.public !== true)
      throw new HarnessError({ code: 'unauthorized', message: UNAUTHORIZED_MESSAGE, action: 'login' })

    const rolled = session !== null && now - session.iat > SESSION_ROLL_AFTER_MS
      ? await deps.sessions.issue({ authAt: session.authAt, now })
      : null
    await next()
    if (rolled !== null) {
      // Login, logout and password changes set the cookie themselves: never override their answer.
      updateResponseHeaders(c, (headers) => {
        if (!setsSessionCookie(headers))
          headers.append('Set-Cookie', sessionCookieHeader(rolled, { secure: isHttpsRequest(c) }))
      })
    }
  }
}
