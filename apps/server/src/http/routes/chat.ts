// Chat stream routes (API.md 5.10 and 6). Owner: W2.1. Thin: validate, then `deps.runs`.
// - `POST /chat`: the AI SDK v7 UI message stream of a new run; errors before the stream are JSON envelopes.
// - `GET /chat/:id/stream`: the active run replayed from its first chunk, then live; 204 when idle.
// - `POST /chat/:id/stop`: aborts the run and waits until the partial message is persisted.
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
    const result: ChatStopResult = { stopped: await deps.runs.stop(c.req.valid('param').id) }
    return c.json(result)
  })

  return app
}
