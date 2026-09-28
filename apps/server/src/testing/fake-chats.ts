// Test double of the Phase 5 members of `ChatsService` (ADR-023 message tree, ADR-024 bulk data) for the tests of other
// services while W5.1 implements the real ones (C8-T6; used by W5.3 data and W5.4 shares):
//
//   const t = await createTestApp({ factories: { chats: createFakeChatsService } })
//
// It wraps the real service (`createChatsService(deps)`) and relies only on its v1 members (`create` of a linear import,
// `get` for the summary / settings / totals, `listMessages`, `getMessage`, `upsertMessage`, `summary`, `find`,
// `export`), so it keeps working while W5.1 rewrites `services/chats/**`. The tree lives in the real columns
// (`messages.parent_id`, `chats.active_leaf_id`):
// - A chat the fake never wrote a tree for, whose messages all have no parent and which has no active leaf, is linear
//   (v1 data, and chats written by the P5-0b pipeline through the real `transaction()`): parent = the previous message
//   by `seq`, active leaf = the last message. The first tree write into such a chat (`appendMessage`, `upsertMessage`
//   with a parent, `setActiveLeaf`, `switchBranch`) stores that chain first; `create` and `importChat` always store the
//   tree.
// - Otherwise the stored tree is used, as the real service does: a parent outside the chat or not older than its child
//   counts as none, and without an active leaf the path is empty.
// Overridden: `get`, `find`, `create`, `remove`, `export` (JSON), `listPath`, `appendMessage`, `upsertMessage`,
// `setActiveLeaf`, `switchBranch`, `allIds`, `importChat`, `removeAll`, and (Phase 6, C11-T5) `deleteMessage`. Everything
// else, `transaction()` included, is the real service (its store members stay the real ones).
// Phase 6 (ADR-030, W6.6): remembered versions like the real service: `create`, `importChat`, `setActiveLeaf` (after a
// successful compare-and-set), `switchBranch` and `deleteMessage` record the shown path in `messages.selected_child_id`,
// and `switchBranch` / `deleteMessage` show the remembered leaf. Every `chat.updated` carries the stored active leaf
// (`update`, `touch` and `setTitle` are the real ones).
// Simplifications: writes are not atomic (a failed tree write after `create` leaves a linear chat), `export(id, 'md')`
// is the real Markdown export, and the `chat.created` event of `importChat` carries the summary from before the title,
// flags and dates are restored.
import type { ChatDetail, ChatExport, HarnessUIMessage, MessageBranch } from '@harness-forge/shared'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client.ts'
import type { ChatImportInput, ChatImportResult, ChatRemoveAllOptions, ChatRemoveAllResult, ChatsService } from '../services/chats/types.ts'
import type { AppDeps } from '../types.ts'
import { chatExportAnySchema, createChatId, createMessageId, HarnessError, validationError } from '@harness-forge/shared'
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { chats, messages, usage } from '../db/schema.ts'
import { createChatsService } from '../services/chats/index.ts'

/** The tree of one chat as the fake reads it (see the module comment). */
export interface FakeChatTree {
  /** Message ids in `seq` order. */
  ids: string[]
  seqOf: Map<string, number>
  /** The effective parent of every message (`null` = a first message). */
  parentOf: Map<string, string | null>
  /** The effective active leaf; null for an empty chat (or a tree without an active leaf). */
  leaf: string | null
  /** A linear chat without a stored tree. */
  linear: boolean
}

/** Parents by index (`-1` = a first message) and the active leaf index of an import (null for no messages). */
interface TreePlan {
  parentIndex: number[]
  leafIndex: number | null
}

type Batch = [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]

function notFound(message: string): HarnessError {
  return new HarnessError({ code: 'not_found', message })
}

function chatNotFound(chatId: string): HarnessError {
  return notFound(`Chat ${chatId} not found.`)
}

function messageNotFound(chatId: string, messageId: string): HarnessError {
  return notFound(`Message ${messageId} is not in chat ${chatId}.`)
}

