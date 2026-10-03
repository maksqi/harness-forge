// Frozen interface of checkpoints, rewind and the changes panel data (Phase 8, ADR-036 / ADR-037, API.md 4.23 / 5.24,
// ARCHITECTURE.md 6.13 "Run scope and journaled writes", 6.16, 6.17). Implementation: `createCheckpointService(deps)` in
// `services/checkpoints/index.ts` (C19 stub; W8.1 composes it from the modules below). Consumers: the changes routes
// (`http/routes/changes.ts`, W8.2), the chat pipeline (`journal(scope)` per run, W8.5), the write tools through
// `journaledWrite` (`workspace/journal.ts`, W8.1), the data service (`purge` in delete-all, `summary`, W8.7) and
// `startDeps` / `stopDeps` (`start`, `stop`). Test doubles: `testing/fake-checkpoints.ts` (a fake service, a fake blob
// store, a row writer and a row-insert helper over the test database).
//
// Modules (owners in P8-A): `store.ts` (the blob store), `journal-service.ts` (journals, the row writer, the coalesced
// `workspace.changed` events of tool edits), `prune.ts` (age / budget eviction, orphan blobs, the 6-hour timer),
// `index.ts` (the composition) -> W8.1; `plan.ts` (pure planner), `restore.ts` (the restore primitive), `rewind.ts`,
// `revert.ts`, `undo.ts` -> W8.2; `changes.ts` (`ChatChanges`, the diff of one file), `git-changes.ts` (`GitStatus`, the
// HEAD diff over `workspace/git.ts`) -> W8.3; `disk.ts` (complete since P8-0b: the before-state and disk sha readers
// every module shares).
//
// Storage: journal rows in `workspace_changes` (one per change, global order by `id`; `message_seq` = the chat's
// `coalesce(max(seq), 0)` at insert time is the rewind watermark) and the raw before-bytes in the content-addressed tree
// `<dataDir>/checkpoints/<aa>/<sha256>` (`DataPaths.checkpoints`; folders 0700, files 0600), never in `files/`, never
// served, never in a backup, export or import. Every path is project-relative POSIX; every disk access goes through the
// frozen path guard (`workspace/paths.ts`) under the per-file lock (`workspace/file-lock.ts`).
import type {
  ChangeDiffQuery,
  ChangeRevertBody,
  ChangeUndoBody,
  ChatChanges,
  FileDiff,
  GitStatus,
  RestoreResult,
  RewindBody,
  RewindPreview,
  WorkspaceChangeKind,
} from '@harness-forge/shared'
import type { Buffer } from 'node:buffer'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { AppDeps } from '../../types.ts'
import type { ResolvedWorkspacePath, WorkspaceWriteResult } from '../../workspace/paths.ts'

// ---------- journal (agent writes) ----------

/** Whose changes a journal records: one chat run in one project. */
export interface CheckpointScope {
  readonly chatId: string
  /**
   * The assistant message of the run (`session.assistantId`; a continuation after an approval keeps the id); null for
   * a journal outside a run.
   */
  readonly messageId: string | null
  /** The chat's current project (its folder is the run's workspace). */
  readonly projectId: string
}

/** `workspace_changes.before_state`: how the state before a change is kept. */
export type CheckpointBeforeState = 'missing' | 'stored' | 'too-large' | 'evicted'

/**
 * The state of a file right before a change, read under its lock (`readCheckpointBefore` of ./disk.ts): `missing`
 * (no file: the change creates it), `present` (a regular file of at most `LIMITS.checkpointFileMaxBytes`, with its
 * bytes: journaled as `stored` once the blob is saved) or `too-large` (bigger: journaled as `too-large`, the change
 * still runs, the file just cannot be restored). `mode` is the permission bits (`fstat`, `& 0o7777`).
 */
export type CheckpointBefore
  = | { readonly state: 'missing' }
    | { readonly state: 'present', readonly bytes: Buffer, readonly sha: string, readonly size: number, readonly mode: number }
    | { readonly state: 'too-large', readonly size: number, readonly mode: number }

