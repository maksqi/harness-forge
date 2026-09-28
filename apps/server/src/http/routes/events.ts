// `GET /events` server-sent events (API.md 5.4 and 7) - Phase 0 stub (501). Owner: W1.5 (W1.5-T1). Keep the export
// name `createEventsRoutes`. Stream `deps.events` subscriptions; end the stream on `onClose` (shutdown) and on abort.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented } from '../validate.ts'

export function createEventsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['events.stream'].path, notImplemented('events.stream'))
  return app
}
