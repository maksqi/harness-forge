// CSRF Origin check (ARCHITECTURE.md 10.2) - Phase 0 pass-through stub. Owner: W1.1 (W1.1-T6).
//
// Contract: first `/api` middleware. For every method except GET / HEAD / OPTIONS: a present `Origin` must equal the
// server origin (scheme + `Host`; `X-Forwarded-Proto` respected) or, when `deps.env.dev`, `http://localhost:3000` /
// `http://127.0.0.1:3000`; without `Origin`, `Sec-Fetch-Site` must be absent, `same-origin` or `none`. Otherwise
// throw `HarnessError` `forbidden`. Runs before authentication, so a cross-site request never reaches a route.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'

export function originCheckMiddleware(_deps: AppDeps): AppMiddleware {
  return async (_c, next) => {
    await next()
  }
}