/** Input of `CheckpointJournal.write`: the core of `journaledWrite(c, root, input, produce)` (`workspace/journal.ts`). */
export interface CheckpointWriteInput {
  /** The tool call (`ToolCallContext.toolCallId`); the row's `tool_call_id`. */
  readonly toolCallId: string
  /** The tool name for the row (`write_file`, `edit_file`). */
  readonly tool: string
  /** The project folder (`ToolWorkspace.root`, a canonical realpath). */
  readonly root: string
  /**
   * The target, resolved by the caller with `resolveWorkspacePath(root, path, { allowMissing: true })` and a `.git`
   * segment already refused (`hasGitSegment`). The lock is taken on `resolved.absolute`; the row's `path` is
   * `resolved.rel`.
   */
  readonly resolved: ResolvedWorkspacePath
  /**
   * Builds the new content from the before-state, under the lock (`edit_file` applies its replacement here, so two
   * parallel edits of one file serialize and the second sees the first's result). A throw (or rejection) ends the write:
   * nothing is stored, written or journaled, and the error reaches the caller. A string is written as UTF-8.
   */
  readonly produce: (before: CheckpointBefore) => string | Uint8Array | Promise<string | Uint8Array>
  /** The call's signal: `signal.throwIfAborted()` runs after `produce` and before anything is stored or written. */
  readonly signal: AbortSignal
}

/** Result of `CheckpointJournal.write`. */
export interface CheckpointWriteResult {
  /** The frozen `writeWorkspaceFile` result. */
  readonly written: WorkspaceWriteResult
  /** The before-state `produce` saw (`present` carries the bytes the tool diffs against; `missing` = created). */
  readonly before: CheckpointBefore
  /**
   * The change is journaled (a row and, for `present`, its blob). False when the journal records nothing (the P8-0b
   * skeleton, a fake) or when recording failed: the failure is logged (`checkpoint not recorded`, warn, no path at
   * `info`) and the write and its result stand.
   */
  readonly recorded: boolean
}

/** Input of `CheckpointJournal.recordShell`: a settled call of the core `shell` tool (success or failure). */
export interface CheckpointShellInput {
  readonly toolCallId: string
  /** The command as run; the row keeps at most `LIMITS.journalCommandMaxChars` characters. */
  readonly command: string
}

/**
 * Input of `CheckpointJournal.recordUntracked`: a settled call of another tool with workspace access `write` or
 * `execute` (a third-party tool; never `write_file` / `edit_file`, which journal themselves, and never MCP tools, which
 * declare no access).
 */
export interface CheckpointUntrackedInput {
  readonly toolCallId: string
  /** The tool name (the row's `tool`; no path). */
  readonly tool: string
}

/**
 * The journal of one run (`CheckpointService.journal(scope)`), carried by the run scope (`workspace/run-scope.ts`).
 * `recordShell` / `recordUntracked` never reject: a failure is logged as a warning and dropped.
 */
export interface CheckpointJournal {
  readonly scope: CheckpointScope
  /**
   * One journaled write, under the per-file lock of `input.resolved.absolute` (`withFileLock`): read the before-state
   * (`readCheckpointBefore`) -> `data = await produce(before)` -> `signal.throwIfAborted()` -> store the before blob
   * (the store gate held shared from the blob write to the row insert) -> the frozen `writeWorkspaceFile(root,
   * resolved.rel, data)` -> insert the `edit` row (`message_seq` watermark, the scope's message id, `tool_call_id`, the
   * before-state and the after sha / size) -> release the lock. Emits the coalesced `workspace.changed` (`source:
   * 'tool'`). Rejects with the errors of the path guard, `produce`, the abort and the write; never because recording
   * failed (`recorded: false`).
   */
  readonly write: (input: CheckpointWriteInput) => Promise<CheckpointWriteResult>
  /** Inserts a `shell` row (tool `shell`, the command cut at 1,000 characters, no path). */
  readonly recordShell: (input: CheckpointShellInput) => Promise<void>
  /** Inserts an `untracked` row (the tool name, no path). */
  readonly recordUntracked: (input: CheckpointUntrackedInput) => Promise<void>
}

// ---------- primitives shared by the modules ----------

/**
 * The content-addressed blob store `<dataDir>/checkpoints/<aa>/<sha256>` (`store.ts`, W8.1): the injected store of the
 * restore and listing modules (tests: `createFakeCheckpointBlobStore()`). Blob names are 64 lowercase hex characters
 * (the sha256 of the content); any other name is refused with `validation_error` and never becomes a path.
 */
