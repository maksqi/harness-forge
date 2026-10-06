// Steer queue routes (API.md 5.26, ADR-042, ARCHITECTURE.md 6.20). Owner: W9.2. Thin: validate, call the chat runner's
// queue (`deps.runs`), map to the response.
//
// - `GET /chat/:id/queue`: the queued messages of the chat, oldest first (an unknown chat is `404`).
// - `POST /chat/:id/queue` (strict body `{ message, modelRef, reasoningEffort, toolMode }`, `201` with the item):
//   `409` `run-idle` when the chat has no active run and no pending approval (send with `POST /chat` instead), `409`
//   `queue-full` at `LIMITS.queueItemsMax`, `409` `exists` when the message id is already used (queued or stored);
//   the parts are normalized like the parts of `POST /chat` (`normalizeUserParts`); every change emits `queue.changed`.
// - `DELETE /chat/:id/queue/:itemId` (`204`): `404` once the message was delivered or started (or never queued); the
//   removal is synchronous, like the step boundary that takes the queue, so a cancel either wins or answers 404.
// - Phase 11 (ADR-048, W11.2): `UserPromptSubmit` runs synchronously before the item is queued (the queue's `add`,
//   `runQueuedPromptHooks`): a block is `409` `conflict` with `details: { reason: 'hook-blocked', chatId, hook }` and
//   queues nothing; a context is kept with the item (attached when it is delivered, never part of the answered item).
// - No fresh auth (a session can already send messages); never logs message contents.
import type { QueueList } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatParamsSchema, chatQueueItemParamsSchema, HarnessError, queueAddBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { chatNotFound } from '../../services/chats/store.ts'
import { validate } from '../validate.ts'

/** `404` for a cancel of a message that is not queued (delivered, started or never queued). */
export function notQueued(itemId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Message ${itemId} is not queued: it was already sent to the agent.` })
}

export function createChatQueueRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['chatQueue.list'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    if (await deps.chats.find(id) === null)
      throw chatNotFound(id)
    const result: QueueList = { items: deps.runs.queueList(id) }
    return c.json(result)
  })

  app.post(apiRoutes['chatQueue.add'].path, validate('param', chatParamsSchema), validate('json', queueAddBodySchema), async (c) => {
    const item = await deps.runs.enqueue(c.req.valid('param').id, c.req.valid('json'), { logger: c.var.logger, requestId: c.var.requestId })
    return c.json(item, 201)
  })

  app.delete(apiRoutes['chatQueue.remove'].path, validate('param', chatQueueItemParamsSchema), async (c) => {
    const { id, itemId } = c.req.valid('param')
    // Synchronous, before any await: the cancel either wins against the step boundary or answers 404.
    if (deps.runs.dequeue(id, itemId))
      return c.body(null, 204)
    if (await deps.chats.find(id) === null)
      throw chatNotFound(id)
    throw notQueued(itemId)
  })

  return app
}
