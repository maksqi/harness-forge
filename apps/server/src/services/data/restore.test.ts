// Import (W5.3-T4): round trip into another server, skip / copy, attachment remapping, the zip guards, per-chat
// failures, single chat JSON (v1 / v2), settings restore, events and the mutex.
import type { BackupFileEntry, BackupManifest, ChatExportV1, ChatExportV2, DataImportResult, FileRef, HarnessUIMessage } from '@harness-forge/shared'
import type { DataTestApp } from './fixtures.test-util.ts'
import { chatExportSchema, dataImportResultSchema, DEFAULT_SETTINGS, HarnessError, LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, files } from '../../db/schema.ts'
import { patchZip, unixMode, zipOf } from '../../plugins/install/testing.ts'
import { PNG, TEXT } from '../files/fixtures.test-util.ts'
import {
  assistant,
  chatId,
  closeDataApps,
  dataApp,
  exportBytes,
  filePart,
  mid,
  sha256,
  treeChat,
  unzip,
  user,
} from './fixtures.test-util.ts'
import { copyTitle } from './restore.ts'

afterEach(async () => {
  await closeDataApps()
})

const ZERO_TOTALS = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

async function upload(app: DataTestApp, bytes: Uint8Array, name: string, type: string): Promise<FileRef> {
  return app.deps.files.upload(new File([new Uint8Array(bytes)], name, { type }))
}

async function importBytes(app: DataTestApp, bytes: Uint8Array | string, form: Parameters<DataTestApp['deps']['data']['importData']>[1] = {}): Promise<DataImportResult> {
  return dataImportResultSchema.parse(await app.deps.data.importData(new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]), form))
}

function exportOf(id: string, messages: HarnessUIMessage[], chat: Partial<ChatExportV2['chat']> = {}): ChatExportV2 {
  return {
    format: 'harness-forge.chat',
    version: 2,
    exportedAt: 5,
    chat: {
      id,
      title: 'Imported chat',
      titleSource: 'user',
      modelRef: 'mock:echo',
      pinned: false,
      archived: false,
      running: false,
      pendingApproval: false,
      createdAt: 10,
      updatedAt: 20,
      settings: {},
      totals: ZERO_TOTALS,
      messages,
      parentIds: messages.map((_message, index) => messages[index - 1]?.id ?? null),
      activeLeafId: messages.at(-1)?.id ?? null,
      ...chat,
    },
  }
}

function manifestOf(chatCount: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'harness-forge.backup',
    version: 1,
    exportedAt: 5,
    appVersion: '1.1.0',
    chatExportVersion: 2,
    includes: { files: true, settings: false },
    counts: { chats: chatCount, messages: 0, files: 0, fileBytes: 0 },
    ...overrides,
  } satisfies Partial<BackupManifest> | Record<string, unknown>
}

/** A zip of the given entries: objects are written as JSON. */
function backupZip(entries: Record<string, unknown>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(entries))
    zippable[name] = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  return zipSync(zippable, { level: 6 })
}

function exportIds(exported: ChatExportV2): string[] {
  return exported.chat.messages.map(message => message.id)
}

async function chatExport(app: DataTestApp, id: string): Promise<ChatExportV2> {
  return chatExportSchema.parse(JSON.parse((await app.deps.chats.export(id, 'json')).body))
}

/** Parts of every message of a chat that point at files. */
async function fileUrls(app: DataTestApp, id: string): Promise<string[]> {
  return (await app.deps.chats.listMessages(id)).flatMap(message => message.parts.flatMap(part => (part.type === 'file' ? [part.url] : [])))
}

