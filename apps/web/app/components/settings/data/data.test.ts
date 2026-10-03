import type { DataImportResult, DataSummary } from '@harness-forge/shared'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataCleanupPreview, keyStatus } from '~/utils/testing/fixtures'
import {
  BUSY_MESSAGE,
  canRotateKey,
  cleanupConfirmText,
  cleanupHeadline,
  cleanupResultMessage,
  clearStoredChatState,
  conflictReason,
  countLabel,
  deleteDescription,
  deletedMessage,
  exceedsImportLimit,
  EXPORT_LIMIT_WARNING,
  FILE_SWEEP_INTERVALS,
  filesLabel,
  fileSweepIntervalLabel,
  fileSweepRemovedText,
  fileSweepState,
  graceLabel,
  hasRemovableFiles,
  importAnnouncement,
  importFileProblem,
  importFilesLine,
  importHeadline,
  importItemLink,
  importItemTitle,
  importKindOf,
  isBusyConflict,
  isFileSweepInterval,
  KEY_SOURCE_LABELS,
  keyRotatedDescription,
  recentFilesLine,
  ROTATE_KEY_COMMANDS,
  rotateEffects,
  secretsLabel,
  summaryLine,
} from './data'

// data.ts reads the storage key of the chats store, whose module imports the Nuxt-bound API composable.
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return { chats: 12, archivedChats: 2, messages: 348, files: 18, fileBytes: 25_480_000, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, ...overrides }
}

