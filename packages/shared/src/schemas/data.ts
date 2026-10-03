// Bulk data DTOs (API.md section 4.16, ADR-024, ADR-035): the backup zip format and the bodies of `GET /data`,
// `GET /data/export`, `POST /data/import`, `POST /data/delete` and the orphaned file cleanup (`/data/cleanup`).
import { z } from 'zod'
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
  includes: z.object({ files: z.boolean(), settings: z.boolean() }),
  counts: z.object({ chats: countSchema, messages: countSchema, files: countSchema, fileBytes: countSchema }),
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
})
export type DataSummary = z.infer<typeof dataSummarySchema>

/** Query of `GET /data/export`; both parts default to true. */
export const dataExportQuerySchema = z.object({
  /** Attachments referenced by message parts (`files/index.json` + `files/<sha256>`). */
  files: queryBooleanSchema.optional(),
  /** The public global settings (`settings.json`). */
  settings: queryBooleanSchema.optional(),
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
})
export type DataCleanupResult = z.infer<typeof dataCleanupResultSchema>
