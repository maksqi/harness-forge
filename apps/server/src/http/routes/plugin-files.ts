// Code plugin scaffold / files / build routes (API.md 5.18) - Phase 0 stubs (501). Owner: W3.4 (W3.4-T2, T3). Keep
// the export name `createPluginFilesRoutes`.
//
// The route table writes the rest path as `/plugins/:id/files/*`; Hono binds it as `:path{.+}` so `path` is a
// (decoded) param validated by `pluginFileParamsSchema` (`..`, absolute paths and backslashes are rejected with 400;
// the implementation still resolves the realpath inside the plugin directory). `/plugins/:id/files` (the tree) never
// matches it.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  pluginBuildBodySchema,
  pluginFileParamsSchema,
  pluginFileWriteSchema,
  pluginParamsSchema,
  scaffoldRequestSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

/** Hono path of `pluginFiles.read` / `write` / `remove` (`/plugins/:id/files/*` in the route table). */
export const PLUGIN_FILE_PATH = '/plugins/:id/files/:path{.+}'

export function createPluginFilesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['pluginFiles.scaffold'].path, validate('json', scaffoldRequestSchema), notImplemented('pluginFiles.scaffold'))
  app.get(apiRoutes['pluginFiles.list'].path, validate('param', pluginParamsSchema), notImplemented('pluginFiles.list'))
  app.get(PLUGIN_FILE_PATH, validate('param', pluginFileParamsSchema), notImplemented('pluginFiles.read'))
  app.put(PLUGIN_FILE_PATH, validate('param', pluginFileParamsSchema), validate('json', pluginFileWriteSchema), notImplemented('pluginFiles.write'))
  app.delete(PLUGIN_FILE_PATH, validate('param', pluginFileParamsSchema), notImplemented('pluginFiles.remove'))
  app.post(apiRoutes['pluginFiles.build'].path, validate('param', pluginParamsSchema), validate('json', pluginBuildBodySchema), notImplemented('pluginFiles.build'))
  return app
}
