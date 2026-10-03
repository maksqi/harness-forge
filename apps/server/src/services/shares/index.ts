// Read-only share links (ADR-025, API.md 4.17 / 5.20, ARCHITECTURE.md 6.10 / 10.7). Owner: W5.4. Implements
// `ShareService` (./types.ts) behind `createShareService(deps)`.
//
// A share is a `chat_shares` row: the allowlist-sanitized snapshot of the chat's active path (`ChatsService.get`,
// ./snapshot.ts), the only file ids it may serve, its options, an optional custom title and an optional expiry. Its
// token (./token.ts) is recomputed from the id with the keyring subkey `share` and never stored or logged. The owner
// members run behind a session (`create` / `update` also behind fresh auth, route table flags); `view` and `openFile`
// serve the public routes: they read only the stored snapshot, answer the same `not_found` for every failure (the chat
// is re-checked on every call) and write nothing. `outdated` = the chat's `updated_at` is later than `snapshot_at`, or
// its active path now holds another number of user / assistant messages than `message_count`; `expired` =
// `expires_at <= now`. Share actions emit no server event. A master-key rotation (ADR-034) changes every token: the
// codec is rebuilt when `keyring.keyVersion` changes.
import type { HarnessError, ShareCreate, ShareOptions, SharesQuery, ShareSummary, ShareUpdate, ShareView } from '@harness-forge/shared'
import type { ChatShareRow } from '../../db/schema.ts'
import type { AppDeps } from '../../types.ts'
import type { ChatRecord } from '../chats/types.ts'
import type { ShareTokens } from './token.ts'
import type { ShareFile, ShareService } from './types.ts'
import { createShareId, isHarnessError, LIMITS, shareOptionsSchema, validationError } from '@harness-forge/shared'
import { count, desc, eq } from 'drizzle-orm'
import { chatShares } from '../../db/schema.ts'
import { guardDb, isConstraintError } from '../chats/db-errors.ts'
import { chatNotFoundError, shareNotFoundError, shareUnavailableError, snapshotTooLargeError } from './errors.ts'
import { renderShareMessages, sanitizeSnapshot, shareableMessageCount, snapshotBytes, snapshotTitle } from './snapshot.ts'
import { createShareTokens, shareFileUrl, sharePagePath } from './token.ts'

/** How far ahead `expiresAt` may be. */
export const SHARE_MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000

export interface ShareServiceOptions {
  /** Clock of `createdAt`, `snapshotAt` and the expiry rules (tests); default `Date.now`. */
  now?: () => number
}

/** The columns of a share that its summary needs (never the snapshot, which can be large). */
const SUMMARY_COLUMNS = {
  id: chatShares.id,
  chatId: chatShares.chatId,
  title: chatShares.title,
  options: chatShares.options,
  messageCount: chatShares.messageCount,
  snapshotAt: chatShares.snapshotAt,
  expiresAt: chatShares.expiresAt,
  createdAt: chatShares.createdAt,
}

type SummaryRow = Pick<ChatShareRow, keyof typeof SUMMARY_COLUMNS>

/** The active path length of a chat, already known (right after a snapshot): saves a second `chats.get`. */
interface KnownPathCount {
  chatId: string
  pathCount: number
}

/** A new snapshot of a chat (`create`, `update` with `refresh`). */
interface TakenSnapshot {
  snapshot: ChatShareRow['snapshot']
  fileIds: string[]
  messageCount: number
  snapshotAt: number
}

/** The stored options with the defaults for anything missing (rows are written only by this service). */
function readOptions(value: unknown): ShareOptions {
  const stored = typeof value === 'object' && value !== null ? value as Partial<Record<keyof ShareOptions, unknown>> : {}
  return {
    reasoning: stored.reasoning === true,
    toolDetails: stored.toolDetails === true,
    attachments: stored.attachments !== false,
  }
}

function readFileIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function isExpired(expiresAt: number | null, time: number): boolean {
  return expiresAt !== null && expiresAt <= time
}

/** `expiresAt` of a create or update: null / omitted, or in the future and at most 365 days ahead. */
function checkExpiry(expiresAt: number | null | undefined, time: number): void {
  if (expiresAt === undefined || expiresAt === null)
    return
  if (expiresAt <= time || expiresAt > time + SHARE_MAX_EXPIRY_MS)
    throw validationError([{ path: ['expiresAt'], message: 'Expected a time in the future, at most 365 days ahead.', code: 'custom' }])
}

function tooManyShares(): HarnessError {
  return validationError([{ path: ['chatId'], message: `A chat has at most ${LIMITS.sharesPerChatMax} share links.`, code: 'custom' }])
}

function isNotFound(error: unknown): boolean {
  return isHarnessError(error) && error.code === 'not_found'
}

