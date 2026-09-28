// Declarative plugin draft routes (API.md 5.17) - Phase 0 stubs (501). Owner: W3.3 (W3.3-T3). Keep the export name
// `createPluginDraftsRoutes`. A reserved id answers 403 (`pluginDraftSchema` accepts it on purpose).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, draftTestRequestSchema, pluginDraftSchema, pluginManifestUpdateSchema, pluginParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createPluginDraftsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['pluginDrafts.create'].path, validate('json', pluginDraftSchema), notImplemented('pluginDrafts.create'))
  app.post(apiRoutes['pluginDrafts.test'].path, validate('json', draftTestRequestSchema), notImplemented('pluginDrafts.test'))
  app.put(apiRoutes['pluginDrafts.updateManifest'].path, validate('param', pluginParamsSchema), validate('json', pluginManifestUpdateSchema), notImplemented('pluginDrafts.updateManifest'))
  return app
}
