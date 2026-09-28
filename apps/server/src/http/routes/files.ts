// Upload routes (API.md 5.11) - Phase 0 stubs (501). Owner: W1.5 (W1.5-T5). Keep the export name `createFilesRoutes`.
// `POST /files` is multipart with exactly one part named `file`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, fileParamsSchema, fileUploadFormSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createFilesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['files.upload'].path, validate('form', fileUploadFormSchema), notImplemented('files.upload'))
  app.get(apiRoutes['files.get'].path, validate('param', fileParamsSchema), notImplemented('files.get'))
  return app
}
