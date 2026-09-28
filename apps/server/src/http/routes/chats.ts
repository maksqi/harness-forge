// Chat CRUD routes (API.md 5.9). Owner: W1.5 (W1.5-T4). Keep the export name `createChatsRoutes`. Thin: validate with
// the shared schemas, call `deps.chats`, map to the response. `DELETE /chats/:id` stops an active run first
// (`deps.runs.stop`, which waits until the partial message is persisted). `POST /chats/:id/branch` (ADR-023) is a
// Phase 5 stub (501) until W5.1.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  chatBranchBodySchema,
  chatCreateSchema,
  chatExportQuerySchema,
  chatParamsSchema,
  chatsQuerySchema,
  chatUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { contentDisposition } from '../../services/files/names.ts'
import { notImplemented, validate } from '../validate.ts'

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

  app.post(apiRoutes['chats.switchBranch'].path, validate('param', chatParamsSchema), validate('json', chatBranchBodySchema), notImplemented('chats.switchBranch'))

  return app
}