export function createShareService(deps: AppDeps, options: ShareServiceOptions = {}): ShareService {
  const { db } = deps
  const now = options.now ?? Date.now

  // Resolved on first use, like the session key, and again after a key rotation (ADR-034): the codec is valid only for
  // the key version its subkey was read at, so every token of the old key stops working at once.
  let codec: { version: number, tokens: ShareTokens } | null = null
  function tokens(): ShareTokens {
    const version = deps.keyring.keyVersion
    if (codec === null || codec.version !== version) {
      const key = deps.keyring.subkey('share')
      try {
        codec = { version, tokens: createShareTokens(key) }
      }
      finally {
        key.fill(0)
      }
    }
    return codec.tokens
  }

  // `create` checks the per-chat limit and inserts under this lock, so concurrent creates cannot pass the limit.
  let createQueue: Promise<unknown> = Promise.resolve()
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = createQueue.then(operation, operation)
    createQueue = run.catch(() => {})
    return run
  }

  async function sharesOfChat(chatId: string): Promise<number> {
    const [row] = await guardDb(() => db.select({ value: count() }).from(chatShares).where(eq(chatShares.chatId, chatId)))
    return row?.value ?? 0
  }

  /** Snapshots the chat's active path; `not_found` for an unknown chat, `payload_too_large` above the limit. */
  async function takeSnapshot(chatId: string): Promise<TakenSnapshot> {
    // Taken before reading the chat: a change that races the read makes the share outdated, never silently stale.
    const snapshotAt = now()
    const detail = await deps.chats.get(chatId)
    const { snapshot, fileIds } = sanitizeSnapshot(detail.title, detail.messages, url => deps.files.idFromUrl(url))
    if (snapshotBytes(snapshot) > LIMITS.shareSnapshotBytes)
      throw snapshotTooLargeError()
    return { snapshot, fileIds, messageCount: snapshot.messages.length, snapshotAt }
  }

  /** The summaries of `rows` (same order); shares whose chat vanished meanwhile are left out. */
  async function summarize(rows: readonly SummaryRow[], known?: KnownPathCount): Promise<ShareSummary[]> {
    const time = now()
    const chatsById = new Map<string, ChatRecord | null>()
    const pathCounts = new Map<string, number | null>(known === undefined ? [] : [[known.chatId, known.pathCount]])

    async function chatOf(chatId: string): Promise<ChatRecord | null> {
      if (!chatsById.has(chatId))
        chatsById.set(chatId, await deps.chats.find(chatId))
      return chatsById.get(chatId) ?? null
    }

    async function pathCountOf(chatId: string): Promise<number | null> {
      if (!pathCounts.has(chatId)) {
        try {
          pathCounts.set(chatId, shareableMessageCount((await deps.chats.get(chatId)).messages))
        }
        catch (error) {
          if (!isNotFound(error))
            throw error
          pathCounts.set(chatId, null)
        }
      }
      return pathCounts.get(chatId) ?? null
    }

    const summaries: ShareSummary[] = []
    for (const row of rows) {
      const chat = await chatOf(row.chatId)
      if (chat === null)
        continue
      let outdated = chat.updatedAt > row.snapshotAt
      if (!outdated) {
        // A branch switch keeps `updated_at`: compare the length of the active path instead.
        const pathCount = await pathCountOf(row.chatId)
        if (pathCount === null)
          continue
        outdated = pathCount !== row.messageCount
      }
      summaries.push({
        id: row.id,
        chatId: row.chatId,
        chatTitle: chat.title,
        title: row.title,
        options: readOptions(row.options),
        path: sharePagePath(tokens().tokenOf(row.id)),
        messageCount: row.messageCount,
        snapshotAt: row.snapshotAt,
        outdated,
        expiresAt: row.expiresAt,
        expired: isExpired(row.expiresAt, time),
        createdAt: row.createdAt,
      })
    }
    return summaries
  }

  async function summaryRow(id: string): Promise<SummaryRow | null> {
    const [row] = await guardDb(() => db.select(SUMMARY_COLUMNS).from(chatShares).where(eq(chatShares.id, id)).limit(1))
    return row ?? null
  }

  async function summaryOf(id: string, known?: KnownPathCount): Promise<ShareSummary> {
    const row = await summaryRow(id)
    const [summary] = row === null ? [] : await summarize([row], known)
    if (summary === undefined)
      throw shareNotFoundError(id)
    return summary
  }

  async function insertShare(chatId: string, values: Omit<typeof chatShares.$inferInsert, 'id' | 'chatId'>): Promise<string> {
    // A random id collision is astronomically unlikely; a constraint error is far more likely a chat deleted meanwhile.
    for (let attempt = 0; ; attempt++) {
      const id = createShareId()
      try {
        await guardDb(() => db.insert(chatShares).values({ id, chatId, ...values }))
        return id
      }
      catch (error) {
        if (!isConstraintError(error))
          throw error
        if (await deps.chats.find(chatId) === null)
          throw chatNotFoundError(chatId)
        if (attempt >= 2)
          throw error
      }
    }
  }

  /**
   * The row of a live share: the token is well formed with a valid MAC, the row exists (not revoked), it has not expired
   * and its chat still exists. Every failure is the same `not_found` (counted as an invalid token by the routes).
   */
  async function liveRow<Row extends { chatId: string, expiresAt: number | null }>(
    token: string,
    read: (shareId: string) => Promise<Row | undefined>,
  ): Promise<Row> {
    const shareId = tokens().shareIdOf(token)
    if (shareId === null)
      throw shareUnavailableError('token')
    const row = await read(shareId)
    if (row === undefined || isExpired(row.expiresAt, now()))
      throw shareUnavailableError('token')
    if (await deps.chats.find(row.chatId) === null)
      throw shareUnavailableError('token')
    return row
  }

  return {
    list: async (query: SharesQuery) => {
      const rows = await guardDb(() => db
        .select(SUMMARY_COLUMNS)
        .from(chatShares)
        .where(query.chatId === undefined ? undefined : eq(chatShares.chatId, query.chatId))
        .orderBy(desc(chatShares.createdAt), desc(chatShares.id)))
      return summarize(rows)
    },

    create: async (input: ShareCreate) => {
      checkExpiry(input.expiresAt, now())
      const shareOptions = shareOptionsSchema.parse(input.options ?? {})
      // A cheap early refusal before the snapshot; the authoritative check runs under the lock.
      if (await sharesOfChat(input.chatId) >= LIMITS.sharesPerChatMax)
        throw tooManyShares()
      const taken = await takeSnapshot(input.chatId)
      const id = await exclusive(async () => {
        if (await sharesOfChat(input.chatId) >= LIMITS.sharesPerChatMax)
          throw tooManyShares()
        const createdAt = now()
        return insertShare(input.chatId, {
          title: input.title ?? null,
          options: shareOptions,
          ...taken,
          expiresAt: input.expiresAt ?? null,
          createdAt,
          updatedAt: createdAt,
        })
      })
      return summaryOf(id, { chatId: input.chatId, pathCount: taken.messageCount })
    },

    update: async (id: string, patch: ShareUpdate) => {
      const row = await summaryRow(id)
      if (row === null)
        throw shareNotFoundError(id)
      checkExpiry(patch.expiresAt, now())
      const changes: Partial<typeof chatShares.$inferInsert> = {}
      if (patch.title !== undefined)
        changes.title = patch.title
      if (patch.options !== undefined) {
        const merged: ShareOptions = readOptions(row.options)
        for (const key of ['reasoning', 'toolDetails', 'attachments'] as const) {
          const value = patch.options[key]
          if (typeof value === 'boolean')
            merged[key] = value
        }
        changes.options = merged
      }
      if (patch.expiresAt !== undefined)
        changes.expiresAt = patch.expiresAt
      const taken = patch.refresh === true ? await takeSnapshot(row.chatId) : null
      if (taken !== null)
        Object.assign(changes, taken)
      changes.updatedAt = now()
      const updated = await guardDb(() => db.update(chatShares).set(changes).where(eq(chatShares.id, id)).returning({ id: chatShares.id }))
      if (updated.length === 0)
        throw shareNotFoundError(id)
      return summaryOf(id, taken === null ? undefined : { chatId: row.chatId, pathCount: taken.messageCount })
    },

    remove: async (id: string) => {
      const deleted = await guardDb(() => db.delete(chatShares).where(eq(chatShares.id, id)).returning({ id: chatShares.id }))
      if (deleted.length === 0)
        throw shareNotFoundError(id)
    },

    view: async (token: string): Promise<ShareView> => {
      const row = await liveRow(token, async shareId => (await guardDb(() => db
        .select({
          chatId: chatShares.chatId,
          title: chatShares.title,
          options: chatShares.options,
          snapshot: chatShares.snapshot,
          fileIds: chatShares.fileIds,
          snapshotAt: chatShares.snapshotAt,
          expiresAt: chatShares.expiresAt,
        })
        .from(chatShares)
        .where(eq(chatShares.id, shareId))
        .limit(1)))[0])
      const shareOptions = readOptions(row.options)
      return {
        title: row.title ?? snapshotTitle(row.snapshot),
        messages: renderShareMessages(row.snapshot, {
          options: shareOptions,
          fileIdOf: url => deps.files.idFromUrl(url),
          fileIds: new Set(readFileIds(row.fileIds)),
          fileUrl: fileId => shareFileUrl(token, fileId),
        }),
        snapshotAt: row.snapshotAt,
        options: shareOptions,
      }
    },

    openFile: async (token: string, fileId: string): Promise<ShareFile> => {
      const row = await liveRow(token, async shareId => (await guardDb(() => db
        .select({ chatId: chatShares.chatId, options: chatShares.options, fileIds: chatShares.fileIds, expiresAt: chatShares.expiresAt })
        .from(chatShares)
        .where(eq(chatShares.id, shareId))
        .limit(1)))[0])
      if (!readOptions(row.options).attachments || !readFileIds(row.fileIds).includes(fileId))
        throw shareUnavailableError('file')
      try {
        return await deps.files.open(fileId)
      }
      catch (error) {
        if (isNotFound(error))
          throw shareUnavailableError('file')
        throw error
      }
    },
  }
}