function runActive(chatId: string): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'A reply is already being generated for this chat. Stop it or wait until it finishes.',
    details: { reason: 'run-active', chatId },
  })
}

function onlyVersion(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'This is the only version of the message. Delete the chat instead.',
    details: { reason: 'only-version' },
  })
}

function messageExists(): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'A message with this id already exists.', details: { reason: 'exists' } })
}

/** The last message of a path waits for a tool approval (`chats.pending_approval`). */
function awaitsApproval(message: HarnessUIMessage | null): boolean {
  if (message?.role !== 'assistant')
    return false
  return message.parts.some(part => (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
    && (part as { state?: unknown }).state === 'approval-requested')
}

/**
 * Reads the tree of a chat; null when the chat does not exist. `stored`: the fake wrote a tree for this chat, so it is
 * never read as a linear v1 chat.
 */
export async function loadFakeChatTree(db: Db, chatId: string, stored = false): Promise<FakeChatTree | null> {
  const [chat] = await db.select({ activeLeafId: chats.activeLeafId }).from(chats).where(eq(chats.id, chatId)).limit(1)
  if (chat === undefined)
    return null
  const rows = await db
    .select({ id: messages.id, parentId: messages.parentId, seq: messages.seq })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.seq))
  const seqOf = new Map(rows.map(row => [row.id, row.seq]))
  const linear = !stored && chat.activeLeafId === null && rows.every(row => row.parentId === null)
  const parentOf = new Map<string, string | null>()
  rows.forEach((row, index) => {
    if (linear) {
      parentOf.set(row.id, rows[index - 1]?.id ?? null)
      return
    }
    const parentSeq = row.parentId === null ? undefined : seqOf.get(row.parentId)
    parentOf.set(row.id, parentSeq !== undefined && parentSeq < row.seq ? row.parentId : null)
  })
  const leaf = linear
    ? rows.at(-1)?.id ?? null
    : chat.activeLeafId !== null && seqOf.has(chat.activeLeafId) ? chat.activeLeafId : null
  return { ids: rows.map(row => row.id), seqOf, parentOf, leaf, linear }
}

/** The ids of the path from the first message to `leafId` (parents always have a lower `seq`, so this ends). */
export function fakePathTo(tree: FakeChatTree, leafId: string | null): string[] {
  const path: string[] = []
  let current = leafId
  while (current !== null && tree.seqOf.has(current)) {
    path.push(current)
    current = tree.parentOf.get(current) ?? null
  }
  return path.reverse()
}

/** The message with the highest `seq` in the subtree of `messageId` (itself when it has no children). */
export function fakeLatestLeafUnder(tree: FakeChatTree, messageId: string): string {
  const children = new Map<string, string[]>()
  for (const id of tree.ids) {
    const parent = tree.parentOf.get(id) ?? null
    if (parent !== null)
      children.set(parent, [...(children.get(parent) ?? []), id])
  }
  let latest = messageId
  const stack = [messageId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if ((tree.seqOf.get(id) ?? -1) > (tree.seqOf.get(latest) ?? -1))
      latest = id
    stack.push(...(children.get(id) ?? []))
  }
  return latest
}

/** `ChatDetail.branches` of a path: every path message with at least two versions (same parent, `seq` order). */
export function fakeBranchesOf(tree: FakeChatTree, path: readonly string[]): Record<string, MessageBranch> {
  const groups = new Map<string | null, string[]>()
  for (const id of tree.ids) {
    const parent = tree.parentOf.get(id) ?? null
    groups.set(parent, [...(groups.get(parent) ?? []), id])
  }
  const branches: Record<string, MessageBranch> = {}
  for (const id of path) {
    const siblings = groups.get(tree.parentOf.get(id) ?? null) ?? []
    if (siblings.length >= 2)
      branches[id] = { siblings: [...siblings], index: siblings.indexOf(id) }
  }
  return branches
}

/** The versions of a message: every message with the same effective parent (itself included), in `seq` order. */
export function fakeSiblingsOf(tree: FakeChatTree, messageId: string): string[] {
  const parent = tree.parentOf.get(messageId) ?? null
  return tree.ids.filter(id => (tree.parentOf.get(id) ?? null) === parent)
}

