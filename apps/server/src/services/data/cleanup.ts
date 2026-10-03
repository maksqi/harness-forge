// Orphaned file cleanup of the data service (ADR-035, API.md 5.19, ARCHITECTURE.md 6.15). Owner: W7.8 (W7.8-T4); the
// plugin data scan, the automatic run and the sweep state by W8.7 (Phase 8, ADR-039). The callers hold
// `maintenance.exclusive('file-cleanup', ...)`: the data service for the preview and the manual run, ./auto-sweep.ts
// for the automatic run.
//
// 1. The cutoff is taken first: `createdBefore = now - FILE_CLEANUP_GRACE_MS` (24 h).
// 2. The referenced ids are collected without any lock: ./references.ts (a loose scan of every column that may hold a
//    file id), then ./plugin-data-scan.ts (the files under `plugins/.data`, within a budget).
// 3. `FilesService.sweep` takes the store gate exclusively, skips the pinned ids, deletes the rest with a DELETE that
//    re-checks the message references, and walks the store for rowless blobs and stale temp files. It walks only
//    `DataPaths.files`: the checkpoint store (`DataPaths.checkpoints`) is never touched.
// 4. A real run stores its time in the internal setting `_files` (`{ lastCleanup, lastAutoSweep? }`) and logs the counts
//    (nothing else: no ids, names or paths). No event.
//
// An automatic run (`runAutoCleanup`) stops at step 2 when the plugin data scan is partial: it deletes nothing and
// stores `lastAutoSweep = { status: 'skipped', reason: 'plugin-data-limit' }`; a manual run proceeds and reports
// `pluginData: 'partial'`. A finished automatic run sets `lastCleanup` too, so a manual and an automatic run reset the
// same clock.
import type { DataCleanupPreview, DataCleanupResult, FileSweepAttempt, FileSweepStatus } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { FileSweepResult } from '../files/types.ts'
import type { InternalSettingKey } from '../settings/types.ts'
import type { PluginDataScanBudget, PluginDataScanResult } from './plugin-data-scan.ts'
import { performance } from 'node:perf_hooks'
import { fileSweepAttemptSchema } from '@harness-forge/shared'
import { FILE_CLEANUP_GRACE_MS } from '../files/pins.ts'
import { scanPluginData } from './plugin-data-scan.ts'
import { collectReferencedFileIds } from './references.ts'

/** Internal setting of the cleanup state: `{ lastCleanup?: number, lastAutoSweep?: FileSweepAttempt }` (ms). */
export const FILE_STATE_SETTING = '_files' satisfies InternalSettingKey

/** The parsed `_files` state (what the automatic sweep's due time depends on). */
export interface FileSweepState {
  /** The last real cleanup, manual or automatic; null = never. */
  readonly lastCleanup: number | null
  /** The last automatic attempt (`done`, `skipped` or `failed`); null = none yet. */
  readonly lastAutoSweep: FileSweepAttempt | null
}

