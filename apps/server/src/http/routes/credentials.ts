// Provider credential routes (API.md 5.6) - Phase 0 stubs (501). Owner: W1.2 (W1.2-T5). Keep the export name
// `createCredentialsRoutes`. Responses never echo secret values.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, credentialsUpdateSchema, providerParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createCredentialsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.put(apiRoutes['credentials.set'].path, validate('param', providerParamsSchema), validate('json', credentialsUpdateSchema), notImplemented('credentials.set'))
  app.delete(apiRoutes['credentials.clear'].path, validate('param', providerParamsSchema), notImplemented('credentials.clear'))
  return app
}
