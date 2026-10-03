// Chats, messages and usage rows (API.md 5.9, ARCHITECTURE.md 6.1 / 6.3 / 6.8 / 6.9, tables `chats`, `messages`,
// `usage`). Owner: W1.5; the message tree (ADR-023) and the bulk data members (ADR-024) by W5.1. Implements
// `ChatsService` (./types.ts) behind `createChatsService(deps)`.
//
// - Ordering: `updated_at` desc, `id` desc with an opaque keyset cursor (./cursor.ts). `updated_at` is the last activity
//   (creation, `touch` when a run ends); renaming, pinning, archiving, changing settings or switching a version keeps a
//   chat's position.
// - Search (`q`): message text through `messages.search_text` (normalized, LIKE with `%` / `_` escaped) of every message
//   version and titles in JavaScript, both Unicode case-insensitive (./text.ts); `snippet` comes from the first matching
//   message (it may be a version that is not on the active path).
// - Message tree (./tree.ts): `get` answers the active path (`listPath` from the active leaf) and the versions of its
//   messages (`branches`, from the light rows of the chat); `switchBranch` moves the active leaf to the remembered leaf
//   under a message with a compare-and-set against the leaf it read; imports (`create` with `messages`,
//   `importChat`) validate the tree before anything is written (./import.ts) and insert the chat, its messages and its
//   active leaf in one batch.
// - Remembered versions (Phase 6, ADR-030): every write that moves the active leaf also records the shown path
//   (`rememberPathSql`: `messages.selected_child_id`) in the same atomic step: `setActiveLeaf` (the pipeline),
//   `switchBranch`, `deleteMessage` and the import batch. The pointers are never exported (an import re-derives them).
// - Deleting a version (`deleteMessage`, ADR-030): one batch with the compare-and-set of the leaf and the subtree
//   delete; the delete checks again when it runs that the leaf is where it expects it (the new leaf, or the unmoved
//   one for a version off the path) and that the new leaf and another version still exist, so a race never deletes the
//   shown path or the last version; usage rows, share snapshots, files and `updated_at` stay.
// - Writes are single statements or atomic batches (no interactive transaction holds the connection), except
//   `transaction()`, which the chat pipeline uses for its commit and persist steps.
// - Events are emitted after the write: `chat.created` (create, ensure when it creates, importChat), `chat.updated`
//   (update, touch, setTitle, switchBranch, deleteMessage; `ChatUpdatedData`: the summary plus the row's active leaf),
//   `chat.deleted` (remove, removeAll: one per chat). Message operations emit nothing.
// - Usage totals (`ChatDetail.totals`) sum the usage rows of purpose `chat` and `image` (Phase 6) of the chat, deleted
//   versions included.
import type { ChatDetail, ChatSettings, ChatSummary, CursorPage, HarnessUIMessage, UsageTotals } from '@harness-forge/shared'
import type { SQL } from 'drizzle-orm'
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import type { ChatRow, UsagePurpose } from '../../db/schema.ts'
import type { AppDeps } from '../../types.ts'
import type { ChatCursor } from './cursor.ts'
import type { ChatExportTree } from './export.ts'
import type { ImportTree } from './import.ts'
import type { ChatListQuery, ChatRecord, ChatsService, UsageInput } from './types.ts'
import {
  CHAT_ID_PATTERN,
  chatExportAnySchema,
  chatSettingsSchema,
  createChatId,
  HarnessError,
  LIMITS,
  modelRefSchema,
  validationError,
} from '@harness-forge/shared'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { chats, messages, usage } from '../../db/schema.ts'
import { decodeChatCursor, encodeChatCursor } from './cursor.ts'
import { databaseError, guardDb, isConstraintError } from './db-errors.ts'
import { buildChatExport } from './export.ts'
import { assignMessageIds, freshMessageIds, planImportTree, validateImportedMessages } from './import.ts'
import {
  chatNotFound,
  chunk,
  createMessageStore,
  deleteSubtreeSql,
  INSERT_CHUNK_ROWS,
  listTreeRows,
  MESSAGE_COLUMNS,
  messageInChatSql,
  messageInsertValues,
  messageNotFound,
  rememberPathSql,
  rowToMessage,
  TREE_COLUMNS,
} from './store.ts'
import { LIKE_ESCAPE, likeContainsPattern, makeSnippet, messagePlainText, normalizeForSearch, sanitizeTitle, titleMatches } from './text.ts'
import { branchesOf, buildTree, pathTo, rememberedLeafUnder, resolveLeaf, siblingsOf } from './tree.ts'

