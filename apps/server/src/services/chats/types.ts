// Frozen interface of chat + message persistence (API.md 5.9, ARCHITECTURE.md 6.1 / 6.3 / 6.8 / 6.9, tables `chats`,
// `messages`, `usage`). Implementation: `createChatsService(deps)` in `services/chats/index.ts` (W1.5). Consumers: the
// chats routes (W1.5) and the chat pipeline (W2.1); in Phase 5 the data service (W5.3) and the share service (W5.4).
//
// Phase 5 additions: the message tree (ADR-023: `listPath`, `appendMessage`, `setActiveLeaf`, `switchBranch`, the
// parent of `upsertMessage`, `ChatRecord.activeLeafId`) and the bulk data members (ADR-024: `allIds`, `importChat`,
// `removeAll`), all implemented by W5.1. `createFakeChatsService` (`testing/fake-chats.ts`) implements them on the test
// database for the tests of other services.
//
// Phase 6 additions (ADR-030, implemented by W6.6): remembered versions (`messages.selected_child_id`, written with the
// active leaf and read by `switchBranch` / `deleteMessage`), `deleteMessage` (deleting a version), totals that include
// image usage, and the active leaf in every `chat.updated` event (`ChatUpdatedData`).
import type {
  ChatCreate,
  ChatDetail,
  ChatExportAny,
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
  /** The last message of the active path waits for a tool approval. */
  pendingApproval: boolean
  /**
   * The last message of the active path (ADR-023, `chats.active_leaf_id`); null for an empty chat. Moved only by the
   * pipeline's commit and persist transactions (`setActiveLeaf`), by `switchBranch` and by `deleteMessage` (Phase 6).
   */
  activeLeafId: string | null
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

/** Input of `importChat`: one chat of a data import (ADR-024), from a backup entry or a single chat JSON upload. */
export interface ChatImportInput {
  /**
   * A parsed chat JSON export (`chatExportAnySchema`): version 1 (a linear chat) or version 2 (every message version in
   * `seq` order, `parentIds` aligned with `messages`, `activeLeafId`). The data import has already rewritten the
   * `/api/files/<id>` URLs of its file parts to the stored file ids.
   */
  exported: ChatExportAny
  /**
   * `keep`: store the chat under `exported.chat.id` (`conflict`, `reason: 'exists'`, when that id is used) and keep
   * every message id that is valid and unused (other ids are replaced; `parentIds` and `activeLeafId` follow).
   * `new`: a new chat id and a new id for every message (the data import's `copy` policy).
   */
  id: 'keep' | 'new'
  /**
   * true: the title (with its `titleSource`), `pinned`, `archived`, `createdAt` and `updatedAt` of the export are
   * restored. false: only the conversation is imported (untitled, not pinned, not archived, created now).
   */
  restore: boolean
}

/** Result of `importChat`. */
export interface ChatImportResult {
  /** The stored chat id: `exported.chat.id` for `id: 'keep'`, a new uuidv7 for `id: 'new'`. */
  id: string
  /** Messages stored (every version). */
  messages: number
}

/** Options of `removeAll`. */
export interface ChatRemoveAllOptions {
  /**
   * true: also delete every usage row (rows already detached from a deleted chat included). false: the usage rows are
   * kept with `chat_id = NULL`, as after `DELETE /chats/:id`.
   */
  usage: boolean
}

/** Result of `removeAll`: what was deleted. */
export interface ChatRemoveAllResult {
  /** Ids of the deleted chats (`chat.deleted` was emitted for each). */
  chatIds: string[]
  /** Deleted messages (every version). */
  messages: number
  /** Deleted usage rows (0 unless `usage: true`). */
  usageRows: number
}

/**
 * Message operations; available on the service and, bound to one transaction, inside `transaction()`.
 *
 * The messages of a chat form a tree (ADR-023, ARCHITECTURE.md 6.8): `parent_id` is the previous message of a path
 * (`null` for a first message), siblings (same parent; the first messages are siblings of each other) are the versions
 * of a message, `seq` is unique per chat and the creation order (a parent's `seq` is lower than its children's), and
 * `chats.active_leaf_id` is the last message of the path the user sees (the active path).
 */
export interface ChatMessageStore {
  /** Every message of a chat, every version, ordered by `seq` (empty for an unknown chat). */
  readonly listMessages: (chatId: string) => Promise<HarnessUIMessage[]>
  /**
   * The path that ends at `leafId`: the leaf and its ancestors through `parent_id`, first message first. A recursive
   * query up `parent_id` guarded by `parent.seq < child.seq` (and the chat), so bad data (a cycle, a parent in another
   * chat) ends the walk instead of looping. `leafId === null` -> `[]` (an empty chat). `not_found` when `leafId` is not
   * a message of the chat.
   */
  readonly listPath: (chatId: string, leafId: string | null) => Promise<HarnessUIMessage[]>
  /** One message of a chat, or null. */
  readonly getMessage: (chatId: string, messageId: string) => Promise<HarnessUIMessage | null>
  /**
   * Inserts a new message, never replaces one: next `seq`, `parent_id = parentId` (`null` = a first message). Updates
   * `search_text` from the text parts. Does not move the active leaf (`setActiveLeaf` does). `not_found` when the chat
   * does not exist or `parentId` is not a message of the chat; `conflict` (`reason: 'exists'`) when the id is already
   * used (in any chat); `validation_error` for a malformed message.
   */
  readonly appendMessage: (chatId: string, message: HarnessUIMessage, parentId: string | null) => Promise<void>
  /**
   * Idempotent insert-or-replace by message id: a new id is appended (next `seq`, `parent_id = parentId`, `null` = a
   * first message), an existing one keeps its `seq` and its parent (`parentId` is ignored) and gets the new role, parts
   * and metadata (approval continuations, re-persisting a run). Updates `search_text` from the text parts. Does not
   * move the active leaf. `not_found` when the chat does not exist (on insert also when `parentId` is not a message of
   * the chat); `conflict` (`reason: 'exists'`) when the id belongs to another chat.
   */
  readonly upsertMessage: (chatId: string, message: HarnessUIMessage, parentId: string | null) => Promise<void>
  /**
   * Compare-and-set of `chats.active_leaf_id`: writes `leafId` when the chat exists, `leafId` is one of its messages
   * and, with `onlyFrom`, the current active leaf is one of `onlyFrom` (`null` matches a chat without one). Returns
   * whether it was written (a lost race or a missing chat / message answers false, nothing throws). Changes nothing else:
   * `updated_at` and `pending_approval` stay, no event. Only the pipeline's commit and persist transactions and
   * `switchBranch` call it.
   *
   * Phase 6 (ADR-030, W6.6): after a successful compare-and-set it also records the path of `leafId` as the remembered
   * versions (every parent on the path gets `selected_child_id` = its child on the path; unchanged rows are not
   * written), atomically inside `transaction()`. A failed compare-and-set writes nothing.
   */
  readonly setActiveLeaf: (chatId: string, leafId: string, onlyFrom?: readonly (string | null)[]) => Promise<boolean>
}

/**
 * Chats, messages and usage rows. Events: `create`, `ensure` (when it creates) and `importChat` emit `chat.created`;
 * `update`, `touch`, `setTitle`, `switchBranch` and `deleteMessage` emit `chat.updated` with `ChatUpdatedData` (the new
 * `ChatSummary` plus the row's `activeLeafId`, ADR-030, so another tab follows a version switch; members that return a
 * summary return it without `activeLeafId`); `remove` and `removeAll` emit `chat.deleted` (one per chat). Message
 * operations emit nothing (the pipeline calls `touch` when a run ends). `ChatSummary.running` comes from
 * `deps.runs.isActive(id)`.
 */
export interface ChatsService extends ChatMessageStore {
  // ----- HTTP API (chats.ts, W1.5; Phase 5 semantics by W5.1)

  /**
   * Order `updatedAt` desc, `id` desc; opaque base64url cursor (invalid -> `validation_error`); `snippet` with `q`. The
   * search covers every message version, so a snippet may come from a version that is not on the active path.
   */
  readonly list: (query: ChatListQuery) => Promise<CursorPage<ChatSummary>>
  /**
   * Summary + settings + `messages` = the active path (first message -> active leaf, `seq` order; during a run it ends
   * at the message committed when the run started) + `branches` (every path message with at least two versions: its
   * siblings in `seq` order and its index among them) + usage totals (every usage row of purpose `chat`, every version
   * included; since Phase 6 also the rows of purpose `image`, W6.6); `not_found`.
   */
  readonly get: (id: string) => Promise<ChatDetail>
  /**
   * Empty chat or import: `messages` deep-validated, ids fixed (invalid or already used ids replaced; `parentIds` and
   * `activeLeafId` follow), pending approvals denied. Without `parentIds` a linear chain; with `parentIds` each parent
   * must be an earlier message and the ids unique (else `validation_error` with the field path). The active leaf is the
   * most recent leaf under `activeLeafId` (default: the last message). `conflict` (`exists`).
   */
  readonly create: (input: ChatCreate) => Promise<ChatDetail>
  /** Rename (`titleSource: 'user'`), pin, archive, model, settings merge (`null` removes a key); `not_found`. */
  readonly update: (id: string, patch: ChatUpdate) => Promise<ChatSummary>
  /**
   * Deletes the chat, its messages (every version) and its share links (cascade); usage rows keep `chat_id = NULL`;
   * `not_found`. The route stops a run first.
   */
  readonly remove: (id: string) => Promise<void>
  /**
   * Markdown (the active path) or JSON (`ChatExport` version 2: every version in `seq` order, `parentIds`,
   * `activeLeafId`), API.md 5.9; `not_found`. The data export writes the JSON body as `chats/<id>.json`.
   */
  readonly export: (id: string, format: ChatExportFormat) => Promise<ChatExportFile>

  // ----- Phase 5: message tree (ADR-023) and bulk data (ADR-024), W5.1

  /**
   * `POST /chats/:id/branch`: the active leaf becomes the most recent leaf under `messageId` (the highest `seq` in its
   * subtree; `messageId` may be any message of the chat), `pending_approval` is recomputed from the new path,
   * `updated_at` is kept (a switch is not activity) and `chat.updated` is emitted. Returns the new detail (as `get`).
   * `not_found` for an unknown chat or a `messageId` outside it. Refused with `conflict` (`reason: 'run-active'`,
   * `chatId`) while a run holds the chat in any phase (`deps.runs.hasRun(id)`; checked here or by the route).
   *
   * Phase 6 (ADR-030, W6.6): the leaf is the remembered leaf under `messageId` (`rememberedLeafUnder`: walking down,
   * the remembered child when it is still a child of the node, else the only child, else the most recent leaf), so
   * switching away and back restores the path last shown; the new path is recorded as remembered.
   */
  readonly switchBranch: (id: string, messageId: string) => Promise<ChatDetail>
  /**
   * `DELETE /chats/:id/messages/:messageId` (Phase 6, ADR-030, stabilization S7; W6.6): deletes one version and every
   * message after it (its subtree). Returns the new detail (as `get`).
   * - `not_found` for an unknown chat or a `messageId` outside it;
   * - `conflict` (`reason: 'only-version'`) when the message has no sibling (the last version of a message is never
   *   deleted; delete the chat instead);
   * - `conflict` (`reason: 'run-active'`, `chatId`) while a run holds the chat (`deps.runs.hasRun(id)`, checked by the
   *   route) and when the compare-and-set of the active leaf misses (nothing is deleted then).
   * When the active path goes through the message, the path moves to its previous sibling by `seq` (else the next one):
   * the new leaf is `rememberedLeafUnder(that sibling)` and `pending_approval` is recomputed like `switchBranch`. A
   * version off the active path is deleted without moving the leaf. One `db.batch` holds the compare-and-set
   * `UPDATE chats … WHERE active_leaf_id IS <old leaf>` and a recursive-CTE `DELETE` of the subtree guarded by `EXISTS`
   * (the new leaf and another sibling still exist); then the new path is recorded as remembered and `chat.updated` is
   * emitted. `updated_at`, usage rows (totals keep counting deleted versions), share snapshots and files stay; the
   * deleted rows take their `search_text` with them.
   */
  readonly deleteMessage: (id: string, messageId: string) => Promise<ChatDetail>
  /** Every chat id, archived chats included, in `id` order (uuidv7: creation order). */
  readonly allIds: () => Promise<string[]>
  /**
   * Imports one chat JSON export atomically (the chat and all its messages, or nothing). Version 1 becomes a linear
   * chain; version 2 restores the tree: `parentIds` (each parent an earlier message) and the active leaf (the most
   * recent leaf under `activeLeafId`, default the last message). Messages are deep-validated and finalized like the
   * `POST /chats` import (pending approvals denied, so `pendingApproval` is false); ids follow `input.id`. Settings and
   * `modelRef` are imported, usage rows are not (totals restart at 0; each message keeps its `metadata.usage`); see
   * `ChatImportInput.restore` for title, flags and dates (the data import appends " (imported)" to a copy's title
   * itself). Emits `chat.created`. `conflict` (`reason: 'exists'`) for `id: 'keep'` when the chat id is used;
   * `validation_error` (issue paths under `chat`, e.g. `chat.parentIds.3`) for an invalid tree, an unknown
   * `activeLeafId` or invalid messages.
   */
  readonly importChat: (input: ChatImportInput) => Promise<ChatImportResult>
  /**
   * Delete-all: deletes every chat with its messages (every version) and share links (cascade) in one batch;
   * `usage: true` also deletes every usage row. Emits `chat.deleted` for every deleted chat. The caller stops the runs
   * first (`ChatRunner.stop` for every id of `allIds()`); uploaded files are not touched (`FilesService.purge`).
   */
  readonly removeAll: (options: ChatRemoveAllOptions) => Promise<ChatRemoveAllResult>

  // ----- chat pipeline (W2.1)

  /** The chat row (with `activeLeafId`), or null. */
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
