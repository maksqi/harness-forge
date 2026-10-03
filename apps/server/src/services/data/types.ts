// Frozen interface of bulk data (ADR-024, API.md 4.16 / 5.19, ARCHITECTURE.md 6.9). Implementation:
// `createDataService(deps)` in `services/data/index.ts` (W5.3). Consumer: the data routes (`http/routes/data.ts`, W5.3).
// Built on `ChatsService` (`allIds`, `export`, `find`, `importChat`, `removeAll`), `FilesService` (`get`, `open`,
// `importFile`, `purge`; Phase 7: `sweep`), the settings service, `ChatRunner.stop` and (Phase 7) the maintenance lock
// (`MaintenanceService.exclusive`). Test double: `createFakeDataService` (`testing/fakes.ts`). Phase 8 (C19): `start` /
// `stop` for the automatic file sweep (ADR-039, W8.7), the last step of `startDeps` and the first of `stopDeps`.
import type {
  DataCleanupPreview,
  DataCleanupResult,
  DataDeleteBody,
  DataDeleteResult,
  DataExportQuery,
  DataImportForm,
  DataImportResult,
  DataSummary,
} from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../../types.ts'

/** A backup zip being produced for `GET /data/export`. */
export interface DataBackup {
  /** `harness-forge-backup-<yyyy-mm-dd>.zip` (UTC date of `exportedAt`), for `Content-Disposition: attachment`. */
  filename: string
  /** When the export started: the manifest's `exportedAt` and the mtime of every entry. */
  exportedAt: number
  /**
   * The zip, built while it is read: each pull adds one chat or one 64 KB chunk of a file, and `manifest.json` (with
   * the exact counts) comes last. Nothing is read before the first pull, so a `cancel()` right away (a `HEAD` request)
   * costs only the pre-check; a cancel at any point (the client went away) stops the export and releases every file.
   */
  stream: ReadableStream<Uint8Array>
}

/**
 * Summary, streamed backup export, import of a backup zip or one chat JSON, delete-all and (Phase 7) the orphaned file
 * cleanup. Imports, delete-all and cleanups run under the maintenance lock (`maintenance.exclusive('import' |
 * 'delete-all' | 'file-cleanup', ...)`, also taken by the key rotation): while another maintenance operation runs they
 * fail at once with `conflict` (`reason: 'busy'`); the summary and exports never wait for it. No new server event types:
 * imports emit `chat.created` and delete-all `chat.deleted`, one per chat (through `ChatsService`); a cleanup emits
 * nothing.
 */
export interface DataService {
  /** `GET /data`: every chat (archived included), the archived ones, every message version, file rows and their bytes. */
  readonly summary: () => Promise<DataSummary>
  /**
   * `GET /data/export` (`files` and `settings` default to true): every chat as its JSON export (version 2,
   * `chats/<chatId>.json`), the attachments referenced by message parts (`files/index.json` + one `files/<sha256>` blob
   * per content, with `files`), the public settings (`settings.json`, with `settings`) and `manifest.json` last; every
   * entry mode 0644 with mtime = `exportedAt`. Never secrets, credentials, the password, plugins, MCP servers, model or
   * tool preferences, share links or usage rows. A pre-check before anything is streamed throws `payload_too_large`
   * (the message suggests `files=false` when that would fit) when the zip would exceed 3.5 GiB or
   * `LIMITS.backupEntriesMax` entries (50,000: every export stays importable; fflate writes no zip64).
   */
  readonly exportBackup: (query: DataExportQuery) => Promise<DataBackup>
  /**
   * `POST /data/import`: `upload` is the multipart part `file` (a `File`; any `Blob` in tests), at most
   * `LIMITS.backupImportBytes` (`payload_too_large`). Its first bytes decide: `PK` = a backup zip (read lazily with the
   * plugin installer's zip guards, a single top-level folder accepted, a newer manifest version refused), `{` = one
   * chat JSON export (`ChatExportAny`); anything else, a guard violation, a missing manifest or an invalid chat JSON is
   * a `validation_error`. `options` are the parsed form fields (defaults `onConflict: 'skip'`,
   * `restoreSettings: false`). Chats are imported one at a time through `ChatsService.importChat` (`skip`: an existing
   * chat id is left alone, so the same import twice changes nothing; `copy`: new ids and " (imported)" appended to the
   * title), after their attachments (`FilesService.importFile`, part URLs rewritten, missing blobs counted); one failing
   * chat never stops the others (`status: 'failed'` + a safe `error`). With `restoreSettings` only the known settings
   * keys are applied, each validated on its own (invalid ones become warnings). `conflict` (`reason: 'busy'`).
   */
  readonly importData: (upload: Blob, options?: DataImportForm) => Promise<DataImportResult>
  /**
   * `POST /data/delete` (fresh auth: the route table flags the route; when `options` is given, `requireFreshAuth()` is
   * called again before anything is deleted). `body` is the validated `DataDeleteBody` (`confirm: 'DELETE'` is checked
   * again: else `validation_error`). Stops every run (`ChatRunner.stop` for every id of `ChatsService.allIds()`,
   * `preparing` runs included), deletes every chat with its messages and share links (`ChatsService.removeAll`, every
   * usage row too with `usage: true`), with `files: true` every uploaded file (`FilesService.purge`), then stops any run
   * whose chat appeared meanwhile. Settings, providers, credentials, plugins and MCP servers stay. `conflict`
   * (`reason: 'busy'`).
   */
  readonly deleteAll: (body: DataDeleteBody, options?: SensitiveOperationOptions) => Promise<DataDeleteResult>

  // ----- Phase 7: orphaned file cleanup (ADR-035, ARCHITECTURE.md 6.15), types C16, implementation W7.8

  /**
   * `GET /data/cleanup`: a dry run under `maintenance.exclusive('file-cleanup', ...)` (no run blocking): collects the
   * referenced file ids (`services/data/references.ts`), then `files.sweep({ referencedIds, createdBefore: now -
   * graceMs, dryRun: true })`; adds `graceMs` (24 h) and `lastRunAt` (`_files.lastCleanup`, null = never). `conflict`
   * (`reason: 'busy'`).
   */
  readonly cleanupPreview: () => Promise<DataCleanupPreview>
  /**
   * `POST /data/cleanup`: the same with `dryRun: false`; stores `_files.lastCleanup` = `ranAt` and logs the counts.
   * `conflict` (`reason: 'busy'`).
   */
  readonly cleanup: () => Promise<DataCleanupResult>

  // ----- Phase 8: the automatic file sweep (ADR-039, ARCHITECTURE.md 6.15), types C19, implementation W8.7

  /**
   * The last step of `startDeps`: schedules the automatic sweep's checks (a chained `setTimeout(...).unref()`: the first
   * at boot + 24 h, or `Env.testFileSweepDelayMs`, then hourly; each check re-reads the `fileSweep` setting and
   * `_files`) when `DataServiceOptions.background` is on (default, off under Vitest). Never runs a sweep at boot.
   */
  readonly start: () => Promise<void>
  /**
   * The first step of `stopDeps`: clears the timer and aborts a sweep in flight (`FileSweepInput.signal`, checked
   * between batches), then resolves; no check runs after it. Idempotent.
   */
  readonly stop: () => Promise<void>
}
