// The orphaned file sweep of the files service (W7.8-T2, T3; ADR-035, ARCHITECTURE.md 6.15): candidates (grace, pins,
// references), the DELETE re-check, shared blobs, rowless blobs and temp files, the dry run, the store gate. Counts:
// `blobs` = leftover blobs without any row only; `diskBytes` = every byte freed (blobs of removed rows, leftovers, temp).
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FileSweepInput, FileSweepResult } from './types.ts'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFileId } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, files, messages } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { collectReferencedFileIds } from '../data/references.ts'
import { JPEG, PNG, TEXT } from './fixtures.test-util.ts'
import { createFilesService, fileUrl } from './index.ts'
import { FILE_CLEANUP_GRACE_MS } from './pins.ts'
import { blobPathOf, DAY_MS, HOUR_MS, seedStoredFile, setMtime, sha256Of, writeBlob } from './store.test-util.ts'

const apps: TestApp[] = []
let clock = 0

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

/** A test app whose files service runs on the test clock (`clock`, starting at the real time). */
async function storeApp(): Promise<TestApp> {
  clock = Date.now()
  const t = await createTestApp({ start: false, factories: { files: deps => createFilesService(deps, { now: () => clock }) } })
  apps.push(t)
  return t
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function sweep(t: TestApp, input: Partial<FileSweepInput> = {}): Promise<FileSweepResult> {
  return t.deps.files.sweep({ referencedIds: new Set(), createdBefore: clock - FILE_CLEANUP_GRACE_MS, dryRun: false, ...input })
}

async function rowIds(t: TestApp): Promise<string[]> {
  return (await t.db.select({ id: files.id }).from(files)).map(row => row.id).sort()
}

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

/** A chat with one user message whose file part points at `fileId` (written straight into the database). */
async function messageWithFile(t: TestApp, fileId: string): Promise<void> {
  await t.db.insert(chats).values({ id: CHAT_ID, settings: {} }).onConflictDoNothing()
  await t.db.insert(messages).values({
    id: 'msg_0000000000000001',
    chatId: CHAT_ID,
    seq: 1,
    role: 'user',
    parts: [{ type: 'file', mediaType: 'image/png', url: fileUrl(fileId) }],
  })
}

describe('file sweep: candidates', () => {
  it('removes old unreferenced rows and their blobs, keeps referenced and recent rows (grace period)', async () => {
    const t = await storeApp()
    const orphan = await seedStoredFile(t.deps, bytes('orphan'), { createdAt: clock - 3 * DAY_MS })
    const referenced = await seedStoredFile(t.deps, bytes('referenced'), { createdAt: clock - 3 * DAY_MS })
    const recent = await seedStoredFile(t.deps, bytes('recent'), { createdAt: clock - HOUR_MS })
    const result = await sweep(t, { referencedIds: new Set([referenced.id]) })
    expect(result).toEqual({ files: 1, fileBytes: 6, blobs: 0, diskBytes: 6, tempFiles: 0, recentFiles: 1 })
    expect(await rowIds(t)).toEqual([referenced.id, recent.id].sort())
    expect(existsSync(blobPathOf(t.deps, bytes('orphan')))).toBe(false)
    expect(existsSync(blobPathOf(t.deps, bytes('referenced')))).toBe(true)
    expect(existsSync(blobPathOf(t.deps, bytes('recent')))).toBe(true)
    // The cutoff is exclusive: a row created exactly at it is recent.
    await t.db.update(files).set({ createdAt: clock - DAY_MS }).where(eq(files.id, recent.id))
    expect((await sweep(t, { referencedIds: new Set([referenced.id]) })).recentFiles).toBe(1)
    expect(orphan.id).not.toBe(recent.id)
  })

  it('a dry run counts exactly what the run removes and deletes nothing', async () => {
    const t = await storeApp()
    await seedStoredFile(t.deps, bytes('a'), { createdAt: clock - 2 * DAY_MS })
    const kept = await seedStoredFile(t.deps, bytes('b'), { createdAt: clock - 2 * DAY_MS })
    // Same content as `kept`: the row goes, the blob stays.
    await seedStoredFile(t.deps, bytes('b'), { createdAt: clock - 2 * DAY_MS })
    const recent = await seedStoredFile(t.deps, bytes('c'), { createdAt: clock - HOUR_MS })
    const rowless = writeBlob(t.deps, bytes('rowless'), clock - 2 * DAY_MS)
    const temp = join(t.env.paths.files, sha256Of(bytes('a')).slice(0, 2), `.${sha256Of(bytes('a'))}.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`)
    writeFileSync(temp, 'partial')
    setMtime(temp, clock - 2 * HOUR_MS)
    const before = await rowIds(t)
    // Disk: the blob of `a` (1 byte), the rowless blob (7) and the temp file (7); `blobs` counts only the leftover.
    const expected = { files: 2, fileBytes: 2, blobs: 1, diskBytes: 1 + 7 + 7, tempFiles: 1, recentFiles: 1 }

    expect(await sweep(t, { referencedIds: new Set([kept.id]), dryRun: true })).toEqual(expected)
    expect(await rowIds(t)).toEqual(before)
    for (const path of [blobPathOf(t.deps, bytes('a')), blobPathOf(t.deps, bytes('b')), rowless, temp])
      expect(existsSync(path), path).toBe(true)

    expect(await sweep(t, { referencedIds: new Set([kept.id]) })).toEqual(expected)
    expect(await rowIds(t)).toEqual([kept.id, recent.id].sort())
    expect(existsSync(blobPathOf(t.deps, bytes('a')))).toBe(false)
    expect(existsSync(blobPathOf(t.deps, bytes('b')))).toBe(true)
    expect(existsSync(rowless)).toBe(false)
    expect(existsSync(temp)).toBe(false)
    // Nothing is left to remove.
    expect(await sweep(t, { referencedIds: new Set([kept.id]) })).toEqual({ files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 1 })
  })

  it('keeps a shared blob while another row uses it, and unlinks it once when its last rows go', async () => {
    const t = await storeApp()
    const content = bytes('shared content')
    const old = await seedStoredFile(t.deps, content, { createdAt: clock - 2 * DAY_MS })
    const young = await seedStoredFile(t.deps, content, { createdAt: clock - HOUR_MS })
    expect(await sweep(t)).toEqual({ files: 1, fileBytes: content.byteLength, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 1 })
    expect(await rowIds(t)).toEqual([young.id])
    expect(existsSync(blobPathOf(t.deps, content))).toBe(true)

    await t.db.update(files).set({ createdAt: clock - 2 * DAY_MS }).where(eq(files.id, young.id))
    const twin = await seedStoredFile(t.deps, content, { createdAt: clock - 3 * DAY_MS })
    expect(await sweep(t)).toEqual({ files: 2, fileBytes: 2 * content.byteLength, blobs: 0, diskBytes: content.byteLength, tempFiles: 0, recentFiles: 0 })
    expect(await rowIds(t)).toEqual([])
    expect(existsSync(blobPathOf(t.deps, content))).toBe(false)
    expect([old.id, twin.id]).not.toContain(young.id)
  })

  it('reads the rows in keyset batches and deletes them in chunks', async () => {
    const t = await storeApp()
    const content = bytes('one blob for many rows')
    writeBlob(t.deps, content)
    const rows = Array.from({ length: 1203 }, () => ({ id: createFileId(), sha256: sha256Of(content), name: 'many.bin', mime: 'application/octet-stream', size: content.byteLength, createdAt: clock - 2 * DAY_MS }))
    for (let index = 0; index < rows.length; index += 400)
      await t.db.insert(files).values(rows.slice(index, index + 400))
    const keep = new Set(rows.slice(0, 3).map(row => row.id))
    expect(await sweep(t, { referencedIds: keep, dryRun: true })).toMatchObject({ files: 1200, blobs: 0 })
    expect(await sweep(t, { referencedIds: keep })).toMatchObject({ files: 1200, fileBytes: 1200 * content.byteLength, blobs: 0 })
    expect(await rowIds(t)).toEqual([...keep].sort())
    expect(await sweep(t)).toMatchObject({ files: 3, blobs: 0, diskBytes: content.byteLength })
  })
})

describe('file sweep: pins and the store gate', () => {
  it('never removes an id upload, importFile or saveGenerated returned within the grace period', async () => {
    const t = await storeApp()
    // Old rows that a run reuses by content (never referenced yet), and an upload whose row is made old.
    const generated = await seedStoredFile(t.deps, PNG, { createdAt: clock - 5 * DAY_MS, mime: 'image/png', name: 'image-1.png' })
    const imported = await seedStoredFile(t.deps, TEXT, { createdAt: clock - 5 * DAY_MS, mime: 'text/plain', name: 'notes.txt' })
    expect((await t.deps.files.saveGenerated({ data: PNG, mediaType: 'image/png', name: 'again.png' })).id).toBe(generated.id)
    expect(await t.deps.files.importFile({ preferredId: imported.id, sha256: sha256Of(TEXT), name: 'notes.txt', mime: 'text/plain', data: TEXT, createdAt: 1 })).toMatchObject({ file: { id: imported.id }, reused: true })
    const uploaded = await t.deps.files.upload(new File([new Uint8Array(JPEG)], 'photo.jpg', { type: 'image/jpeg' }))
    await t.db.update(files).set({ createdAt: clock - 5 * DAY_MS }).where(eq(files.id, uploaded.id))

    const pinned = t.deps.files.pinnedIds()
    expect([...pinned].sort()).toEqual([generated.id, imported.id, uploaded.id].sort())
    expect(await sweep(t)).toEqual({ files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 3 })

    // A snapshot: later pins do not change it. After the grace period the pins expire and the rows go.
    clock += FILE_CLEANUP_GRACE_MS
    expect(t.deps.files.pinnedIds().size).toBe(0)
    expect(pinned.size).toBe(3)
    expect(await sweep(t)).toEqual({ files: 3, fileBytes: PNG.byteLength + TEXT.byteLength + JPEG.byteLength, blobs: 0, diskBytes: PNG.byteLength + TEXT.byteLength + JPEG.byteLength, tempFiles: 0, recentFiles: 0 })
    expect(await rowIds(t)).toEqual([])
  })

  it('keeps a row a run reused after the reference scan (the pinned reuse race)', async () => {
    const t = await storeApp()
    const old = await seedStoredFile(t.deps, PNG, { createdAt: clock - 3 * DAY_MS, mime: 'image/png', name: 'image-1.png' })
    // The scan runs first and finds no reference; then a run saves the same image (its message is not saved yet).
    const referencedIds = await collectReferencedFileIds(t.db)
    expect(referencedIds.has(old.id)).toBe(false)
    const saved = await t.deps.files.saveGenerated({ data: PNG, mediaType: 'image/png', name: 'image-1.png' })
    expect(saved.id).toBe(old.id)
    expect(await sweep(t, { referencedIds })).toMatchObject({ files: 0, recentFiles: 1 })
    expect((await t.deps.files.read(old.id)).data).toEqual(PNG)
  })

  it('waits for writes that hold the gate; a write that arrives during a sweep waits and gets a readable file', async () => {
    const t = await storeApp()
    const old = await seedStoredFile(t.deps, PNG, { createdAt: clock - 3 * DAY_MS, mime: 'image/png', name: 'image-1.png' })
    let release!: () => void
    const held = t.deps.files.withSharedGate(() => new Promise<string>((resolve) => {
      release = () => resolve('written')
    }))
    let swept = false
    const sweeping = sweep(t).then((result) => {
      swept = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(swept).toBe(false)
    release()
    expect(await held).toBe('written')
    expect(await sweeping).toMatchObject({ files: 1, blobs: 0, diskBytes: PNG.byteLength })

    // The sweep takes the gate when it is called: the save requested right after it waits, then stores a new row.
    const old2 = await seedStoredFile(t.deps, PNG, { createdAt: clock - 3 * DAY_MS, mime: 'image/png', name: 'image-1.png' })
    const second = sweep(t)
    const saving = t.deps.files.saveGenerated({ data: PNG, mediaType: 'image/png', name: 'image-2.png' })
    expect(await second).toMatchObject({ files: 1, blobs: 0, diskBytes: PNG.byteLength })
    const saved = await saving
    expect([old.id, old2.id]).not.toContain(saved.id)
    expect((await t.deps.files.read(saved.id)).data).toEqual(PNG)
    expect(await t.deps.files.withExclusiveGate(async () => 'alone')).toBe('alone')
  })

  it('purge holds the gate exclusively', async () => {
    const t = await storeApp()
    await t.deps.files.upload(new File([new Uint8Array(TEXT)], 'a.txt', { type: 'text/plain' }))
    let release!: () => void
    const held = t.deps.files.withSharedGate(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    let purged = false
    const purging = t.deps.files.purge().then((result) => {
      purged = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(purged).toBe(false)
    release()
    await held
    expect(await purging).toEqual({ files: 1, bytes: TEXT.byteLength })
  })
})

describe('file sweep: the DELETE re-check', () => {
  it('keeps a file whose message was committed after the reference scan', async () => {
    const t = await storeApp()
    const file = await seedStoredFile(t.deps, PNG, { createdAt: clock - 3 * DAY_MS, mime: 'image/png' })
    const referencedIds = await collectReferencedFileIds(t.db)
    expect(referencedIds.size).toBe(0)
    await messageWithFile(t, file.id)
    // The dry run trusts the scan; the real DELETE re-checks the message references in the same statement.
    expect(await sweep(t, { referencedIds, dryRun: true })).toMatchObject({ files: 1, blobs: 0, diskBytes: PNG.byteLength })
    expect(await sweep(t, { referencedIds })).toEqual({ files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 0 })
    expect(await rowIds(t)).toEqual([file.id])
    expect(readFileSync(blobPathOf(t.deps, PNG))).toEqual(Buffer.from(PNG))
  })
})

describe('file sweep: the store walk', () => {
  it('removes rowless blobs past the cutoff and temp files older than an hour; everything else stays', async () => {
    const t = await storeApp()
    const root = t.env.paths.files
    const old = clock - 2 * DAY_MS
    const rowlessOld = writeBlob(t.deps, bytes('rowless old'), old)
    const rowlessYoung = writeBlob(t.deps, bytes('rowless young'), clock - HOUR_MS)
    // A blob with a row of any age stays.
    await seedStoredFile(t.deps, bytes('with a row'), { createdAt: clock - HOUR_MS })
    setMtime(blobPathOf(t.deps, bytes('with a row')), old)
    const shard = sha256Of(bytes('rowless old')).slice(0, 2)
    const stale: string[] = []
    const kept: string[] = []
    const put = (path: string, mtime: number, list: string[]): void => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'x')
      setMtime(path, mtime)
      list.push(path)
    }
    put(join(root, shard, `.${sha256Of(bytes('a'))}.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`), clock - 2 * HOUR_MS, stale)
    put(join(root, shard, `.${sha256Of(bytes('b'))}.1f8fad5b-d9cb-469f-a165-70867728950e.tmp`), clock - 10 * 60 * 1000, kept)
    put(join(root, shard, `.${sha256Of(bytes('c'))}.not-a-uuid.tmp`), old, kept)
    put(join(root, shard, 'notes.txt'), old, kept)
    put(join(root, 'stray'), old, kept)
    put(join(root, 'zz', sha256Of(bytes('d'))), old, kept)
    const misplaced = sha256Of(bytes('misplaced'))
    put(join(root, misplaced.startsWith('00') ? '01' : '00', misplaced), old, kept)
    put(join(root, shard, sha256Of(bytes('upper')).toUpperCase()), old, kept)
    // A directory named like a blob, and (not on Windows) a symlink named like a blob pointing outside the store.
    mkdirSync(join(root, shard, `${shard}${'0'.repeat(62)}`), { recursive: true })
    const outside = join(t.env.dataDir, 'outside.txt')
    writeFileSync(outside, 'keep me')
    const linkSha = sha256Of(bytes('link'))
    if (process.platform !== 'win32') {
      mkdirSync(join(root, linkSha.slice(0, 2)), { recursive: true })
      symlinkSync(outside, join(root, linkSha.slice(0, 2), linkSha))
    }
    // Disk: the leftover blob and the stale temp file ('x'); the young row is recent.
    const expected = { files: 0, fileBytes: 0, blobs: 1, diskBytes: bytes('rowless old').byteLength + 1, tempFiles: 1, recentFiles: 1 }

    expect(await sweep(t, { dryRun: true })).toEqual(expected)
    for (const path of [rowlessOld, ...stale])
      expect(existsSync(path), path).toBe(true)

    expect(await sweep(t)).toEqual(expected)
    for (const path of [rowlessOld, ...stale])
      expect(existsSync(path), path).toBe(false)
    for (const path of [rowlessYoung, ...kept, blobPathOf(t.deps, bytes('with a row')), join(root, shard, `${shard}${'0'.repeat(62)}`)])
      expect(existsSync(path), path).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
  })

  it('answers zero counts when the store folder does not exist', async () => {
    const t = await storeApp()
    rmSync(t.env.paths.files, { recursive: true, force: true })
    expect(await sweep(t)).toEqual({ files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 0 })
  })
})

// ---------- Phase 8 (W8.7, ADR-039): `FileSweepInput.signal` ----------

/**
 * A signal whose state follows the sweep's checks: `throwIfAborted` throws `reason` from its call number `throwAt` on,
 * `aborted` is true from its call number `abortedAt` on (the DELETE chunks read `aborted`).
 */
function scriptedSignal(reason: Error, script: { throwAt?: number, abortedAt?: number }): AbortSignal & { checks: () => number } {
  let checks = 0
  let reads = 0
  return {
    get aborted() {
      reads += 1
      return script.abortedAt !== undefined && reads >= script.abortedAt
    },
    reason,
    throwIfAborted() {
      checks += 1
      if (script.throwAt !== undefined && checks >= script.throwAt)
        throw reason
    },
    checks: () => checks,
  } as unknown as AbortSignal & { checks: () => number }
}

async function manyOldRows(t: TestApp, count: number): Promise<Uint8Array> {
  const content = bytes('one blob for many rows')
  writeBlob(t.deps, content)
  const rows = Array.from({ length: count }, () => ({ id: createFileId(), sha256: sha256Of(content), name: 'many.bin', mime: 'application/octet-stream', size: content.byteLength, createdAt: clock - 2 * DAY_MS }))
  for (let index = 0; index < rows.length; index += 400)
    await t.db.insert(files).values(rows.slice(index, index + 400))
  return content
}

describe('file sweep: the abort signal (Phase 8)', () => {
  it('an aborted signal rejects at once with its reason: no gate, nothing deleted', async () => {
    const t = await storeApp()
    await seedStoredFile(t.deps, bytes('old orphan'), { createdAt: clock - 2 * DAY_MS })
    const controller = new AbortController()
    const reason = new Error('stopped')
    controller.abort(reason)
    // A shared holder would make a sweep wait: an aborted one never asks for the gate.
    let release!: () => void
    const holder = t.deps.files.withSharedGate(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    await expect(sweep(t, { signal: controller.signal })).rejects.toBe(reason)
    release()
    await holder
    expect(await rowIds(t)).toHaveLength(1)
  })

  it('stops between keyset batches before deleting anything', async () => {
    const t = await storeApp()
    await manyOldRows(t, 1203)
    const reason = new Error('stopped')
    // Checks: the service, the sweep, then one per batch of 500 rows: the third batch is never read.
    const signal = scriptedSignal(reason, { throwAt: 5 })
    await expect(sweep(t, { signal })).rejects.toBe(reason)
    expect(signal.checks()).toBe(5)
    expect(await rowIds(t)).toHaveLength(1203)
  })

  it('finishes the DELETE chunk in progress, then rejects: what was removed stays removed, the walk never runs', async () => {
    const t = await storeApp()
    const content = await manyOldRows(t, 1203)
    const rowless = writeBlob(t.deps, bytes('rowless old'), clock - 2 * DAY_MS)
    const reason = new Error('stopped')
    // The first chunk (500 ids) runs; the second sees the abort; the check after the chunks throws.
    const signal = scriptedSignal(reason, { abortedAt: 2, throwAt: 6 })
    await expect(sweep(t, { signal })).rejects.toBe(reason)
    expect(await rowIds(t)).toHaveLength(703)
    // 703 rows still share the blob; the leftover blob is untouched (the walk did not run).
    expect(existsSync(blobPathOf(t.deps, content))).toBe(true)
    expect(existsSync(rowless)).toBe(true)
  })
})