/** Chats scanned per query while searching (title matches are decided in JavaScript). */
const SEARCH_BATCH_ROWS = 200
/** Ids per `IN (...)` lookup. */
const ID_LOOKUP_CHUNK = 500
/** The usage rows counted by `ChatDetail.totals` (Phase 6 adds `image`; title, transcription and speech rows are not). */
const TOTALS_PURPOSES: readonly UsagePurpose[] = ['chat', 'image']

type ChatUpdateSet = SQLiteUpdateSetSource<typeof chats>
type ChatInsert = typeof chats.$inferInsert

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit))
    return LIMITS.pageLimitDefault
  return Math.min(LIMITS.pageLimitMax, Math.max(1, Math.trunc(limit)))
}

/** Keyset condition "after `cursor`" for the order `updated_at` desc, `id` desc. */
function afterCursor(cursor: ChatCursor | null) {
  if (cursor === null)
    return undefined
  return or(lt(chats.updatedAt, cursor.updatedAt), and(eq(chats.updatedAt, cursor.updatedAt), lt(chats.id, cursor.id)))
}

function toRecord(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.titleSource,
    modelRef: row.modelRef,
    settings: row.settings,
    pinned: row.pinned,
    archived: row.archived,
    pendingApproval: row.pendingApproval,
    activeLeafId: row.activeLeafId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function conflictExists(id: string): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: `Chat ${id} already exists.`,
    details: { reason: 'exists', chatId: id },
  })
}

/**
 * The active leaf changed between reading and writing it (a run committed meanwhile, or another switch or delete won),
 * so the compare-and-set of a version switch or delete missed; nothing was written.
 */
function leafMoved(id: string, action: 'switch' | 'delete'): HarnessError {
  const doing = action === 'switch' ? 'switching versions' : 'deleting the version'
  return new HarnessError({
    code: 'conflict',
    message: `The chat changed while ${doing}. Wait until the reply finishes, then try again.`,
    details: { reason: 'run-active', chatId: id },
  })
}

/** `deleteMessage` of a message without another version (ADR-030): the last version is never deleted. */
function onlyVersion(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'This is the only version of the message. Delete the chat instead.',
    details: { reason: 'only-version' },
  })
}

/** An SQL condition on `chats.active_leaf_id` (in an UPDATE of `chats`): it `IS` `leafId` (null-safe). */
function leafIs(leafId: string | null): SQL {
  return sql`${chats.activeLeafId} IS ${leafId}`
}

/** An SQL condition for statements on other tables: the active leaf of the chat `IS` `leafId` (null-safe). */
function activeLeafIs(chatId: string, leafId: string | null): SQL {
  return sql`EXISTS (SELECT 1 FROM chats AS l WHERE l.id = ${chatId} AND l.active_leaf_id IS ${leafId})`
}

function invalidField(path: string, message: string): HarnessError {
  return validationError([{ path: [path], message, code: 'custom' }])
}

/** A title to store; `validation_error` when nothing printable is left. */
function requireTitle(raw: string): string {
  const title = sanitizeTitle(raw)
  if (title === null)
    throw invalidField('title', 'The title cannot be empty.')
  return title
}

function checkModelRef(value: string): string {
  const parsed = modelRefSchema.safeParse(value)
  if (!parsed.success)
    throw invalidField('modelRef', 'Expected a model ref "<providerId>:<modelId>".')
  return parsed.data
}

