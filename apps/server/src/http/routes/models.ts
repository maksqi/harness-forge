// Model catalog routes (API.md 5.7). Model refs never appear in paths: models are addressed by `providerId` +
// `modelId` in bodies and query strings.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  customModelInputSchema,
  customModelKeySchema,
  modelPrefsUpdateSchema,
  modelsQuerySchema,
  providerParamsSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createModelsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['models.list'].path, validate('query', modelsQuerySchema), async (c) => {
    const query = c.req.valid('query')
    const items = await deps.catalog.list({ providerId: query.providerId, includeHidden: query.includeHidden ?? false })
    return c.json({ items })
  })

  app.post(apiRoutes['models.refresh'].path, validate('param', providerParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json({ items: await deps.catalog.refresh(id) })
  })

  app.put(apiRoutes['models.updatePrefs'].path, validate('json', modelPrefsUpdateSchema), async (c) => {
    return c.json(await deps.catalog.updatePrefs(c.req.valid('json')))
  })

  app.post(apiRoutes['models.addCustom'].path, validate('json', customModelInputSchema), async (c) => {
    return c.json(await deps.catalog.addCustom(c.req.valid('json')), 201)
  })

  app.delete(apiRoutes['models.removeCustom'].path, validate('query', customModelKeySchema), async (c) => {
    await deps.catalog.removeCustom(c.req.valid('query'))
    return c.body(null, 204)
  })

  return app
}
