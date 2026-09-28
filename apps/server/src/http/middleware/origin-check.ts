// CSRF Origin check (ARCHITECTURE.md 10.2, API.md 1 "CSRF"). Owner: W1.1 (W1.1-T6).
//
// First `/api` middleware, so a cross-site request never reaches authentication or a route. For every method except
// GET / HEAD / OPTIONS: a present `Origin` must equal the server origin (scheme + `Host`; `X-Forwarded-Proto` counts
// under the rule of ARCHITECTURE.md 10.6 - from a trusted proxy when `HF_TRUST_PROXY` is set, from anyone when it is
// unset; `X-Forwarded-Host` never counts) or, in development (`deps.env.dev`), `http://localhost:3000` /
// `http://127.0.0.1:3000` (the `nuxt dev` origins); without `Origin`, `Sec-Fetch-Site` must be absent, `same-origin`
// or `none` (so curl passes; it cannot ride on the user's cookie). Otherwise `403 forbidden`. No CORS headers are ever
// sent (see `secure-headers.ts`).
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppMiddleware } from '../types.ts'
import type { ProxyTrustSetting } from './request-info.ts'
import { HarnessError } from '@harness-forge/shared'
import { normalizeOrigin, serverOrigin } from './request-info.ts'

/** Methods that never change state and skip the check. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])
/** `nuxt dev` origins accepted in development only (the dev proxy forwards the browser's `Origin`). */
export const DEV_ORIGINS = Object.freeze(['http://localhost:3000', 'http://127.0.0.1:3000'])
/** `Sec-Fetch-Site` values accepted when `Origin` is absent. */
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none'])

export const CROSS_ORIGIN_MESSAGE = 'Cross-origin request blocked: the Origin header does not match this server.'
export const CROSS_SITE_MESSAGE = 'Cross-site request blocked.'

function forbidden(message: string): HarnessError {
  return new HarnessError({ code: 'forbidden', message })
}

/**
 * Throws `forbidden` when a state-changing request does not come from this server's origin. Pass `deps.env` as
 * `trust` (the scheme of the server origin follows `requestProtocol`).
 */
export function checkRequestOrigin(c: AppContext, allowedOrigins: ReadonlySet<string>, trust?: ProxyTrustSetting): void {
  if (SAFE_METHODS.has(c.req.method.toUpperCase()))
    return
  const origin = c.req.header('origin')
  if (origin !== undefined) {
    const normalized = normalizeOrigin(origin.trim())
    if (normalized !== null && (normalized === serverOrigin(c, trust) || allowedOrigins.has(normalized)))
      return
    throw forbidden(CROSS_ORIGIN_MESSAGE)
  }
  const site = c.req.header('sec-fetch-site')
  if (site !== undefined && !ALLOWED_FETCH_SITES.has(site.trim().toLowerCase()))
    throw forbidden(CROSS_SITE_MESSAGE)
}

export function originCheckMiddleware(deps: AppDeps): AppMiddleware {
  const allowedOrigins: ReadonlySet<string> = new Set(deps.env.dev ? DEV_ORIGINS : [])
  return async (c, next) => {
    checkRequestOrigin(c, allowedOrigins, deps.env)
    await next()
  }
}
