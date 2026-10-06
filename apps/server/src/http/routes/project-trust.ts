// Project trust routes (API.md 5.32, ADR-049) - Phase 11 stubs (501). Owner: W11.3. Keep the export name
// `createProjectTrustRoutes`. Thin: validate, call the project trust service, map to the response.
//
// - `GET /projects/:id/trust`: the executable items of a fresh scan of the project folder (hooks of its settings
//   files, `.mcp.json` servers, command files with `` !`cmd` `` spans) with their trust state, review warnings and
//   referenced files; `404` unknown project; an unavailable folder answers `available: false` and no items.
// - `POST /projects/:id/trust` (fresh auth through the route table): approves 1..50 reviewed hashes after a re-scan; a
//   hash that is not current is `409` `stale` and nothing is approved. Answers the fresh list.
// - `DELETE /projects/:id/trust/:sha256` (no fresh auth; idempotent): revokes one approval (also an orphaned one) and
//   answers the fresh list. Approve and revoke emit `project-trust.changed` and `hooks.changed` and stop the affected
//   project MCP servers.
// - Never logs commands, URLs or variable names at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectParamsSchema, projectTrustApproveBodySchema, projectTrustItemParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createProjectTrustRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['projectTrust.list'].path, validate('param', projectParamsSchema), notImplemented('projectTrust.list'))
  app.post(apiRoutes['projectTrust.approve'].path, validate('param', projectParamsSchema), validate('json', projectTrustApproveBodySchema), notImplemented('projectTrust.approve'))
  app.delete(apiRoutes['projectTrust.revoke'].path, validate('param', projectTrustItemParamsSchema), notImplemented('projectTrust.revoke'))
  return app
}
