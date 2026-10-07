// Plugin management routes (API.md 5.15). Owner: W1.3 (W1.3-T9); Phase 12: W12.2. Thin: validate with the shared
// schemas, call the plugin host, map DTOs. `plugins.reload` of a code plugin requires fresh auth (ADR-017). Phase 12
// (ADR-053 / ADR-054): every detail carries the row's `format`, its `origin` (without the entry overlay), the `claude`
// info of a Claude Code plugin and `editable: false` for one (`plugins-detail.ts`); the list carries the formats.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  pluginLogsQuerySchema,
  pluginParamsSchema,
  pluginRemoveQuerySchema,
  pluginSettingsUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { requireFreshAuth } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'
import { completeDetail, completeSummaries } from './plugins-detail.ts'

/** Headers of a plugin file icon (API.md 5.15 `plugins.icon`). */
export const PLUGIN_ICON_HEADERS = {
  'Cache-Control': 'private, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'',
} as const

export function createPluginsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['plugins.list'].path, async c => c.json({ items: await completeSummaries(deps, await deps.plugins.list()) }))

  app.get(apiRoutes['plugins.get'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await completeDetail(deps, await deps.plugins.get(id)))
  })

  app.delete(apiRoutes['plugins.remove'].path, validate('param', pluginParamsSchema), validate('query', pluginRemoveQuerySchema), async (c) => {
    const { id } = c.req.valid('param')
    const { keepData } = c.req.valid('query')
    await deps.plugins.uninstall(id, { keepData: keepData ?? false })
    return c.body(null, 204)
  })

  app.post(apiRoutes['plugins.enable'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await completeDetail(deps, await deps.plugins.enable(id)))
  })

  app.post(apiRoutes['plugins.disable'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await completeDetail(deps, await deps.plugins.disable(id)))
  })

  app.post(apiRoutes['plugins.reload'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    // Reloading re-runs the plugin's code from disk: fresh auth for code plugins (builtins are part of the server).
    const plugin = await deps.plugins.summary(id)
    if (plugin.kind === 'code' && !plugin.builtin)
      requireFreshAuth(c)
    return c.json(await completeDetail(deps, await deps.plugins.reload(id)))
  })

  app.get(apiRoutes['plugins.getSettings'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.plugins.getSettings(id))
  })

  app.put(apiRoutes['plugins.updateSettings'].path, validate('param', pluginParamsSchema), validate('json', pluginSettingsUpdateSchema), async (c) => {
    const { id } = c.req.valid('param')
    const { values } = c.req.valid('json')
    return c.json(await deps.plugins.updateSettings(id, values))
  })

  app.get(apiRoutes['plugins.icon'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    const icon = await deps.plugins.icon(id)
    if (icon.kind === 'lobe') {
      let version = ''
      try {
        version = `?v=${encodeURIComponent(deps.icons.version)}`
      }
      catch {}
      return c.redirect(`/api/icons/lobe/${encodeURIComponent(icon.slug)}${version}`, 302)
    }
    return c.body(new Uint8Array(icon.body), 200, { ...PLUGIN_ICON_HEADERS, 'Content-Type': icon.contentType })
  })

  app.get(apiRoutes['plugins.logs'].path, validate('param', pluginParamsSchema), validate('query', pluginLogsQuerySchema), async (c) => {
    const { id } = c.req.valid('param')
    const query = c.req.valid('query')
    return c.json({ items: await deps.plugins.logs(id, { after: query.after, limit: query.limit }) })
  })

  return app
}
