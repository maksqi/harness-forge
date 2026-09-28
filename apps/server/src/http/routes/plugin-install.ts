// Plugin install / trust / export routes (API.md 5.16) - Phase 0 stubs (501). Owner: W3.2 (W3.2-T6, T7). Keep the
// export name `createPluginInstallRoutes`. `inspect` and `install` accept JSON (`pluginInspectBodySchema` /
// `pluginInstallBodySchema`) or multipart (part `file` + `pluginInstallFormSchema`), so their bodies are validated by
// the implementation, not here. `pluginInstall.trust` is fresh (middleware); `install` of a plugin that requires trust
// is fresh through `PluginInstallOptions.authorize`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, pluginParamsSchema, pluginTrustBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createPluginInstallRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['pluginInstall.inspect'].path, notImplemented('pluginInstall.inspect'))
  app.post(apiRoutes['pluginInstall.install'].path, notImplemented('pluginInstall.install'))
  app.post(apiRoutes['pluginInstall.trust'].path, validate('param', pluginParamsSchema), validate('json', pluginTrustBodySchema), notImplemented('pluginInstall.trust'))
  app.get(apiRoutes['pluginInstall.export'].path, validate('param', pluginParamsSchema), notImplemented('pluginInstall.export'))
  return app
}
