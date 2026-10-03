// Orphaned file cleanup of the data service (ADR-035, API.md 5.19, ARCHITECTURE.md 6.15). Owner: W7.8 (W7.8-T4).
// The data service runs both under `maintenance.exclusive('file-cleanup', ...)`.
//
// 1. The cutoff is taken first: `createdBefore = now - FILE_CLEANUP_GRACE_MS` (24 h).
// 2. The referenced ids are collected without any lock (./references.ts: a loose scan of every column that may hold a
//    file id).
// 3. `FilesService.sweep` takes the store gate exclusively, skips the pinned ids, deletes the rest with a DELETE that
//    re-checks the message references, and walks the store for rowless blobs and stale temp files.
// 4. A real run stores its time in the internal setting `_files` (`{ lastCleanup }`) and logs the counts (nothing
//    else: no ids, names or paths). No event.
import type { DataCleanupPreview, DataCleanupResult, FileSweepStatus } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { FileSweepResult } from '../files/types.ts'
import type { InternalSettingKey } from '../settings/types.ts'
import { FILE_CLEANUP_GRACE_MS } from '../files/pins.ts'
import { collectReferencedFileIds } from './references.ts'

/** Internal setting of the cleanup state: `{ lastCleanup: number }` (ms). */
export const FILE_STATE_SETTING = '_files' satisfies InternalSettingKey

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored `_files` object (an unexpected value counts as empty). */
async function readFileState(deps: AppDeps): Promise<Record<string, unknown>> {
  const state = await deps.settings.getInternal<unknown>(FILE_STATE_SETTING)
  return isRecord(state) ? state : {}
}

/** `lastCleanup` of the stored state; null when it never ran (or the value is not a timestamp). */
export function lastCleanupOf(state: Record<string, unknown>): number | null {
  const value = state.lastCleanup
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * The automatic sweep state of `GET /data` and `GET /data/cleanup` (ADR-039). P8-A (W8.7): a contract placeholder
 * (the current `fileSweep` setting, no attempt, no next run) until the automatic sweep exists.
 */
export async function fileSweepStatus(deps: AppDeps): Promise<FileSweepStatus> {
  const { fileSweep } = await deps.settings.get()
  return { mode: fileSweep, lastAttempt: null, nextRunAt: null }
}

async function sweepOrphans(deps: AppDeps, now: () => number, dryRun: boolean): Promise<FileSweepResult> {
  const createdBefore = now() - FILE_CLEANUP_GRACE_MS
  const referencedIds = await collectReferencedFileIds(deps.db)
  return deps.files.sweep({ referencedIds, createdBefore, dryRun })
}

/** `GET /data/cleanup`: what a cleanup would remove (deletes nothing). The caller holds the maintenance lock. */
export async function previewCleanup(deps: AppDeps, now: () => number): Promise<DataCleanupPreview> {
  const result = await sweepOrphans(deps, now, true)
  const state = await readFileState(deps)
  return {
    files: result.files,
    fileBytes: result.fileBytes,
    blobs: result.blobs,
    diskBytes: result.diskBytes,
    tempFiles: result.tempFiles,
    recentFiles: result.recentFiles,
    graceMs: FILE_CLEANUP_GRACE_MS,
    lastRunAt: lastCleanupOf(state),
    // P8-A (W8.7): the plugin data scan reports `partial` when it stops at its budget.
    fileSweep: await fileSweepStatus(deps),
    pluginData: 'complete',
  }
}

/** `POST /data/cleanup`: removes the orphans, stores `_files.lastCleanup`. The caller holds the maintenance lock. */
export async function runCleanup(deps: AppDeps, now: () => number): Promise<DataCleanupResult> {
  const result = await sweepOrphans(deps, now, false)
  const ranAt = now()
  const state = await readFileState(deps)
  await deps.settings.setInternal(FILE_STATE_SETTING, { ...state, lastCleanup: ranAt })
  const counts = {
    files: result.files,
    fileBytes: result.fileBytes,
    blobs: result.blobs,
    diskBytes: result.diskBytes,
    tempFiles: result.tempFiles,
  }
  deps.logger.info('orphaned files cleaned up', { ...counts, recentFiles: result.recentFiles })
  // P8-A (W8.7): the plugin data scan reports `partial` when it stops at its budget.
  return { ...counts, ranAt, pluginData: 'complete' }
}