describe('import of a backup zip', () => {
  it('restores every chat into another server: ids, versions, active leaf, flags, dates and attachment bytes', async () => {
    const source = await dataApp()
    const png = await upload(source, PNG, 'dot.png', 'image/png')
    const text = await upload(source, TEXT, 'notes.txt', 'text/plain')
    await source.deps.chats.create(treeChat(1, [filePart(png)]))
    await source.deps.chats.create({ id: chatId(2), title: 'Archived', messages: [user(201, 'see', [filePart(text), filePart(png)]), assistant(202)] })
    await source.deps.chats.update(chatId(2), { archived: true, pinned: true })
    await source.t.db.update(chats).set({ createdAt: 1000, updatedAt: 2000 }).where(eq(chats.id, chatId(2)))
    await source.deps.chats.create({ id: chatId(3) })
    const zip = await exportBytes(source.deps)

    const target = await dataApp()
    const result = await importBytes(target, zip)
    expect(result).toEqual({
      kind: 'backup',
      counts: { imported: 3, copied: 0, skipped: 0, failed: 0, filesImported: 2, filesReused: 0, filesMissing: 0 },
      settingsRestored: false,
      items: [
        { sourceId: chatId(1), chatId: chatId(1), title: 'Chat 1', status: 'imported' },
        { sourceId: chatId(2), chatId: chatId(2), title: 'Archived', status: 'imported' },
        { sourceId: chatId(3), chatId: chatId(3), title: null, status: 'imported' },
      ],
      warnings: [],
    })
    for (const n of [1, 2, 3]) {
      const before = await chatExport(source, chatId(n))
      const after = await chatExport(target, chatId(n))
      expect({ ...after, exportedAt: 0 }).toEqual({ ...before, exportedAt: 0 })
    }
    expect(await target.deps.chats.get(chatId(2))).toMatchObject({ archived: true, pinned: true, createdAt: 1000, updatedAt: 2000 })
    expect((await target.deps.chats.get(chatId(1))).branches).toEqual((await source.deps.chats.get(chatId(1))).branches)
    expect((await target.deps.files.read(png.id)).data).toEqual(PNG)
    expect((await target.deps.files.read(text.id)).data).toEqual(TEXT)
    expect(await target.deps.data.summary()).toEqual({ chats: 3, archivedChats: 1, messages: 8, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, checkpoints: { bytes: 0, blobs: 0 } })
    // One chat.created per chat, no other event.
    expect(target.events.events.map(event => event.type)).toEqual(['chat.created', 'chat.created', 'chat.created'])
    expect(target.events.ofType('chat.created').map(event => event.data.id)).toEqual([chatId(1), chatId(2), chatId(3)])

    // The same import again changes nothing.
    target.events.clear()
    const again = await importBytes(target, zip)
    expect(again.counts).toEqual({ imported: 0, copied: 0, skipped: 3, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 })
    expect(again.items.map(item => [item.status, item.chatId])).toEqual([['skipped', chatId(1)], ['skipped', chatId(2)], ['skipped', chatId(3)]])
    expect(target.events.events).toEqual([])
    expect(await target.deps.data.summary()).toMatchObject({ chats: 3, messages: 8, files: 2 })

    // copy: new chat and message ids, " (imported)" titles, the attachments reused.
    const copied = await importBytes(target, zip, { onConflict: 'copy' })
    expect(copied.counts).toEqual({ imported: 0, copied: 3, skipped: 0, failed: 0, filesImported: 0, filesReused: 2, filesMissing: 0 })
    expect(copied.items.map(item => item.title)).toEqual(['Chat 1 (imported)', 'Archived (imported)', null])
    for (const item of copied.items) {
      expect(item.status).toBe('copied')
      expect(item.chatId).not.toBe(item.sourceId)
    }
    const copy = await chatExport(target, copied.items[0]!.chatId!)
    const original = await chatExport(target, chatId(1))
    expect(exportIds(copy).some(id => exportIds(original).includes(id))).toBe(false)
    expect(copy.chat.parentIds.map(parent => (parent === null ? null : exportIds(copy).indexOf(parent))))
      .toEqual(original.chat.parentIds.map(parent => (parent === null ? null : exportIds(original).indexOf(parent))))
    expect(await fileUrls(target, copied.items[0]!.chatId!)).toEqual([png.url])
    expect(target.events.ofType('chat.created')).toHaveLength(3)
  })

  it('stores attachments under new ids when needed, reuses stored content and reports missing blobs', async () => {
    const source = await dataApp()
    const png = await upload(source, PNG, 'dot.png', 'image/png')
    const text = await upload(source, TEXT, 'notes.txt', 'text/plain')
    const other = await upload(source, new TextEncoder().encode('other content\n'), 'other.txt', 'text/plain')
    await source.deps.chats.create({ id: chatId(1), messages: [user(1, 'files', [filePart(png), filePart(text), filePart(other)])] })
    const entries = unzip(await exportBytes(source.deps))
    // The blob of `other` is lost.
    delete entries[`files/${sha256(new TextEncoder().encode('other content\n'))}`]

    const target = await dataApp()
    // The same PNG is already stored under another id; the id of the text file is taken by other content.
    const storedPng = await upload(target, PNG, 'mine.png', 'image/png')
    const taken = await upload(target, new TextEncoder().encode('taken\n'), 'taken.txt', 'text/plain')
    await target.t.db.update(files).set({ id: text.id }).where(eq(files.id, taken.id))

    const result = await importBytes(target, zipSync(entries))
    expect(result.counts).toMatchObject({ imported: 1, filesImported: 1, filesReused: 1, filesMissing: 1 })
    expect(result.warnings).toEqual(['1 attachment referenced by the imported chats is neither in the upload nor stored on this server.'])
    const urls = await fileUrls(target, chatId(1))
    expect(urls[0]).toBe(storedPng.url)
    expect(urls[1]).not.toBe(text.url)
    expect((await target.deps.files.read(urls[1]!.slice('/api/files/'.length))).data).toEqual(TEXT)
    expect((await target.deps.files.read(text.id)).data).toEqual(new TextEncoder().encode('taken\n'))
    // A missing attachment keeps its URL (it answers 404 here).
    expect(urls[2]).toBe(other.url)
  })

  it('accepts a single top-level folder, ignores macOS metadata and reports unknown entries', async () => {
    const source = await dataApp()
    await source.deps.chats.create({ id: chatId(1), title: 'Folder', messages: [user(1)] })
    const entries = unzip(await exportBytes(source.deps))
    const nested: Record<string, Uint8Array> = {}
    for (const [name, bytes] of Object.entries(entries))
      nested[`backup-2026/${name}`] = bytes
    nested['backup-2026/notes/readme.txt'] = new TextEncoder().encode('hello')
    nested['__MACOSX/backup-2026/._manifest.json'] = new TextEncoder().encode('meta')

    const target = await dataApp()
    const result = await importBytes(target, zipSync(nested))
    expect(result.counts.imported).toBe(1)
    expect(result.warnings).toEqual(['The unknown entry "backup-2026/notes/readme.txt" was ignored.'])
    expect((await target.deps.chats.get(chatId(1))).title).toBe('Folder')
  })

  it.each([
    ['a path traversal', () => zipOf({ 'manifest.json': JSON.stringify(manifestOf(0)), '../evil.json': '{}' }), '".." segment'],
    ['a symbolic link', () => zipOf({ 'manifest.json': JSON.stringify(manifestOf(0)), 'chats/link.json': ['/etc/passwd', unixMode(0o120777)] }), 'symbolic link'],
    ['a missing manifest', () => backupZip({ [`chats/${chatId(1)}.json`]: exportOf(chatId(1), [user(1)]) }), 'manifest.json is missing'],
    ['a newer manifest version', () => backupZip({ 'manifest.json': manifestOf(0, { version: 2 }) }), 'newer version of harness-forge'],
    ['a newer chat format', () => backupZip({ 'manifest.json': manifestOf(0, { chatExportVersion: 3 }) }), 'newer version of harness-forge'],
    ['another manifest format', () => backupZip({ 'manifest.json': { format: 'something-else', version: 1 } }), 'another format'],
    ['an invalid manifest', () => backupZip({ 'manifest.json': manifestOf(0, { counts: { chats: -1 } }) }), 'manifest.json is invalid'],
    ['a manifest that is not JSON', () => backupZip({ 'manifest.json': 'not json' }), 'not valid UTF-8 JSON'],
    ['an invalid file index', () => backupZip({ 'manifest.json': manifestOf(0), 'files/index.json': { items: [{ id: 'nope' }] } }), 'files/index.json is invalid'],
    ['a damaged zip', () => backupZip({ 'manifest.json': manifestOf(0) }).subarray(0, 40), 'zip'],
    ['an oversized manifest', () => patchZip(backupZip({ 'manifest.json': manifestOf(0) }), (view, central) => view.setUint32(central + 24, 2 * 1024 * 1024, true)), 'manifest.json is larger than 1 MB'],
    ['a damaged manifest', () => patchZip(backupZip({ 'manifest.json': manifestOf(0) }), (view, central) => view.setUint32(central + 16, 0xDEADBEEF, true)), 'fails its CRC check'],
  ])('refuses %s with 400 and imports nothing', async (_label, build, message) => {
    const app = await dataApp()
    const error = await rejection(app.deps.data.importData(new Blob([new Uint8Array(build())])))
    expect(error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['file'] }] } })
    expect(error.message).toContain(message)
    expect(await app.deps.data.summary()).toMatchObject({ chats: 0, files: 0 })
    expect(app.events.events).toEqual([])
  })

  it('refuses more entries than a backup may hold, and a backup that expands too much', async () => {
    const zip = backupZip({ 'manifest.json': manifestOf(3), ...Object.fromEntries([1, 2, 3].map(n => [`chats/${chatId(n)}.json`, exportOf(chatId(n), [user(n)])])) })
    const counted = await dataApp({ data: { limits: { backupEntries: 3 } } })
    expect((await rejection(counted.deps.data.importData(new Blob([new Uint8Array(zip)])))).message).toContain('more than 3 entries')
    const expanded = await dataApp({ data: { limits: { expandedBytes: 100 } } })
    expect(await rejection(expanded.deps.data.importData(new Blob([new Uint8Array(zip)])))).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 100 } })
    expect(await counted.deps.data.summary()).toMatchObject({ chats: 0 })
    expect(await expanded.deps.data.summary()).toMatchObject({ chats: 0 })
  })

  it('reports a failing chat and imports the others (damaged, bomb, oversized, invalid JSON, invalid tree)', async () => {
    const good = (n: number): [string, ChatExportV2] => [`chats/${chatId(n)}.json`, exportOf(chatId(n), [user(n * 10), assistant(n * 10 + 1)], { title: `Good ${n}` })]
    const padded = `${JSON.stringify(exportOf(chatId(3), [user(30)]))}${' '.repeat(50_000)}`
    const zip = backupZip(Object.fromEntries([
      ['manifest.json', manifestOf(7)],
      good(1),
      [`chats/${chatId(2)}.json`, exportOf(chatId(2), [user(20)])],
      [`chats/${chatId(3)}.json`, padded],
      [`chats/${chatId(4)}.json`, exportOf(chatId(4), [user(40)])],
      [`chats/${chatId(5)}.json`, '{"format": "harness-forge.chat", '],
      [`chats/${chatId(6)}.json`, exportOf(chatId(6), [user(60), assistant(61), user(62)], { parentIds: [null, mid(62), mid(61)] })],
      good(7),
    ]))
    // Entry order in the zip: manifest, chat 1 ... chat 7 (central records 1 .. 7).
    let damaged = patchZip(zip, (view, central) => view.setUint32(central + 16, 0xDEADBEEF, true), 2)
    damaged = patchZip(damaged, (view, central) => view.setUint32(central + 24, 1024, true), 3)
    damaged = patchZip(damaged, (view, central) => view.setUint32(central + 24, LIMITS.backupChatEntryBytes + 1, true), 4)

    const app = await dataApp()
    const result = await importBytes(app, damaged)
    expect(result.counts).toMatchObject({ imported: 2, failed: 5 })
    expect(result.items.map(item => [item.sourceId, item.status])).toEqual([
      [chatId(1), 'imported'],
      [chatId(2), 'failed'],
      [chatId(3), 'failed'],
      [chatId(4), 'failed'],
      [chatId(5), 'failed'],
      [chatId(6), 'failed'],
      [chatId(7), 'imported'],
    ])
    const errors = result.items.map(item => item.error ?? '')
    expect(errors[1]).toContain('fails its CRC check')
    expect(errors[2]).toContain('expands beyond its declared size')
    expect(errors[3]).toContain('larger than 64 MB')
    expect(errors[4]).toContain('not valid UTF-8 JSON')
    expect(errors[5]).toContain('chat.parentIds.1')
    expect(result.items[5]).toMatchObject({ title: 'Imported chat', chatId: null })
    expect(await app.deps.chats.allIds()).toEqual([chatId(1), chatId(7)])
    expect(app.events.ofType('chat.created').map(event => event.data.id)).toEqual([chatId(1), chatId(7)])
  })

  it('refuses attachments whose blob does not match its hash or whose type is not allowed, and imports the chat', async () => {
    const zipBytes = new TextEncoder().encode('PK not really a zip')
    const index: BackupFileEntry[] = [
      { id: 'file_0000000000000001', sha256: sha256(PNG), name: 'dot.png', mime: 'image/png', size: PNG.byteLength, createdAt: 1 },
      { id: 'file_0000000000000002', sha256: sha256(zipBytes), name: 'archive.zip', mime: 'application/zip', size: zipBytes.byteLength, createdAt: 2 },
    ]
    const message = user(1, 'files', [
      { type: 'file', mediaType: 'image/png', filename: 'dot.png', url: '/api/files/file_0000000000000001' },
      { type: 'file', mediaType: 'application/zip', filename: 'archive.zip', url: '/api/files/file_0000000000000002' },
    ])
    const zip = backupZip({
      'manifest.json': manifestOf(1),
      [`chats/${chatId(1)}.json`]: exportOf(chatId(1), [message]),
      'files/index.json': { items: index },
      // The PNG entry carries other bytes.
      [`files/${sha256(PNG)}`]: TEXT,
      [`files/${sha256(zipBytes)}`]: zipBytes,
    })
    const app = await dataApp()
    const result = await importBytes(app, zip)
    expect(result.counts).toMatchObject({ imported: 1, filesImported: 0, filesMissing: 2 })
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toMatch(/^The attachment "dot\.png" was not imported: .*sha256/)
    expect(result.warnings[1]).toMatch(/^The attachment "archive\.zip" was not imported: .*application\/zip.*not allowed/)
    expect(await app.deps.data.summary()).toMatchObject({ chats: 1, files: 0 })
  })

  it('restores the known settings on request, each validated on its own', async () => {
    const zip = backupZip({
      'manifest.json': manifestOf(0, { includes: { files: false, settings: true } }),
      'settings.json': { displayName: 'Restored', maxSteps: 0, textSize: 'lg', unknownKey: true, password: 'x' },
    })
    const app = await dataApp()
    const skipped = await importBytes(app, zip)
    expect(skipped.settingsRestored).toBe(false)
    expect(await app.deps.settings.get()).toEqual(DEFAULT_SETTINGS)

    const restored = await importBytes(app, zip, { restoreSettings: true })
    expect(restored.settingsRestored).toBe(true)
    expect(await app.deps.settings.get()).toEqual({ ...DEFAULT_SETTINGS, displayName: 'Restored', textSize: 'lg' })
    expect(restored.warnings).toEqual([
      'The setting "maxSteps" is invalid and was not restored.',
      'The unknown setting "unknownKey" was ignored.',
      'The unknown setting "password" was ignored.',
    ])

    const without = await importBytes(app, backupZip({ 'manifest.json': manifestOf(0) }), { restoreSettings: true })
    expect(without).toMatchObject({ settingsRestored: false, warnings: ['The backup has no settings.json, so no settings were restored.'] })
  })

  it('reports attachments of a backup exported without them that are not stored here', async () => {
    const source = await dataApp()
    const png = await upload(source, PNG, 'dot.png', 'image/png')
    await source.deps.chats.create({ id: chatId(1), messages: [user(1, 'x', [filePart(png)])] })
    const zip = await exportBytes(source.deps, { files: false })
    const target = await dataApp()
    const result = await importBytes(target, zip)
    expect(result.counts).toMatchObject({ imported: 1, filesMissing: 1 })
    expect(result.warnings).toEqual(['The backup was exported without attachments: 1 attachment of its chats is not stored on this server.'])
    // On the server that made it, the attachments are still stored: they are reused.
    await source.deps.chats.remove(chatId(1))
    const back = await importBytes(source, zip)
    expect(back.counts).toMatchObject({ imported: 1, filesReused: 1, filesMissing: 0 })
    expect(await fileUrls(source, chatId(1))).toEqual([png.url])
  })
})

