// Chat CRUD routes (API.md 5.9). Owner: W1.5 (W1.5-T4); `POST /chats/:id/branch` by W5.1 (ADR-023). Keep the export name
// `createChatsRoutes`. Thin: validate with the shared schemas, call `deps.chats`, map to the response.
// `DELETE /chats/:id` stops an active run first (`deps.runs.stop`, which waits until the partial message is persisted).
// `POST /chats/:id/branch` and `DELETE /chats/:id/messages/:messageId` (deleting a version, ADR-030, W6.6) are refused
// with `409 conflict` (`reason: 'run-active'`) while the runs registry holds the chat in any phase (`deps.runs.hasRun`),
// so a version switch or delete never races a run's commit or persist.
// Phase 7 (ADR-031, W7.5): `GET /chats?projectId=<id>|none` filters by project; `POST /chats` and `PATCH /chats/:id`
// with `projectId` answer `404` for an unknown project; the move of `PATCH` is refused with `409 run-active` while a run
// holds the chat. The chats service checks both (`update` asks `deps.runs.hasRun` itself), so the routes stay thin.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  chatBranchBodySchema,
  chatCreateSchema,
  chatExportQuerySchema,
  chatMessageParamsSchema,
  chatParamsSchema,
  chatsQuerySchema,
  chatUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { runConflict } from '../../chat/runs.ts'
import { contentDisposition } from '../../services/files/names.ts'
import { validate } from '../validate.ts'

export function createChatsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['chats.list'].path, validate('query', chatsQuerySchema), async (c) => {
    return c.json(await deps.chats.list(c.req.valid('query')))
  })

  app.post(apiRoutes['chats.create'].path, validate('json', chatCreateSchema), async (c) => {
    return c.json(await deps.chats.create(c.req.valid('json')), 201)
  })

  app.get(apiRoutes['chats.get'].path, validate('param', chatParamsSchema), async (c) => {
    return c.json(await deps.chats.get(c.req.valid('param').id))
  })

  app.patch(apiRoutes['chats.update'].path, validate('param', chatParamsSchema), validate('json', chatUpdateSchema), async (c) => {
    return c.json(await deps.chats.update(c.req.valid('param').id, c.req.valid('json')))
  })

  app.delete(apiRoutes['chats.remove'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await deps.runs.stop(id)
    await deps.chats.remove(id)
    return c.body(null, 204)
  })

  app.get(apiRoutes['chats.export'].path, validate('param', chatParamsSchema), validate('query', chatExportQuerySchema), async (c) => {
    const file = await deps.chats.export(c.req.valid('param').id, c.req.valid('query').format)
    return c.body(file.body, 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': contentDisposition('attachment', file.filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'default-src \'none\'; sandbox',
    })
  })

  app.post(apiRoutes['chats.switchBranch'].path, validate('param', chatParamsSchema), validate('json', chatBranchBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    if (deps.runs.hasRun(id))
      throw runConflict(id)
    return c.json(await deps.chats.switchBranch(id, c.req.valid('json').messageId))
  })

  app.delete(apiRoutes['chats.deleteMessage'].path, validate('param', chatMessageParamsSchema), async (c) => {
    const { id, messageId } = c.req.valid('param')
    if (deps.runs.hasRun(id))
      throw runConflict(id)
    return c.json(await deps.chats.deleteMessage(id, messageId))
  })

  return app
}
