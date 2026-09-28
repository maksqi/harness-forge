// Bulk data routes (API.md 5.19, ADR-024) - Phase 5 stubs (501). Owner: W5.3. Keep the export name `createDataRoutes`.
// `GET /data/export` streams a zip; `POST /data/import` is multipart: the upload (a backup zip or a chat JSON export)
// in part `file` + `DataImportForm` fields; `POST /data/delete` needs fresh auth (route table flag).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, dataDeleteBodySchema, dataExportQuerySchema, dataImportFormSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createDataRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['data.summary'].path, notImplemented('data.summary'))
  app.get(apiRoutes['data.export'].path, validate('query', dataExportQuerySchema), notImplemented('data.export'))
  app.post(apiRoutes['data.import'].path, validate('form', dataImportFormSchema), notImplemented('data.import'))
  app.post(apiRoutes['data.deleteAll'].path, validate('json', dataDeleteBodySchema), notImplemented('data.deleteAll'))
  return app
}