describe('import of a single chat JSON', () => {
  const v1: ChatExportV1 = {
    format: 'harness-forge.chat',
    version: 1,
    exportedAt: 1,
    chat: {
      id: chatId(7),
      title: 'Old export',
      titleSource: 'user',
      modelRef: 'mock:echo',
      pinned: true,
      archived: false,
      running: false,
      pendingApproval: false,
      createdAt: 5,
      updatedAt: 6,
      settings: {},
      totals: ZERO_TOTALS,
      messages: [user(1), assistant(2), user(3)],
    },
  }

  it('imports version 1 as a linear chat and version 2 with its tree; skip and copy apply', async () => {
    const app = await dataApp()
    const first = await importBytes(app, JSON.stringify(v1))
    expect(first).toEqual({
      kind: 'chat',
      counts: { imported: 1, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 },
      settingsRestored: false,
      items: [{ sourceId: chatId(7), chatId: chatId(7), title: 'Old export', status: 'imported' }],
      warnings: [],
    })
    expect(await app.deps.chats.get(chatId(7))).toMatchObject({ pinned: true, createdAt: 5, updatedAt: 6, branches: {} })
    expect((await app.deps.chats.get(chatId(7))).messages.map(message => message.id)).toEqual([mid(1), mid(2), mid(3)])

    const tree = exportOf(chatId(8), [user(10, 'A'), assistant(11), user(12, 'A2')], { parentIds: [null, mid(10), null], activeLeafId: mid(11) })
    // A BOM and leading whitespace are fine.
    await importBytes(app, `\uFEFF \n${JSON.stringify(tree)}`)
    const detail = await app.deps.chats.get(chatId(8))
    expect(detail.messages.map(message => message.id)).toEqual([mid(10), mid(11)])
    expect(detail.branches).toEqual({ [mid(10)]: { siblings: [mid(10), mid(12)], index: 0 } })

    expect((await importBytes(app, JSON.stringify(tree))).items[0]).toMatchObject({ status: 'skipped', chatId: chatId(8) })
    const copy = await importBytes(app, JSON.stringify(tree), { onConflict: 'copy', restoreSettings: true })
    expect(copy.items[0]).toMatchObject({ status: 'copied', title: 'Imported chat (imported)' })
    expect(copy.items[0]!.chatId).not.toBe(chatId(8))
    expect(copy.warnings).toEqual(['Settings are restored only from a backup zip.'])
  })

  it('reuses attachments stored here and counts the others as missing', async () => {
    const app = await dataApp()
    const png = await upload(app, PNG, 'dot.png', 'image/png')
    const message = user(1, 'x', [filePart(png), { type: 'file', mediaType: 'image/png', filename: 'gone.png', url: '/api/files/file_0000000000000009' }])
    const result = await importBytes(app, JSON.stringify(exportOf(chatId(1), [message])))
    expect(result.counts).toMatchObject({ imported: 1, filesReused: 1, filesMissing: 1 })
    expect(result.warnings).toEqual(['1 attachment referenced by the imported chats is neither in the upload nor stored on this server.'])
  })

  it.each([
    ['not JSON', '{ nope', 'not valid UTF-8 JSON'],
    ['another format', JSON.stringify({ format: 'other', version: 1 }), 'not a harness-forge chat export'],
    ['a newer version', JSON.stringify({ format: 'harness-forge.chat', version: 3, chat: {} }), 'newer version'],
    ['an invalid export', JSON.stringify({ ...v1, chat: { ...v1.chat, id: 'not-a-chat-id' } }), 'chat.id'],
    ['an invalid tree', JSON.stringify(exportOf(chatId(1), [user(1), user(2)], { parentIds: [mid(2), null] })), 'chat.parentIds.0'],
    ['neither a zip nor JSON', 'hello world', 'backup zip or a chat JSON export'],
  ])('refuses %s with 400', async (_label, body, message) => {
    const app = await dataApp()
    const error = await rejection(app.deps.data.importData(new Blob([body])))
    expect(error.code).toBe('validation_error')
    expect(error.message).toContain(message)
    expect(await app.deps.data.summary()).toMatchObject({ chats: 0 })
  })

  it('refuses uploads above the import limit and chat JSON above the chat limit before reading them', async () => {
    const app = await dataApp()
    const huge = { size: LIMITS.backupImportBytes + 1, slice: () => new Blob(['{']) } as unknown as Blob
    expect(await rejection(app.deps.data.importData(huge))).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.backupImportBytes } })
    const bigChat = { size: LIMITS.backupChatEntryBytes + 1, slice: () => new Blob(['{']) } as unknown as Blob
    expect(await rejection(app.deps.data.importData(bigChat))).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.backupChatEntryBytes } })
  })
})

