// Test doubles of the checkpoint service (Phase 8, C19-T9), so the P8-A agents can test against the frozen interfaces
// of `services/checkpoints/types.ts` while the real modules land in parallel:
//
//   const blobs = createFakeCheckpointBlobStore()                      // W8.2 / W8.3: the injected blob store
//   const rows = createTestChangeRowWriter(t.db)                        // W8.2: the row writer of restores
//   await insertChangeRows(t.db, [{ chatId, projectId, kind: 'edit', path: 'a.txt', ... }])   // seed a journal
//   const ctx: CheckpointContext = { deps: t.deps, blobs, rows, now: () => T0 }
//
//   const t = await createTestApp({ checkpoints: 'fake' })              // W8.5: a recording CheckpointService
//   const fake = t.deps.checkpoints as FakeCheckpointService           // fake.records: every journal call of the runs
//
// The rows go into the test database (`workspace_changes` has real foreign keys: insert the chat and the project
// first). The fake service's journal writes like the P8-0b skeleton (`writeWithoutRecording`: lock, before-state,
// `produce`, abort check, write) and records every call in memory; its route-facing members answer canned DTOs
// (`overrides` replace any member).
import type { RestoreResult, RewindPreview } from '@harness-forge/shared'
import type { Db } from '../db/client.ts'
import type { WorkspaceChangeRow } from '../db/schema.ts'
import type {
  ChangeRowInput,
  CheckpointBeforeState,
  CheckpointBlobStore,
  CheckpointJournal,
  CheckpointRowWriter,
  CheckpointScope,
  CheckpointService,
  CheckpointSummary,
  PruneResult,
} from '../services/checkpoints/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, LIMITS, SHA256_HEX_PATTERN, validationError } from '@harness-forge/shared'
import { sql } from 'drizzle-orm'
import { workspaceChanges } from '../db/schema.ts'
import { sha256Hex, writeWithoutRecording } from '../services/checkpoints/disk.ts'
import { createStoreGate } from '../services/files/gate.ts'

// ---------- blob store ----------

export interface FakeCheckpointBlobStore extends CheckpointBlobStore {
  /** Every blob by sha (tests may delete one to simulate an evicted or pruned blob). */
  readonly blobs: Map<string, Buffer>
  /** Calls of `put` so far (a deduplicated put counts too). */
  readonly puts: () => number
  /** Runs `operation` holding the gate alone (a stand-in for prune). */
  readonly withExclusiveGate: <T>(operation: () => Promise<T>) => Promise<T>
  /** Holders and waiters of the gate. */
  readonly gateState: () => { shared: number, exclusive: boolean, waiting: number }
}

function checkName(sha: string): void {
  if (!SHA256_HEX_PATTERN.test(sha))
    throw validationError([{ path: ['sha'], message: 'Expected a lowercase hex SHA-256.', code: 'custom' }])
}

/**
 * An in-memory `CheckpointBlobStore`: deduplicated by sha256, copies in and out (a caller mutating its buffer never
 * changes a blob), names validated like the real store, a real store gate.
 */
export function createFakeCheckpointBlobStore(): FakeCheckpointBlobStore {
  const blobs = new Map<string, Buffer>()
  const gate = createStoreGate()
  let puts = 0
  return {
    blobs,
    puts: () => puts,
    put: async (bytes) => {
      puts += 1
      const sha = sha256Hex(bytes)
      if (!blobs.has(sha))
        blobs.set(sha, Buffer.from(bytes))
      return sha
    },
    read: async (sha) => {
      checkName(sha)
      const blob = blobs.get(sha)
      return blob === undefined ? null : Buffer.from(blob)
    },
    has: async (sha) => {
      checkName(sha)
      return blobs.has(sha)
    },
    remove: async (sha) => {
      checkName(sha)
      return blobs.delete(sha)
    },
    withSharedGate: operation => gate.shared(operation),
    withExclusiveGate: operation => gate.exclusive(operation),
    gateState: () => gate.state(),
  }
}

// ---------- journal rows ----------

/** A row for `insertChangeRows`: a `ChangeRowInput` whose watermark and time may be set explicitly. */
export interface TestChangeRowInput extends ChangeRowInput {
  /** Default: the chat's `coalesce(max(messages.seq), 0)` at insert time (what the real writer stores). */
  messageSeq?: number
  /** Default: the writer's clock. */
  createdAt?: number
}

