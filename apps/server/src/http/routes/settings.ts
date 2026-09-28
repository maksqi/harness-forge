// Global settings routes (API.md 5.3, W1.2-T4). `GET /settings` returns every key with defaults applied; `PUT /settings`
// applies a partial update (strict: unknown keys and bad values -> 400 `validation_error`) and returns the full settings.
// Internal keys (`_...`) are never exposed.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, settingsUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createSettingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['settings.get'].path, async (c) => {
    const settings = await deps.settings.get()
    c.header('Cache-Control', 'no-store')
    return c.json(settings)
  })

  app.put(apiRoutes['settings.update'].path, validate('json', settingsUpdateSchema), async (c) => {
    const settings = await deps.settings.update(c.req.valid('json'))
    c.header('Cache-Control', 'no-store')
    return c.json(settings)
  })

  return app
}
