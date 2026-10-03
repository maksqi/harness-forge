// Journals of chat runs and the journal row writer (Phase 8, ADR-036, ARCHITECTURE.md 6.13 "Run scope and journaled
// writes", 6.16 "Journal"). Owner: W8.1.
//
// - `createCheckpointJournal(ctx, scope, { toolEvents })`: the journal of one run (`CheckpointService.journal`). `write`
//   is the core of `journaledWrite` (`workspace/journal.ts`): under the file lock, the before-state
//   (`readCheckpointBefore`), `produce`, the abort check, then, holding the store gate shared, the before blob, the
//   frozen `writeWorkspaceFile` and the `edit` row; then the coalesced `workspace.changed` (`source: 'tool'`).
//   `recordShell` / `recordUntracked` insert the `shell` / `untracked` rows of the chat pipeline's wrapper (W8.5).
//   A recording failure never fails the tool: it is logged (`checkpoint not recorded`, warn, no path or content) and the
//   write and its result stand (`recorded: false`). A before blob whose put failed is journaled as `evicted` (the edit is
//   listed, its base cannot be restored); a blob left behind by a failed write or insert is removed by prune.
// - `createChangeRowWriter(deps, now)`: inserts rows (`message_seq` = the chat's `coalesce(max(seq), 0)` at insert
//   time, `created_at` = now, a shell command cut at `LIMITS.journalCommandMaxChars`); the restore primitive (W8.2)
//   writes its `revert` / `rewind` / `undo` rows through it (`ctx.rows`), with `beforeRowFields` for the snapshot.
// - `createToolEventCoalescer(emit)`: the live `workspace.changed` of agent edits, at most one event per second per
//   chat (the paths of every edit in that second, deduplicated, at most `LIMITS.workspaceEventPathsMax`); `stop()`
//   drops what is pending (the service stops after the runs, so nothing is lost but a refresh hint).
import type { WorkspaceChangedData } from '@harness-forge/shared'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type {
  ChangeRowInput,
  CheckpointBefore,
  CheckpointContext,
  CheckpointJournal,
  CheckpointRowWriter,
  CheckpointScope,
  CheckpointWriteInput,
  CheckpointWriteResult,
} from './types.ts'
import { Buffer } from 'node:buffer'
import { isHarnessError, LIMITS } from '@harness-forge/shared'
import { sql } from 'drizzle-orm'
import { workspaceChanges } from '../../db/schema.ts'
import { withFileLock } from '../../workspace/file-lock.ts'
import { writeWorkspaceFile } from '../../workspace/paths.ts'
import { cutLine } from '../../workspace/text.ts'
import { readCheckpointBefore, sha256Hex } from './disk.ts'

/** The tool name of `shell` rows. */
export const SHELL_ROW_TOOL = 'shell'

/** Minimum time between two tool `workspace.changed` events of one chat (ms). */
export const TOOL_EVENT_INTERVAL_MS = 1000

// ---------- row writer ----------

/** The before-state columns of a file row: `stored` with the blob's sha, or how the state is kept otherwise. */
export function beforeRowFields(before: CheckpointBefore, storedSha: string | null): Pick<ChangeRowInput, 'beforeState' | 'beforeSha' | 'beforeSize' | 'beforeMode'> {
  switch (before.state) {
    case 'missing':
      return { beforeState: 'missing', beforeSha: null, beforeSize: null, beforeMode: null }
    case 'too-large':
      return { beforeState: 'too-large', beforeSha: null, beforeSize: before.size, beforeMode: before.mode }
    case 'present':
      // A blob that could not be stored: the change is listed, its base cannot be restored.
      return { beforeState: storedSha === null ? 'evicted' : 'stored', beforeSha: storedSha ?? before.sha, beforeSize: before.size, beforeMode: before.mode }
  }
}

/** The journal row writer over the database (see the module comment). */
export function createChangeRowWriter(deps: Pick<AppDeps, 'db'>, now: () => number): CheckpointRowWriter {
  return {
    insert: async (row) => {
      const [stored] = await deps.db.insert(workspaceChanges).values({
        chatId: row.chatId,
        projectId: row.projectId,
        messageSeq: sql<number>`(SELECT coalesce(max(seq), 0) FROM messages WHERE chat_id = ${row.chatId})`,
        messageId: row.messageId ?? null,
        toolCallId: row.toolCallId ?? null,
        batchId: row.batchId ?? null,
        kind: row.kind,
        tool: row.tool ?? null,
        path: row.path ?? null,
        command: row.command == null ? null : cutLine(row.command, LIMITS.journalCommandMaxChars),
        beforeState: row.beforeState ?? null,
        beforeSha: row.beforeSha ?? null,
        beforeSize: row.beforeSize ?? null,
        beforeMode: row.beforeMode ?? null,
        afterSha: row.afterSha ?? null,
        afterSize: row.afterSize ?? null,
        createdAt: now(),
      }).returning()
      if (stored === undefined)
        throw new Error('The workspace change was not inserted.')
      return stored satisfies WorkspaceChangeRow
    },
  }
}

// ---------- tool events ----------

export interface ToolEventCoalescer {
  /** One agent edit of `path` in the chat's project; the event follows within `TOOL_EVENT_INTERVAL_MS`. */
  readonly add: (projectId: string, chatId: string, path: string) => void
  /** Drops the pending events and ignores later edits. */
  readonly stop: () => void
  /** Chats with a pending event (tests). */
  readonly pending: () => number
}