/** The values of one row as the real writer stores them (nulls for omitted fields, the command cut). */
function rowValues(row: TestChangeRowInput, createdAt: number): Omit<typeof workspaceChanges.$inferInsert, 'messageSeq'> {
  return {
    chatId: row.chatId,
    projectId: row.projectId,
    messageId: row.messageId ?? null,
    toolCallId: row.toolCallId ?? null,
    batchId: row.batchId ?? null,
    kind: row.kind,
    tool: row.tool ?? null,
    path: row.path ?? null,
    command: row.command == null ? null : row.command.slice(0, LIMITS.journalCommandMaxChars),
    beforeState: row.beforeState ?? null,
    beforeSha: row.beforeSha ?? null,
    beforeSize: row.beforeSize ?? null,
    beforeMode: row.beforeMode ?? null,
    afterSha: row.afterSha ?? null,
    afterSize: row.afterSize ?? null,
    createdAt,
  }
}

/** Inserts one row into the test database and returns it as stored. */
async function insertRow(db: Db, row: TestChangeRowInput, createdAt: number): Promise<WorkspaceChangeRow> {
  const values = rowValues(row, createdAt)
  const messageSeq = row.messageSeq ?? sql<number>`(SELECT coalesce(max(seq), 0) FROM messages WHERE chat_id = ${row.chatId})`
  const [inserted] = await db.insert(workspaceChanges).values({ ...values, messageSeq }).returning()
  if (inserted === undefined)
    throw new Error('The workspace change was not inserted.')
  return inserted
}

/**
 * Inserts journal rows in order (W8.2 / W8.3 unit tests seed a chat's history with it) and returns them as stored.
 * The chat and the project must exist (real foreign keys). `createdAt` defaults to `now()` (the clock, default
 * `Date.now`), `messageSeq` to the chat's current watermark.
 */
export async function insertChangeRows(db: Db, rows: readonly TestChangeRowInput[], now: () => number = Date.now): Promise<WorkspaceChangeRow[]> {
  const inserted: WorkspaceChangeRow[] = []
  for (const row of rows)
    inserted.push(await insertRow(db, row, row.createdAt ?? now()))
  return inserted
}

/** A `CheckpointRowWriter` over the test database with the real writer's rules (the restore primitive's tests). */
export function createTestChangeRowWriter(db: Db, now: () => number = Date.now): CheckpointRowWriter & { readonly inserted: WorkspaceChangeRow[] } {
  const inserted: WorkspaceChangeRow[] = []
  return {
    inserted,
    insert: async (row) => {
      const stored = await insertRow(db, row, now())
      inserted.push(stored)
      return stored
    },
  }
}

/** The fields of an `edit` row for a change from `before` to `after` content (null = missing). Test convenience. */
export function editRowFields(before: string | Uint8Array | null, after: string | Uint8Array | null, mode: number | null = 0o644): Pick<ChangeRowInput, 'beforeState' | 'beforeSha' | 'beforeSize' | 'beforeMode' | 'afterSha' | 'afterSize'> {
  const size = (value: string | Uint8Array): number => (typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength)
  const beforeState: CheckpointBeforeState = before === null ? 'missing' : 'stored'
  return {
    beforeState,
    beforeSha: before === null ? null : sha256Hex(before),
    beforeSize: before === null ? null : size(before),
    beforeMode: before === null ? null : mode,
    afterSha: after === null ? null : sha256Hex(after),
    afterSize: after === null ? null : size(after),
  }
}

// ---------- service ----------

/** One call a fake journal received. */
export type FakeJournalRecord
  = | { readonly kind: 'write', readonly scope: CheckpointScope, readonly toolCallId: string, readonly tool: string, readonly path: string }
    | { readonly kind: 'shell', readonly scope: CheckpointScope, readonly toolCallId: string, readonly command: string }
    | { readonly kind: 'untracked', readonly scope: CheckpointScope, readonly toolCallId: string, readonly tool: string }

export interface FakeCheckpointService extends CheckpointService {
  /** Every call in order: the member and its arguments. */
  readonly calls: Array<{ member: keyof CheckpointService, args: unknown[] }>
  /** The scope of every `journal()` call. */
  readonly journals: CheckpointScope[]
  /** Every journal call (`write`, `recordShell`, `recordUntracked`) of every journal, in order. */
  readonly records: FakeJournalRecord[]
  /** `start()` ran and `stop()` did not run since. */
  readonly started: () => boolean
}

