import type { DataImportResult, DataSummary } from '@harness-forge/shared'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearStoredChatState,
  countLabel,
  deleteDescription,
  deletedMessage,
  exceedsImportLimit,
  EXPORT_LIMIT_WARNING,
  filesLabel,
  importAnnouncement,
  importFileProblem,
  importFilesLine,
  importHeadline,
  importItemLink,
  importItemTitle,
  importKindOf,
  isBusyConflict,
  summaryLine,
} from './data'

// data.ts reads the storage key of the chats store, whose module imports the Nuxt-bound API composable.
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return { chats: 12, archivedChats: 2, messages: 348, files: 18, fileBytes: 25_480_000, ...overrides }
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
