// Frozen interface of chat + message persistence (API.md 5.9, ARCHITECTURE.md 6.1 / 6.3, tables `chats`, `messages`,
// `usage`). Implementation: `createChatsService(deps)` in `services/chats/index.ts` (W1.5). Consumers: the chats
// routes (W1.5) and the chat pipeline (W2.1).
import type {
  ChatCreate,
  ChatDetail,
  ChatExportFormat,
  ChatSettings,
  ChatSummary,
  ChatUpdate,
  CursorPage,
  HarnessUIMessage,
  TitleSource,
} from '@harness-forge/shared'
import type { UsagePurpose } from '../../db/schema.ts'

/** A `chats` row as the pipeline sees it (`ChatSummary` without the live `running` flag, plus settings). */
export interface ChatRecord {
  id: string
  title: string | null
  titleSource: TitleSource | null
  modelRef: string | null
  settings: ChatSettings
  pinned: boolean
  archived: boolean
  pendingApproval: boolean
  createdAt: number
  updatedAt: number
}

/** Parsed query of `GET /chats`. `limit` defaults to 50, `archived` to false. */
export interface ChatListQuery {
  cursor?: string
  limit?: number
  q?: string
  archived?: boolean
}

/** Body of `GET /chats/:id/export` (sent as an attachment by the route). */
export interface ChatExportFile {
  /** `<title-slug>-<yyyy-mm-dd>.<md|json>`, sanitized. */
  filename: string
  /** `text/markdown; charset=utf-8` or `application/json; charset=utf-8`. */
  contentType: string
  body: string
}

/** Fields the chat pipeline sets on a chat (first request of a chat, every run). */
export interface ChatEnsureInput {
  modelRef?: string
  settings?: ChatSettings
}

/** Fields updated by `touch` (always sets `updated_at`). */
export interface ChatTouchInput {
  pendingApproval?: boolean
  modelRef?: string
  /** Merged into the stored settings. */
  settings?: ChatSettings
  /** Default `Date.now()`. */
  at?: number
}

/** One `usage` row (one model call). */
export interface UsageInput {
  chatId: string | null
  messageId: string | null
  purpose: UsagePurpose
  providerId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** null when the price is unknown. */
  costUsd: number | null
  /** Default `Date.now()`. */
  createdAt?: number
}

/** Message operations; available on the service and, bound to one transaction, inside `transaction()`. */
export interface ChatMessageStore {
  /** Every message of a chat ordered by `seq` (empty for an unknown chat). */
  readonly listMessages: (chatId: string) => Promise<HarnessUIMessage[]>
  /** One message of a chat, or null. */
  readonly getMessage: (chatId: string, messageId: string) => Promise<HarnessUIMessage | null>
  /**
   * Idempotent insert-or-replace by message id: a new id is appended (next `seq`), an existing one keeps its `seq`
   * (approval continuations, re-persisting a run). Updates `search_text` from the text parts. The chat must exist.
   */
  readonly upsertMessage: (chatId: string, message: HarnessUIMessage) => Promise<void>
  /**
   * Deletes `fromMessageId` and every later message, then appends `messages` in order: edit =
   * `[editedUserMessage]`, regenerate = `[]`. Returns the number of deleted messages; `not_found` when the id is not
   * in the chat.
   */
  readonly replaceFrom: (chatId: string, fromMessageId: string, messages: readonly HarnessUIMessage[]) => Promise<number>
}

/**
 * Chats, messages and usage rows. Events: `create`, `ensure` (when it creates), `update`, `touch` and `setTitle` emit
 * `chat.created` / `chat.updated` with the new `ChatSummary`; `remove` emits `chat.deleted`. Message operations emit
 * nothing (the pipeline calls `touch` when a run ends). `ChatSummary.running` comes from `deps.runs.isActive(id)`.
 */
export interface ChatsService extends ChatMessageStore {
  // ----- HTTP API (chats.ts, W1.5)

  /** Order `updatedAt` desc, `id` desc; opaque base64url cursor (invalid -> `validation_error`); `snippet` with `q`. */
  readonly list: (query: ChatListQuery) => Promise<CursorPage<ChatSummary>>
  /** Summary + settings + messages (ordered by `seq`) + usage totals; `not_found`. */
  readonly get: (id: string) => Promise<ChatDetail>
  /** Empty chat or import (`messages` deep-validated, ids fixed, pending approvals denied); `conflict` (`exists`). */
  readonly create: (input: ChatCreate) => Promise<ChatDetail>
  /** Rename (`titleSource: 'user'`), pin, archive, model, settings merge (`null` removes a key); `not_found`. */
  readonly update: (id: string, patch: ChatUpdate) => Promise<ChatSummary>
  /** Deletes the chat and its messages (usage rows keep `chat_id = NULL`); `not_found`. The route stops a run first. */
  readonly remove: (id: string) => Promise<void>
  /** Markdown or JSON export (API.md 5.9); `not_found`. */
  readonly export: (id: string, format: ChatExportFormat) => Promise<ChatExportFile>

  // ----- chat pipeline (W2.1)

  /** The chat row, or null. */
  readonly find: (id: string) => Promise<ChatRecord | null>
  /** The current `ChatSummary` (events, stream metadata); `not_found`. */
  readonly summary: (id: string) => Promise<ChatSummary>
  /** Creates the chat when missing (client uuidv7 validated) and applies `init`; emits `chat.created` on creation. */
  readonly ensure: (id: string, init?: ChatEnsureInput) => Promise<{ chat: ChatRecord, created: boolean }>
  /** Sets `updated_at` (and the given fields); emits `chat.updated`. */
  readonly touch: (id: string, input?: ChatTouchInput) => Promise<ChatSummary>
  /** Sets an automatic title; never overwrites a user title (returns null then); emits `chat.updated`. */
  readonly setTitle: (id: string, title: string, source: Exclude<TitleSource, 'user'>) => Promise<ChatSummary | null>
  /** Appends a usage row (kept when the chat is deleted). */
  readonly addUsage: (input: UsageInput) => Promise<void>
  /**
   * Runs `fn` in one write transaction (history operations of a request are atomic). Inside `fn` use only `store`
   * (the in-memory test database has a single connection).
   */
  readonly transaction: <T>(fn: (store: ChatMessageStore) => Promise<T>) => Promise<T>
}
