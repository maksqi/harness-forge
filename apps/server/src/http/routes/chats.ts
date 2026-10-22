// Chat CRUD routes (API.md 5.9). Owner: W1.5 (W1.5-T4); `POST /chats/:id/branch` by W5.1 (ADR-023). Keep the export name
// `createChatsRoutes`. Thin: validate with the shared schemas, call `deps.chats`, map to the response.
// `DELETE /chats/:id` stops an active run first (`deps.runs.stop`, which waits until the partial message is persisted).
// `POST /chats/:id/branch` and `DELETE /chats/:id/messages/:messageId` (deleting a version, ADR-030, W6.6) are refused
// with `409 conflict` (`reason: 'run-active'`) while the runs registry holds the chat in any phase (`deps.runs.hasRun`),
// so a version switch or delete never races a run's commit or persist.
// Phase 7 (ADR-031, W7.5): `GET /chats?projectId=<id>|none` filters by project; `POST /chats` and `PATCH /chats/:id`
// with `projectId` answer `404` for an unknown project; the move of `PATCH` is refused with `409 run-active` while a run
// holds the chat. The chats service checks both (`update` asks `deps.runs.hasRun` itself), so the routes stay thin.
// Phase 10 (ADR-046, W10.4): `DELETE /chats/:id` stops the chat's background tasks first (`deps.runs.stopTasks`: their
// rows are saved, then they go with the chat); deleting a version is also refused (`409 run-active`) while a background
// task of the chat runs (`deps.runs.hasTasks`; it may write files journaled under a message of the chat); a version
// switch stays allowed (the tasks keep running and deliver into the active path).
// Phase 12 (C44 call site, ADR-057; W12.5 implements the runner, W12.6 owns this route in P12-A): `DELETE /chats/:id`
// reads the chat row before the delete and, once the chat is deleted, hands it to `deps.hooks.sessionEnd(chat)`
// (`SessionEnd`, `reason: 'other'`; detached: the answer never waits for it, a failure never fails the delete). Only a
// single chat delete ends a session: delete-all, a project delete and shutdown never call it.
// Phase 14 (C52, ADR-060, open point 2; COMPLETE and FROZEN after P14-0b): the answers of `GET /chats` (every item) and
// `GET /chats/:id` carry `awaitingInput: deps.elicitations.pendingCount(id) > 0` (live: an MCP tool call of the chat's
// run waits for the user's answer to an elicitation; `withAwaitingInput`). A broker that throws counts as nothing
// pending. The other answers (create, update, branch, version delete) keep the v1.8 shape (absent = unchanged for the
// web store); the broker reports changes through `chat.updated` (W14.3).
import type { ChatSummary } from '@harness-forge/shared'
import type { SessionEndChat } from '../../services/hooks/types.ts'
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
import { backgroundConflict } from '../../chat/background/busy.ts'
import { runConflict } from '../../chat/runs.ts'
import { contentDisposition } from '../../services/files/names.ts'
import { validate } from '../validate.ts'

/**
 * Hands a deleted chat to the `SessionEnd` hooks (`HookService.sessionEnd`; detached: never awaited, and a throw or a
 * rejection, which the contract excludes, never reaches the route).
 */
export function endChatSession(deps: Pick<AppDeps, 'hooks' | 'logger'>, chat: SessionEndChat): void {
  const failed = (error: unknown): void => deps.logger.warn('the SessionEnd hooks failed', { chatId: chat.id, err: error })
  try {
    void deps.hooks.sessionEnd(chat).catch(failed)
  }
  catch (error) {
    failed(error)
  }
}

/**
 * `summary` with `awaitingInput` (Phase 14, see the module comment): true while an elicitation of the chat waits for the
 * user (`ElicitationBroker.pendingCount`), else false; a failing broker counts as nothing pending.
 */
export function withAwaitingInput<T extends Pick<ChatSummary, 'id'>>(deps: Pick<AppDeps, 'elicitations' | 'logger'>, summary: T): T & { awaitingInput: boolean } {
  let pending = 0
  try {
    pending = deps.elicitations.pendingCount(summary.id)
  }
  catch (error) {
    deps.logger.warn('cannot read the pending elicitations of a chat', { chatId: summary.id, err: error })
  }
  return { ...summary, awaitingInput: Number.isFinite(pending) && pending > 0 }
}

export function createChatsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['chats.list'].path, validate('query', chatsQuerySchema), async (c) => {
    const page = await deps.chats.list(c.req.valid('query'))
    return c.json({ ...page, items: page.items.map(item => withAwaitingInput(deps, item)) })
  })

  app.post(apiRoutes['chats.create'].path, validate('json', chatCreateSchema), async (c) => {
    return c.json(await deps.chats.create(c.req.valid('json')), 201)
  })

  app.get(apiRoutes['chats.get'].path, validate('param', chatParamsSchema), async (c) => {
    return c.json(withAwaitingInput(deps, await deps.chats.get(c.req.valid('param').id)))
  })

  app.patch(apiRoutes['chats.update'].path, validate('param', chatParamsSchema), validate('json', chatUpdateSchema), async (c) => {
    return c.json(await deps.chats.update(c.req.valid('param').id, c.req.valid('json')))
  })

  app.delete(apiRoutes['chats.remove'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    // The background tasks first (their rows saved; a task launched by the stopping run meanwhile is stopped by the
    // manager on `chat.deleted`), then the run.
    await deps.runs.stopTasks(id)
    await deps.runs.stop(id)
    // Phase 12: the row `SessionEnd` describes (its project and settings), read before it is gone.
    const chat = await deps.chats.find(id)
    await deps.chats.remove(id)
    if (chat !== null)
      endChatSession(deps, chat)
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
    if (deps.runs.hasTasks(id))
      throw backgroundConflict(id)
    return c.json(await deps.chats.deleteMessage(id, messageId))
  })

  return app
}
