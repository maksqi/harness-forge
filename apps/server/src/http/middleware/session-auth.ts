// Session authentication (ARCHITECTURE.md 10.1, API.md 1 "Auth"). Owner: W1.1 (W1.1-T5), hardened by W4.1.
//
// Second `/api` middleware; sets `c.var.auth` (`RequestAuth`) for every `/api` request. Without a password
// (`deps.passwords.source()` is null) every request is authenticated, but only when it is addressed to a local host
// name (`localhost`, `*.localhost`, a loopback IP) unless `HF_INSECURE=1`: a web page whose DNS name is rebound to
// 127.0.0.1 is same-origin with itself, passes the Origin check and would otherwise drive the whole API (DNS
// rebinding); such requests get `403 forbidden`. A password (or `HF_INSECURE=1`) is required to reach a password-less
// server through any other host name (reverse proxy, tunnel, LAN name).
// With a password the `hf_session` cookie is verified (`deps.sessions.verify`: signature, expiry, epoch); every route
// that is not `public` in the route table (unknown routes count as non-public) answers `401 unauthorized` (action
// `login`) without a valid session. A session older than 24 h is re-issued with the same `authAt` (rolling), unless
// the route set or cleared the cookie itself. The rolled token is signed before the handler runs: when a master-key
// rotation swapped the key during the request (`keyring.keyVersion` changed, ADR-034), it would be invalid already and
// is dropped (the rotation route issues the caller's new cookie itself).
import type { Env } from '../../env.ts'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppMiddleware, RequestAuth } from '../types.ts'
import type { ProxyTrustSetting } from './request-info.ts'
import { HarnessError } from '@harness-forge/shared'
import { getCookie } from 'hono/cookie'
import { classifyAddress } from '../../security/ssrf.ts'
import { getApiRoute } from '../route-match.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'
import { isHttpsRequest, requestHostname } from './request-info.ts'
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

/** Message of the `403 forbidden` answered to a request for a non-local host name while no password is set. */
export const LOCAL_HOST_ONLY_MESSAGE = 'Without a password this server only answers requests addressed to localhost or 127.0.0.1 '
  + '(DNS rebinding protection). Open it through localhost, or set a password (HF_PASSWORD) to use another host name.'

/** `localhost`, `*.localhost` (never resolved through DNS by browsers) and loopback IP literals. */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost') || classifyAddress(name) === 'loopback'
}

/**
 * DNS rebinding guard of a password-less server: throws `403 forbidden` for a request addressed to anything but a local
 * host name, unless `HF_INSECURE=1` (see the module comment). Only the `Host` header counts, never `X-Forwarded-Host`,
 * whatever `HF_TRUST_PROXY` says: the rebound page connects from 127.0.0.1 and can send any header (ADR-026).
 */
export function checkPasswordlessHost(c: AppContext, env: Pick<Env, 'insecure'>): void {
  if (env.insecure)
    return
  const hostname = requestHostname(c)
  if (hostname === null || !isLocalHostname(hostname))
    throw new HarnessError({ code: 'forbidden', message: LOCAL_HOST_ONLY_MESSAGE })
}

/** `Set-Cookie` value of the session cookie; an empty token with `maxAgeSeconds` 0 clears it. */
export function sessionCookieHeader(token: string, options: { secure: boolean, maxAgeSeconds?: number }): string {
  const maxAge = options.maxAgeSeconds ?? SESSION_COOKIE_MAX_AGE_SECONDS
  const attributes = [`${SESSION_COOKIE_NAME}=${token}`, `Max-Age=${maxAge}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (options.secure)
    attributes.push('Secure')
  return attributes.join('; ')
}

/**
 * Adds the session cookie to the response (`Secure` over HTTPS: pass `deps.env` so `X-Forwarded-Proto` counts only
 * from a trusted proxy when `HF_TRUST_PROXY` is set). Call before the response is built, or after `next()`.
 */
export function setSessionCookie(c: AppContext, token: string, trust?: ProxyTrustSetting): void {
  c.header('Set-Cookie', sessionCookieHeader(token, { secure: isHttpsRequest(c, trust) }), { append: true })
}

/** Clears the session cookie (`Max-Age=0`; `Secure` under the rule of `setSessionCookie`). */
export function clearSessionCookie(c: AppContext, trust?: ProxyTrustSetting): void {
  c.header('Set-Cookie', sessionCookieHeader('', { secure: isHttpsRequest(c, trust), maxAgeSeconds: 0 }), { append: true })
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
      checkPasswordlessHost(c, deps.env)
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

    const keyVersion = deps.keyring.keyVersion
    const rolled = session !== null && now - session.iat > SESSION_ROLL_AFTER_MS
      ? await deps.sessions.issue({ authAt: session.authAt, now })
      : null
    await next()
    // Signed under a key that a rotation replaced during the request: no longer valid, never sent.
    if (rolled !== null && deps.keyring.keyVersion === keyVersion) {
      // Login, logout and password changes set the cookie themselves: never override their answer.
      updateResponseHeaders(c, (headers) => {
        if (!setsSessionCookie(headers))
          headers.append('Set-Cookie', sessionCookieHeader(rolled, { secure: isHttpsRequest(c, deps.env) }))
      })
    }
  }
}
