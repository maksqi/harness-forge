// Tool routes (API.md 5.12) - Phase 0 stubs (501). Owner: W3.5 (W3.5-T3). Keep the export name `createToolsRoutes`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, toolParamsSchema, toolUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createToolsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['tools.list'].path, notImplemented('tools.list'))
  app.patch(apiRoutes['tools.update'].path, validate('param', toolParamsSchema), validate('json', toolUpdateSchema), notImplemented('tools.update'))
  return app
}