interface PendingToolEvent {
  readonly projectId: string
  readonly chatId: string
  readonly paths: Set<string>
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Coalesces agent edits into `workspace.changed` events: the first edit of a chat starts a timer of `intervalMs`, every
 * edit until it fires adds its path, and the timer emits one event with all of them. So a chat gets at most one event
 * per interval, and an edit is announced at most `intervalMs` after it happened.
 */
export function createToolEventCoalescer(emit: (data: WorkspaceChangedData) => void, intervalMs = TOOL_EVENT_INTERVAL_MS): ToolEventCoalescer {
  const pending = new Map<string, PendingToolEvent>()
  let stopped = false

  function flush(key: string): void {
    const entry = pending.get(key)
    if (entry === undefined)
      return
    pending.delete(key)
    emit({ projectId: entry.projectId, chatId: entry.chatId, batchId: null, source: 'tool', paths: [...entry.paths] })
  }

  return {
    add: (projectId, chatId, path) => {
      if (stopped)
        return
      const key = `${projectId}\u0000${chatId}`
      let entry = pending.get(key)
      if (entry === undefined) {
        const timer = setTimeout(flush, intervalMs, key)
        timer.unref?.()
        entry = { projectId, chatId, paths: new Set(), timer }
        pending.set(key, entry)
      }
      if (entry.paths.size < LIMITS.workspaceEventPathsMax)
        entry.paths.add(path)
    },
    stop: () => {
      stopped = true
      for (const entry of pending.values())
        clearTimeout(entry.timer)
      pending.clear()
    },
    pending: () => pending.size,
  }
}

// ---------- journal ----------

export interface CheckpointJournalOptions {
  /** The service's coalescer of tool events; without it the journal emits nothing. */
  readonly toolEvents?: ToolEventCoalescer
}

/** What a log record may say about a failure: its code or name, never a path or a message with content. */
export function failureCode(error: unknown): string {
  if (isHarnessError(error))
    return error.code
  if (typeof error === 'object' && error !== null && 'code' in error)
    return String((error as { code: unknown }).code)
  return error instanceof Error ? error.name : 'unknown'
}

/** The journal of one run (see the module comment). */
export function createCheckpointJournal(ctx: CheckpointContext, scope: CheckpointScope, options: CheckpointJournalOptions = {}): CheckpointJournal {
  const frozen: CheckpointScope = Object.freeze({ chatId: scope.chatId, messageId: scope.messageId, projectId: scope.projectId })
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= ctx.deps.logger.child({ component: 'checkpoints' }))

  function notRecorded(kind: string, toolCallId: string, error: unknown): void {
    log().warn('checkpoint not recorded', { kind, chatId: frozen.chatId, toolCallId, code: failureCode(error) })
    log().debug('checkpoint not recorded (detail)', { kind, chatId: frozen.chatId, toolCallId, err: error })
  }

  async function insertQuietly(kind: string, toolCallId: string, row: ChangeRowInput): Promise<boolean> {
    try {
      await ctx.rows.insert(row)
      return true
    }
    catch (error) {
      notRecorded(kind, toolCallId, error)
      return false
    }
  }

  async function write(input: CheckpointWriteInput): Promise<CheckpointWriteResult> {
    const { toolCallId, tool, root, resolved, produce, signal } = input
    const result = await withFileLock(resolved.absolute, async () => {
      const before = await readCheckpointBefore(root, resolved)
      const data = await produce(before)
      signal.throwIfAborted()
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data

      const record = async (): Promise<CheckpointWriteResult> => {
        let storedSha: string | null = null
        let blobStored = before.state !== 'present'
        if (before.state === 'present') {
          try {
            storedSha = await ctx.blobs.put(before.bytes)
            blobStored = true
          }
          catch (error) {
            notRecorded('edit', toolCallId, error)
          }
        }
        // A failed write rejects here: no row (a stored blob is an orphan for prune).
        const written = await writeWorkspaceFile(root, resolved.rel, bytes)
        const inserted = await insertQuietly('edit', toolCallId, {
          chatId: frozen.chatId,
          projectId: frozen.projectId,
          kind: 'edit',
          messageId: frozen.messageId,
          toolCallId,
          tool,
          path: written.rel,
          ...beforeRowFields(before, storedSha),
          afterSha: sha256Hex(bytes),
          afterSize: bytes.byteLength,
        })
        return { written, before, recorded: inserted && blobStored }
      }
      // The gate is held shared from the blob write until the row is inserted (prune holds it exclusively).
      return before.state === 'present' ? ctx.blobs.withSharedGate(record) : record()
    })
    options.toolEvents?.add(frozen.projectId, frozen.chatId, result.written.rel)
    return result
  }

  return {
    scope: frozen,
    write,
    recordShell: async ({ toolCallId, command }) => {
      await insertQuietly('shell', toolCallId, {
        chatId: frozen.chatId,
        projectId: frozen.projectId,
        kind: 'shell',
        messageId: frozen.messageId,
        toolCallId,
        tool: SHELL_ROW_TOOL,
        command,
      })
    },
    recordUntracked: async ({ toolCallId, tool }) => {
      await insertQuietly('untracked', toolCallId, {
        chatId: frozen.chatId,
        projectId: frozen.projectId,
        kind: 'untracked',
        messageId: frozen.messageId,
        toolCallId,
        tool,
      })
    },
  }
}
