// Session authentication (ARCHITECTURE.md 10.1, API.md 1) - Phase 0 stub: no password support yet, so every request
// is authenticated. Owner: W1.1 (W1.1-T5).
//
// Contract: second `/api` middleware; MUST set `c.var.auth` (`RequestAuth`) for every `/api` request. When a password
// is configured (`deps.passwords.source()`), verify the `hf_session` cookie (`deps.sessions.verify`), re-issue it when
// older than 24 h, and throw `unauthorized` (action `login`) for every route that is not `public` in the route table
// (`getApiRoute(c)?.route.public`; unknown routes count as non-public). Without a password: `enabled: false,
// authenticated: true`.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware, RequestAuth } from '../types.ts'

/** `RequestAuth` when no password is configured. */
export const AUTH_DISABLED: Readonly<RequestAuth> = Object.freeze({
  enabled: false,
  authenticated: true,
  source: null,
  session: null,
  freshUntil: null,
})

export function sessionAuthMiddleware(_deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    c.set('auth', { ...AUTH_DISABLED })
    await next()
  }
}
