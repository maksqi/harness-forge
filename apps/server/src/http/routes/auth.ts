// Auth routes (API.md 5.2) - Phase 0 stubs (501). Owner: W1.1 (W1.1-T4). Keep the export name `createAuthRoutes`.
// `auth.status`, `auth.login` and `auth.logout` are public; `auth.setPassword` is fresh (enforced by the middleware).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, loginBodySchema, passwordUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createAuthRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['auth.status'].path, notImplemented('auth.status'))
  app.post(apiRoutes['auth.login'].path, validate('json', loginBodySchema), notImplemented('auth.login'))
  app.post(apiRoutes['auth.logout'].path, notImplemented('auth.logout'))
  app.put(apiRoutes['auth.setPassword'].path, validate('json', passwordUpdateSchema), notImplemented('auth.setPassword'))
  return app
}
