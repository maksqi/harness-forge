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
//   (runs are not blocked: the pins and the grace period cover them).
import type { DataDeleteBody, DataDeleteResult, DataSummary } from '@harness-forge/shared'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { DataLimits } from './limits.ts'
import type { DataService } from './types.ts'
import { validationError } from '@harness-forge/shared'
import { sql } from 'drizzle-orm'
import { chats, files, messages } from '../../db/schema.ts'
import { guardDb } from '../chats/db-errors.ts'
import { backupFilename, createBackupStream, planBackup } from './backup.ts'
import { fileSweepStatus, previewCleanup, runCleanup } from './cleanup.ts'
import { DATA_LIMITS } from './limits.ts'
import { importUpload } from './restore.ts'

export interface DataServiceOptions {
  /** Overrides of `DATA_LIMITS` (tests). */
  limits?: Partial<DataLimits>
  /** Clock of `exportedAt` and of the cleanup (its cutoff and `ranAt`; default `Date.now`). */
  now?: () => number
}

async function dataSummary(deps: AppDeps): Promise<DataSummary> {
  const { db } = deps
  // P8-A (W8.7): the real sweep status; W8.1 may add `checkpoints` (optional).
  const fileSweep = await fileSweepStatus(deps)
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
    }
  })
}

async function deleteEverything(deps: AppDeps, body: DataDeleteBody): Promise<DataDeleteResult> {
  const ids = await deps.chats.allIds()
  // `stop` also refuses runs that are still preparing, and waits until each run is released.
  await Promise.all(ids.map(id => deps.runs.stop(id)))
  const removed = await deps.chats.removeAll({ usage: body.usage === true })
  const purged = body.files === true ? await deps.files.purge() : { files: 0, bytes: 0 }
  // Runs of chats that appeared (or started) while everything was deleted.
  await Promise.all(removed.chatIds.filter(id => deps.runs.hasRun(id)).map(id => deps.runs.stop(id)))
  const result: DataDeleteResult = {
    chats: removed.chatIds.length,
    messages: removed.messages,
    files: purged.files,
    fileBytes: purged.bytes,
    usageRows: removed.usageRows,
  }
  deps.logger.info('data deleted', { ...result })
  return result
}

export function createDataService(deps: AppDeps, options: DataServiceOptions = {}): DataService {
  const limits: DataLimits = { ...DATA_LIMITS, ...options.limits }
  const now = options.now ?? Date.now

  return {
    summary: () => dataSummary(deps),

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

    cleanupPreview: () => deps.maintenance.exclusive('file-cleanup', () => previewCleanup(deps, now)),

    cleanup: () => deps.maintenance.exclusive('file-cleanup', () => runCleanup(deps, now)),
  }
}
