// Tool routes (API.md 5.12). Owner: W3.5 (W3.5-T3). Thin: validate with the shared schemas, call the tool service.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, toolParamsSchema, toolUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createToolsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['tools.list'].path, async c => c.json({ items: await deps.tools.list() }))

  app.patch(apiRoutes['tools.update'].path, validate('param', toolParamsSchema), validate('json', toolUpdateSchema), async (c) => {
    const { name } = c.req.valid('param')
    return c.json(await deps.tools.update(name, c.req.valid('json')))
  })

  return app
}