function importResult(counts: Partial<DataImportResult['counts']> = {}): DataImportResult {
  return {
    kind: 'backup',
    counts: { imported: 0, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0, ...counts },
    settingsRestored: false,
    items: [],
    warnings: [],
  }
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('summary texts', () => {
  it('reads like the wireframe, with singular forms and thousands separators', () => {
    expect(summaryLine(summary())).toBe('12 chats (2 archived) · 348 messages · 18 files, 24 MB')
    expect(summaryLine(summary({ chats: 1, archivedChats: 0, messages: 1, files: 1, fileBytes: 812 })))
      .toBe('1 chat · 1 message · 1 file, 812 B')
    expect(summaryLine(summary({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0 })))
      .toBe('0 chats · 0 messages · 0 files')
    expect(summaryLine(summary({ messages: 12_345 }))).toContain('12,345 messages')
  })

  it('labels counts and attachments', () => {
    expect(countLabel(1, 'chat')).toBe('1 chat')
    expect(countLabel(2, 'chat')).toBe('2 chats')
    expect(filesLabel(3, 2048)).toBe('3 files, 2 KB')
    expect(filesLabel(0, 0)).toBe('0 files')
  })

  it('flags attachments above the import limit', () => {
    expect(exceedsImportLimit(summary({ fileBytes: LIMITS.backupImportBytes }))).toBe(false)
    expect(exceedsImportLimit(summary({ fileBytes: LIMITS.backupImportBytes + 1 }))).toBe(true)
    expect(EXPORT_LIMIT_WARNING).toBe('This backup may be too large to import through the browser (limit 256 MB). Export without attachments, or copy the data directory to move a whole server.')
  })
})

describe('import file', () => {
  it('tells a chat JSON from a backup zip by name or type', () => {
    expect(importKindOf({ name: 'chat.json', type: '' })).toBe('chat')
    expect(importKindOf({ name: 'CHAT.JSON', type: '' })).toBe('chat')
    expect(importKindOf({ name: 'export', type: 'application/json; charset=utf-8' })).toBe('chat')
    expect(importKindOf({ name: 'harness-forge-backup-2026-09-28.zip', type: 'application/zip' })).toBe('backup')
    expect(importKindOf({ name: 'backup', type: '' })).toBe('backup')
  })

  it('refuses a file above 256 MB before the upload', () => {
    expect(importFileProblem({ size: LIMITS.backupImportBytes })).toBeNull()
    expect(importFileProblem({ size: LIMITS.backupImportBytes + 1 })).toBe('This file is larger than 256 MB.')
  })
})

describe('import result texts', () => {
  it('leaves out zero counts after the first', () => {
    expect(importHeadline(importResult({ imported: 1 }))).toBe('Imported 1 chat')
    expect(importHeadline(importResult({ skipped: 12 }))).toBe('Imported 0 chats · skipped 12')
    expect(importHeadline(importResult({ imported: 10, copied: 1, skipped: 2, failed: 1 })))
      .toBe('Imported 10 chats · copied 1 · skipped 2 · failed 1')
  })

  it('describes the attachments, or nothing when there were none', () => {
    expect(importFilesLine(importResult())).toBeNull()
    expect(importFilesLine(importResult({ filesImported: 2 }))).toBe('2 files')
    expect(importFilesLine(importResult({ filesImported: 15, filesReused: 3, filesMissing: 1 }))).toBe('18 files (3 reused, 1 missing)')
    expect(importFilesLine(importResult({ filesMissing: 2 }))).toBe('0 files (2 missing)')
  })

  it('announces the outcome once', () => {
    expect(importAnnouncement(importResult({ imported: 10, failed: 1 }))).toBe('Import finished: 10 imported, 1 failed')
    expect(importAnnouncement(importResult({ copied: 2, skipped: 3 }))).toBe('Import finished: 0 imported, 2 copied, 3 skipped')
  })

  it('titles and links the rows', () => {
    expect(importItemTitle({ title: 'Refactor auth flow' })).toBe('Refactor auth flow')
    expect(importItemTitle({ title: null })).toBe('Untitled chat')
    expect(importItemTitle({ title: '  ' })).toBe('Untitled chat')
    expect(importItemLink({ status: 'imported', chatId: 'abc' })).toBe('/chat/abc')
    expect(importItemLink({ status: 'copied', chatId: 'def' })).toBe('/chat/def')
    expect(importItemLink({ status: 'skipped', chatId: 'abc' })).toBeNull()
    expect(importItemLink({ status: 'failed', chatId: null })).toBeNull()
  })
})

describe('delete-all texts', () => {
  it('names what gets deleted', () => {
    expect(deleteDescription(summary())).toBe('This deletes 12 chats and 348 messages. It can\'t be undone; export a backup first if you might need them.')
    expect(deleteDescription(null)).toBe('This deletes every chat and message. It can\'t be undone; export a backup first if you might need them.')
    expect(deletedMessage({ chats: 1 })).toBe('Deleted 1 chat')
    expect(deletedMessage({ chats: 12 })).toBe('Deleted 12 chats')
  })
})

describe('errors', () => {
  it('recognizes the busy conflict', () => {
    expect(isBusyConflict(new HarnessError({ code: 'conflict', message: 'Busy', details: { reason: 'busy' } }))).toBe(true)
    expect(isBusyConflict(new HarnessError({ code: 'conflict', message: 'Running', details: { reason: 'run-active' } }))).toBe(false)
    expect(isBusyConflict({ error: { code: 'conflict', message: 'Busy', details: { reason: 'busy' } } })).toBe(true)
  })

  it('reads the reason of a conflict only', () => {
    expect(conflictReason(new HarnessError({ code: 'conflict', message: 'Env', details: { reason: 'env-key' } }))).toBe('env-key')
    expect(conflictReason(new HarnessError({ code: 'conflict', message: 'No reason' }))).toBeNull()
    expect(conflictReason(new HarnessError({ code: 'forbidden', message: 'Busy', details: { reason: 'busy' } }))).toBeNull()
    expect(conflictReason(new Error('boom'))).toBeNull()
  })

  it('names every maintenance task in the busy text (Phase 7)', () => {
    expect(BUSY_MESSAGE).toBe('Another data task is running. Try again when it finishes.')
  })
})

describe('storage cleanup texts', () => {
  it('says what a cleanup removes', () => {
    expect(cleanupHeadline(dataCleanupPreview({ files: 12, fileBytes: 50_331_648 }))).toBe('12 files · 48 MB can be removed')
    expect(cleanupHeadline(dataCleanupPreview({ files: 1, fileBytes: 2048, blobs: 1, tempFiles: 1 })))
      .toBe('1 file · 2 KB can be removed, and 2 leftover files on disk')
    expect(cleanupHeadline(dataCleanupPreview({ blobs: 1 }))).toBe('1 leftover file on disk can be removed')
    expect(cleanupHeadline(dataCleanupPreview({ recentFiles: 3 }))).toBe('No unused files.')
  })

  it('enables Remove only when something can be removed', () => {
    expect(hasRemovableFiles(dataCleanupPreview())).toBe(false)
    expect(hasRemovableFiles(dataCleanupPreview({ recentFiles: 4 }))).toBe(false)
    expect(hasRemovableFiles(dataCleanupPreview({ files: 1 }))).toBe(true)
    expect(hasRemovableFiles(dataCleanupPreview({ tempFiles: 1 }))).toBe(true)
  })

  it('mentions the recent files kept for the grace period', () => {
    expect(recentFilesLine(dataCleanupPreview())).toBeNull()
    expect(recentFilesLine(dataCleanupPreview({ recentFiles: 3 }))).toBe('3 recent files are kept for 24 hours.')
    expect(recentFilesLine(dataCleanupPreview({ recentFiles: 1 }))).toBe('1 recent file is kept for 24 hours.')
    expect(graceLabel(3_600_000)).toBe('1 hour')
    expect(graceLabel(0)).toBe('1 hour')
  })

  it('words the confirmation and the result', () => {
    expect(cleanupConfirmText(dataCleanupPreview({ files: 12, fileBytes: 50_331_648, blobs: 12 })))
      .toBe('This deletes 12 files (48 MB). It can\'t be undone.')
    expect(cleanupConfirmText(dataCleanupPreview({ blobs: 2, tempFiles: 1 }))).toBe('This deletes 3 leftover files on disk. It can\'t be undone.')
    const result = { files: 12, fileBytes: 50_331_648, blobs: 12, diskBytes: 50_331_648, tempFiles: 0, ranAt: 1, pluginData: 'complete' as const }
    expect(cleanupResultMessage(result)).toBe('Removed 12 files (48 MB)')
    expect(cleanupResultMessage({ ...result, files: 1, fileBytes: 812 })).toBe('Removed 1 file (812 B)')
    expect(cleanupResultMessage({ ...result, files: 0, fileBytes: 0, blobs: 1, tempFiles: 0 })).toBe('Removed 1 leftover file from disk')
    expect(cleanupResultMessage({ ...result, files: 0, fileBytes: 0, blobs: 0 })).toBe('No unused files.')
  })
})

describe('automatic cleanup texts', () => {
  const attempt = { at: 1, files: 4, diskBytes: 2 * 1024 * 1024, reason: null }

  it('offers Every day and Every week', () => {
    expect(FILE_SWEEP_INTERVALS.map(option => [option.value, option.label])).toEqual([['daily', 'Every day'], ['weekly', 'Every week']])
    expect(fileSweepIntervalLabel('weekly')).toBe('Every week')
    expect(isFileSweepInterval('daily')).toBe(true)
    expect(isFileSweepInterval('off')).toBe(false)
    expect(isFileSweepInterval(undefined)).toBe(false)
  })

  it('names the state of the status line: the last outcome, else never while on, else off', () => {
    expect(fileSweepState('off', { lastAttempt: null })).toBe('off')
    expect(fileSweepState('daily', { lastAttempt: null })).toBe('never')
    expect(fileSweepState('weekly', { lastAttempt: { ...attempt, status: 'done' } })).toBe('done')
    expect(fileSweepState('off', { lastAttempt: { ...attempt, status: 'failed', reason: 'error' } })).toBe('failed')
    expect(fileSweepState('daily', { lastAttempt: { ...attempt, status: 'skipped', reason: 'plugin-data-limit' } })).toBe('skipped')
  })

  it('words what a run removed', () => {
    expect(fileSweepRemovedText(attempt)).toBe('removed 4 files (2 MB).')
    expect(fileSweepRemovedText({ files: 1, diskBytes: 2048 })).toBe('removed 1 file (2 KB).')
  })
})

describe('encryption key texts', () => {
  it('labels the source and the secrets', () => {
    expect(KEY_SOURCE_LABELS.file).toBe('Key file in the data directory')
    expect(KEY_SOURCE_LABELS.env).toBe('HF_MASTER_KEY environment variable')
    expect(secretsLabel({ secrets: 4, unreadableSecrets: 0 })).toBe('4 encrypted')
    expect(secretsLabel({ secrets: 4, unreadableSecrets: 1 })).toBe('4 encrypted · 1 can\'t be read')
  })

  it('allows a rotation only for a key file that passes the key check', () => {
    expect(canRotateKey(null)).toBe(false)
    expect(canRotateKey(keyStatus())).toBe(true)
    expect(canRotateKey(keyStatus({ canRotate: false }))).toBe(false)
    expect(canRotateKey(keyStatus({ source: 'env' }))).toBe(false)
    expect(canRotateKey(keyStatus({ keyCheck: 'mismatch' }))).toBe(false)
    expect(canRotateKey(keyStatus({ keyCheck: 'unknown' }))).toBe(true)
  })

  it('lists the effects of a rotation, with the counts when known', () => {
    expect(rotateEffects(keyStatus({ shares: 3, pendingApprovals: 2 }))).toEqual([
      'Other browsers and devices are signed out; you stay signed in.',
      'Every share link changes (3 links): copy the new links from Shared links.',
      'Running replies stop and pending approvals expire (2 waiting).',
      'Older versions of harness-forge can\'t read the secrets afterwards: back up the data directory first.',
    ])
    expect(rotateEffects(keyStatus({ shares: 1 }))[1]).toBe('Every share link changes (1 link): copy the new links from Shared links.')
    expect(rotateEffects(null).slice(1, 3)).toEqual([
      'Every share link changes: copy the new links from Shared links.',
      'Running replies stop and pending approvals expire.',
    ])
  })

  it('words the rotation toast and the offline commands', () => {
    expect(keyRotatedDescription({ secrets: 4, approvalsExpired: 1 })).toBe('4 secrets encrypted again · 1 approval expired')
    expect(keyRotatedDescription({ secrets: 0, approvalsExpired: 0 })).toBe('0 secrets encrypted again · 0 approvals expired')
    expect(ROTATE_KEY_COMMANDS.map(item => item.command)).toEqual([
      'docker run --rm -v <volume>:/data -e HF_MASTER_KEY=<old> -e HF_NEW_MASTER_KEY=<new> harness-forge node apps/server/dist/main.mjs rotate-key',
      'HF_MASTER_KEY=<old> HF_NEW_MASTER_KEY=<new> pnpm key:rotate',
    ])
  })
})

describe('clearStoredChatState', () => {
  it('removes every composer draft and the unread marks, and nothing else', () => {
    sessionStorage.setItem('hf-composer-draft:one', 'draft one')
    sessionStorage.setItem('hf-composer-draft:two', 'draft two')
    sessionStorage.setItem('hf-other', 'kept')
    localStorage.setItem('hf-unread', '["one"]')
    localStorage.setItem('hf-theme', 'dark')

    clearStoredChatState()

    expect(sessionStorage.getItem('hf-composer-draft:one')).toBeNull()
    expect(sessionStorage.getItem('hf-composer-draft:two')).toBeNull()
    expect(sessionStorage.getItem('hf-other')).toBe('kept')
    expect(localStorage.getItem('hf-unread')).toBeNull()
    expect(localStorage.getItem('hf-theme')).toBe('dark')
  })
})
