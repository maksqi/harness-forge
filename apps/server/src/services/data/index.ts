// Bulk data (ADR-024, API.md 5.19, ARCHITECTURE.md 6.9). Owner: W5.3. Implements `DataService` (./types.ts) behind
// `createDataService(deps)`.
//
// - `summary`: counts straight from the database (every chat and message version, file rows and their bytes).
// - `exportBackup`: the pre-check and the streamed zip of ./backup.ts.
// - `importData`: ./restore.ts (a backup zip or one chat JSON).
// - `deleteAll`: stops every run, deletes every chat (and its messages and share links) through `ChatsService`,
//   optionally the usage rows and every uploaded file, then stops any run whose chat appeared meanwhile. Settings,
//   providers, credentials, plugins and MCP servers stay.
// - Imports and delete-all run under the maintenance lock (Phase 7, C16-T1: `deps.maintenance.exclusive('import' |
//   'delete-all', ...)`, shared with the key rotation and the file cleanup; it replaced the private mutex): while
//   another maintenance operation runs they fail at once with `409 conflict` (`reason: 'busy'`). Summaries and exports
//   never take it. No new event types: `ChatsService` emits `chat.created` / `chat.deleted` per chat.
// - `cleanupPreview` / `cleanup` (ADR-035, W7.8): ./cleanup.ts under `maintenance.exclusive('file-cleanup', ...)`
//   (runs are not blocked: the pins and the grace period cover them); since Phase 8 the reference scan also reads the
//   plugin data (./plugin-data-scan.ts) and both answers carry `fileSweep` / `pluginData`.
// - `start` / `stop` (Phase 8, ADR-039, W8.7): the automatic file sweep (./auto-sweep.ts): `start()` schedules its
//   checks (`DataServiceOptions.background`, default on, off under Vitest; the delays come from
//   `Env.testFileSweepDelayMs` when set), `stop()` clears the timer and aborts a sweep in flight.
// - `summary` (Phase 8): `fileSweep` (the sweep status: the setting and `_files`, no scan) and `checkpoints`
//   (`CheckpointService.summary()`, omitted when it fails). `deleteAll` (Phase 8) also empties the checkpoint store
//   (`CheckpointService.purge()`) inside its maintenance operation.
import type { DataDeleteBody, DataDeleteResult, DataSummary, FileSweepStatus } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { AutoSweep } from './auto-sweep.ts'
import type { CleanupContext } from './cleanup.ts'
import type { DataLimits } from './limits.ts'
import type { PluginDataScanBudget } from './plugin-data-scan.ts'
import type { DataService } from './types.ts'
import process from 'node:process'
import { validationError } from '@harness-forge/shared'
import { sql } from 'drizzle-orm'
import { chats, files, messages } from '../../db/schema.ts'
import { guardDb } from '../chats/db-errors.ts'
import { attemptAutoSweep, createAutoSweep, describeError, SWEEP_BOOT_DELAY_MS, SWEEP_BUSY_RETRY_MS, SWEEP_CHECK_INTERVAL_MS } from './auto-sweep.ts'
import { backupFilename, createBackupStream, planBackup } from './backup.ts'
import { previewCleanup, readSweepState, runCleanup } from './cleanup.ts'
import { DATA_LIMITS } from './limits.ts'
import { PLUGIN_DATA_SCAN_BUDGET } from './plugin-data-scan.ts'
import { importUpload } from './restore.ts'

export interface DataServiceOptions {
  /** Overrides of `DATA_LIMITS` (tests). */
  limits?: Partial<DataLimits>
  /** Clock of `exportedAt`, of the cleanup (its cutoff and `ranAt`) and of the automatic sweep (default `Date.now`). */
  now?: () => number
  /**
   * Phase 8 (ADR-039): run the automatic file sweep's timer after `start()`; default on, off under Vitest (tests drive
   * the sweep with fake timers and an injected clock).
   */
  background?: boolean
  /** Phase 8: overrides of `PLUGIN_DATA_SCAN_BUDGET` (tests). */
  pluginDataBudget?: Partial<PluginDataScanBudget>
}

/** `createDataService`'s result: the service plus its automatic sweep (tests: `idle()`, `nextCheckAt()`). */
export interface DataServiceWithSweep extends DataService {
  readonly autoSweep: AutoSweep
}

function isVitest(): boolean {
  return process.env.VITEST !== undefined
}

/** `DataSummary.checkpoints` from the checkpoint store; null (omitted) when it cannot be read. */
async function checkpointSummary(deps: AppDeps, logger: Logger): Promise<{ bytes: number, blobs: number } | null> {
  try {
    const summary = await deps.checkpoints.summary()
    return { bytes: summary.bytes, blobs: summary.blobs }
  }
  catch (error) {
    logger.warn('checkpoint store summary failed', describeError(error))
    return null
  }
}

