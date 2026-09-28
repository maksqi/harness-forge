// LobeHub icon routes (API.md 5.8, public) - Phase 0 stubs (501). Owner: W1.4 (W1.4-T5). Keep the export name
// `createIconsRoutes`. Files are read from the `@lobehub/icons-static-svg` package directory only.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, iconParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createIconsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['icons.list'].path, notImplemented('icons.list'))
  app.get(apiRoutes['icons.get'].path, validate('param', iconParamsSchema), notImplemented('icons.get'))
  return app
}