/** `messageId` and every message after it (its subtree), in `seq` order. */
export function fakeSubtreeOf(tree: FakeChatTree, messageId: string): string[] {
  const subtree = new Set([messageId])
  for (const id of tree.ids) {
    const parent = tree.parentOf.get(id) ?? null
    if (parent !== null && subtree.has(parent))
      subtree.add(id)
  }
  return tree.ids.filter(id => subtree.has(id))
}

/**
 * The remembered leaf under `messageId` (ADR-030): walking down, the remembered child (`selected_child_id`) while it is
 * still a child of the node, else the only child, else the most recent leaf.
 */
export function fakeRememberedLeafUnder(tree: FakeChatTree, pointers: ReadonlyMap<string, string | null>, messageId: string): string {
  let node = messageId
  for (;;) {
    const children = tree.ids.filter(id => tree.parentOf.get(id) === node)
    if (children.length === 0)
      return node
    const remembered = pointers.get(node) ?? null
    if (remembered !== null && children.includes(remembered))
      node = remembered
    else if (children.length === 1)
      node = children[0]!
    else
      return fakeLatestLeafUnder(tree, node)
  }
}

/**
 * Validates the tree of an import (`parentIds` aligned with `list`, each parent an earlier message, unique ids, a known
 * `activeLeafId`) before anything is written; `validation_error` with the field path under `base`.
 */
function planTree(
  list: readonly HarnessUIMessage[],
  parentIds: readonly (string | null)[] | undefined,
  activeLeafId: string | null | undefined,
  base: (string | number)[],
): TreePlan {
  const ids = list.map(message => message.id)
  const invalid = (path: (string | number)[], message: string): HarnessError =>
    validationError([{ path: [...base, ...path], message, code: 'custom' }])
  let parentIndex = ids.map((_id, index) => index - 1)
  if (parentIds !== undefined) {
    if (parentIds.length !== ids.length)
      throw invalid(['parentIds'], `Expected ${ids.length} parent ids, one per message.`)
    const indexOf = new Map<string, number>()
    ids.forEach((id, index) => {
      if (indexOf.has(id))
        throw invalid(['messages', index, 'id'], 'Duplicate message id.')
      indexOf.set(id, index)
    })
    parentIndex = parentIds.map((parentId, index) => {
      if (parentId === null)
        return -1
      const at = indexOf.get(parentId)
      if (at === undefined || at >= index)
        throw invalid(['parentIds', index], 'Expected the id of an earlier message.')
      return at
    })
  }
  let start = ids.length - 1
  if (activeLeafId !== undefined && activeLeafId !== null) {
    start = ids.indexOf(activeLeafId)
    if (start < 0)
      throw invalid(['activeLeafId'], 'Expected the id of a message of the chat.')
  }
  if (start < 0)
    return { parentIndex, leafIndex: null }
  // The most recent leaf under `start`: the highest index in its subtree (a child always comes after its parent).
  const subtree = new Set([start])
  let leafIndex = start
  for (let index = start + 1; index < ids.length; index++) {
    if (subtree.has(parentIndex[index] ?? -1)) {
      subtree.add(index)
      leafIndex = index
    }
  }
  return { parentIndex, leafIndex }
}

/**
 * The real `ChatsService` with the Phase 5 members replaced by simple versions on the test database (see the module
 * comment). Use as a factory: `createTestApp({ factories: { chats: createFakeChatsService } })`.
 */
