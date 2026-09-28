// Message persistence (table `messages`) behind `ChatMessageStore`: on the database (multi-statement writes run as one
// atomic `batch`, so no interactive transaction holds the connection) or bound to a transaction of
// `ChatsService.transaction()` (statements run in order inside it).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db, DbExecutor } from '../../db/client.ts'
import type { MessageRow } from '../../db/schema.ts'
import type { ChatMessageStore } from './types.ts'
import { HarnessError, MESSAGE_ID_PATTERN } from '@harness-forge/shared'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { chats, messages } from '../../db/schema.ts'
import { guardDb, isConstraintError } from './db-errors.ts'
import { toSearchText } from './text.ts'

/** `database`: `deps.db` (atomic batches); `transaction`: a Drizzle transaction (sequential statements). */
export type StoreMode = 'database' | 'transaction'

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant'])
/** Rows per multi-row INSERT (9 parameters each, far below SQLite's variable limit). */
export const INSERT_CHUNK_ROWS = 200

type MessageFields = Pick<MessageRow, 'id' | 'role' | 'parts' | 'metadata'>

export const MESSAGE_COLUMNS = {
  id: messages.id,
  role: messages.role,
  parts: messages.parts,
  metadata: messages.metadata,
}

/** A stored row as a UI message (`metadata` omitted when null). */
export function rowToMessage(row: MessageFields): HarnessUIMessage {
  return {
    id: row.id,
    role: row.role,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    parts: row.parts,
  } as HarnessUIMessage
}

export function chatNotFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Chat ${id} not found.` })
}

export function messageConflict(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'A message with this id already exists.',
    details: { reason: 'exists' },
  })
}

function invalidMessage(message: string, path: (string | number)[]): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message: `${path.join('.')}: ${message}`,
    details: { issues: [{ path, message, code: 'custom' }] },
  })
}

/** Shape check before a write: `msg_` id (ADR-019), known role, parts array. */
export function checkMessage(message: HarnessUIMessage): void {
  if (typeof message.id !== 'string' || !MESSAGE_ID_PATTERN.test(message.id))
    throw invalidMessage('Expected a message id "msg_" + 16 characters.', ['message', 'id'])
  if (!MESSAGE_ROLES.has(message.role))
    throw invalidMessage('Expected the role system, user or assistant.', ['message', 'role'])
  if (!Array.isArray(message.parts))
    throw invalidMessage('Expected an array of parts.', ['message', 'parts'])
}

/** Insert values of a message at position `seq`. */
export function messageInsertValues(chatId: string, message: HarnessUIMessage, seq: number, now: number): typeof messages.$inferInsert {
  return {
    id: message.id,
    chatId,
    seq,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata ?? null,
    searchText: toSearchText(message.parts),
    createdAt: now,
    updatedAt: now,
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size))
  return chunks
}

/** Runs write statements atomically: one batch on the database, in order inside a transaction. */
export async function runAtomic(executor: DbExecutor, mode: StoreMode, queries: readonly BatchItem<'sqlite'>[]): Promise<unknown[]> {
  if (queries.length === 0)
    return []
  if (mode === 'database')
    return (executor as Db).batch(queries as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  const results: unknown[] = []
  for (const query of queries)
    results.push(await query)
  return results
}

export function createMessageStore(executor: DbExecutor, mode: StoreMode): ChatMessageStore {
  return {
    listMessages: chatId => guardDb(async () => {
      const rows = await executor
        .select(MESSAGE_COLUMNS)
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.seq))
      return rows.map(rowToMessage)
    }),

    getMessage: (chatId, messageId) => guardDb(async () => {
      const [row] = await executor
        .select(MESSAGE_COLUMNS)
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.id, messageId)))
        .limit(1)
      return row === undefined ? null : rowToMessage(row)
    }),

    upsertMessage: (chatId, message) => guardDb(async () => {
      checkMessage(message)
      const now = Date.now()
      const metadata = message.metadata === undefined ? null : JSON.stringify(message.metadata)
      // One statement: append with the next `seq` when the id is new, replace parts / metadata / role when it exists
      // in this chat (keeping its `seq`), do nothing when the chat is missing or the id belongs to another chat.
      const result = await executor.run(sql`
        INSERT INTO ${messages} (id, chat_id, seq, role, parts, metadata, search_text, created_at, updated_at)
        SELECT ${message.id}, ${chatId},
          COALESCE((SELECT MAX(${messages.seq}) FROM ${messages} WHERE ${messages.chatId} = ${chatId}), -1) + 1,
          ${message.role}, ${JSON.stringify(message.parts)}, ${metadata}, ${toSearchText(message.parts)}, ${now}, ${now}
        WHERE EXISTS (SELECT 1 FROM ${chats} WHERE ${chats.id} = ${chatId})
        ON CONFLICT (id) DO UPDATE SET
          role = excluded.role,
          parts = excluded.parts,
          metadata = excluded.metadata,
          search_text = excluded.search_text,
          updated_at = excluded.updated_at
        WHERE ${messages.chatId} = excluded.chat_id`)
      if (result.rowsAffected > 0)
        return
      const [chat] = await executor.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1)
      throw chat === undefined ? chatNotFound(chatId) : messageConflict()
    }),

    replaceFrom: (chatId, fromMessageId, list) => guardDb(async () => {
      list.forEach(checkMessage)
      const [from] = await executor
        .select({ seq: messages.seq })
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.id, fromMessageId)))
        .limit(1)
      if (from === undefined)
        throw new HarnessError({ code: 'not_found', message: `Message ${fromMessageId} not found in chat ${chatId}.` })
      const now = Date.now()
      const rows = list.map((message, index) => messageInsertValues(chatId, message, from.seq + index, now))
      const queries: BatchItem<'sqlite'>[] = [
        executor
          .delete(messages)
          .where(and(eq(messages.chatId, chatId), gte(messages.seq, from.seq)))
          .returning({ id: messages.id }),
        ...chunk(rows, INSERT_CHUNK_ROWS).map(values => executor.insert(messages).values(values)),
      ]
      let results: unknown[]
      try {
        results = await runAtomic(executor, mode, queries)
      }
      catch (error) {
        if (isConstraintError(error))
          throw messageConflict()
        throw error
      }
      return Array.isArray(results[0]) ? results[0].length : 0
    }),
  }
}
