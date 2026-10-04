// Bulk data DTOs (API.md section 4.16, ADR-024, ADR-035, ADR-039): the backup zip format and the bodies of `GET /data`,
// `GET /data/export`, `POST /data/import`, `POST /data/delete` and the orphaned file cleanup (`/data/cleanup`, manual or
// automatic). Phase 10 (ADR-044): backups also carry the personal agents, commands and skills (`customizations.json`,
// `backupCustomizationsSchema` in `customizations.ts`).
import { z } from 'zod'
import { fileSweepModeSchema } from '../enums.ts'
import { chatIdSchema, fileIdSchema, sha256HexSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { queryBooleanSchema } from './common.ts'

const countSchema = z.int().min(0)

// ---------- backup zip ----------

/** `manifest.json` of a backup zip; written last, so its counts are exact. */
export const backupManifestSchema = z.object({
  format: z.literal('harness-forge.backup'),
  /** A newer version is refused by the import. */
  version: z.literal(1),
  exportedAt: timestampSchema,
  /** harness-forge version that wrote the backup. */
  appVersion: z.string().max(64),
  /** `version` of every `chats/<chatId>.json` (`ChatExport`). */
  chatExportVersion: z.literal(2),
  /** `customizations` (Phase 10): the backup holds `customizations.json`; absent in older backups (= false). */
  includes: z.object({ files: z.boolean(), settings: z.boolean(), customizations: z.boolean().optional() }),
  /** `customizations` (Phase 10): the items of `customizations.json`; absent in older backups. */
  counts: z.object({ chats: countSchema, messages: countSchema, files: countSchema, fileBytes: countSchema, customizations: countSchema.optional() }),
})
export type BackupManifest = z.infer<typeof backupManifestSchema>

/** One item of `files/index.json`: an attachment referenced by a message part of the backup. */
export const backupFileEntrySchema = z.object({
  /** The file id of the part URLs (`/api/files/<id>`); remapped when the import stores the file under another id. */
  id: fileIdSchema,
  /** The blob entry is `files/<sha256>`; the import re-hashes the bytes against it. */
  sha256: sha256HexSchema,
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  size: z.int().min(0).max(LIMITS.uploadBytes),
  createdAt: timestampSchema,
})
export type BackupFileEntry = z.infer<typeof backupFileEntrySchema>

/** `files/index.json` of a backup zip. */
export const backupFileIndexSchema = z.object({
  items: z.array(backupFileEntrySchema).max(LIMITS.backupEntriesMax),
})
export type BackupFileIndex = z.infer<typeof backupFileIndexSchema>

// ---------- automatic file sweep (ADR-039) ----------

/** Outcome of an automatic sweep: `done`, `skipped` (nothing deleted) or `failed`. */
export const fileSweepAttemptStatusSchema = z.enum(['done', 'skipped', 'failed'])
export type FileSweepAttemptStatus = z.infer<typeof fileSweepAttemptStatusSchema>

/** Why an automatic sweep was skipped or failed: the plugin data scan went over its budget, or an error. */
export const fileSweepAttemptReasonSchema = z.enum(['plugin-data-limit', 'error'])
export type FileSweepAttemptReason = z.infer<typeof fileSweepAttemptReasonSchema>

/** The last automatic sweep (internal setting `_files.lastAutoSweep`). */
export const fileSweepAttemptSchema = z.object({
  at: timestampSchema,
  status: fileSweepAttemptStatusSchema,
  /** null when `done`. */
  reason: fileSweepAttemptReasonSchema.nullable(),
  /** File rows removed and disk bytes freed (0 unless `done`). */
  files: countSchema,
  diskBytes: countSchema,
})
export type FileSweepAttempt = z.infer<typeof fileSweepAttemptSchema>

/** State of the automatic sweep, in `GET /data` and `GET /data/cleanup`. */
export const fileSweepStatusSchema = z.object({
  /** The `fileSweep` setting. */
  mode: fileSweepModeSchema,
  /** The last automatic sweep; null = none yet. */
  lastAttempt: fileSweepAttemptSchema.nullable(),
  /** When the next automatic sweep is due (an estimate: the timer checks hourly); null when `mode` is `off`. */
  nextRunAt: timestampSchema.nullable(),
})
export type FileSweepStatus = z.infer<typeof fileSweepStatusSchema>

/**
 * How much of the plugin data folder (`<dataDir>/plugins/.data`) the reference scan read: `complete`, or `partial`
 * when it stopped at its budget (an automatic sweep is then skipped; a manual cleanup proceeds).
 */
export const pluginDataScanSchema = z.enum(['complete', 'partial'])
export type PluginDataScan = z.infer<typeof pluginDataScanSchema>

// ---------- routes ----------

/** `GET /data`: what a backup contains and what delete-all removes. */
export const dataSummarySchema = z.object({
  /** Every chat, archived ones included. */
  chats: countSchema,
  archivedChats: countSchema,
  /** Every message version. */
  messages: countSchema,
  /** Uploaded files (rows). */
  files: countSchema,
  /** Bytes of the uploaded files. */
  fileBytes: countSchema,
  /** The automatic file sweep (Phase 8, ADR-039). */
  fileSweep: fileSweepStatusSchema,
  /**
   * Stored before-states of workspace files (`<dataDir>/checkpoints`, ADR-036; never in a backup): their disk bytes and
   * blob count. Optional.
   */
  checkpoints: z.object({ bytes: countSchema, blobs: countSchema }).optional(),
})
export type DataSummary = z.infer<typeof dataSummarySchema>

/** Query of `GET /data/export`; every part defaults to true. */
export const dataExportQuerySchema = z.object({
  /** Attachments referenced by message parts (`files/index.json` + `files/<sha256>`). */
  files: queryBooleanSchema.optional(),
  /** The public global settings (`settings.json`). */
  settings: queryBooleanSchema.optional(),
  /** The personal agents, commands and skills (`customizations.json`, Phase 10). */
  customizations: queryBooleanSchema.optional(),
})
export type DataExportQuery = z.infer<typeof dataExportQuerySchema>

/** What an import does with a chat whose id already exists: keep the existing chat, or import a copy under new ids. */
export const dataConflictPolicySchema = z.enum(['skip', 'copy'])
export type DataConflictPolicy = z.infer<typeof dataConflictPolicySchema>

/** Multipart fields of `POST /data/import` next to the upload part `file` (not part of this schema, dropped by it). */
export const dataImportFormSchema = z.object({
  /** Default `skip`. */
  onConflict: dataConflictPolicySchema.optional(),
  /** Apply the known keys of the backup's `settings.json`; default false. */
  restoreSettings: queryBooleanSchema.optional(),
  /**
   * Restore the personal agents, commands and skills of the backup's `customizations.json` (Phase 10); default false. A
   * definition whose kind and name already exist is kept (skipped).
   */
  restoreCustomizations: queryBooleanSchema.optional(),
})
export type DataImportForm = z.infer<typeof dataImportFormSchema>

/** What was uploaded: a backup zip, or a single chat JSON export (version 1 or 2). */
export const dataImportKindSchema = z.enum(['backup', 'chat'])
export type DataImportKind = z.infer<typeof dataImportKindSchema>

export const dataImportStatusSchema = z.enum(['imported', 'copied', 'skipped', 'failed'])
export type DataImportStatus = z.infer<typeof dataImportStatusSchema>

/** The outcome for one chat of an import. */
export const dataImportItemSchema = z.object({
  /** The chat id in the upload. */
  sourceId: z.string().max(80),
  /** The stored chat: the same id (`imported`, `skipped`) or the new one (`copied`); null when it failed. */
  chatId: chatIdSchema.nullable(),
  title: z.string().nullable(),
  status: dataImportStatusSchema,
  /** Why the chat failed; safe to show. */
  error: z.string().max(500).optional(),
})
export type DataImportItem = z.infer<typeof dataImportItemSchema>

/** Response of `POST /data/import`. */
export const dataImportResultSchema = z.object({
  kind: dataImportKindSchema,
  counts: z.object({
    imported: countSchema,
    copied: countSchema,
    skipped: countSchema,
    failed: countSchema,
    /** Attachments stored by this import. */
    filesImported: countSchema,
    /** Attachments whose content was already stored. */
    filesReused: countSchema,
    /** Attachments referenced by a chat but missing from the backup. */
    filesMissing: countSchema,
  }),
  settingsRestored: z.boolean(),
  /**
   * Phase 10: what `restoreCustomizations` did with `customizations.json` (`imported` rows, `skipped` = the kind and
   * name already existed, `failed` = invalid content or the per-kind limit); absent when nothing was restored.
   */
  customizations: z.object({ imported: countSchema, skipped: countSchema, failed: countSchema }).optional(),
  items: z.array(dataImportItemSchema),
  /** Unknown entries, missing files, settings keys that failed validation, ... */
  warnings: z.array(z.string().max(300)).max(100),
})
export type DataImportResult = z.infer<typeof dataImportResultSchema>

/** Body of `POST /data/delete` (fresh auth). */
export const dataDeleteBodySchema = z.strictObject({
  /** Typed confirmation. */
  confirm: z.literal('DELETE'),
  /** Also delete every uploaded file (rows and blobs); default false. */
  files: z.boolean().optional(),
  /** Also delete the usage rows; default false (kept without a chat, as for `DELETE /chats/:id`). */
  usage: z.boolean().optional(),
})
export type DataDeleteBody = z.infer<typeof dataDeleteBodySchema>

/** Response of `POST /data/delete`: what was deleted. */
export const dataDeleteResultSchema = z.object({
  chats: countSchema,
  /** Every message version. */
  messages: countSchema,
  /** 0 unless `files: true`. */
  files: countSchema,
  fileBytes: countSchema,
  /** 0 unless `usage: true`. */
  usageRows: countSchema,
})
export type DataDeleteResult = z.infer<typeof dataDeleteResultSchema>

// ---------- orphaned file cleanup (ADR-035) ----------

/**
 * `GET /data/cleanup`: a dry run of the cleanup. Removable = file rows that no message, share, plugin value or setting
 * references and that are older than the grace period, blobs no row keeps, and stale temp files.
 */
export const dataCleanupPreviewSchema = z.object({
  /** Removable file rows and their bytes. */
  files: countSchema,
  fileBytes: countSchema,
  /** Blobs (`files/<aa>/<sha256>`) that would be deleted and the disk bytes they free. */
  blobs: countSchema,
  diskBytes: countSchema,
  /** Stale temp files (from interrupted uploads). */
  tempFiles: countSchema,
  /** Unreferenced files kept because they are younger than the grace period. */
  recentFiles: countSchema,
  /** The grace period (24 h). */
  graceMs: countSchema,
  /** Last cleanup; null = never. */
  lastRunAt: timestampSchema.nullable(),
  /** The automatic file sweep (Phase 8, ADR-039). */
  fileSweep: fileSweepStatusSchema,
  /** How much of the plugin data the reference scan read (Phase 8, ADR-039). */
  pluginData: pluginDataScanSchema,
})
export type DataCleanupPreview = z.infer<typeof dataCleanupPreviewSchema>

/** `POST /data/cleanup` (no body): what was removed. */
export const dataCleanupResultSchema = z.object({
  files: countSchema,
  fileBytes: countSchema,
  blobs: countSchema,
  diskBytes: countSchema,
  tempFiles: countSchema,
  ranAt: timestampSchema,
  /** How much of the plugin data the reference scan read (Phase 8, ADR-039). */
  pluginData: pluginDataScanSchema,
})
export type DataCleanupResult = z.infer<typeof dataCleanupResultSchema>
