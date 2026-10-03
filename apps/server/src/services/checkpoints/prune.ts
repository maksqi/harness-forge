// Checkpoint retention (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Prune"). Owner: W8.1.
//
// `pruneCheckpoints(ctx, store, { now, signal })`, holding the store gate exclusively (no blob is written and no row of
// a blob is inserted meanwhile), in order:
//   1. age: every `stored` row older than `LIMITS.checkpointMaxAgeMs` (its `created_at`, the time the before-state was
//      captured) becomes `before_state = 'evicted'`;
//   2. budget: per project, the distinct blobs its `stored` rows reference (size = `before_size`) are summed; above
//      `LIMITS.checkpointProjectMaxBytes` the least recently used ones (the newest row referencing the blob in that
//      project, oldest first) are evicted from the project's rows until the rest fits;
//   after 1 and 2, a blob that no `stored` row of any project references any more is unlinked (blobs are shared across
//   projects by content: one project's eviction never removes another project's base);
//   3. orphans: blobs older than `CHECKPOINT_TEMP_MAX_AGE_MS` (mtime; a put refreshes it) that no `stored` row
//      references (a failed write or insert, a crash) are unlinked; younger ones wait for the next prune;
//   4. temp files of interrupted writes older than `CHECKPOINT_TEMP_MAX_AGE_MS` are removed.
// Counts (`PruneResult`): `evictedByAge` / `evictedByBudget` = blobs unlinked by steps 1 / 2, `rowsEvicted` = rows of
// both steps, `orphanBlobs`, `tempFiles`, `bytesFreed` = the bytes of every unlinked file. The schedule (boot, every 6
// hours, 60 s after a `chat.deleted`) lives in `index.ts`. `signal` stops between steps and between unlinks.
import type { CheckpointStore, CheckpointStoreEntry } from './store.ts'
import type { CheckpointContext, PruneResult } from './types.ts'
import { LIMITS } from '@harness-forge/shared'
import { and, eq, inArray, isNotNull, lt, max } from 'drizzle-orm'
import { workspaceChanges } from '../../db/schema.ts'
import { CHECKPOINT_TEMP_MAX_AGE_MS } from './store.ts'

export interface PruneRunOptions {
  /** The clock of the age limit and the orphan grace (ms). */
  readonly now: number
  /** Stops between steps (`stop()` waits for a running prune). */
  readonly signal?: AbortSignal
}

/** What a prune that found nothing reports. */
export const EMPTY_PRUNE_RESULT: PruneResult = Object.freeze({
  evictedByAge: 0,
  evictedByBudget: 0,
  rowsEvicted: 0,
  orphanBlobs: 0,
  tempFiles: 0,
  bytesFreed: 0,
})

/** Shas per `IN (…)` list (far below SQLite's variable limit). */
const QUERY_CHUNK = 500

/** Mutable counts of one prune. */
type Counts = { -readonly [K in keyof PruneResult]: PruneResult[K] }

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += QUERY_CHUNK)
    result.push(values.slice(index, index + QUERY_CHUNK))
  return result
}

/** The shas of `shas` that a `stored` row still references. */
async function referencedShas(ctx: CheckpointContext, shas: readonly string[]): Promise<Set<string>> {
  const referenced = new Set<string>()
  for (const chunk of chunks(shas)) {
    const rows = await ctx.deps.db
      .selectDistinct({ sha: workspaceChanges.beforeSha })
      .from(workspaceChanges)
      .where(and(eq(workspaceChanges.beforeState, 'stored'), inArray(workspaceChanges.beforeSha, chunk)))
    for (const row of rows) {
      if (row.sha !== null)
        referenced.add(row.sha)
    }
  }
  return referenced
}

/** Unlinks the blobs of `shas` that no `stored` row references any more; resolves to the count and the bytes freed. */
async function unlinkUnreferenced(ctx: CheckpointContext, store: CheckpointStore, shas: ReadonlySet<string>, signal?: AbortSignal): Promise<{ blobs: number, bytes: number }> {
  const candidates = [...shas].sort()
  const referenced = await referencedShas(ctx, candidates)
  const freed = { blobs: 0, bytes: 0 }
  for (const sha of candidates) {
    signal?.throwIfAborted()
    if (referenced.has(sha))
      continue
    // A row may carry a sha that is not on disk (a failed put, a blob already gone): nothing to unlink.
    const entry = await store.blobEntry(sha)
    if (entry !== null && await store.unlinkEntry(entry)) {
      freed.blobs += 1
      freed.bytes += entry.size
    }
  }
  return freed
}

/** Step 1: `stored` rows older than the age limit become `evicted`; resolves to the shas they referenced. */
async function evictByAge(ctx: CheckpointContext, now: number, counts: Counts): Promise<Set<string>> {
  const cutoff = now - LIMITS.checkpointMaxAgeMs
  const evicted = await ctx.deps.db
    .update(workspaceChanges)
    .set({ beforeState: 'evicted' })
    .where(and(eq(workspaceChanges.beforeState, 'stored'), lt(workspaceChanges.createdAt, cutoff)))
    .returning({ sha: workspaceChanges.beforeSha })
  counts.rowsEvicted += evicted.length
  return new Set(evicted.flatMap(row => (row.sha === null ? [] : [row.sha])))
}

