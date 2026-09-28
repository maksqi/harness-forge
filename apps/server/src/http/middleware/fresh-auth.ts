// Fresh authentication (ADR-017, API.md 1 "Fresh auth", ARCHITECTURE.md 10.1). Owner: W1.1 (W1.1-T5).
//
// - `freshAuthMiddleware(deps)`: third `/api` middleware; routes flagged `fresh` in the route table
//   (`getApiRoute(c)?.route.fresh`) call `requireFreshAuth(c)` before anything else runs.
// - `requireFreshAuth(c)`: synchronous; when a password is configured and the session's password login
//   (`authAt`) is more than 10 minutes old (`Date.now() > c.var.auth.freshUntil`), throws `403 forbidden` with
//   `action: 'login'` (the web asks for the password, calls `POST /auth/login` and retries). Routes use it for the
//   conditional cases (installing a plugin that requires trust, stdio MCP servers, drafts with a stdio server,
//   `plugins.reload`, plugin file writes / deletes of code plugins), usually through
//   `SensitiveOperationOptions.requireFreshAuth` (`freshAuthOptions(c)`).
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { AppContext, AppMiddleware, RequestAuth } from '../types.ts'
import { HarnessError } from '@harness-forge/shared'
import { getApiRoute } from '../route-match.ts'

/** Message of the `403 forbidden` answered when fresh auth is missing. */
export const FRESH_AUTH_REQUIRED_MESSAGE = 'Confirm your password to continue: this action needs a login within the last 10 minutes.'

export function freshAuthRequiredError(): HarnessError {
  return new HarnessError({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
}

/** True when `auth` allows a sensitive operation at `now`: no password, or a password login within the window. */
export function isFreshAuth(auth: RequestAuth | undefined, now: number = Date.now()): boolean {
  if (auth === undefined)
    return false
  if (!auth.enabled)
    return true
  return auth.freshUntil !== null && now <= auth.freshUntil
}

/** Throws `403 forbidden` (action `login`) unless the request is freshly authenticated. */
export function requireFreshAuth(c: AppContext): void {
  // `auth` is always set under `/api`; anything else (a misuse outside the API) fails closed.
  if (!isFreshAuth(c.get('auth') as RequestAuth | undefined))
    throw freshAuthRequiredError()
}

/** `SensitiveOperationOptions` bound to the request, for services that decide about fresh auth themselves. */
export function freshAuthOptions(c: AppContext): SensitiveOperationOptions {
  return { requireFreshAuth: () => requireFreshAuth(c) }
}

export function freshAuthMiddleware(_deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    if (getApiRoute(c)?.route.fresh === true)
      requireFreshAuth(c)
    await next()
  }
}
