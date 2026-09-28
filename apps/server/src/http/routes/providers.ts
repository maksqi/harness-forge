// Provider routes (API.md 5.5) - Phase 0 stubs (501). Owner: W1.4 (W1.4-T2). Keep the export name
// `createProvidersRoutes`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, providerParamsSchema, providerTestBodySchema, providerUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createProvidersRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['providers.list'].path, notImplemented('providers.list'))
  app.patch(apiRoutes['providers.update'].path, validate('param', providerParamsSchema), validate('json', providerUpdateSchema), notImplemented('providers.update'))
  app.post(apiRoutes['providers.test'].path, validate('param', providerParamsSchema), validate('json', providerTestBodySchema), notImplemented('providers.test'))
  return app
}
