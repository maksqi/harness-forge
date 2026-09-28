// Declarative plugin draft routes (API.md 5.17). Owner: W3.3 (W3.3-T3). Thin: validate with the shared schemas and
// call `deps.drafts` (`plugins/drafts/`). A reserved id answers 403 (`pluginDraftSchema` accepts it on purpose); fresh
// auth (ADR-017) is decided by the service, which knows whether a manifest declares a stdio MCP server.
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import { apiRoutes, draftTestRequestSchema, pluginDraftSchema, pluginManifestUpdateSchema, pluginParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { requireFreshAuth } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

/** Fresh-auth callback bound to the request (resolved at call time, so tests can replace `requireFreshAuth`). */
function sensitive(c: AppContext): SensitiveOperationOptions {
  return { requireFreshAuth: () => requireFreshAuth(c) }
}

export function createPluginDraftsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(apiRoutes['pluginDrafts.create'].path, validate('json', pluginDraftSchema), async (c) => {
    const detail = await deps.drafts.create(c.req.valid('json'), sensitive(c))
    return c.json(detail, 201)
  })

  app.post(apiRoutes['pluginDrafts.test'].path, validate('json', draftTestRequestSchema), async (c) => {
    return c.json(await deps.drafts.test(c.req.valid('json')))
  })

  app.put(
    apiRoutes['pluginDrafts.updateManifest'].path,
    validate('param', pluginParamsSchema),
    validate('json', pluginManifestUpdateSchema),
    async (c) => {
      const { id } = c.req.valid('param')
      return c.json(await deps.drafts.updateManifest(id, c.req.valid('json'), sensitive(c)))
    },
  )

  return app
}
