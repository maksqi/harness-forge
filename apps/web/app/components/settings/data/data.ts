// Settings -> Data rules (docs/UI.md 2.7, 9.8, 7.4; docs/API.md 4.16, 5.19; ADR-024): the summary and hint texts, the
// checks of an import file, the wording of an import result, the errors that get special handling (busy, fresh auth)
// and the browser storage that delete-all clears (composer drafts, unread marks).
import type {
  DataDeleteResult,
  DataImportItem,
  DataImportKind,
  DataImportResult,
  DataImportStatus,
  DataSummary,
} from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { formatBytes } from '~/components/common/format'
import { COMPOSER_DRAFT_KEY_PREFIX } from '~/composables/useComposerDraft'
import { UNREAD_CHATS_KEY } from '~/stores/chats'
import { toHarnessError } from '~/utils/errors'
import { rateLimitMessage } from '../login'

/** The typed confirmation of delete-all (`DataDeleteBody.confirm`); case-sensitive. */
export const DELETE_CONFIRMATION = 'DELETE'

/** Download name when the export response has no `Content-Disposition` file name. */
export const BACKUP_FILE_NAME = 'harness-forge-backup.zip'

/** Toast of a `409 conflict` with `details.reason: 'busy'` (docs/UI.md 7.4, 15). */
export const BUSY_MESSAGE = 'Another import or delete is running. Try again when it finishes.'

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

/** `409 conflict` because another import or delete-all is running. */
export function isBusyConflict(error: unknown): boolean {
  const failure = toHarnessError(error)
  const details = failure.details as { reason?: unknown } | undefined
  return failure.code === 'conflict' && details?.reason === 'busy'
}

/** `403 forbidden` + `action: 'login'`: the session is valid but not fresh (docs/UI.md 8.4). */
export function needsFreshAuth(error: unknown): boolean {
  const failure = toHarnessError(error)
  return failure.code === 'forbidden' && failure.action === 'login'
}

/** Text under the password field after `auth.login()` failed (docs/UI.md 9.7, 15). */
export function loginErrorText(error: unknown): string {
  const failure = toHarnessError(error)
  if (failure.code === 'unauthorized' || failure.code === 'forbidden')
    return 'Wrong password'
  if (failure.code === 'rate_limited')
    return rateLimitMessage((failure.retryAfterMs ?? 1000) / 1000)
  return failure.message
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