describe('import mutex', () => {
  it('refuses a second import or a delete-all while an import runs, and is released afterwards', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const app = await dataApp({
      chats: chats => ({
        ...chats,
        importChat: async (input) => {
          calls += 1
          await gate
          return chats.importChat(input)
        },
      }),
    })
    const body = JSON.stringify(exportOf(chatId(1), [user(1)]))
    const running = app.deps.data.importData(new Blob([body]))
    const busy = await rejection(app.deps.data.importData(new Blob([body])))
    expect(busy.toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    expect((await rejection(app.deps.data.deleteAll({ confirm: 'DELETE' }))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    // Summaries and exports never wait for it.
    expect(await app.deps.data.summary()).toMatchObject({ chats: 0 })
    expect(unzip(await exportBytes(app.deps))['manifest.json']).toBeDefined()
    release()
    expect((await running).counts.imported).toBe(1)
    expect(calls).toBe(1)

    // A failed import releases it too.
    await rejection(app.deps.data.importData(new Blob(['nope'])))
    expect((await importBytes(app, JSON.stringify(exportOf(chatId(2), [user(2)])))).counts.imported).toBe(1)
  })
})

describe('copyTitle', () => {
  it('appends " (imported)" within the title limit', () => {
    expect(copyTitle('Notes')).toBe('Notes (imported)')
    expect(copyTitle(null)).toBeNull()
    const long = copyTitle('x'.repeat(250))!
    expect(Array.from(long)).toHaveLength(200)
    expect(long.endsWith(' (imported)')).toBe(true)
    // Never splits a surrogate pair.
    const emoji = copyTitle('\u{1F600}'.repeat(199))!
    expect(Array.from(emoji)).toHaveLength(200)
    expect(emoji.startsWith('\u{1F600}'.repeat(189))).toBe(true)
  })
})
