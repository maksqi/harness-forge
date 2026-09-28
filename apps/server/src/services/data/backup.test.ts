// Backup export (W5.3-T2): layout, lazy pulls, manifest last, public settings only, secret scan, files=false, the zip
// limits of the pre-check, and blobs that went missing.
import type { BackupFileIndex, BackupManifest, FileRef } from '@harness-forge/shared'
import type { DataTestApp } from './fixtures.test-util.ts'
import { Buffer } from 'node:buffer'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backupManifestSchema, chatExportSchema, HarnessError, SETTINGS_KEYS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chats } from '../../db/schema.ts'
import { readAllBytes } from '../../testing/fakes.ts'
import { PNG, TEXT } from '../files/fixtures.test-util.ts'
import { backupFilename } from './backup.ts'
import {
  assistant,
  centralDirectory,
  chatId,
  closeDataApps,
  dataApp,
  dosDateTime,
  entryJson,
  exportBytes,
  filePart,
  sha256,
  treeChat,
  unzip,
  user,
} from './fixtures.test-util.ts'

afterEach(async () => {
  await closeDataApps()
})

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

/** Chat 1: a tree with an image and a text attachment; chat 2: archived, pinned, one message; chat 3: empty. */
async function seed(app: DataTestApp): Promise<{ png: FileRef, text: FileRef }> {
  const png = await upload(app, PNG, 'dot.png', 'image/png')
  const text = await upload(app, TEXT, 'notes.txt', 'text/plain')
  await app.deps.chats.create(treeChat(1, [filePart(png), filePart(text)]))
  await app.deps.chats.create({ id: chatId(2), title: 'Archived', messages: [user(201)] })
  await app.deps.chats.update(chatId(2), { archived: true, pinned: true })
  await app.deps.chats.create({ id: chatId(3) })
  // An upload no chat references is not part of the backup.
  await upload(app, new TextEncoder().encode('unreferenced\n'), 'loose.txt', 'text/plain')
  return { png, text }
}

