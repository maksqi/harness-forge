// Message persistence (table `messages`) behind `ChatMessageStore`, on the database or bound to a transaction of
// `ChatsService.transaction()`. Every member is a single statement, so it is atomic on its own and needs no
// interactive transaction.
//
// The messages of a chat form a tree (ADR-023, ARCHITECTURE.md 6.8, ./tree.ts): `appendMessage` and `upsertMessage`
// store the parent of a new message (a parent must be a message of the same chat), `seq` is the creation order
// (MAX + 1), `listPath` walks up `parent_id` with a recursive query guarded by `parent.seq < child.seq`, and
// `setActiveLeaf` is a compare-and-set of `chats.active_leaf_id`.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { SQL } from 'drizzle-orm'
import type { DbExecutor } from '../../db/client.ts'
import type { MessageRow } from '../../db/schema.ts'
import type { TreeRow } from './tree.ts'
import type { ChatMessageStore } from './types.ts'
import { HarnessError, MESSAGE_ID_PATTERN } from '@harness-forge/shared'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { chats, messages } from '../../db/schema.ts'
import { guardDb, isConstraintError } from './db-errors.ts'
import { toSearchText } from './text.ts'

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant'])
/** Rows per multi-row INSERT (10 parameters each, far below SQLite's variable limit). */
export const INSERT_CHUNK_ROWS = 200

type MessageFields = Pick<MessageRow, 'id' | 'role' | 'parts' | 'metadata'>

export const MESSAGE_COLUMNS = {
  id: messages.id,
  role: messages.role,
  parts: messages.parts,
  metadata: messages.metadata,
}

