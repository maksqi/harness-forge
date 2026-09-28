// Provider routes (API.md 5.5): the provider list, enable / disable and credential tests. Credentials themselves are
// written by `credentials.ts` (W1.2).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, providerParamsSchema, providerTestBodySchema, providerUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createProvidersRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['providers.list'].path, async (c) => {
    return c.json({ items: await deps.providers.list() })
  })

  app.patch(apiRoutes['providers.update'].path, validate('param', providerParamsSchema), validate('json', providerUpdateSchema), async (c) => {
    const { id } = c.req.valid('param')
    const { enabled } = c.req.valid('json')
    return c.json(await deps.providers.setEnabled(id, enabled))
  })

  app.post(apiRoutes['providers.test'].path, validate('param', providerParamsSchema), validate('json', providerTestBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    const { values } = c.req.valid('json')
    return c.json(await deps.providers.test(id, values))
  })

  return app
}