describe('backup export', () => {
  it('writes the settings, every chat, each referenced blob once, the index and the manifest last', async () => {
    const exportedAt = Date.UTC(2026, 8, 28, 12, 30, 10)
    const app = await dataApp({ data: { now: () => exportedAt } })
    const { png, text } = await seed(app)
    // A second chat referencing the same image adds no blob.
    await app.deps.chats.create({ id: chatId(4), title: 'Again', messages: [user(401, 'again', [filePart(png)])] })

    const backup = await app.deps.data.exportBackup({})
    expect(backup.filename).toBe('harness-forge-backup-2026-09-28.zip')
    expect(backup.exportedAt).toBe(exportedAt)
    const zip = await readAllBytes(backup.stream)
    const records = centralDirectory(zip)
    expect(records.map(record => record.name)).toEqual([
      'settings.json',
      `chats/${chatId(1)}.json`,
      `chats/${chatId(2)}.json`,
      `chats/${chatId(3)}.json`,
      `chats/${chatId(4)}.json`,
      `files/${sha256(PNG)}`,
      `files/${sha256(TEXT)}`,
      'files/index.json',
      'manifest.json',
    ])
    const { dosDate, dosTime } = dosDateTime(exportedAt)
    for (const record of records) {
      // Unix host, regular file mode 0644, mtime = exportedAt.
      expect(record.versionMadeBy >> 8).toBe(3)
      expect(record.externalAttributes >>> 16).toBe(0o100644)
      expect(record).toMatchObject({ dosDate, dosTime })
      // Stored for images, deflated for text and JSON.
      expect(record.method).toBe(record.name === `files/${sha256(PNG)}` ? 0 : 8)
    }

    const entries = unzip(zip)
    expect(entries[`files/${sha256(PNG)}`]).toEqual(PNG)
    expect(entries[`files/${sha256(TEXT)}`]).toEqual(TEXT)
    expect(entryJson<BackupFileIndex>(entries, 'files/index.json').items).toEqual([png, text]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(ref => ({ id: ref.id, sha256: sha256(ref.id === png.id ? PNG : TEXT), name: ref.name, mime: ref.mime, size: ref.size, createdAt: expect.any(Number) })))

    const manifest = backupManifestSchema.parse(entryJson(entries, 'manifest.json'))
    expect(manifest).toEqual({
      format: 'harness-forge.backup',
      version: 1,
      exportedAt,
      appVersion: expect.any(String),
      chatExportVersion: 2,
      includes: { files: true, settings: true },
      counts: { chats: 4, messages: 6 + 1 + 0 + 1, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength },
    } satisfies BackupManifest)

    // Every chat entry is exactly its chat JSON export (v2), archived chats included.
    for (const n of [1, 2, 3, 4]) {
      const exported = chatExportSchema.parse(entryJson(entries, `chats/${chatId(n)}.json`))
      const direct = chatExportSchema.parse(JSON.parse((await app.deps.chats.export(chatId(n), 'json')).body))
      expect({ ...exported, exportedAt: 0 }).toEqual({ ...direct, exportedAt: 0 })
    }
    const archived = chatExportSchema.parse(entryJson(entries, `chats/${chatId(2)}.json`))
    expect(archived.chat).toMatchObject({ archived: true, pinned: true, title: 'Archived' })
    const tree = chatExportSchema.parse(entryJson(entries, `chats/${chatId(1)}.json`))
    expect(tree.chat.parentIds).toEqual([null, tree.chat.messages[0]!.id, tree.chat.messages[1]!.id, tree.chat.messages[2]!.id, null, tree.chat.messages[4]!.id])

    // Public settings only: exactly the settings keys, nothing internal.
    expect(Object.keys(entryJson<Record<string, unknown>>(entries, 'settings.json')).sort()).toEqual([...SETTINGS_KEYS].sort())
  })

  it('leaves out attachments with files=false and the settings with settings=false', async () => {
    const app = await dataApp()
    await seed(app)
    const entries = unzip(await exportBytes(app.deps, { files: false, settings: false }))
    expect(Object.keys(entries)).toEqual([`chats/${chatId(1)}.json`, `chats/${chatId(2)}.json`, `chats/${chatId(3)}.json`, 'manifest.json'])
    expect(entryJson<BackupManifest>(entries, 'manifest.json')).toMatchObject({
      includes: { files: false, settings: false },
      counts: { chats: 3, messages: 7, files: 0, fileBytes: 0 },
    })
    // An empty store: the index is still written (empty) with files=true.
    const empty = await dataApp()
    const bare = unzip(await exportBytes(empty.deps))
    expect(Object.keys(bare)).toEqual(['settings.json', 'files/index.json', 'manifest.json'])
    expect(entryJson(bare, 'files/index.json')).toEqual({ items: [] })
  })

  it('never contains a secret, a credential, the password, plugins, MCP servers or internal settings', async () => {
    const sentinels = {
      providerKey: 'sk-sentinel-provider-key-0001',
      pluginSecret: 'sentinel-plugin-secret-0002',
      mcpHeader: 'sentinel-mcp-header-0003',
      password: 'sentinel-password-0004',
      internal: 'sentinel-internal-setting-0005',
      envKey: 'sk-ant-sentinel-env-key-0006',
    }
    const app = await dataApp({ env: { ANTHROPIC_API_KEY: sentinels.envKey } })
    await seed(app)
    await app.deps.secrets.set('provider:openai', 'apiKey', sentinels.providerKey)
    await app.deps.secrets.set('plugin:sample-plugin', 'settings.token', sentinels.pluginSecret)
    await app.deps.secrets.set('mcp:everything', 'header.Authorization', sentinels.mcpHeader)
    await app.deps.passwords.set(sentinels.password)
    await app.deps.settings.setInternal('_probe.value', sentinels.internal)
    await app.deps.chats.addUsage({ chatId: chatId(1), messageId: null, purpose: 'chat', providerId: 'mock', modelId: 'echo', inputTokens: 7, outputTokens: 9, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 })

    const zip = await exportBytes(app.deps)
    const entries = unzip(zip)
    const haystacks = [Buffer.from(zip).toString('latin1'), ...Object.values(entries).map(bytes => Buffer.from(bytes).toString('utf8'))]
    for (const [name, value] of Object.entries(sentinels)) {
      for (const haystack of haystacks)
        expect(haystack.includes(value), name).toBe(false)
    }
    expect(Object.keys(entries).every(name => name === 'settings.json' || name === 'manifest.json' || name.startsWith('chats/') || name.startsWith('files/'))).toBe(true)
  })

  it('reads nothing before the first pull and one piece per pull; a cancel stops it and releases the files', async () => {
    let exports = 0
    const app = await dataApp({
      chats: chats => ({
        ...chats,
        export: async (id, format) => {
          exports += 1
          return chats.export(id, format)
        },
      }),
    })
    await seed(app)
    // Records the blob streams cancelled before their end.
    const cancelled: string[] = []
    const open = app.deps.files.open
    const opened = vi.spyOn(app.deps.files, 'open').mockImplementation(async (id) => {
      const file = await open(id)
      const source = file.stream.getReader()
      return {
        file: file.file,
        stream: new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            const chunk = await source.read()
            if (chunk.done)
              controller.close()
            else
              controller.enqueue(chunk.value)
          },
          cancel: async (reason) => {
            cancelled.push(id)
            await source.cancel(reason)
          },
        }),
      }
    })

    // HEAD: only the pre-check runs.
    const head = await app.deps.data.exportBackup({})
    await head.stream.cancel()
    expect(exports).toBe(0)
    expect(opened).not.toHaveBeenCalled()

    const backup = await app.deps.data.exportBackup({ settings: false })
    expect(exports).toBe(0)
    const reader = backup.stream.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(exports).toBe(1)
    await reader.cancel()
    expect(exports).toBe(1)
    expect(opened).not.toHaveBeenCalled()

    // One 64 KB chunk of a stored blob per pull; a cancel in the middle of the blob releases it.
    const big = new Uint8Array(300_000)
    big.set(PNG)
    const ref = await upload(app, big, 'big.png', 'image/png')
    await app.deps.chats.create({ id: chatId(9), messages: [user(901, 'big', [filePart(ref)])] })
    const partial = await app.deps.data.exportBackup({ settings: false })
    const partialReader = partial.stream.getReader()
    const exportsBefore = exports
    let blobChunks = 0
    while (blobChunks < 2) {
      const chunk = await partialReader.read()
      expect(chunk.done).toBe(false)
      if (opened.mock.calls.some(([id]) => id === ref.id))
        blobChunks += 1
    }
    expect(exports - exportsBefore).toBe(4)
    await partialReader.cancel()
    expect(cancelled).toContain(ref.id)
    expect((await app.deps.files.read(ref.id)).data).toEqual(big)
  })

  it('refuses in the pre-check a backup above the entry or byte limit, suggesting files=false when that helps', async () => {
    const app = await dataApp({ data: { limits: { backupEntries: 5 } } })
    await seed(app)
    // settings + 3 chats + manifest = 5 entries; the index and 2 blobs make 8.
    const entries = await rejection(app.deps.data.exportBackup({}))
    expect(entries).toMatchObject({ code: 'payload_too_large', details: { limitEntries: 5 } })
    expect(entries.message).toContain('files=false')
    expect(unzip(await exportBytes(app.deps, { files: false }))['manifest.json']).toBeDefined()
    // Without room for the chats either, the message does not suggest files=false.
    const tight = await dataApp({ data: { limits: { backupEntries: 2 } } })
    await seed(tight)
    const chatsOnly = await rejection(tight.deps.data.exportBackup({ files: false }))
    expect(chatsOnly.code).toBe('payload_too_large')
    expect(chatsOnly.message).not.toContain('files=false')

    const big = new TextEncoder().encode('x'.repeat(300_000))
    const sized = await dataApp({ data: { limits: { backupBytes: 250_000 } } })
    const ref = await upload(sized, big, 'big.txt', 'text/plain')
    await sized.deps.chats.create({ id: chatId(1), messages: [user(1, 'hi', [filePart(ref)])] })
    const bytes = await rejection(sized.deps.data.exportBackup({}))
    expect(bytes).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 250_000 } })
    expect(bytes.message).toContain('files=false')
    expect(unzip(await exportBytes(sized.deps, { files: false }))['manifest.json']).toBeDefined()
    // Unreferenced files never count.
    const loose = await dataApp({ data: { limits: { backupBytes: 250_000 } } })
    await upload(loose, big, 'big.txt', 'text/plain')
    expect(unzip(await exportBytes(loose.deps))['manifest.json']).toBeDefined()
  })

  it('leaves blobs that are missing or altered on disk out of the index, and chats deleted meanwhile out of the zip', async () => {
    const app = await dataApp({
      chats: chats => ({
        ...chats,
        export: async (id, format) => {
          if (id === chatId(3))
            await chats.remove(id)
          return chats.export(id, format)
        },
      }),
    })
    await seed(app)
    const pngBlob = join(app.t.env.paths.files, sha256(PNG).slice(0, 2), sha256(PNG))
    const textBlob = join(app.t.env.paths.files, sha256(TEXT).slice(0, 2), sha256(TEXT))
    rmSync(pngBlob)
    writeFileSync(textBlob, new Uint8Array(TEXT.byteLength).fill(0x61))
    const entries = unzip(await exportBytes(app.deps))
    expect(entries[`files/${sha256(PNG)}`]).toBeUndefined()
    expect(entryJson<BackupFileIndex>(entries, 'files/index.json').items).toEqual([])
    expect(Object.keys(entries).filter(name => name.startsWith('chats/'))).toEqual([`chats/${chatId(1)}.json`, `chats/${chatId(2)}.json`])
    expect(entryJson<BackupManifest>(entries, 'manifest.json').counts).toEqual({ chats: 2, messages: 7, files: 0, fileBytes: 0 })
    expect(app.t.logs.records.some(record => record.msg.includes('missing on disk'))).toBe(true)
    expect(app.t.logs.records.some(record => record.msg.includes('no longer matches'))).toBe(true)
  })

  it('names the file after the UTC date of the export', () => {
    expect(backupFilename(Date.UTC(2026, 0, 2, 23, 59))).toBe('harness-forge-backup-2026-01-02.zip')
  })

  it('exports the chats as they are when the stream is read', async () => {
    const app = await dataApp()
    await app.deps.chats.create({ id: chatId(1), title: 'One', messages: [user(1), assistant(2)] })
    const backup = await app.deps.data.exportBackup({ files: false, settings: false })
    await app.t.db.update(chats).set({ title: 'Renamed' }).where(eq(chats.id, chatId(1)))
    const entries = unzip(await readAllBytes(backup.stream))
    expect(chatExportSchema.parse(entryJson(entries, `chats/${chatId(1)}.json`)).chat.title).toBe('Renamed')
    expect(entryJson<BackupManifest>(entries, 'manifest.json').counts).toMatchObject({ chats: 1, messages: 2 })
  })

  it('fails the stream instead of ending a broken zip when reading a chat fails', async () => {
    const app = await dataApp({
      chats: chats => ({
        ...chats,
        export: async (id, format) => {
          if (id === chatId(2))
            throw new Error('disk on fire')
          return chats.export(id, format)
        },
      }),
    })
    await seed(app)
    const backup = await app.deps.data.exportBackup({})
    await expect(readAllBytes(backup.stream)).rejects.toThrow('disk on fire')
    expect(app.t.logs.records.some(record => record.msg === 'backup export failed')).toBe(true)
  })
})