export function createFakeChatsService(deps: AppDeps): ChatsService {
  const base = createChatsService(deps)
  const db: Db = deps.db
  /** Chats the fake wrote a tree for: never read as linear v1 chats again. */
  const treeChats = new Set<string>()

  async function readTree(chatId: string): Promise<FakeChatTree | null> {
    return loadFakeChatTree(db, chatId, treeChats.has(chatId))
  }

  async function requireTree(chatId: string): Promise<FakeChatTree> {
    const tree = await readTree(chatId)
    if (tree === null)
      throw chatNotFound(chatId)
    return tree
  }

  /** Before a tree write: stores the implicit chain of a linear chat (the migration backfill, for one chat). */
  async function materialize(chatId: string, tree: FakeChatTree): Promise<void> {
    treeChats.add(chatId)
    if (!tree.linear || tree.ids.length === 0)
      return
    await db.batch([
      db.update(messages)
        .set({ parentId: sql`(SELECT p.id FROM messages p WHERE p.chat_id = messages.chat_id AND p.seq < messages.seq ORDER BY p.seq DESC LIMIT 1)` })
        .where(eq(messages.chatId, chatId)),
      db.update(chats).set({ activeLeafId: tree.leaf }).where(eq(chats.id, chatId)),
    ])
    tree.linear = false
  }

  /** `selected_child_id` of every message of a chat. */
  async function pointersOf(chatId: string): Promise<Map<string, string | null>> {
    const rows = await db.select({ id: messages.id, selectedChildId: messages.selectedChildId }).from(messages).where(eq(messages.chatId, chatId))
    return new Map(rows.map(row => [row.id, row.selectedChildId]))
  }

  /** Records the path that ends at `leafId` as the remembered versions (ADR-030): each parent points at its child. */
  async function rememberPath(chatId: string, tree: FakeChatTree, leafId: string): Promise<void> {
    const path = fakePathTo(tree, leafId)
    for (let index = 1; index < path.length; index++)
      await db.update(messages).set({ selectedChildId: path[index]! }).where(and(eq(messages.chatId, chatId), eq(messages.id, path[index - 1]!)))
  }

  /** Writes the planned tree over the messages of a chat that was just created (same order as the plan). */
  async function applyTree(chatId: string, plan: TreePlan): Promise<void> {
    const stored = (await base.listMessages(chatId)).map(message => message.id)
    if (stored.length !== plan.parentIndex.length)
      throw new Error(`fake chats: chat ${chatId} holds ${stored.length} messages, the import had ${plan.parentIndex.length}.`)
    // The pointers the real `create` wrote for its linear chain are cleared; the planned path is remembered below.
    const statements: BatchItem<'sqlite'>[] = stored.map((id, index) => {
      const parent = plan.parentIndex[index] ?? -1
      return db.update(messages)
        .set({ parentId: parent < 0 ? null : stored[parent] ?? null, selectedChildId: null })
        .where(and(eq(messages.chatId, chatId), eq(messages.id, id)))
    })
    statements.push(db.update(chats)
      .set({ activeLeafId: plan.leafIndex === null ? null : stored[plan.leafIndex] ?? null })
      .where(eq(chats.id, chatId)))
    treeChats.add(chatId)
    await db.batch(statements as Batch)
    // The active path is remembered (an import re-derives the pointers, which are never exported).
    const tree = await requireTree(chatId)
    if (tree.leaf !== null)
      await rememberPath(chatId, tree, tree.leaf)
  }

  async function detail(id: string): Promise<ChatDetail> {
    const current = await base.get(id)
    const all = await base.listMessages(id)
    const tree = await requireTree(id)
    const path = fakePathTo(tree, tree.leaf)
    const byId = new Map(all.map(message => [message.id, message]))
    return {
      ...current,
      messages: path.flatMap((messageId) => {
        const message = byId.get(messageId)
        return message === undefined ? [] : [message]
      }),
      branches: fakeBranchesOf(tree, path),
    }
  }

  async function allIds(): Promise<string[]> {
    const rows = await db.select({ id: chats.id }).from(chats).orderBy(asc(chats.id))
    return rows.map(row => row.id)
  }

  async function importChat(input: ChatImportInput): Promise<ChatImportResult> {
    const parsed = chatExportAnySchema.safeParse(input.exported)
    if (!parsed.success)
      throw validationError(parsed.error)
    const exported = parsed.data
    const list = exported.chat.messages
    const plan = exported.version === 2
      ? planTree(list, exported.chat.parentIds, exported.chat.activeLeafId, ['chat'])
      : planTree(list, undefined, undefined, ['chat'])
    const created = await base.create({
      id: input.id === 'keep' ? exported.chat.id : createChatId(),
      ...(exported.chat.modelRef === null ? {} : { modelRef: exported.chat.modelRef }),
      settings: exported.chat.settings,
      messages: input.id === 'keep' ? list : list.map(message => ({ ...message, id: createMessageId() })),
    })
    await applyTree(created.id, plan)
    if (input.restore) {
      const { title, titleSource, pinned, archived, createdAt, updatedAt } = exported.chat
      await db.update(chats).set({ title, titleSource, pinned, archived, createdAt, updatedAt }).where(eq(chats.id, created.id))
    }
    return { id: created.id, messages: list.length }
  }

  /**
   * `deleteMessage` (ADR-030): 404s, `run-active` (`deps.runs.hasRun`), `only-version`; deletes the subtree; when the
   * active path went through the message the leaf moves to the remembered leaf under its previous sibling (else the
   * next), `pending_approval` follows and the new path is recorded as remembered; emits `chat.updated` with the leaf.
   * No compare-and-set (tests run one request at a time).
   */
  async function deleteMessage(id: string, messageId: string): Promise<ChatDetail> {
    const tree = await requireTree(id)
    if (!tree.seqOf.has(messageId))
      throw messageNotFound(id, messageId)
    if (deps.runs.hasRun(id))
      throw runActive(id)
    const siblings = fakeSiblingsOf(tree, messageId)
    if (siblings.length < 2)
      throw onlyVersion()
    await materialize(id, tree)
    const subtree = fakeSubtreeOf(tree, messageId)
    const onPath = fakePathTo(tree, tree.leaf).includes(messageId)
    let leaf = tree.leaf
    if (onPath) {
      const index = siblings.indexOf(messageId)
      const target = siblings[index - 1] ?? siblings[index + 1]!
      leaf = fakeRememberedLeafUnder(tree, await pointersOf(id), target)
    }
    await db.delete(messages).where(and(eq(messages.chatId, id), inArray(messages.id, subtree)))
    if (onPath && leaf !== null) {
      const pendingApproval = awaitsApproval(await base.getMessage(id, leaf))
      await db.update(chats).set({ activeLeafId: leaf, pendingApproval }).where(eq(chats.id, id))
      await rememberPath(id, tree, leaf)
    }
    deps.events.emit('chat.updated', { ...(await base.summary(id)), activeLeafId: leaf })
    return detail(id)
  }

  async function removeAll(options: ChatRemoveAllOptions): Promise<ChatRemoveAllResult> {
    const usageStatement = options.usage
      ? db.delete(usage).returning({ id: usage.id })
      : db.update(usage).set({ chatId: null }).where(isNotNull(usage.chatId)).returning({ id: usage.id })
    // Share links go with their chats (`chat_shares.chat_id` ON DELETE CASCADE).
    const [usageRows, messageRows, chatRows] = await db.batch([
      usageStatement,
      db.delete(messages).returning({ id: messages.id }),
      db.delete(chats).returning({ id: chats.id }),
    ])
    const chatIds = chatRows.map(row => row.id).sort()
    for (const id of chatIds) {
      treeChats.delete(id)
      deps.events.emit('chat.deleted', { id })
    }
    return { chatIds, messages: messageRows.length, usageRows: options.usage ? usageRows.length : 0 }
  }

  const fake = {
    ...base,

    get: detail,

    find: async (id: string) => {
      const record = await base.find(id)
      if (record === null || record.activeLeafId !== null)
        return record
      const tree = await readTree(id)
      return { ...record, activeLeafId: tree?.leaf ?? null }
    },

    remove: async (id: string) => {
      await base.remove(id)
      treeChats.delete(id)
    },

    create: async (input: Parameters<ChatsService['create']>[0]) => {
      const { parentIds, activeLeafId, ...linear } = input
      const plan = planTree(input.messages ?? [], parentIds, activeLeafId, [])
      const created = await base.create(linear)
      await applyTree(created.id, plan)
      return detail(created.id)
    },

    export: async (id: string, format: Parameters<ChatsService['export']>[1]) => {
      const file = await base.export(id, format)
      if (format !== 'json')
        return file
      const current = await base.get(id)
      const all = await base.listMessages(id)
      const tree = await requireTree(id)
      const { branches: _branches, settings, totals, messages: _path, snippet: _snippet, ...summary } = current
      const body: ChatExport = {
        format: 'harness-forge.chat',
        version: 2,
        exportedAt: Date.now(),
        chat: {
          ...summary,
          running: false,
          pendingApproval: false,
          settings,
          totals,
          messages: all,
          parentIds: all.map(message => tree.parentOf.get(message.id) ?? null),
          activeLeafId: tree.leaf,
        },
      }
      return { ...file, body: `${JSON.stringify(body, null, 2)}\n` }
    },

    listPath: async (chatId: string, leafId: string | null) => {
      if (leafId === null)
        return []
      const tree = await requireTree(chatId)
      if (!tree.seqOf.has(leafId))
        throw messageNotFound(chatId, leafId)
      const byId = new Map((await base.listMessages(chatId)).map(message => [message.id, message]))
      return fakePathTo(tree, leafId).flatMap((id) => {
        const message = byId.get(id)
        return message === undefined ? [] : [message]
      })
    },

    appendMessage: async (chatId: string, message: HarnessUIMessage, parentId: string | null) => {
      const tree = await requireTree(chatId)
      if (parentId !== null && !tree.seqOf.has(parentId))
        throw messageNotFound(chatId, parentId)
      const [used] = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id)).limit(1)
      if (used !== undefined)
        throw messageExists()
      await materialize(chatId, tree)
      await base.upsertMessage(chatId, message, parentId)
      await db.update(messages).set({ parentId }).where(and(eq(messages.chatId, chatId), eq(messages.id, message.id)))
    },

    upsertMessage: async (chatId: string, message: HarnessUIMessage, parentId?: string | null) => {
      // No parent (the v1 pipeline) or an existing message: the real upsert (an existing message keeps its parent).
      if (parentId === undefined || await base.getMessage(chatId, message.id) !== null)
        return base.upsertMessage(chatId, message, null)
      const tree = await requireTree(chatId)
      if (parentId !== null && !tree.seqOf.has(parentId))
        throw messageNotFound(chatId, parentId)
      await materialize(chatId, tree)
      await base.upsertMessage(chatId, message, parentId)
      await db.update(messages).set({ parentId }).where(and(eq(messages.chatId, chatId), eq(messages.id, message.id)))
    },

    setActiveLeaf: async (chatId: string, leafId: string, onlyFrom?: readonly (string | null)[]) => {
      const tree = await readTree(chatId)
      if (tree === null || !tree.seqOf.has(leafId))
        return false
      await materialize(chatId, tree)
      let current
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
      const rows = await db.update(chats).set({ activeLeafId: leafId }).where(and(eq(chats.id, chatId), current)).returning({ id: chats.id })
      if (rows.length === 0)
        return false
      // The shown path is remembered after a successful compare-and-set only (ADR-030).
      await rememberPath(chatId, tree, leafId)
      return true
    },

    switchBranch: async (id: string, messageId: string) => {
      const tree = await requireTree(id)
      if (!tree.seqOf.has(messageId))
        throw messageNotFound(id, messageId)
      if (deps.runs.hasRun(id))
        throw runActive(id)
      await materialize(id, tree)
      // The path last shown under the message (ADR-030); the new path is remembered.
      const leaf = fakeRememberedLeafUnder(tree, await pointersOf(id), messageId)
      const pendingApproval = awaitsApproval(await base.getMessage(id, leaf))
      await db.update(chats).set({ activeLeafId: leaf, pendingApproval }).where(eq(chats.id, id))
      await rememberPath(id, tree, leaf)
      deps.events.emit('chat.updated', { ...(await base.summary(id)), activeLeafId: leaf })
      return detail(id)
    },

    deleteMessage,
    allIds,
    importChat,
    removeAll,
  }
  return fake
}