/** What the cleanup functions need besides the lock. */
export interface CleanupContext {
  readonly deps: AppDeps
  /** Clock of the cutoff, `ranAt` and the attempt times. */
  readonly now: () => number
  /** The plugin data scan budget (`PLUGIN_DATA_SCAN_BUDGET`, overridable in tests). */
  readonly pluginDataBudget: PluginDataScanBudget
  readonly logger: Logger
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored `_files` object (an unexpected value counts as empty). */
async function readFileState(deps: AppDeps): Promise<Record<string, unknown>> {
  const state = await deps.settings.getInternal<unknown>(FILE_STATE_SETTING)
  return isRecord(state) ? state : {}
}

/** Merges `patch` into the stored `_files` object (the caller holds the maintenance lock: no concurrent writer). */
export async function updateFileState(deps: AppDeps, patch: { lastCleanup?: number, lastAutoSweep?: FileSweepAttempt }): Promise<void> {
  const state = await readFileState(deps)
  await deps.settings.setInternal(FILE_STATE_SETTING, { ...state, ...patch })
}

/** `lastCleanup` of the stored state; null when it never ran (or the value is not a timestamp). */
export function lastCleanupOf(state: Record<string, unknown>): number | null {
  const value = state.lastCleanup
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** `lastAutoSweep` of the stored state; null when there is none (or it is malformed). */
export function lastAutoSweepOf(state: Record<string, unknown>): FileSweepAttempt | null {
  const parsed = fileSweepAttemptSchema.safeParse(state.lastAutoSweep)
  return parsed.success ? parsed.data : null
}

/** The `_files` state as the automatic sweep reads it (malformed parts count as absent). */
export async function readSweepState(deps: AppDeps): Promise<FileSweepState> {
  const state = await readFileState(deps)
  return { lastCleanup: lastCleanupOf(state), lastAutoSweep: lastAutoSweepOf(state) }
}

/** The referenced ids of step 2 and how much of the plugin data was read. */
interface References {
  readonly ids: ReadonlySet<string>
  readonly pluginData: PluginDataScanResult
}

async function collectReferences(context: CleanupContext, signal: AbortSignal | undefined, stopWhenPartial: boolean): Promise<References> {
  const ids = await collectReferencedFileIds(context.deps.db, { signal })
  const pluginData = await scanPluginData(context.deps.env.paths.pluginData, ids, {
    budget: context.pluginDataBudget,
    signal,
    stopWhenPartial,
  })
  if (pluginData.scan === 'partial')
    context.logger.debug('plugin data scan stopped early', { limit: pluginData.limit, files: pluginData.files, bytes: pluginData.bytes })
  return { ids, pluginData }
}

/** The counts of a real run (`DataCleanupResult` without `ranAt` and `pluginData`). */
function removedCounts(result: FileSweepResult) {
  return { files: result.files, fileBytes: result.fileBytes, blobs: result.blobs, diskBytes: result.diskBytes, tempFiles: result.tempFiles }
}

/** The log fields every finished run shares (counts only). */
function runLogFields(result: FileSweepResult, pluginData: PluginDataScanResult, startedAt: number) {
  return {
    ...removedCounts(result),
    recentFiles: result.recentFiles,
    pluginData: pluginData.scan,
    pluginDataFiles: pluginData.files,
    pluginDataBytes: pluginData.bytes,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  }
}

/**
 * `GET /data/cleanup`: what a cleanup would remove (deletes nothing, stores nothing). `fileSweep` is the automatic
 * sweep's status. The caller holds the maintenance lock.
 */
export async function previewCleanup(context: CleanupContext, fileSweep: () => Promise<FileSweepStatus>): Promise<DataCleanupPreview> {
  const { deps, now } = context
  const createdBefore = now() - FILE_CLEANUP_GRACE_MS
  const references = await collectReferences(context, undefined, false)
  const result = await deps.files.sweep({ referencedIds: references.ids, createdBefore, dryRun: true })
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
    fileSweep: await fileSweep(),
    pluginData: references.pluginData.scan,
  }
}

/**
 * `POST /data/cleanup`: removes the orphans (also when the plugin data scan is partial: `pluginData: 'partial'`) and
 * stores `_files.lastCleanup`. The caller holds the maintenance lock.
 */
export async function runCleanup(context: CleanupContext): Promise<DataCleanupResult> {
  const { deps, now, logger } = context
  const startedAt = performance.now()
  const createdBefore = now() - FILE_CLEANUP_GRACE_MS
  const references = await collectReferences(context, undefined, false)
  const result = await deps.files.sweep({ referencedIds: references.ids, createdBefore, dryRun: false })
  const ranAt = now()
  await updateFileState(deps, { lastCleanup: ranAt })
  logger.info('orphaned files cleaned up', { trigger: 'manual', ...runLogFields(result, references.pluginData, startedAt) })
  return { ...removedCounts(result), ranAt, pluginData: references.pluginData.scan }
}

/** What an automatic run did (`runAutoCleanup`). */
export type AutoCleanupOutcome
  = | { readonly status: 'done', readonly attempt: FileSweepAttempt }
    | { readonly status: 'skipped', readonly attempt: FileSweepAttempt }

/**
 * One automatic run (ADR-039): like `runCleanup`, but skipped (nothing deleted) when the plugin data scan is partial,
 * and aborted by `signal` (between batches: it rejects with the signal's reason and stores nothing). Stores
 * `_files.lastAutoSweep` (and `lastCleanup` when done) and logs `automatic file sweep finished` / `... skipped`. The
 * caller holds the maintenance lock and records failures (./auto-sweep.ts).
 */
export async function runAutoCleanup(context: CleanupContext, signal: AbortSignal): Promise<AutoCleanupOutcome> {
  const { deps, now, logger } = context
  const startedAt = performance.now()
  const createdBefore = now() - FILE_CLEANUP_GRACE_MS
  const references = await collectReferences(context, signal, true)
  signal.throwIfAborted()
  if (references.pluginData.scan === 'partial') {
    const attempt: FileSweepAttempt = { at: now(), status: 'skipped', reason: 'plugin-data-limit', files: 0, diskBytes: 0 }
    await updateFileState(deps, { lastAutoSweep: attempt })
    logger.info('automatic file sweep skipped', {
      trigger: 'auto',
      reason: attempt.reason,
      pluginDataFiles: references.pluginData.files,
      pluginDataBytes: references.pluginData.bytes,
    })
    return { status: 'skipped', attempt }
  }
  const result = await deps.files.sweep({ referencedIds: references.ids, createdBefore, dryRun: false, signal })
  const ranAt = now()
  const attempt: FileSweepAttempt = { at: ranAt, status: 'done', reason: null, files: result.files, diskBytes: result.diskBytes }
  await updateFileState(deps, { lastCleanup: ranAt, lastAutoSweep: attempt })
  logger.info('automatic file sweep finished', { trigger: 'auto', ...runLogFields(result, references.pluginData, startedAt) })
  return { status: 'done', attempt }
}