function checkSettings(value: ChatSettings): ChatSettings {
  const parsed = chatSettingsSchema.safeParse(value)
  if (!parsed.success)
    throw validationError(parsed.error)
  return parsed.data
}

/** RFC 7396 merge of a settings patch into the stored JSON (`null` removes a key), done by SQLite in the UPDATE. */
function mergeSettings(patch: Record<string, unknown>) {
  return sql`json_patch(${chats.settings}, ${JSON.stringify(patch)})`
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** The message ends with a tool call waiting for the user (`chats.pending_approval` of the path it ends). */
function awaitsApproval(message: HarnessUIMessage | null): boolean {
  if (message?.role !== 'assistant')
    return false
  return message.parts.some(part => (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
    && (part as { state?: unknown }).state === 'approval-requested')
}

export function createChatsService(deps: AppDeps): ChatsService {
  const { db } = deps
  const store = createMessageStore(db)

  // `deps.runs` and `deps.events` are read at call time: the runner (W2.1) may need this service while it is built.
  function isRunning(id: string): boolean {
    try {
      return deps.runs.isActive(id)
    }
    catch {
      return false
    }
  }

  function toSummary(row: ChatRow, snippet?: string): ChatSummary {
    return {
      id: row.id,
      title: row.title,
      titleSource: row.titleSource,
      modelRef: row.modelRef,
      pinned: row.pinned,
      archived: row.archived,
      running: isRunning(row.id),
      pendingApproval: row.pendingApproval,
      // Phase 7 placeholder until `chats.project_id` exists (migration 0004, W7.5).
      projectId: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(snippet === undefined ? {} : { snippet }),
    }
  }

  async function findRow(id: string): Promise<ChatRow | undefined> {
    if (!CHAT_ID_PATTERN.test(id))
      return undefined
    const [row] = await db.select().from(chats).where(eq(chats.id, id)).limit(1)
    return row
  }

  async function requireRow(id: string): Promise<ChatRow> {
    const row = await findRow(id)
    if (row === undefined)
      throw chatNotFound(id)
    return row
  }

  async function updateRow(id: string, set: ChatUpdateSet): Promise<ChatRow | undefined> {
    if (!CHAT_ID_PATTERN.test(id))
      return undefined
    const [row] = await db.update(chats).set(set).where(eq(chats.id, id)).returning()
    return row
  }

  async function usageTotals(chatId: string): Promise<UsageTotals> {
    const [row] = await db
      .select({
        inputTokens: sql<number>`coalesce(sum(${usage.input}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usage.output}), 0)`,
        reasoningTokens: sql<number>`coalesce(sum(${usage.reasoning}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${usage.cacheRead}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${usage.cacheWrite}), 0)`,
        costUsd: sql<number | null>`sum(${usage.costUsd})`,
      })
      .from(usage)
      .where(and(eq(usage.chatId, chatId), inArray(usage.purpose, [...TOTALS_PURPOSES])))
    return {
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      reasoningTokens: Number(row?.reasoningTokens ?? 0),
      cacheReadTokens: Number(row?.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(row?.cacheWriteTokens ?? 0),
      costUsd: row?.costUsd === null || row?.costUsd === undefined ? null : Number(row.costUsd),
    }
  }

  /** Summary, settings, the active path, the versions of its messages and the usage totals. */
  async function detailOf(row: ChatRow): Promise<ChatDetail> {
    const tree = buildTree(await listTreeRows(db, row.id))
    const path = await store.listPath(row.id, resolveLeaf(tree, row.activeLeafId))
    const branches = branchesOf(tree, path.map(message => message.id))
    const totals = await usageTotals(row.id)
    return { ...toSummary(row), settings: row.settings, messages: path, branches, totals }
  }

  /** Every message version of a chat (one query) with its parent and the active leaf, for the JSON export. */
  async function exportTree(row: ChatRow): Promise<ChatExportTree> {
    const rows = await db
      .select({ ...MESSAGE_COLUMNS, parentId: TREE_COLUMNS.parentId, seq: TREE_COLUMNS.seq })
      .from(messages)
      .where(eq(messages.chatId, row.id))
      .orderBy(asc(messages.seq))
    const tree = buildTree(rows)
    return {
      messages: rows.map(rowToMessage),
      // The effective parents: an export always imports again, even from damaged data.
      parentIds: rows.map(entry => tree.parentOf.get(entry.id) ?? null),
      activeLeafId: resolveLeaf(tree, row.activeLeafId),
    }
  }

  /** Message ids of `ids` that already exist (any chat). */
  async function existingMessageIds(ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>()
    for (const part of chunk([...new Set(ids)], ID_LOOKUP_CHUNK)) {
      const rows = await db.select({ id: messages.id }).from(messages).where(inArray(messages.id, part))
      for (const row of rows)
        found.add(row.id)
    }
    return found
  }

  /**
   * Inserts a chat with its messages (final ids, `seq` = position), their parents and its active leaf from `tree`, in
   * one batch that also records the active path as the remembered versions (ADR-030: an import re-derives them, they
   * are not exported). `conflict` (`exists`) when the chat id (or a message id, raced) is taken meanwhile.
   */
  async function insertChat(row: ChatInsert, list: readonly HarnessUIMessage[], tree: ImportTree, now: number): Promise<void> {
    const rows = list.map((message, seq) => {
      const parent = tree.parentIndex[seq] ?? -1
      return messageInsertValues(row.id, message, seq, parent < 0 ? null : list[parent]?.id ?? null, now)
    })
    const activeLeafId = tree.leafIndex < 0 ? null : list[tree.leafIndex]?.id ?? null
    try {
      await db.batch([
        db.insert(chats).values({ ...row, activeLeafId }),
        ...chunk(rows, INSERT_CHUNK_ROWS).map(values => db.insert(messages).values(values)),
        ...(activeLeafId === null ? [] : [db.run(rememberPathSql(row.id, activeLeafId))]),
      ])
    }
    catch (error) {
      if (isConstraintError(error))
        throw conflictExists(row.id)
      throw databaseError(error)
    }
  }

  function page(rows: readonly { row: ChatRow, snippet?: string }[], limit: number): CursorPage<ChatSummary> {
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return {
      items: items.map(({ row, snippet }) => toSummary(row, snippet)),
      nextCursor: rows.length > limit && last !== undefined ? encodeChatCursor({ updatedAt: last.row.updatedAt, id: last.row.id }) : null,
    }
  }

  async function listPlain(archived: boolean, after: ChatCursor | null, limit: number): Promise<CursorPage<ChatSummary>> {
    const rows = await db
      .select()
      .from(chats)
      .where(and(eq(chats.archived, archived), afterCursor(after)))
      .orderBy(desc(chats.updatedAt), desc(chats.id))
      .limit(limit + 1)
    return page(rows.map(row => ({ row })), limit)
  }

  async function search(q: string, archived: boolean, after: ChatCursor | null, limit: number): Promise<CursorPage<ChatSummary>> {
    const needle = normalizeForSearch(q)
    const pattern = likeContainsPattern(needle)
    // Plain SQL with explicit aliases: inside a select list Drizzle renders columns unqualified, which would bind
    // `chats.id` to the subquery's own table. Every message version is searched.
    const matchId = sql<string | null>`(
      SELECT m.id FROM messages AS m
      WHERE m.chat_id = chats.id AND m.search_text LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
      ORDER BY m.seq LIMIT 1
    )`
    const found: { row: ChatRow, matchId: string | null }[] = []
    let cursor = after
    for (;;) {
      const rows = await db
        .select({ chat: chats, matchId })
        .from(chats)
        .where(and(eq(chats.archived, archived), afterCursor(cursor)))
        .orderBy(desc(chats.updatedAt), desc(chats.id))
        .limit(SEARCH_BATCH_ROWS)
      for (const { chat, matchId: messageId } of rows) {
        if (messageId === null && !titleMatches(chat.title, needle))
          continue
        found.push({ row: chat, matchId: messageId })
        if (found.length > limit)
          break
      }
      const last = rows.at(-1)
      if (found.length > limit || rows.length < SEARCH_BATCH_ROWS || last === undefined)
        break
      cursor = { updatedAt: last.chat.updatedAt, id: last.chat.id }
    }

    // Snippets of the page from the original text of each matching message.
    const pageMatches = found.slice(0, limit)
    const matchIds = pageMatches.flatMap(entry => (entry.matchId === null ? [] : [entry.matchId]))
    const texts = new Map<string, string>()
    for (const part of chunk(matchIds, ID_LOOKUP_CHUNK)) {
      const rows = await db.select({ id: messages.id, parts: messages.parts }).from(messages).where(inArray(messages.id, part))
      for (const row of rows)
        texts.set(row.id, messagePlainText(row.parts))
    }
    return page(found.map(entry => ({
      row: entry.row,
      snippet: entry.matchId === null ? undefined : makeSnippet(texts.get(entry.matchId) ?? '', q),
    })), limit)
  }

  function emitUpdated(row: ChatRow): ChatSummary {
    const summary = toSummary(row)
    // `chat.updated` carries the active leaf so other tabs follow a version switch (ADR-030); callers get the summary.
    deps.events.emit('chat.updated', { ...summary, activeLeafId: row.activeLeafId })
    return summary
  }

  /**
   * Why the guarded write of a version switch or delete changed nothing although the checks before it passed: the chat
   * or the message is gone now (404), a delete's message has no other version left (409 `only-version`), else the active
   * leaf moved (409 `run-active`).
   */
  async function missReason(id: string, messageId: string, action: 'switch' | 'delete'): Promise<HarnessError> {
    if (await findRow(id) === undefined)
      return chatNotFound(id)
    const tree = buildTree(await listTreeRows(db, id))
    if (!tree.byId.has(messageId))
      return messageNotFound(id, messageId)
    if (action === 'delete' && siblingsOf(tree, messageId).length < 2)
      return onlyVersion()
    return leafMoved(id, action)
  }

  return {
    ...store,

    list: (query: ChatListQuery) => guardDb(async () => {
      const limit = clampLimit(query.limit)
      const archived = query.archived ?? false
      const after = query.cursor === undefined ? null : decodeChatCursor(query.cursor)
      const q = query.q?.trim() ?? ''
      return q === '' ? listPlain(archived, after, limit) : search(q, archived, after, limit)
    }),

    get: id => guardDb(async () => detailOf(await requireRow(id))),

    create: input => guardDb(async () => {
      const id = input.id ?? createChatId()
      if (!CHAT_ID_PATTERN.test(id))
        throw invalidField('id', 'Expected a lowercase uuidv7 chat id.')
      const title = input.title === undefined ? null : requireTitle(input.title)
      const modelRef = input.modelRef === undefined ? null : checkModelRef(input.modelRef)
      const settings = input.settings === undefined ? {} : checkSettings(input.settings)
      const imported = await validateImportedMessages(input.messages ?? [])
      const ids = imported.map(message => message.id)
      const tree = planImportTree(ids, input.parentIds, input.activeLeafId)
      if (await findRow(id) !== undefined)
        throw conflictExists(id)
      const list = assignMessageIds(imported, await existingMessageIds(ids))

      const now = Date.now()
      await insertChat({ id, title, titleSource: title === null ? null : 'user', modelRef, settings, createdAt: now, updatedAt: now }, list, tree, now)
      const row = await requireRow(id)
      const detail = await detailOf(row)
      deps.events.emit('chat.created', toSummary(row))
      return detail
    }),

    update: (id, patch) => guardDb(async () => {
      const set: ChatUpdateSet = {}
      if (patch.title !== undefined) {
        set.title = requireTitle(patch.title)
        set.titleSource = 'user'
      }
      if (patch.pinned !== undefined)
        set.pinned = patch.pinned
      if (patch.archived !== undefined)
        set.archived = patch.archived
      if (patch.modelRef !== undefined)
        set.modelRef = patch.modelRef === null ? null : checkModelRef(patch.modelRef)
      if (patch.settings !== undefined)
        set.settings = mergeSettings(patch.settings)
      const row = Object.keys(set).length === 0 ? await findRow(id) : await updateRow(id, set)
      if (row === undefined)
        throw chatNotFound(id)
      return emitUpdated(row)
    }),

    remove: id => guardDb(async () => {
      if (!CHAT_ID_PATTERN.test(id))
        throw chatNotFound(id)
      // Messages go with the chat (also without foreign key enforcement); usage rows are kept, detached.
      const [, , deleted] = await db.batch([
        db.update(usage).set({ chatId: null }).where(eq(usage.chatId, id)),
        db.delete(messages).where(eq(messages.chatId, id)),
        db.delete(chats).where(eq(chats.id, id)).returning({ id: chats.id }),
      ])
      if (deleted.length === 0)
        throw chatNotFound(id)
      deps.events.emit('chat.deleted', { id })
    }),

    export: (id, format) => guardDb(async () => {
      const row = await requireRow(id)
      const detail = await detailOf(row)
      const at = Date.now()
      return format === 'json' ? buildChatExport(detail, 'json', at, await exportTree(row)) : buildChatExport(detail, format, at)
    }),

    switchBranch: (id, messageId) => guardDb(async () => {
      const row = await requireRow(id)
      const tree = buildTree(await listTreeRows(db, id))
      // The path last shown under the message (ADR-030), so switching away and back restores it.
      const leaf = rememberedLeafUnder(tree, messageId)
      if (leaf === null)
        throw messageNotFound(id, messageId)
      const pendingApproval = tree.byId.get(leaf)?.role === 'assistant' && awaitsApproval(await store.getMessage(id, leaf))
      // Compare-and-set against the leaf read above (a run that committed meanwhile keeps its path) while the new leaf
      // still exists (a version delete may have taken it); the new path is remembered under the same condition, in the
      // same batch.
      const target = and(eq(chats.id, id), leafIs(row.activeLeafId), messageInChatSql(id, leaf))!
      const [, [updated]] = await db.batch([
        db.run(rememberPathSql(id, leaf, sql`EXISTS (SELECT 1 FROM ${chats} WHERE ${target})`)),
        db.update(chats).set({ activeLeafId: leaf, pendingApproval }).where(target).returning(),
      ])
      if (updated === undefined)
        throw await missReason(id, messageId, 'switch')
      emitUpdated(updated)
      return detailOf(updated)
    }),

    deleteMessage: (id, messageId) => guardDb(async () => {
      const row = await requireRow(id)
      const tree = buildTree(await listTreeRows(db, id))
      if (!tree.byId.has(messageId))
        throw messageNotFound(id, messageId)
      const siblings = siblingsOf(tree, messageId)
      const others = siblings.filter(sibling => sibling !== messageId)
      if (others.length === 0)
        throw onlyVersion()
      // Every write below also checks, when it runs, that another version is still there (a concurrent delete may have
      // taken the others): the last version of a message is never deleted.
      const otherVersion = sql`EXISTS (SELECT 1 FROM messages AS v WHERE v.chat_id = ${id}
        AND v.id IN (${sql.join(others.map(other => sql`${other}`), sql`, `)}))`
      let deleted: number
      if (pathTo(tree, resolveLeaf(tree, row.activeLeafId)).includes(messageId)) {
        // The active path goes through the message: it moves to what was last shown under the previous version by
        // `seq`, else the next one (`others` is not empty, so one of them exists), like a switch to that version.
        const index = siblings.indexOf(messageId)
        const target = siblings[index - 1] ?? siblings[index + 1]!
        const leaf = rememberedLeafUnder(tree, target)!
        const pendingApproval = tree.byId.get(leaf)?.role === 'assistant' && awaitsApproval(await store.getMessage(id, leaf))
        const leafExists = messageInChatSql(id, leaf)
        // One batch: the new path is remembered and the leaf moved under the compare-and-set against the leaf read
        // above; the subtree is deleted only when the leaf is the new one by then (a missed compare-and-set deletes
        // nothing).
        const cas = and(eq(chats.id, id), leafIs(row.activeLeafId), messageInChatSql(id, messageId), otherVersion, leafExists)!
        const [, , result] = await db.batch([
          db.run(rememberPathSql(id, leaf, sql`EXISTS (SELECT 1 FROM ${chats} WHERE ${cas})`)),
          db.update(chats).set({ activeLeafId: leaf, pendingApproval }).where(cas),
          db.run(deleteSubtreeSql(id, messageId, sql`${activeLeafIs(id, leaf)} AND ${leafExists} AND ${otherVersion}`)),
        ])
        deleted = result.rowsAffected
      }
      else {
        // A version off the active path: the leaf stays, and the subtree is deleted only while it is still the leaf
        // read above (a switch to this version may have won meanwhile).
        const [result] = await db.batch([
          db.run(deleteSubtreeSql(id, messageId, sql`${activeLeafIs(id, row.activeLeafId)} AND ${otherVersion}`)),
        ])
        deleted = result.rowsAffected
      }
      if (deleted === 0)
        throw await missReason(id, messageId, 'delete')
      // `updated_at`, usage rows, share snapshots and files stay; the deleted rows took their search text with them.
      const updated = await requireRow(id)
      emitUpdated(updated)
      return detailOf(updated)
    }),

    allIds: () => guardDb(async () => {
      const rows = await db.select({ id: chats.id }).from(chats).orderBy(asc(chats.id))
      return rows.map(row => row.id)
    }),

    importChat: input => guardDb(async () => {
      const parsed = chatExportAnySchema.safeParse(input.exported)
      if (!parsed.success)
        throw validationError(parsed.error)
      const exported = parsed.data
      const { chat } = exported
      const imported = await validateImportedMessages(chat.messages, ['chat'])
      const ids = imported.map(message => message.id)
      const tree = exported.version === 2
        ? planImportTree(ids, exported.chat.parentIds, exported.chat.activeLeafId, ['chat'])
        : planImportTree(ids, undefined, undefined, ['chat'])
      const id = input.id === 'keep' ? chat.id : createChatId()
      if (input.id === 'keep' && await findRow(id) !== undefined)
        throw conflictExists(id)
      const list = input.id === 'keep' ? assignMessageIds(imported, await existingMessageIds(ids)) : freshMessageIds(imported)

      const now = Date.now()
      const title = input.restore && chat.title !== null ? sanitizeTitle(chat.title) : null
      await insertChat({
        id,
        title,
        // A title without a source is kept like a user title (never replaced by an automatic one).
        titleSource: title === null ? null : chat.titleSource ?? 'user',
        modelRef: chat.modelRef,
        settings: chat.settings,
        pinned: input.restore && chat.pinned,
        archived: input.restore && chat.archived,
        createdAt: input.restore ? chat.createdAt : now,
        updatedAt: input.restore ? chat.updatedAt : now,
      }, list, tree, now)
      deps.events.emit('chat.created', toSummary(await requireRow(id)))
      return { id, messages: list.length }
    }),

    removeAll: options => guardDb(async () => {
      // One batch: usage rows first (deleted, or detached like `remove` does), then every message and every chat;
      // share links go with their chats (`chat_shares.chat_id` ON DELETE CASCADE).
      const usageStatement = options.usage
        ? db.delete(usage).returning({ id: usage.id })
        : db.update(usage).set({ chatId: null }).where(isNotNull(usage.chatId)).returning({ id: usage.id })
      const [usageRows, messageResult, deleted] = await db.batch([
        usageStatement,
        db.delete(messages),
        db.delete(chats).returning({ id: chats.id }),
      ])
      const chatIds = deleted.map(entry => entry.id).sort()
      for (const id of chatIds)
        deps.events.emit('chat.deleted', { id })
      return { chatIds, messages: messageResult.rowsAffected, usageRows: options.usage ? usageRows.length : 0 }
    }),

    find: id => guardDb(async () => {
      const row = await findRow(id)
      return row === undefined ? null : toRecord(row)
    }),

    summary: id => guardDb(async () => toSummary(await requireRow(id))),

    ensure: (id, init = {}) => guardDb(async () => {
      if (!CHAT_ID_PATTERN.test(id))
        throw invalidField('id', 'Expected a lowercase uuidv7 chat id.')
      const modelRef = init.modelRef === undefined ? undefined : checkModelRef(init.modelRef)
      const settings = init.settings === undefined ? undefined : checkSettings(init.settings)
      const now = Date.now()
      const [created] = await db
        .insert(chats)
        .values({ id, modelRef: modelRef ?? null, settings: settings ?? {}, createdAt: now, updatedAt: now })
        .onConflictDoNothing({ target: chats.id })
        .returning()
      if (created !== undefined) {
        deps.events.emit('chat.created', toSummary(created))
        return { chat: toRecord(created), created: true }
      }
      const set: ChatUpdateSet = {}
      if (modelRef !== undefined)
        set.modelRef = modelRef
      if (settings !== undefined)
        set.settings = mergeSettings(settings)
      const row = Object.keys(set).length === 0 ? await findRow(id) : await updateRow(id, set)
      if (row === undefined)
        throw chatNotFound(id)
      return { chat: toRecord(row), created: false }
    }),

    touch: (id, input = {}) => guardDb(async () => {
      const at = input.at ?? Date.now()
      // Activity only moves forward: an older `at` never sends a chat down the list.
      const set: ChatUpdateSet = { updatedAt: sql`max(${chats.updatedAt}, ${Math.max(0, Math.trunc(at))})` }
      if (input.pendingApproval !== undefined)
        set.pendingApproval = input.pendingApproval
      if (input.modelRef !== undefined)
        set.modelRef = checkModelRef(input.modelRef)
      if (input.settings !== undefined)
        set.settings = mergeSettings(checkSettings(input.settings))
      const row = await updateRow(id, set)
      if (row === undefined)
        throw chatNotFound(id)
      return emitUpdated(row)
    }),

    setTitle: (id, title, source) => guardDb(async () => {
      if (source !== 'auto' && source !== 'fallback')
        throw invalidField('titleSource', 'Automatic titles use the source auto or fallback.')
      const clean = sanitizeTitle(title)
      if (clean === null || !CHAT_ID_PATTERN.test(id))
        return null
      const [row] = await db
        .update(chats)
        .set({ title: clean, titleSource: source })
        .where(and(eq(chats.id, id), or(isNull(chats.titleSource), ne(chats.titleSource, 'user'))))
        .returning()
      return row === undefined ? null : emitUpdated(row)
    }),

    addUsage: (input: UsageInput) => guardDb(async () => {
      const cost = input.costUsd
      await db.insert(usage).values({
        // The chat may be gone (deleted during the run): the row is kept with `chat_id = NULL`.
        chatId: input.chatId === null ? null : sql`(SELECT ${chats.id} FROM ${chats} WHERE ${chats.id} = ${input.chatId})`,
        messageId: input.messageId,
        purpose: input.purpose,
        providerId: input.providerId,
        modelId: input.modelId,
        input: tokenCount(input.inputTokens),
        output: tokenCount(input.outputTokens),
        reasoning: tokenCount(input.reasoningTokens),
        cacheRead: tokenCount(input.cacheReadTokens),
        cacheWrite: tokenCount(input.cacheWriteTokens),
        costUsd: cost === null || !Number.isFinite(cost) || cost < 0 ? null : cost,
        createdAt: input.createdAt ?? Date.now(),
      })
    }),

    transaction: fn => guardDb(async () => db.transaction(async tx => fn(createMessageStore(tx)))),
  }
}
