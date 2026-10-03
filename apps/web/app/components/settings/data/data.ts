// Settings -> Data rules (docs/UI.md 2.7, 9.8, 7.4; docs/API.md 4.16, 5.19, 5.23; ADR-024, ADR-034, ADR-035): the
// summary and hint texts, the checks of an import file, the wording of an import result, the texts of the Storage
// cleanup and Encryption key sections, the errors that get special handling (busy, env-key, key-mismatch; fresh auth is
// useFreshAuth's) and the browser storage that delete-all clears (composer drafts, unread marks).
import type {
  DataCleanupPreview,
  DataCleanupResult,
  DataDeleteResult,
  DataImportItem,
  DataImportKind,
  DataImportResult,
  DataImportStatus,
  DataSummary,
  KeyRotationResult,
  KeySource,
  KeyStatus,
} from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { formatBytes } from '~/components/common/format'
import { COMPOSER_DRAFT_KEY_PREFIX } from '~/composables/useComposerDraft'
import { UNREAD_CHATS_KEY } from '~/stores/chats'
import { toHarnessError } from '~/utils/errors'

/** The typed confirmation of delete-all (`DataDeleteBody.confirm`); case-sensitive. */
export const DELETE_CONFIRMATION = 'DELETE'

/** Download name when the export response has no `Content-Disposition` file name. */
export const BACKUP_FILE_NAME = 'harness-forge-backup.zip'

/**
 * Toast of a `409 conflict` with `details.reason: 'busy'` (docs/UI.md 7.4, 15): an import, delete-all, key rotation or
 * file cleanup is running (they share one lock on the server, ADR-034, ADR-035).
 */
export const BUSY_MESSAGE = 'Another data task is running. Try again when it finishes.'

/** "256 MB": the upload limit of `POST /data/import` (`LIMITS.backupImportBytes`). */
export const IMPORT_LIMIT_LABEL = formatBytes(LIMITS.backupImportBytes)

/** Warning of the export while attachments are included and larger than the import limit. */
export const EXPORT_LIMIT_WARNING = `This backup may be too large to import through the browser (limit ${IMPORT_LIMIT_LABEL}). Export without attachments, or copy the data directory to move a whole server.`

/** What "Delete all data" may also remove (`DataDeleteBody` minus the confirmation). */
export interface DeleteAllOptions {
  files: boolean
  usage: boolean
}

/** "1 chat", "12 chats", "1,204 messages". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}

/** "18 files, 24 MB"; "0 files" without a size. */
export function filesLabel(files: number, bytes: number): string {
  return files > 0 ? `${countLabel(files, 'file')}, ${formatBytes(bytes)}` : countLabel(0, 'file')
}

/** The summary line: "12 chats (2 archived) · 348 messages · 18 files, 24 MB" (messages count every version). */
export function summaryLine(summary: DataSummary): string {
  const archived = summary.archivedChats > 0 ? ` (${summary.archivedChats.toLocaleString('en-US')} archived)` : ''
  return [
    `${countLabel(summary.chats, 'chat')}${archived}`,
    countLabel(summary.messages, 'message'),
    filesLabel(summary.files, summary.fileBytes),
  ].join(' · ')
}

/** True when the attachments alone exceed what the browser import accepts. */
export function exceedsImportLimit(summary: DataSummary): boolean {
  return summary.fileBytes > LIMITS.backupImportBytes
}

/** What an import file holds, from its name or type: a chat exported as JSON, else a backup zip. */
export function importKindOf(file: Pick<File, 'name' | 'type'>): DataImportKind {
  const type = file.type.split(';')[0]?.trim().toLowerCase()
  return file.name.toLowerCase().endsWith('.json') || type === 'application/json' ? 'chat' : 'backup'
}

/** Why a chosen file cannot be uploaded (checked before the upload), or null. */
export function importFileProblem(file: Pick<File, 'size'>): string | null {
  return file.size > LIMITS.backupImportBytes ? `This file is larger than ${IMPORT_LIMIT_LABEL}.` : null
}

/** Badge text of an import item. */
export const IMPORT_STATUS_LABELS: Record<DataImportStatus, string> = {
  imported: 'Imported',
  copied: 'Copied',
  skipped: 'Skipped',
  failed: 'Failed',
}

/** "Imported 10 chats · copied 1 · skipped 2 · failed 1"; zero counts after the first are left out. */
export function importHeadline(result: DataImportResult): string {
  const { imported, copied, skipped, failed } = result.counts
  const parts = [`Imported ${countLabel(imported, 'chat')}`]
  if (copied > 0)
    parts.push(`copied ${copied.toLocaleString('en-US')}`)
  if (skipped > 0)
    parts.push(`skipped ${skipped.toLocaleString('en-US')}`)
  if (failed > 0)
    parts.push(`failed ${failed.toLocaleString('en-US')}`)
  return parts.join(' · ')
}