/** The light columns of the tree helpers (`TreeRow`). */
export const TREE_COLUMNS = {
  id: messages.id,
  parentId: messages.parentId,
  seq: messages.seq,
  role: messages.role,
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

export function messageNotFound(chatId: string, messageId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Message ${messageId} not found in chat ${chatId}.` })
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

/** Insert values of a message at position `seq` under `parentId`. */
export function messageInsertValues(
  chatId: string,
  message: HarnessUIMessage,
  seq: number,
  parentId: string | null,
  now: number,
): typeof messages.$inferInsert {
  return {
    id: message.id,
    chatId,
    parentId,
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

/** The light rows of a chat in `seq` order (empty for an unknown chat), for the tree helpers. */
export async function listTreeRows(executor: DbExecutor, chatId: string): Promise<TreeRow[]> {
  return executor.select(TREE_COLUMNS).from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.seq))
}

/**
 * `INSERT INTO messages ... SELECT` of one new message: the next `seq` of the chat, `parent_id = parentId`; the SELECT
 * yields no row (nothing is written) unless the chat exists and `condition` holds.
 */
function insertMessageSql(chatId: string, message: HarnessUIMessage, parentId: string | null, condition: SQL): SQL {
  const now = Date.now()
  const metadata = message.metadata === undefined ? null : JSON.stringify(message.metadata)
  return sql`
    INSERT INTO ${messages} (id, chat_id, parent_id, seq, role, parts, metadata, search_text, created_at, updated_at)
    SELECT ${message.id}, ${chatId}, ${parentId},
      COALESCE((SELECT MAX(m.seq) FROM messages AS m WHERE m.chat_id = ${chatId}), -1) + 1,
      ${message.role}, ${JSON.stringify(message.parts)}, ${metadata}, ${toSearchText(message.parts)}, ${now}, ${now}
    WHERE EXISTS (SELECT 1 FROM chats AS c WHERE c.id = ${chatId}) AND ${condition}`
}

/** `parentId` is null or a message of the chat. */
function parentInChat(chatId: string, parentId: string | null): SQL {
  return sql`(${parentId} IS NULL OR EXISTS (SELECT 1 FROM messages AS p WHERE p.chat_id = ${chatId} AND p.id = ${parentId}))`
}

/** Why a message write stored nothing: the chat is missing, the id belongs to another chat, or the parent is missing. */
async function writeFailure(executor: DbExecutor, chatId: string, messageId: string, parentId: string | null): Promise<HarnessError> {
  const [chat] = await executor.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1)
  if (chat === undefined)
    return chatNotFound(chatId)
  const [used] = await executor.select({ chatId: messages.chatId }).from(messages).where(eq(messages.id, messageId)).limit(1)
  if (used !== undefined && used.chatId !== chatId)
    return messageConflict()
  return messageNotFound(chatId, parentId ?? messageId)
}

export function createMessageStore(executor: DbExecutor): ChatMessageStore {
  return {
    listMessages: chatId => guardDb(async () => {
      const rows = await executor
        .select(MESSAGE_COLUMNS)
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.seq))
      return rows.map(rowToMessage)
    }),

    listPath: (chatId, leafId) => guardDb(async () => {
      if (leafId === null)
        return []
      // Up from the leaf through `parent_id`, only to messages of the chat with a lower `seq`: bad data (a cycle, a
      // parent in another chat) ends the walk instead of looping.
      const pathIds = sql`(
        WITH RECURSIVE path(id, parent_id, seq) AS (
          SELECT m.id, m.parent_id, m.seq FROM messages AS m WHERE m.chat_id = ${chatId} AND m.id = ${leafId}
          UNION ALL
          SELECT p.id, p.parent_id, p.seq FROM messages AS p JOIN path ON p.id = path.parent_id
          WHERE p.chat_id = ${chatId} AND p.seq < path.seq
        )
        SELECT id FROM path
      )`
      const rows = await executor
        .select(MESSAGE_COLUMNS)
        .from(messages)
        .where(and(eq(messages.chatId, chatId), inArray(messages.id, pathIds)))
        .orderBy(asc(messages.seq))
      if (rows.length === 0)
        throw messageNotFound(chatId, leafId)
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

    appendMessage: (chatId, message, parentId) => guardDb(async () => {
      checkMessage(message)
      let result
      try {
        // A plain INSERT: an id that is already used (in any chat) violates the primary key.
        result = await executor.run(insertMessageSql(chatId, message, parentId, parentInChat(chatId, parentId)))
      }
      catch (error) {
        if (isConstraintError(error))
          throw messageConflict()
        throw error
      }
      if (result.rowsAffected === 0)
        throw await writeFailure(executor, chatId, message.id, parentId)
    }),

    upsertMessage: (chatId, message, parentId) => guardDb(async () => {
      checkMessage(message)
      // One statement: append under `parentId` with the next `seq` when the id is new, replace role / parts / metadata
      // when it exists in this chat (keeping its `seq` and its parent, whatever `parentId` says), do nothing when the
      // chat is missing, the id belongs to another chat or a new message's parent is not in the chat.
      const condition = sql`(${parentInChat(chatId, parentId)}
        OR EXISTS (SELECT 1 FROM messages AS e WHERE e.chat_id = ${chatId} AND e.id = ${message.id}))`
      let result
      try {
        result = await executor.run(sql`${insertMessageSql(chatId, message, parentId, condition)}
          ON CONFLICT (id) DO UPDATE SET
            role = excluded.role,
            parts = excluded.parts,
            metadata = excluded.metadata,
            search_text = excluded.search_text,
            updated_at = excluded.updated_at
          WHERE ${messages.chatId} = excluded.chat_id`)
      }
      catch (error) {
        // A concurrent append took the same `seq`.
        if (isConstraintError(error))
          throw messageConflict()
        throw error
      }
      if (result.rowsAffected === 0)
        throw await writeFailure(executor, chatId, message.id, parentId)
    }),

    setActiveLeaf: (chatId, leafId, onlyFrom) => guardDb(async () => {
      let current: SQL | undefined
      if (onlyFrom !== undefined) {
        const ids = onlyFrom.filter((value): value is string => value !== null)
        const matches = [
          ...(ids.length > 0 ? [inArray(chats.activeLeafId, ids)] : []),
          ...(onlyFrom.includes(null) ? [isNull(chats.activeLeafId)] : []),
        ]
        if (matches.length === 0)
          return false
        current = or(...matches)
      }
      const rows = await executor
        .update(chats)
        .set({ activeLeafId: leafId })
        .where(and(
          eq(chats.id, chatId),
          current,
          sql`EXISTS (SELECT 1 FROM messages AS m WHERE m.chat_id = ${chatId} AND m.id = ${leafId})`,
        ))
        .returning({ id: chats.id })
      return rows.length > 0
    }),
  }
}
