// Background task routes (API.md 5.30, ADR-046) - Phase 10 stubs (501). Owner: W10.4. Keep the export name
// `createChatTasksRoutes`. Thin: validate, call the chat runner's background tasks, map to the response.
//
// - `GET /chat/:id/tasks`: the background tasks of the chat, newest first (an unknown chat is `404`).
// - `POST /chat/:id/tasks/:taskId/stop`: aborts a running task and answers it (`aborted`; a task that already ended is
//   answered as it is); an unknown chat or task is `404`. The chat's own Stop (`POST /chat/:id/stop`) never stops
//   background tasks; "Stop all" is one call per task.
// - No fresh auth; never logs prompts or reports at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatParamsSchema, chatTaskParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createChatTasksRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['chatTasks.list'].path, validate('param', chatParamsSchema), notImplemented('chatTasks.list'))
  app.post(apiRoutes['chatTasks.stop'].path, validate('param', chatTaskParamsSchema), notImplemented('chatTasks.stop'))
  return app
}
