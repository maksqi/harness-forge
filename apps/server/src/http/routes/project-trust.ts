// Project trust routes (API.md 5.32, ADR-049). Owner: W11.3. Thin: validate, call the project trust service
// (`services/project-trust/`), answer the list.
//
// - `GET /projects/:id/trust`: the executable items of a fresh scan of the project folder (hooks of its settings
//   files, `.mcp.json` servers, command files with `` !`cmd` `` spans) with their trust state, review warnings and
//   referenced files; `404` unknown project; an unavailable folder answers `available: false` and no items.
// - `POST /projects/:id/trust` (fresh auth through the route table, and again in the service): approves 1..50 reviewed
//   hashes after a re-scan; a hash that is not current is `409` `stale` and nothing is approved. Answers the fresh list.
// - `DELETE /projects/:id/trust/:sha256` (no fresh auth; idempotent): revokes one approval (also an orphaned one) and
//   the project's orphaned approvals; answers the fresh list (200). Approve and revoke emit `project-trust.changed` and
//   `hooks.changed`; the project MCP manager stops the servers that lost their approval (it reacts to the event).
// - Never logs commands, URLs or variable names at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectParamsSchema, projectTrustApproveBodySchema, projectTrustItemParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

export function createProjectTrustRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['projectTrust.list'].path, validate('param', projectParamsSchema), async (c) => {
    return c.json(await deps.projectTrust.list(c.req.valid('param').id))
  })

  app.post(apiRoutes['projectTrust.approve'].path, validate('param', projectParamsSchema), validate('json', projectTrustApproveBodySchema), async (c) => {
    return c.json(await deps.projectTrust.approve(c.req.valid('param').id, c.req.valid('json').items, freshAuthOptions(c)))
  })

  app.delete(apiRoutes['projectTrust.revoke'].path, validate('param', projectTrustItemParamsSchema), async (c) => {
    const { id, sha256 } = c.req.valid('param')
    return c.json(await deps.projectTrust.revoke(id, sha256))
  })

  return app
}
