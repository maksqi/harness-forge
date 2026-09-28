// `GET /commands` (API.md 5.14) - Phase 0 stub (501). Owner: W2.1 (W2.1-T11). Keep the export name
// `createCommandsRoutes`. Lists `deps.registry.commands` (server-side commands only).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented } from '../validate.ts'

export function createCommandsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['commands.list'].path, notImplemented('commands.list'))
  return app
}
