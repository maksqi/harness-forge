// `GET /health` (API.md 5.1, public): liveness + versions for Docker `HEALTHCHECK`, gates and Settings -> About.
// Owner after Phase 0: W1.1 (W1.1-T10). Keep the export name `createHealthRoutes`.
import type { Health } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { apiRoutes } from '@harness-forge/shared'
import { Hono } from 'hono'
import { appVersion, packageVersion, webBuildInfoFile, webPublicDir } from '../../paths.ts'

/** Nuxt version recorded by `nuxt generate` next to the served SPA, when there is a build. */
function builtNuxtVersion(): string | undefined {
  const file = webBuildInfoFile()
  if (!existsSync(file) || !existsSync(webPublicDir()))
    return undefined
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as { framework?: { name?: unknown, version?: unknown } }
    return info.framework?.name === 'nuxt' && typeof info.framework.version === 'string' ? info.framework.version : undefined
  }
  catch {
    return undefined
  }
}

/** Library versions read from the installed packages (once, at startup). */
export function readHealthVersions(): Health['versions'] {
  const nuxt = builtNuxtVersion()
  return {
    ai: packageVersion('ai') ?? 'unknown',
    hono: packageVersion('hono') ?? 'unknown',
    ...(nuxt === undefined ? {} : { nuxt }),
  }
}

export function createHealthRoutes(deps: AppDeps): Hono<AppEnv> {
  const version = appVersion()
  const versions = readHealthVersions()
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['health.get'].path, (c) => {
    const body: Health = {
      ok: true,
      version,
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
      safeMode: deps.env.safeMode,
      pluginApiVersion: PLUGIN_API_VERSION,
      versions,
    }
    c.header('Cache-Control', 'no-store')
    return c.json(body)
  })

  return app
}