/** "18 files (3 reused, 1 missing)" for the attachments of an import; null when it had none. */
export function importFilesLine(result: DataImportResult): string | null {
  const { filesImported, filesReused, filesMissing } = result.counts
  const stored = filesImported + filesReused
  if (stored === 0 && filesMissing === 0)
    return null
  const details: string[] = []
  if (filesReused > 0)
    details.push(`${filesReused.toLocaleString('en-US')} reused`)
  if (filesMissing > 0)
    details.push(`${filesMissing.toLocaleString('en-US')} missing`)
  return details.length > 0 ? `${countLabel(stored, 'file')} (${details.join(', ')})` : countLabel(stored, 'file')
}

/** Polite announcement of a finished import: "Import finished: 10 imported, 1 failed". */
export function importAnnouncement(result: DataImportResult): string {
  const { imported, copied, skipped, failed } = result.counts
  const parts = [`${imported} imported`]
  if (copied > 0)
    parts.push(`${copied} copied`)
  if (skipped > 0)
    parts.push(`${skipped} skipped`)
  if (failed > 0)
    parts.push(`${failed} failed`)
  return `Import finished: ${parts.join(', ')}`
}

/** The title of an imported chat ("Untitled chat" when it has none). */
export function importItemTitle(item: Pick<DataImportItem, 'title'>): string {
  return item.title?.trim() || 'Untitled chat'
}

/** Imported and copied chats link to their new place; skipped and failed ones do not. */
export function importItemLink(item: Pick<DataImportItem, 'status' | 'chatId'>): string | null {
  return (item.status === 'imported' || item.status === 'copied') && item.chatId ? `/chat/${item.chatId}` : null
}

/** Text of the delete-all dialog; without a summary the counts are left out. */
export function deleteDescription(summary: DataSummary | null): string {
  const what = summary
    ? `${countLabel(summary.chats, 'chat')} and ${countLabel(summary.messages, 'message')}`
    : 'every chat and message'
  return `This deletes ${what}. It can't be undone; export a backup first if you might need them.`
}

/** Toast after delete-all: "Deleted 12 chats". */
export function deletedMessage(result: Pick<DataDeleteResult, 'chats'>): string {
  return `Deleted ${countLabel(result.chats, 'chat')}`
}

