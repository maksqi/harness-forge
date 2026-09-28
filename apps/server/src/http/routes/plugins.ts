// Plugin management routes (API.md 5.15) - Phase 0 stubs (501). Owner: W1.3 (W1.3-T9). Keep the export name
// `createPluginsRoutes`. `plugins.reload` of a code plugin requires fresh auth (`requireFreshAuth`).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  pluginLogsQuerySchema,
  pluginParamsSchema,
  pluginRemoveQuerySchema,
  pluginSettingsUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createPluginsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['plugins.list'].path, notImplemented('plugins.list'))
  app.get(apiRoutes['plugins.get'].path, validate('param', pluginParamsSchema), notImplemented('plugins.get'))
  app.delete(apiRoutes['plugins.remove'].path, validate('param', pluginParamsSchema), validate('query', pluginRemoveQuerySchema), notImplemented('plugins.remove'))
  app.post(apiRoutes['plugins.enable'].path, validate('param', pluginParamsSchema), notImplemented('plugins.enable'))
  app.post(apiRoutes['plugins.disable'].path, validate('param', pluginParamsSchema), notImplemented('plugins.disable'))
  app.post(apiRoutes['plugins.reload'].path, validate('param', pluginParamsSchema), notImplemented('plugins.reload'))
  app.get(apiRoutes['plugins.getSettings'].path, validate('param', pluginParamsSchema), notImplemented('plugins.getSettings'))
  app.put(apiRoutes['plugins.updateSettings'].path, validate('param', pluginParamsSchema), validate('json', pluginSettingsUpdateSchema), notImplemented('plugins.updateSettings'))
  app.get(apiRoutes['plugins.icon'].path, validate('param', pluginParamsSchema), notImplemented('plugins.icon'))
  app.get(apiRoutes['plugins.logs'].path, validate('param', pluginParamsSchema), validate('query', pluginLogsQuerySchema), notImplemented('plugins.logs'))
  return app
}
