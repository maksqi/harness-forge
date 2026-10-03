// Chat stream routes (API.md 5.10 and 6). Owner: W2.1. Thin: validate, then `deps.runs`.
// - `POST /chat`: the AI SDK v7 UI message stream of a new run; errors before the stream are JSON envelopes.
// - `GET /chat/:id/stream`: the active run replayed from its first chunk, then live; 204 when idle.
// - `POST /chat/:id/stop`: aborts the run and waits until the partial message is persisted. Phase 9 (ADR-042): it first
//   empties the chat's steer queue (`clearQueue(id, 'stopped')`, also without a run: a chat waiting for an approval) and
//   answers the removed messages as `dropped` (oldest first; absent when none were queued), so the stopping tab puts
//   them back into its composer.
import type { ChatStopResult } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatParamsSchema, chatRequestBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createChatRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(apiRoutes['chat.send'].path, validate('json', chatRequestBodySchema), async (c) => {
    return deps.runs.start(c.req.valid('json'), { logger: c.var.logger, requestId: c.var.requestId })
  })

  app.get(apiRoutes['chat.resume'].path, validate('param', chatParamsSchema), (c) => {
    return deps.runs.resume(c.req.valid('param').id) ?? c.body(null, 204)
  })

  app.post(apiRoutes['chat.stop'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    // The queue first, so no queued message is steered or started while the run stops.
    const dropped = deps.runs.clearQueue(id, 'stopped')
    const stopped = await deps.runs.stop(id)
    const result: ChatStopResult = { stopped, ...(dropped.length === 0 ? {} : { dropped }) }
    return c.json(result)
  })

  return app
}