/** Step 2: per project over the budget, the least recently used blobs leave the project's `stored` rows. */
async function evictByBudget(ctx: CheckpointContext, counts: Counts, signal?: AbortSignal): Promise<Set<string>> {
  const usage = await ctx.deps.db
    .select({
      projectId: workspaceChanges.projectId,
      sha: workspaceChanges.beforeSha,
      size: max(workspaceChanges.beforeSize),
      lastUsedAt: max(workspaceChanges.createdAt),
      lastId: max(workspaceChanges.id),
    })
    .from(workspaceChanges)
    .where(and(eq(workspaceChanges.beforeState, 'stored'), isNotNull(workspaceChanges.beforeSha)))
    .groupBy(workspaceChanges.projectId, workspaceChanges.beforeSha)

  const byProject = new Map<string, Array<{ sha: string, size: number, lastUsedAt: number, lastId: number }>>()
  for (const row of usage) {
    if (row.sha === null)
      continue
    const list = byProject.get(row.projectId) ?? []
    list.push({ sha: row.sha, size: row.size ?? 0, lastUsedAt: Number(row.lastUsedAt ?? 0), lastId: row.lastId ?? 0 })
    byProject.set(row.projectId, list)
  }

  const evictedShas = new Set<string>()
  for (const [projectId, blobs] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
    signal?.throwIfAborted()
    let total = blobs.reduce((sum, blob) => sum + blob.size, 0)
    if (total <= LIMITS.checkpointProjectMaxBytes)
      continue
    blobs.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.lastId - b.lastId)
    const victims: string[] = []
    for (const blob of blobs) {
      if (total <= LIMITS.checkpointProjectMaxBytes)
        break
      victims.push(blob.sha)
      total -= blob.size
    }
    for (const chunk of chunks(victims)) {
      const evicted = await ctx.deps.db
        .update(workspaceChanges)
        .set({ beforeState: 'evicted' })
        .where(and(eq(workspaceChanges.projectId, projectId), eq(workspaceChanges.beforeState, 'stored'), inArray(workspaceChanges.beforeSha, chunk)))
        .returning({ id: workspaceChanges.id })
      counts.rowsEvicted += evicted.length
    }
    for (const sha of victims)
      evictedShas.add(sha)
  }
  return evictedShas
}

/** Steps 3 and 4: old blobs no `stored` row references, and stale temp files. */
async function removeOrphans(ctx: CheckpointContext, store: CheckpointStore, now: number, counts: Counts, signal?: AbortSignal): Promise<void> {
  const cutoff = now - CHECKPOINT_TEMP_MAX_AGE_MS
  const entries = await store.list()
  const oldBlobs = entries.filter(entry => entry.kind === 'blob' && entry.mtimeMs < cutoff)
  const referenced = await referencedShas(ctx, oldBlobs.map(entry => entry.name))
  const unlink = async (entry: CheckpointStoreEntry): Promise<boolean> => {
    signal?.throwIfAborted()
    if (!await store.unlinkEntry(entry))
      return false
    counts.bytesFreed += entry.size
    return true
  }
  for (const entry of oldBlobs) {
    if (!referenced.has(entry.name) && await unlink(entry))
      counts.orphanBlobs += 1
  }
  for (const entry of entries) {
    if (entry.kind === 'temp' && entry.mtimeMs < cutoff && await unlink(entry))
      counts.tempFiles += 1
  }
}

/** One prune of the store (see the module comment). */
export async function pruneCheckpoints(ctx: CheckpointContext, store: CheckpointStore, options: PruneRunOptions): Promise<PruneResult> {
  const { now, signal } = options
  signal?.throwIfAborted()
  return store.withExclusiveGate(async () => {
    const counts: Counts = { ...EMPTY_PRUNE_RESULT }

    signal?.throwIfAborted()
    const aged = await unlinkUnreferenced(ctx, store, await evictByAge(ctx, now, counts), signal)
    counts.evictedByAge = aged.blobs
    counts.bytesFreed += aged.bytes

    signal?.throwIfAborted()
    const budget = await unlinkUnreferenced(ctx, store, await evictByBudget(ctx, counts, signal), signal)
    counts.evictedByBudget = budget.blobs
    counts.bytesFreed += budget.bytes

    signal?.throwIfAborted()
    await removeOrphans(ctx, store, now, counts, signal)
    return counts
  })
}

/** True when a prune changed nothing (the info log is skipped). */
export function pruneFoundNothing(result: PruneResult): boolean {
  return result.rowsEvicted === 0 && result.orphanBlobs === 0 && result.tempFiles === 0 && result.evictedByAge === 0 && result.evictedByBudget === 0
}
