// Steer queue routes (API.md 5.26, ADR-042) - Phase 9 stubs (501). Owner: W9.2. Keep the export name
// `createChatQueueRoutes`. Thin: validate, call the chat runner's queue, map to the response.
//
// - `GET /chat/:id/queue`: the queued messages of the chat, oldest first (an unknown chat is `404`).
// - `POST /chat/:id/queue` (strict body `{ message, modelRef, reasoningEffort, toolMode }`, `201` with the item):
//   `409` `run-idle` when the chat has no active run and no pending approval (send with `POST /chat` instead), `409`
//   `queue-full` above `LIMITS.queueItemsMax`, `409` `exists` when the message id is already used (queued or stored);
//   the parts are normalized like the parts of `POST /chat` (`normalizeUserParts`); every change emits `queue.changed`.
// - `DELETE /chat/:id/queue/:itemId` (`204`): `404` once the message was delivered or started (or never queued).
// - No fresh auth; never logs message contents at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatParamsSchema, chatQueueItemParamsSchema, queueAddBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createChatQueueRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['chatQueue.list'].path, validate('param', chatParamsSchema), notImplemented('chatQueue.list'))
  app.post(apiRoutes['chatQueue.add'].path, validate('param', chatParamsSchema), validate('json', queueAddBodySchema), notImplemented('chatQueue.add'))
  app.delete(apiRoutes['chatQueue.remove'].path, validate('param', chatQueueItemParamsSchema), notImplemented('chatQueue.remove'))
  return app
}
