// Global settings routes (API.md 5.3) - Phase 0 stubs (501). Owner: W1.2 (W1.2-T4). Keep the export name
// `createSettingsRoutes`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, settingsUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createSettingsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['settings.get'].path, notImplemented('settings.get'))
  app.put(apiRoutes['settings.update'].path, validate('json', settingsUpdateSchema), notImplemented('settings.update'))
  return app
}
