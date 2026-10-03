// Changes routes (API.md 5.24, ADR-036, ADR-037). Owner: W8.2. Thin: validate, check the chat, call the checkpoint
// service (`deps.checkpoints`), answer its DTO.
//
// - Chat-scoped (`/chats/:id/changes...`, `/chats/:id/git`, `/chats/:id/rewind`); none needs fresh auth. Each path
//   differs from the `chats.ts` routes under `/chats/:id` in its static segments or its method (API.md 8).
// - Every route answers `404 not_found` for an unknown chat first ("Chat <id> not found.").
// - The chat's current project counts. Without a project (or with a folder that cannot be opened) `changes.list` and
//   `changes.git` answer `200` with `available: false` + `reason` (the service's read members); every other route
//   answers `400 validation_error` with the project service's message.
// - Revert, undo and rewind are `409` (`run-active`, `chatId`) while any chat of the project runs; a revert whose
//   `expectedSha` no longer matches the disk is `409` (`stale`). Every write batch emits `workspace.changed`.
// - The read members get the request's signal: a client that went away stops the git and disk reads.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  changeDiffQuerySchema,
  changeRevertBodySchema,
  changeUndoBodySchema,
  chatParamsSchema,
  rewindBodySchema,
  rewindQuerySchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { chatNotFound } from '../../services/chats/store.ts'
import { validate } from '../validate.ts'

export function createChangesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** `404 not_found` for an unknown chat (before any project, git or disk work). */
  async function requireChat(id: string): Promise<void> {
    if (await deps.chats.find(id) === null)
      throw chatNotFound(id)
  }

  app.get(apiRoutes['changes.list'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.listChanges(id, { signal: c.req.raw.signal }))
  })

  app.get(apiRoutes['changes.diff'].path, validate('param', chatParamsSchema), validate('query', changeDiffQuerySchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.fileDiff(id, c.req.valid('query'), { signal: c.req.raw.signal }))
  })

  app.get(apiRoutes['changes.git'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.gitStatus(id, { signal: c.req.raw.signal }))
  })

  app.post(apiRoutes['changes.revert'].path, validate('param', chatParamsSchema), validate('json', changeRevertBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.revert(id, c.req.valid('json')))
  })

  app.post(apiRoutes['changes.undo'].path, validate('param', chatParamsSchema), validate('json', changeUndoBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.undo(id, c.req.valid('json')))
  })

  app.get(apiRoutes['changes.rewindPreview'].path, validate('param', chatParamsSchema), validate('query', rewindQuerySchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.rewindPreview(id, c.req.valid('query').messageId, { signal: c.req.raw.signal }))
  })

  app.post(apiRoutes['changes.rewind'].path, validate('param', chatParamsSchema), validate('json', rewindBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    return c.json(await deps.checkpoints.rewind(id, c.req.valid('json')))
  })

  return app
}
