// Chat stream routes (API.md 5.10 and 6) - Phase 0 stubs (501). Owner: W2.1. Keep the export name `createChatRoutes`.
// `chat.send` returns `deps.runs.start(...)`; `chat.resume` answers 204 when `deps.runs.resume(id)` is null.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatParamsSchema, chatRequestBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createChatRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['chat.send'].path, validate('json', chatRequestBodySchema), notImplemented('chat.send'))
  app.get(apiRoutes['chat.resume'].path, validate('param', chatParamsSchema), notImplemented('chat.resume'))
  app.post(apiRoutes['chat.stop'].path, validate('param', chatParamsSchema), notImplemented('chat.stop'))
  return app
}