/** The `details.reason` of a `409 conflict`, or null for any other error. */
export function conflictReason(error: unknown): string | null {
  const failure = toHarnessError(error)
  if (failure.code !== 'conflict')
    return null
  const reason = (failure.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : null
}

/** `409 conflict` because another maintenance task (import, delete-all, key rotation, file cleanup) is running. */
export function isBusyConflict(error: unknown): boolean {
  return conflictReason(error) === 'busy'
}

/**
 * Forgets the browser-side state of the deleted chats: every composer draft (`hf-composer-draft:*` in sessionStorage)
 * and the unread marks (`hf-unread` in localStorage). Missing or blocked storage is skipped.
 */
export function clearStoredChatState(): void {
  try {
    const session = globalThis.sessionStorage
    if (session) {
      const drafts: string[] = []
      for (let index = 0; index < session.length; index++) {
        const key = session.key(index)
        if (key?.startsWith(COMPOSER_DRAFT_KEY_PREFIX))
          drafts.push(key)
      }
      for (const key of drafts)
        session.removeItem(key)
    }
  }
  catch {
    // Blocked storage: nothing was stored there either.
  }
  try {
    globalThis.localStorage?.removeItem(UNREAD_CHATS_KEY)
  }
  catch {
    // Same as above.
  }
}

// ---------- Storage cleanup (docs/UI.md 9.8, ADR-035) ----------

/** Files on disk without a row (rowless blobs and stale temp files) that a cleanup removes too. */
export function leftoverFiles(counts: Pick<DataCleanupPreview, 'blobs' | 'tempFiles'>): number {
  return counts.blobs + counts.tempFiles
}

/** The check found something to remove: "Remove…" is enabled. */
export function hasRemovableFiles(preview: DataCleanupPreview): boolean {
  return preview.files > 0 || leftoverFiles(preview) > 0
}

/**
 * First line of the cleanup summary: "12 files · 48 MB can be removed" plus ", and 2 leftover files on disk";
 * "No unused files." when nothing can be removed.
 */
export function cleanupHeadline(preview: DataCleanupPreview): string {
  const leftovers = leftoverFiles(preview)
  if (preview.files === 0) {
    return leftovers > 0
      ? `${countLabel(leftovers, 'leftover file')} on disk can be removed`
      : 'No unused files.'
  }
  const removable = `${countLabel(preview.files, 'file')} · ${formatBytes(preview.fileBytes)} can be removed`
  return leftovers > 0 ? `${removable}, and ${countLabel(leftovers, 'leftover file')} on disk` : removable
}

/** "24 hours" for the grace period (whole hours; "1 hour" at least). */
export function graceLabel(graceMs: number): string {
  return countLabel(Math.max(1, Math.round(graceMs / 3_600_000)), 'hour')
}

/** "3 recent files are kept for 24 hours."; null when none are. */
export function recentFilesLine(preview: DataCleanupPreview): string | null {
  if (preview.recentFiles === 0)
    return null
  const verb = preview.recentFiles === 1 ? 'is' : 'are'
  return `${countLabel(preview.recentFiles, 'recent file')} ${verb} kept for ${graceLabel(preview.graceMs)}.`
}

/** Text of the cleanup confirmation, with the counts of the last check. */
export function cleanupConfirmText(preview: DataCleanupPreview): string {
  const what = preview.files > 0
    ? `${countLabel(preview.files, 'file')} (${formatBytes(preview.fileBytes)})`
    : `${countLabel(leftoverFiles(preview), 'leftover file')} on disk`
  return `This deletes ${what}. It can't be undone.`
}

/** Toast after a cleanup: "Removed 12 files (48 MB)". */
export function cleanupResultMessage(result: DataCleanupResult): string {
  if (result.files > 0)
    return `Removed ${countLabel(result.files, 'file')} (${formatBytes(result.fileBytes)})`
  const leftovers = leftoverFiles(result)
  return leftovers > 0 ? `Removed ${countLabel(leftovers, 'leftover file')} from disk` : 'No unused files.'
}

// ---------- Encryption key (docs/UI.md 9.8, ADR-034) ----------

/** The typed confirmation of a key rotation (`KeyRotateBody.confirm`); case-sensitive. */
export const ROTATE_CONFIRMATION = 'ROTATE' as const

/** "Source" row of the Encryption key section. */
export const KEY_SOURCE_LABELS: Record<KeySource, string> = {
  file: 'Key file in the data directory',
  env: 'HF_MASTER_KEY environment variable',
}

/** "Secrets" row: "4 encrypted", plus " · 1 can't be read" when some secrets fail the current key. */
export function secretsLabel(status: Pick<KeyStatus, 'secrets' | 'unreadableSecrets'>): string {
  const encrypted = `${status.secrets.toLocaleString('en-US')} encrypted`
  return status.unreadableSecrets > 0
    ? `${encrypted} · ${status.unreadableSecrets.toLocaleString('en-US')} can't be read`
    : encrypted
}

/** "Rotate key…" can run: the server says so, the key comes from `secret.key` and it passes the key check. */
export function canRotateKey(status: KeyStatus | null): boolean {
  return status !== null && status.canRotate && status.source === 'file' && status.keyCheck !== 'mismatch'
}

/** The destructive alert of a key-check mismatch. */
export const KEY_MISMATCH_MESSAGE = 'The master key doesn\'t match the stored secrets. Saved API keys can\'t be read. Restore the previous key (HF_MASTER_KEY or data/secret.key), or enter the keys again.'

/** The offline rotation of a key from `HF_MASTER_KEY` (docs/guides/using-projects.md 8): Docker, then a source checkout. */
export const ROTATE_KEY_COMMANDS = [
  {
    label: 'Docker',
    copyLabel: 'Copy the Docker command',
    command: 'docker run --rm -v <volume>:/data -e HF_MASTER_KEY=<old> -e HF_NEW_MASTER_KEY=<new> harness-forge node apps/server/dist/main.mjs rotate-key',
  },
  {
    label: 'Source checkout',
    copyLabel: 'Copy the source checkout command',
    command: 'HF_MASTER_KEY=<old> HF_NEW_MASTER_KEY=<new> pnpm key:rotate',
  },
] as const

/** The effects list of the rotate dialog; the counts are left out while the status is unknown. */
export function rotateEffects(status: KeyStatus | null): string[] {
  const links = status ? ` (${countLabel(status.shares, 'link')})` : ''
  const waiting = status ? ` (${status.pendingApprovals.toLocaleString('en-US')} waiting)` : ''
  return [
    'Other browsers and devices are signed out; you stay signed in.',
    `Every share link changes${links}: copy the new links from Shared links.`,
    `Running replies stop and pending approvals expire${waiting}.`,
    'Older versions of harness-forge can\'t read the secrets afterwards: back up the data directory first.',
  ]
}

/** Toast after a rotation: "Master key rotated" with "4 secrets encrypted again · 1 approval expired". */
export const KEY_ROTATED_TITLE = 'Master key rotated'

export function keyRotatedDescription(result: Pick<KeyRotationResult, 'secrets' | 'approvalsExpired'>): string {
  return `${countLabel(result.secrets, 'secret')} encrypted again · ${countLabel(result.approvalsExpired, 'approval')} expired`
}
