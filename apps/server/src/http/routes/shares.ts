// Share link routes (API.md 5.20, ADR-025) - Phase 5 stubs (501). Owner: W5.4. Keep the export name
// `createSharesRoutes`. Owner routes live under `/shares` (`shares.create` / `shares.update` need fresh auth, route
// table flags); the public routes `GET /share/:token` and `GET /share/:token/files/:fileId` need no session and answer
// the same 404 for every failure, a malformed token included, so they check `sharePublicParamsSchema` /
// `shareFileParamsSchema` themselves instead of `validate('param', ...)` (which would answer 400).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, shareCreateSchema, shareParamsSchema, sharesQuerySchema, shareUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createSharesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['shares.list'].path, validate('query', sharesQuerySchema), notImplemented('shares.list'))
  app.post(apiRoutes['shares.create'].path, validate('json', shareCreateSchema), notImplemented('shares.create'))
  app.patch(apiRoutes['shares.update'].path, validate('param', shareParamsSchema), validate('json', shareUpdateSchema), notImplemented('shares.update'))
  app.delete(apiRoutes['shares.remove'].path, validate('param', shareParamsSchema), notImplemented('shares.remove'))
  app.get(apiRoutes['shares.view'].path, notImplemented('shares.view'))
  app.get(apiRoutes['shares.file'].path, notImplemented('shares.file'))
  return app
}
