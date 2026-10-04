// Background task routes (API.md 5.30, ADR-046). Owner: W10.4. Keep the export name `createChatTasksRoutes`. Thin:
// validate, call the chat runner's background tasks, map to the response.
//
// - `GET /chat/:id/tasks`: the background tasks of the chat, newest first (an unknown chat is `404`).
// - `POST /chat/:id/tasks/:taskId/stop`: aborts a running task and answers it once its row is saved (`aborted`; a task
//   that already ended is answered as it is); an unknown chat or a task of another chat is `404`. The chat's own Stop
//   (`POST /chat/:id/stop`) never stops background tasks; "Stop all" is one call per task. A stop never starts a turn.
// - No fresh auth; never logs prompts or reports at `info`.
import type { BackgroundTaskList } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatParamsSchema, chatTaskParamsSchema, HarnessError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { chatNotFound } from '../../services/chats/store.ts'
import { validate } from '../validate.ts'

/** `404 not_found` for a task the chat does not have. */
export function taskNotFound(chatId: string, taskId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Background task ${taskId} not found in chat ${chatId}.` })
}

export function createChatTasksRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** Throws `404` for an unknown chat. */
  async function requireChat(id: string): Promise<void> {
    if (await deps.chats.find(id) === null)
      throw chatNotFound(id)
  }

  app.get(apiRoutes['chatTasks.list'].path, validate('param', chatParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await requireChat(id)
    const result: BackgroundTaskList = { items: await deps.runs.taskList(id) }
    return c.json(result)
  })

  app.post(apiRoutes['chatTasks.stop'].path, validate('param', chatTaskParamsSchema), async (c) => {
    const { id, taskId } = c.req.valid('param')
    await requireChat(id)
    const task = await deps.runs.stopTask(id, taskId)
    if (task === null)
      throw taskNotFound(id, taskId)
    c.var.logger.info('background task stop requested', { chatId: id, taskId, status: task.status })
    return c.json(task)
  })

  return app
}
