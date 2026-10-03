// Checkpoint retention (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Prune"). Owner: W8.1 (C19 stub).
//
// `pruneCheckpoints(ctx, store, { now })`, holding the store gate exclusively, in order: evict blobs older than
// `LIMITS.checkpointMaxAgeMs` (their rows become `before_state = 'evicted'`), then the oldest blobs of each project over
// `LIMITS.checkpointProjectMaxBytes`, unlink blobs that no `stored` row references and that are older than 1 hour, and
// remove stale temp files. `CheckpointService.start()` runs it once, then every 6 hours (a chained
// `setTimeout(...).unref()` like the catalog cycle, cleared by `stop()`) and 60 s after a `chat.deleted` (debounced).
//
// Stub: nothing is ever stored before W8.1, so a prune finds nothing to do and reports zeros.
import type { CheckpointStore } from './store.ts'
import type { CheckpointContext, PruneResult } from './types.ts'

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

/** One prune of the store (see the module comment). */
export async function pruneCheckpoints(_ctx: CheckpointContext, _store: CheckpointStore, _options: PruneRunOptions): Promise<PruneResult> {
  return EMPTY_PRUNE_RESULT
}
