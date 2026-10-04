// The rows of background tasks (Phase 10, ADR-046; table `background_tasks`, a cascade from `chats`), for the manager
// (./index.ts). A row is written when the task starts (`running`, the first snapshot), when it ends (`status`, the final
// `output`, `finished_at`) and when its result is delivered (`delivered_at`, `delivered_message_id`); the three writes
// touch disjoint columns, so they never overwrite each other. Progress snapshots stay in memory. The boot sweep turns rows
// still `running` into `aborted`. Rows are pruned per chat to `LIMITS.backgroundTasksKeptPerChat` (the oldest delivered
// ones). Never logs prompts or reports.
// The writes run beside other chats' runs: a database client with a single connection (the in-memory database of the
// tests) refuses a statement while another request's transaction holds it (`TRANSACTION_ACTIVE`), so `retryBusy`
// tries such a write again a few times (a file database has a pool and never answers that).
import type { BackgroundTask, BackgroundTaskStatus, TaskOutput } from '@harness-forge/shared'
import type { Db } from '../../db/client.ts'
import type { BackgroundTaskRow } from '../../db/schema.ts'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { backgroundTasks } from '../../db/schema.ts'

/** Attempts after the first of a write the connection refused while a transaction held it. */
export const BUSY_RETRIES = 8

/** True for the error of a single-connection client whose connection an open transaction holds (also as a cause). */
export function isConnectionBusy(error: unknown): boolean {
  for (let current = error, depth = 0; typeof current === 'object' && current !== null && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === 'TRANSACTION_ACTIVE')
      return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** Runs `write`, again after a short wait while the connection is busy (`BUSY_RETRIES` times at most). */
export async function retryBusy<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write()
    }
    catch (error) {
      if (attempt >= BUSY_RETRIES || !isConnectionBusy(error))
        throw error
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5 * (attempt + 1))
        timer.unref?.()
      })
    }
  }
}

/** A row as the DTO (`backgroundTaskSchema`). */
export function taskOfRow(row: BackgroundTaskRow): BackgroundTask {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    toolCallId: row.toolCallId,
    origin: row.origin,
    status: row.status,
    output: row.output,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    deliveredMessageId: row.deliveredMessageId ?? null,
  }
}

/** Inserts the row of a task that starts (`running`). */
export async function insertTaskRow(db: Db, task: BackgroundTask): Promise<void> {
  await retryBusy(async () => db.insert(backgroundTasks).values({
    id: task.id,
    chatId: task.chatId,
    messageId: task.messageId,
    toolCallId: task.toolCallId,
    type: task.output.type,
    description: task.output.description,
    status: task.status,
    origin: task.origin,
    output: task.output,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    deliveredAt: task.deliveredAt,
    deliveredMessageId: task.deliveredMessageId,
  }))
}

/** Saves the end of a task (status, final output, finish time); the delivery columns are left alone. */
export async function saveTaskEnd(db: Db, task: BackgroundTask): Promise<void> {
  await retryBusy(async () => db.update(backgroundTasks)
    .set({ status: task.status, output: task.output, finishedAt: task.finishedAt })
    .where(eq(backgroundTasks.id, task.id)))
}

/** Records the delivery of a task's result (when, and the message that holds the `data-task-result` part). */
export async function saveTaskDelivery(db: Db, taskId: string, deliveredAt: number, messageId: string): Promise<void> {
  await retryBusy(async () => db.update(backgroundTasks)
    .set({ deliveredAt, deliveredMessageId: messageId })
    .where(eq(backgroundTasks.id, taskId)))
}

/** The chat's tasks, newest first (at most `limit`). */
export async function listTaskRows(db: Db, chatId: string, limit: number): Promise<BackgroundTask[]> {
  const rows = await db.select().from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId)).orderBy(desc(backgroundTasks.createdAt), desc(backgroundTasks.id)).limit(limit)
  return rows.map(taskOfRow)
}

/** One task of the chat, or null (unknown, or a task of another chat). */
export async function findTaskRow(db: Db, chatId: string, taskId: string): Promise<BackgroundTask | null> {
  const [row] = await db.select().from(backgroundTasks).where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.chatId, chatId))).limit(1)
  return row === undefined ? null : taskOfRow(row)
}

/**
 * Deletes the chat's oldest delivered, finished rows above `keep` rows (undelivered and running rows are never pruned).
 * Returns how many rows went.
 */
export async function pruneTaskRows(db: Db, chatId: string, keep: number): Promise<number> {
  const [total] = await db.select({ n: count() }).from(backgroundTasks).where(eq(backgroundTasks.chatId, chatId))
  const excess = Number(total?.n ?? 0) - keep
  if (excess <= 0)
    return 0
  const oldest = await db.select({ id: backgroundTasks.id }).from(backgroundTasks).where(and(eq(backgroundTasks.chatId, chatId), isNotNull(backgroundTasks.deliveredAt), ne(backgroundTasks.status, 'running'))).orderBy(asc(backgroundTasks.createdAt), asc(backgroundTasks.id)).limit(excess)
  if (oldest.length === 0)
    return 0
  await retryBusy(async () => db.delete(backgroundTasks).where(inArray(backgroundTasks.id, oldest.map(row => row.id))))
  return oldest.length
}

/** Rows still `running` (the boot sweep). */
export async function runningTaskRows(db: Db): Promise<BackgroundTask[]> {
  const rows = await db.select().from(backgroundTasks).where(eq(backgroundTasks.status, 'running'))
  return rows.map(taskOfRow)
}

/** Finished rows whose result was never delivered, oldest first (the boot sweep fills the inboxes with them). */
export async function undeliveredTaskRows(db: Db): Promise<BackgroundTask[]> {
  const rows = await db.select().from(backgroundTasks).where(and(isNull(backgroundTasks.deliveredAt), ne(backgroundTasks.status, 'running'))).orderBy(asc(backgroundTasks.createdAt), asc(backgroundTasks.id))
  return rows.map(taskOfRow)
}

/** The output of a task that ended as `status` at `finishedAt` (an `error` replaces the previous one). */
export function endedOutput(output: TaskOutput, status: BackgroundTaskStatus, finishedAt: number, error?: string): TaskOutput {
  const { error: _previous, ...rest } = output
  const kept = error === undefined && output.error !== undefined ? { error: output.error } : {}
  return { ...rest, status, finishedAt: output.finishedAt ?? finishedAt, ...kept, ...(error === undefined ? {} : { error }) }
}