async function dataSummary(deps: AppDeps, logger: Logger, fileSweepStatus: () => Promise<FileSweepStatus>): Promise<DataSummary> {
  const { db } = deps
  const [fileSweep, checkpoints] = await Promise.all([fileSweepStatus(), checkpointSummary(deps, logger)])
  return guardDb(async () => {
    const [chatCounts] = await db
      .select({ chats: sql<number>`count(*)`, archived: sql<number>`coalesce(sum(${chats.archived}), 0)` })
      .from(chats)
    const [messageCounts] = await db.select({ messages: sql<number>`count(*)` }).from(messages)
    const [fileCounts] = await db.select({ files: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${files.size}), 0)` }).from(files)
    return {
      chats: Number(chatCounts?.chats ?? 0),
      archivedChats: Number(chatCounts?.archived ?? 0),
      messages: Number(messageCounts?.messages ?? 0),
      files: Number(fileCounts?.files ?? 0),
      fileBytes: Number(fileCounts?.bytes ?? 0),
      fileSweep,
      ...(checkpoints === null ? {} : { checkpoints }),
    }
  })
}

/**
 * Empties the checkpoint store (the journal rows went with their chats). A failure is logged and does not fail the
 * delete-all (the chats are already gone; the next prune removes the orphaned blobs).
 */
async function purgeCheckpoints(deps: AppDeps): Promise<{ bytes: number, blobs: number }> {
  try {
    const purged = await deps.checkpoints.purge()
    return { bytes: purged.bytes, blobs: purged.blobs }
  }
  catch (error) {
    deps.logger.warn('checkpoint store purge failed', describeError(error))
    return { bytes: 0, blobs: 0 }
  }
}

async function deleteEverything(deps: AppDeps, body: DataDeleteBody): Promise<DataDeleteResult> {
  const ids = await deps.chats.allIds()
  // `stop` also refuses runs that are still preparing, and waits until each run is released.
  await Promise.all(ids.map(id => deps.runs.stop(id)))
  const removed = await deps.chats.removeAll({ usage: body.usage === true })
  const purged = body.files === true ? await deps.files.purge() : { files: 0, bytes: 0 }
  // Runs of chats that appeared (or started) while everything was deleted.
  await Promise.all(removed.chatIds.filter(id => deps.runs.hasRun(id)).map(id => deps.runs.stop(id)))
  // Phase 8: the before-states of the deleted chats' workspace edits, after every run stopped.
  const checkpoints = await purgeCheckpoints(deps)
  const result: DataDeleteResult = {
    chats: removed.chatIds.length,
    messages: removed.messages,
    files: purged.files,
    fileBytes: purged.bytes,
    usageRows: removed.usageRows,
  }
  deps.logger.info('data deleted', { ...result, checkpointBlobs: checkpoints.blobs, checkpointBytes: checkpoints.bytes })
  return result
}

export function createDataService(deps: AppDeps, options: DataServiceOptions = {}): DataServiceWithSweep {
  const limits: DataLimits = { ...DATA_LIMITS, ...options.limits }
  // Read at call time, so fake timers that replace `Date` after the service was built still apply (tests).
  const now = options.now ?? (() => Date.now())
  const logger = deps.logger.child({ component: 'data' })
  // Test-only `HF_TEST_FILE_SWEEP_DELAY_MS` (honored only with `HF_MOCK_PROVIDER=1`, else null): the boot delay and
  // the check interval.
  const testDelayMs = deps.env.testFileSweepDelayMs
  // `deps.*` services are read when a member runs, never while the deps are being built.
  const cleanupContext = (): CleanupContext => ({
    deps,
    now,
    pluginDataBudget: { ...PLUGIN_DATA_SCAN_BUDGET, ...options.pluginDataBudget },
    logger,
  })
  const autoSweep = createAutoSweep({
    now,
    background: options.background ?? !isVitest(),
    bootDelayMs: testDelayMs ?? SWEEP_BOOT_DELAY_MS,
    checkIntervalMs: testDelayMs ?? SWEEP_CHECK_INTERVAL_MS,
    busyRetryMs: SWEEP_BUSY_RETRY_MS,
    readMode: async () => (await deps.settings.get()).fileSweep,
    readState: () => readSweepState(deps),
    run: signal => attemptAutoSweep(cleanupContext(), signal),
    logger,
  })

  return {
    autoSweep,

    summary: () => dataSummary(deps, logger, autoSweep.status),

    exportBackup: async (query) => {
      const plan = await planBackup(deps, query, limits, now())
      return { filename: backupFilename(plan.exportedAt), exportedAt: plan.exportedAt, stream: createBackupStream(deps, plan) }
    },

    importData: (upload, form = {}) => deps.maintenance.exclusive('import', () => importUpload(deps, upload, form, limits)),

    deleteAll: async (body: DataDeleteBody, sensitive?: SensitiveOperationOptions) => {
      sensitive?.requireFreshAuth()
      if (body.confirm !== 'DELETE')
        throw validationError([{ path: ['confirm'], message: 'Type DELETE to confirm.', code: 'custom' }])
      return deps.maintenance.exclusive('delete-all', () => deleteEverything(deps, body))
    },

    cleanupPreview: () => deps.maintenance.exclusive('file-cleanup', () => previewCleanup(cleanupContext(), autoSweep.status)),

    cleanup: () => deps.maintenance.exclusive('file-cleanup', () => runCleanup(cleanupContext())),

    start: async () => {
      if (testDelayMs !== null)
        logger.info('automatic file sweep checks use the test delay', { delayMs: testDelayMs })
      autoSweep.start()
    },

    stop: () => autoSweep.stop(),
  }
}