/** The canned answer of the restore members (nothing written). */
export const FAKE_RESTORE_RESULT: RestoreResult = Object.freeze({ batchId: null, restored: [], deleted: [], unchanged: [], skipped: [] })

const EMPTY_SUMMARY: CheckpointSummary = Object.freeze({ bytes: 0, blobs: 0 })

const EMPTY_PRUNE: PruneResult = Object.freeze({ evictedByAge: 0, evictedByBudget: 0, rowsEvicted: 0, orphanBlobs: 0, tempFiles: 0, bytesFreed: 0 })

/**
 * A recording `CheckpointService` (W8.5's pipeline tests; route tests). Defaults: `listChanges` -> unavailable
 * (`no-project`), `gitStatus` -> unavailable (`not-a-repo`), `fileDiff` -> `404 not_found`, `rewindPreview` -> nothing to
 * restore, `revert` / `undo` / `rewind` -> `FAKE_RESTORE_RESULT`, `prune` -> zeros, `purge` / `summary` -> an empty
 * store. `overrides` replace any member (they are recorded too). Usable as a factory:
 * `createTestApp({ factories: { checkpoints: () => createFakeCheckpointService() } })` or `createTestApp({ checkpoints:
 * 'fake' })`.
 */
export function createFakeCheckpointService(overrides: Partial<CheckpointService> = {}): FakeCheckpointService {
  const calls: FakeCheckpointService['calls'] = []
  const journals: CheckpointScope[] = []
  const records: FakeJournalRecord[] = []
  let started = false
  const record = <A extends unknown[], R>(member: keyof CheckpointService, run: (...args: A) => R) => (...args: A): R => {
    calls.push({ member, args })
    return run(...args)
  }

  const journal = (scope: CheckpointScope): CheckpointJournal => {
    journals.push(scope)
    const frozen = Object.freeze({ ...scope })
    return {
      scope: frozen,
      write: async (input) => {
        records.push({ kind: 'write', scope: frozen, toolCallId: input.toolCallId, tool: input.tool, path: input.resolved.rel })
        return writeWithoutRecording(input)
      },
      recordShell: async (input) => {
        records.push({ kind: 'shell', scope: frozen, toolCallId: input.toolCallId, command: input.command.slice(0, LIMITS.journalCommandMaxChars) })
      },
      recordUntracked: async (input) => {
        records.push({ kind: 'untracked', scope: frozen, toolCallId: input.toolCallId, tool: input.tool })
      },
    }
  }

  const defaults: CheckpointService = {
    journal,
    listChanges: async () => ({ available: false, reason: 'no-project', projectId: null, files: [], truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } }),
    fileDiff: async (_chatId, query) => {
      throw new HarnessError({ code: 'not_found', message: `"${query.path}" has no changes.` })
    },
    gitStatus: async () => ({ available: false, reason: 'not-a-repo', branch: null, head: null, prefix: '', files: [], truncated: false }),
    revert: async () => ({ ...FAKE_RESTORE_RESULT }),
    undo: async () => ({ ...FAKE_RESTORE_RESULT }),
    rewindPreview: async (_chatId, messageId): Promise<RewindPreview> => ({ messageId, files: [], untracked: { shellCount: 0, shell: [], tools: [] }, truncated: false }),
    rewind: async () => ({ ...FAKE_RESTORE_RESULT }),
    start: async () => {
      started = true
    },
    stop: async () => {
      started = false
    },
    prune: async () => ({ ...EMPTY_PRUNE }),
    purge: async () => ({ ...EMPTY_SUMMARY }),
    summary: async () => ({ ...EMPTY_SUMMARY }),
  }
  const merged = { ...defaults, ...overrides }
  return {
    calls,
    journals,
    records,
    started: () => started,
    journal: record('journal', merged.journal),
    listChanges: record('listChanges', merged.listChanges),
    fileDiff: record('fileDiff', merged.fileDiff),
    gitStatus: record('gitStatus', merged.gitStatus),
    revert: record('revert', merged.revert),
    undo: record('undo', merged.undo),
    rewindPreview: record('rewindPreview', merged.rewindPreview),
    rewind: record('rewind', merged.rewind),
    start: record('start', merged.start),
    stop: record('stop', merged.stop),
    prune: record('prune', merged.prune),
    purge: record('purge', merged.purge),
    summary: record('summary', merged.summary),
  }
}
