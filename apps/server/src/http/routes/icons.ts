// LobeHub icon routes (API.md 5.8, public). Files are read from the `@lobehub/icons-static-svg` package directory
// only; the `?v=` query of icon URLs (package version) only busts caches and is ignored here.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, HarnessError, iconParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

/** Response headers of an icon (API.md 5.8). */
export const ICON_HEADERS = {
  'Content-Type': 'image/svg+xml',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'',
} as const

/** `Cache-Control` of the slug list. */
export const ICON_LIST_CACHE_CONTROL = 'public, max-age=86400'

export function createIconsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['icons.list'].path, async (c) => {
    const list = await deps.icons.list()
    return c.json(list, 200, { 'Cache-Control': ICON_LIST_CACHE_CONTROL })
  })

  app.get(apiRoutes['icons.get'].path, validate('param', iconParamsSchema), async (c) => {
    const { slug } = c.req.valid('param')
    const svg = await deps.icons.read(slug)
    if (svg === null)
      throw new HarnessError({ code: 'not_found', message: `Unknown icon "${slug}".` })
    return c.body(svg, 200, { ...ICON_HEADERS })
  })

  return app
}
