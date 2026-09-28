// Fresh authentication (ADR-017, API.md 1 "Fresh auth") - Phase 0 stub: no password support yet, so every session is
// fresh. Owner: W1.1 (W1.1-T5).
//
// Contract:
// - `freshAuthMiddleware(deps)`: third `/api` middleware; for routes flagged `fresh` in the route table
//   (`getApiRoute(c)?.route.fresh`) calls `requireFreshAuth(c)`.
// - `requireFreshAuth(c)`: synchronous; when `c.var.auth.enabled` and `Date.now() > (c.var.auth.freshUntil ?? 0)`
//   throws `HarnessError` `forbidden` with `action: 'login'`. Used by routes for the conditional cases (installing a
//   plugin that requires trust, stdio MCP servers, drafts with a stdio server, `plugins.reload` and plugin file writes
//   of code plugins), usually through `SensitiveOperationOptions.requireFreshAuth`.
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppMiddleware } from '../types.ts'

export function requireFreshAuth(_c: AppContext): void {}

export function freshAuthMiddleware(_deps: AppDeps): AppMiddleware {
  return async (_c, next) => {
    await next()
  }
}
