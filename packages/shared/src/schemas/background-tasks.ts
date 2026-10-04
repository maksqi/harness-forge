// Background sub-agents (Phase 10, ADR-046; API.md section 4.29): a `task` call with `background: true` returns at once
// and its child runs detached from the tool call (table `background_tasks`, `bgt_` ids). The result is delivered
// exactly once as a `data-task-result` part; `GET /chat/:id/tasks` lists the tasks of a chat, `task.changed` reports
// every change.
import { z } from 'zod'
import { runOriginSchema } from '../enums.ts'
import { backgroundTaskIdSchema, chatIdSchema, messageIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { taskOutputSchema, taskStatusSchema } from './agent.ts'

/**
 * Status of a background task: `running`, then `completed`, `failed`, `aborted` (its Stop, a chat or project delete,
 * delete-all, a key rotation, shutdown, or a server restart) or `limit` (the step limit or the 30-minute deadline).
 */
export const backgroundTaskStatusSchema = taskStatusSchema.extract(['running', 'completed', 'failed', 'aborted', 'limit'])
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>

/** One background task of a chat (`GET /chat/:id/tasks`, `task.changed`). */
export const backgroundTaskSchema = z.object({
  id: backgroundTaskIdSchema,
  chatId: chatIdSchema,
  /** The assistant message whose `task` call launched it (its writes are journaled under this message). */
  messageId: messageIdSchema,
  /** The `task` call that launched it. */
  toolCallId: z.string().min(1).max(256),
  /** The origin of the run that launched it (a task launched from an `origin: 'task'` turn never starts a turn). */
  origin: runOriginSchema,
  status: backgroundTaskStatusSchema,
  /** The latest snapshot of the sub-agent (live while it runs, the final output once it ended). */
  output: taskOutputSchema,
  createdAt: timestampSchema,
  /** null while it runs. */
  finishedAt: timestampSchema.nullable(),
  /** When its result was delivered to the chat (exactly once); null = not yet. */
  deliveredAt: timestampSchema.nullable(),
  /** The message that holds the delivered `data-task-result` part. */
  deliveredMessageId: messageIdSchema.nullable(),
})
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>

/** `GET /chat/:id/tasks`: the background tasks of the chat, newest first (at most 100 are kept per chat). */
export const backgroundTaskListSchema = z.object({
  items: z.array(backgroundTaskSchema).max(LIMITS.backgroundTasksKeptPerChat),
})
export type BackgroundTaskList = z.infer<typeof backgroundTaskListSchema>

/** `/chat/:id/tasks/:taskId/stop`. */
export const chatTaskParamsSchema = z.object({ id: chatIdSchema, taskId: backgroundTaskIdSchema })
export type ChatTaskParams = z.infer<typeof chatTaskParamsSchema>

/**
 * Data of `data-task-result` parts (ADR-046): the result of a finished background task, delivered once, either inside a
 * running reply at a step boundary (like a steer) or in the user-role carrier message of a turn the server starts
 * (`run.started.origin = 'task'`). The model sees it as `taskResultText` (`<background-task …>…</background-task>`).
 */
export const taskResultDataSchema = z.object({
  taskId: backgroundTaskIdSchema,
  /** The `task` call that launched it. */
  toolCallId: z.string().min(1).max(256),
  /** The assistant message that launched it. */
  messageId: messageIdSchema,
  /** The final output of the sub-agent (its report, status and usage). */
  output: taskOutputSchema,
  deliveredAt: timestampSchema,
})
export type TaskResultData = z.infer<typeof taskResultDataSchema>

/** Data of `task.changed`: the task after the change (at most one per second per task, plus every status change). */
export const taskChangedDataSchema = z.object({
  chatId: chatIdSchema,
  task: backgroundTaskSchema,
})
export type TaskChangedData = z.infer<typeof taskChangedDataSchema>
