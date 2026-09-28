// Model catalog routes (API.md 5.7) - Phase 0 stubs (501). Owner: W1.4 (W1.4-T4). Keep the export name
// `createModelsRoutes`. Model refs never appear in paths: models are addressed by `providerId` + `modelId`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  customModelInputSchema,
  customModelKeySchema,
  modelPrefsUpdateSchema,
  modelsQuerySchema,
  providerParamsSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createModelsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['models.list'].path, validate('query', modelsQuerySchema), notImplemented('models.list'))
  app.post(apiRoutes['models.refresh'].path, validate('param', providerParamsSchema), notImplemented('models.refresh'))
  app.put(apiRoutes['models.updatePrefs'].path, validate('json', modelPrefsUpdateSchema), notImplemented('models.updatePrefs'))
  app.post(apiRoutes['models.addCustom'].path, validate('json', customModelInputSchema), notImplemented('models.addCustom'))
  app.delete(apiRoutes['models.removeCustom'].path, validate('query', customModelKeySchema), notImplemented('models.removeCustom'))
  return app
}