export interface CheckpointBlobStore {
  /**
   * Stores raw bytes and resolves to their sha256 (lowercase hex). Deduplicated: an existing blob is kept (its mtime
   * refreshed, so prune's 1-hour orphan grace covers the time until its row is inserted). Folders 0700, files 0600;
   * written to a temp file, fsynced, then renamed.
   */
  readonly put: (bytes: Uint8Array) => Promise<string>
  /** The bytes of a blob; null when it does not exist (never stored, evicted or pruned). */
  readonly read: (sha: string) => Promise<Buffer | null>
  /** True when the blob exists. */
  readonly has: (sha: string) => Promise<boolean>
  /** Unlinks a blob; true when it existed. */
  readonly remove: (sha: string) => Promise<boolean>
  /**
   * Runs `operation` holding the store gate shared (`createStoreGate()`): writers hold it from the blob write until
   * their row is inserted; prune and purge hold it exclusively. Not re-entrant.
   */
  readonly withSharedGate: <T>(operation: () => Promise<T>) => Promise<T>
}

/**
 * One new `workspace_changes` row. `message_seq` (the chat's `coalesce(max(messages.seq), 0)` at insert time) and
 * `created_at` are set by the writer. Omitted optional fields are null.
 */
export interface ChangeRowInput {
  readonly chatId: string
  /** The chat's current project when the change happened. */
  readonly projectId: string
  readonly kind: WorkspaceChangeKind
  /** The assistant message of the run (`edit`, `shell`, `untracked` rows); null for `revert` / `rewind` / `undo`. */
  readonly messageId?: string | null
  readonly toolCallId?: string | null
  /** `wcb_` id of one revert, rewind or undo (every row of the batch); null for agent rows. */
  readonly batchId?: string | null
  /** `write_file`, `edit_file`, `shell` or a plugin tool; null for user operations. */
  readonly tool?: string | null
  /** Project-relative POSIX path of a file row; null for `shell` / `untracked` rows. */
  readonly path?: string | null
  /** The command of a `shell` row (the writer cuts it to `LIMITS.journalCommandMaxChars`). */
  readonly command?: string | null
  /** File rows: how the before-state is kept, and its sha / size / mode (null when `missing`). */
  readonly beforeState?: CheckpointBeforeState | null
  readonly beforeSha?: string | null
  readonly beforeSize?: number | null
  readonly beforeMode?: number | null
  /** File rows: the sha / size of the content the change left; `afterSha: null` = the change removed the file. */
  readonly afterSha?: string | null
  readonly afterSize?: number | null
}

/**
 * Inserts journal rows (`journal-service.ts`, W8.1): the journal, and the restore primitive for its `revert` /
 * `rewind` / `undo` rows with their batch id (tests: `createTestChangeRowWriter(db)`).
 */
export interface CheckpointRowWriter {
  /** Inserts one row and returns it as stored. */
  readonly insert: (row: ChangeRowInput) => Promise<WorkspaceChangeRow>
}

/**
 * What the checkpoint modules share, built once by `createCheckpointService` (tests build it from a test app's deps,
 * a fake blob store and the test row writer). The modules reach chats, projects (`openWorkspace`), runs (the
 * `run-active` check), events (`workspace.changed`) and the logger through `deps`.
 */
export interface CheckpointContext {
  readonly deps: AppDeps
  readonly blobs: CheckpointBlobStore
  readonly rows: CheckpointRowWriter
  /** Clock of rows, batches and prune (ms). */
  readonly now: () => number
}

// ---------- service ----------

/** Options of the read members: the request's signal (a client that went away stops git and disk reads). */
export interface CheckpointReadOptions {
  readonly signal?: AbortSignal
}

/** Options of `prune`. */
export interface CheckpointPruneOptions {
  /** The clock of the age limit and the orphan grace (ms; default `Date.now()`). */
  readonly now?: number
}

/** What one prune did (ARCHITECTURE.md 6.16 "Prune"), in counts and bytes. */
export interface PruneResult {
  /** Blobs older than `LIMITS.checkpointMaxAgeMs` evicted. */
  readonly evictedByAge: number
  /** Blobs evicted because their project was over `LIMITS.checkpointProjectMaxBytes` (oldest first). */
  readonly evictedByBudget: number
  /** Rows changed from `stored` to `evicted`. */
  readonly rowsEvicted: number
  /** Blobs unlinked that no `stored` row referenced (older than 1 hour). */
  readonly orphanBlobs: number
  /** Stale temp files removed. */
  readonly tempFiles: number
  /** Bytes freed on disk. */
  readonly bytesFreed: number
}

/** The blob store on disk: `DataSummary.checkpoints`. */
export interface CheckpointSummary {
  /** Bytes of every blob. */
  readonly bytes: number
  /** Number of blobs. */
  readonly blobs: number
}

/**
 * Checkpoints, rewind, revert, undo and the changes panel data. The chat-scoped members take the chat id of the route
 * (`404 not_found` for an unknown chat) and work on the chat's **current** project (rows recorded in an earlier
 * project are ignored). Read members answer `available: false` with a reason for a chat without a project or with a
 * folder that cannot be opened; the other members answer `400 validation_error` with the `openWorkspace` message
 * there. Writes (`revert`, `undo`, `rewind`) are `409 conflict` (`reason: 'run-active'`, `details.chatId`) while any
 * chat of the project runs, run under the per-file locks, journal every file of the batch (one `wcb_` id) and emit
 * `workspace.changed` once per batch that wrote something.
 */
export interface CheckpointService {
  /**
   * The journal of one run (`chat/pipeline.ts` builds the run scope with it); synchronous, nothing is read or written
   * until a member is called.
   */
  readonly journal: (scope: CheckpointScope) => CheckpointJournal
  /**
   * `GET /chats/:id/changes`: one entry per path (at most `LIMITS.changesFilesMax`, most recently changed first) from
   * base (the earliest before-state), expected (the latest after-state) and current (the disk); `changedOutside` =
   * current != expected; `revertible` = the base is `stored`, or `missing` (a created file is reverted by deleting it);
   * line counts for the first `LIMITS.changesLineCountFiles` text files of at most `LIMITS.changesLineCountMaxBytes`;
   * `untracked` counts the `shell` and `untracked` rows.
   */
  readonly listChanges: (chatId: string, options?: CheckpointReadOptions) => Promise<ChatChanges>
  /**
   * `GET /chats/:id/changes/diff`: one file, `chat` (its base against the disk) or `git` (HEAD against the disk); sides
   * of at most `LIMITS.changeDiffSideMaxBytes`; `404 not_found` for a path the source does not list.
   */
  readonly fileDiff: (chatId: string, query: ChangeDiffQuery, options?: CheckpointReadOptions) => Promise<FileDiff>
  /** `GET /chats/:id/git`: `git status` of the project folder through the hardened runner (`workspace/git.ts`). */
  readonly gitStatus: (chatId: string, options?: CheckpointReadOptions) => Promise<GitStatus>
  /**
   * `POST /chats/:id/changes/revert`: one file back to its base (`chat`) or to HEAD (`git`), as one `revert` batch;
   * `409 conflict` (`reason: 'stale'`) when the disk is not `expectedSha` (when given).
   */
  readonly revert: (chatId: string, body: ChangeRevertBody) => Promise<RestoreResult>
  /**
   * `POST /chats/:id/changes/undo`: the before-states of one batch's rows (expected = their after-states) as an `undo`
   * batch; `404 not_found` for an unknown batch or one of another chat.
   */
  readonly undo: (chatId: string, body: ChangeUndoBody) => Promise<RestoreResult>
  /**
   * `GET /chats/:id/rewind?messageId=`: what a rewind to the user message would do (writes nothing); `400
   * validation_error` on `['messageId']` for a message that is not a user message of the chat, `404` when unknown.
   */
  readonly rewindPreview: (chatId: string, messageId: string, options?: CheckpointReadOptions) => Promise<RewindPreview>
  /** `POST /chats/:id/rewind`: every file the chat changed since the user message was sent, as one `rewind` batch. */
  readonly rewind: (chatId: string, body: RewindBody) => Promise<RestoreResult>
  /**
   * `startDeps` (after `projects.start()`): creates `DataPaths.checkpoints` (0700), runs one prune, then schedules it
   * every 6 hours (a chained `setTimeout(...).unref()`) and 60 s after a `chat.deleted` (debounced). Never rejects
   * because of a failed prune (logged).
   */
  readonly start: () => Promise<void>
  /** `stopDeps` (after the runs stopped): clears the timers and waits for a running prune; pending tool events dropped. */
  readonly stop: () => Promise<void>
  /** One prune now (the store gate held exclusively). */
  readonly prune: (options?: CheckpointPruneOptions) => Promise<PruneResult>
  /**
   * Delete-all (`services/data`, inside its maintenance operation): removes every blob and temp file of the store
   * (the rows go with their chats); resolves to what was removed.
   */
  readonly purge: () => Promise<CheckpointSummary>
  /** The store on disk (`DataSummary.checkpoints`). */
  readonly summary: () => Promise<CheckpointSummary>
}
