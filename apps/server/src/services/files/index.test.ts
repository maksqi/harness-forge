import type { TestApp } from '../../testing/create-test-app.ts'
import type { FileImportInput } from './types.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileRefSchema, HarnessError, LIMITS } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeSolidPng } from '../../builtin-plugins/mock/png.ts'
import { files } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { GIF, JPEG, PDF, PNG, SVG, TEXT } from './fixtures.test-util.ts'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({ start: false })
})

afterEach(async () => {
  await t.close()
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function blobPath(bytes: Uint8Array): string {
  const hash = sha256(bytes)
  return join(t.env.paths.files, hash.slice(0, 2), hash)
}

/** Every regular file below the files root (temporary files included). */
function storedBlobs(): string[] {
  return readdirSync(t.env.paths.files, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
}

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

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe('files service', () => {
  it('stores an upload content-addressed with private permissions and returns a FileRef', async () => {
    const ref = await t.deps.files.upload(new File([PNG], 'dir/photo.png', { type: 'image/png' }))
    expect(fileRefSchema.parse(ref)).toEqual(ref)
    expect(ref).toMatchObject({ name: 'photo.png', mime: 'image/png', size: PNG.byteLength, url: `/api/files/${ref.id}` })
    const path = blobPath(PNG)
    expect(existsSync(path)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    }
    const [row] = await t.db.select().from(files)
    expect(row).toMatchObject({ id: ref.id, sha256: sha256(PNG), name: 'photo.png', mime: 'image/png', size: PNG.byteLength })
  })

  it('deduplicates identical bytes: one blob, one row per upload', async () => {
    const first = await t.deps.files.upload(new File([TEXT], 'a.txt', { type: 'text/plain' }))
    const second = await t.deps.files.upload(new File([TEXT], 'b.txt', { type: 'text/plain' }))
    expect(first.id).not.toBe(second.id)
    expect(await t.db.select().from(files)).toHaveLength(2)
    expect(storedBlobs()).toEqual([blobPath(TEXT)])
  })

  it('refuses files over 20 MB with payload_too_large', async () => {
    const big = new File([new Uint8Array(LIMITS.uploadBytes + 1)], 'big.txt', { type: 'text/plain' })
    const error = await rejection(t.deps.files.upload(big))
    expect(error).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.uploadBytes } })
    expect(storedBlobs()).toEqual([])
  })

  it('refuses disallowed or mismatched types and stores nothing', async () => {
    const mismatch = await rejection(t.deps.files.upload(new File([TEXT], 'x.png', { type: 'image/png' })))
    expect(mismatch.code).toBe('validation_error')
    expect(mismatch.details).toMatchObject({ issues: [{ path: ['file'] }] })
    const disallowed = await rejection(t.deps.files.upload(new File([TEXT], 'x.zip', { type: 'application/zip' })))
    expect(disallowed.code).toBe('validation_error')
    expect(storedBlobs()).toEqual([])
    expect(await t.db.select().from(files)).toHaveLength(0)
  })

  it('gets, reads and opens stored files; unknown or malformed ids are not found', async () => {
    const ref = await t.deps.files.upload(new File([PDF], 'doc.pdf', { type: 'application/pdf' }))
    expect(await t.deps.files.get(ref.id)).toMatchObject({ id: ref.id, name: 'doc.pdf', mime: 'application/pdf' })
    const { file, data } = await t.deps.files.read(ref.id)
    expect(file.id).toBe(ref.id)
    expect(data).toEqual(PDF)
    const opened = await t.deps.files.open(ref.id)
    expect(await streamBytes(opened.stream)).toEqual(PDF)
    await expect(t.deps.files.get('file_0000000000000000')).resolves.toBeNull()
    await expect(t.deps.files.get('../../secret.key')).resolves.toBeNull()
    expect((await rejection(t.deps.files.read('file_0000000000000000'))).code).toBe('not_found')
    expect((await rejection(t.deps.files.open('nope'))).code).toBe('not_found')
  })

  it('answers not_found when the blob is missing on disk', async () => {
    const ref = await t.deps.files.upload(new File([TEXT], 'a.txt', { type: 'text/plain' }))
    rmSync(blobPath(TEXT))
    expect((await rejection(t.deps.files.read(ref.id))).code).toBe('not_found')
    expect((await rejection(t.deps.files.open(ref.id))).code).toBe('not_found')
  })

  it('extracts file ids from file part URLs only', () => {
    expect(t.deps.files.idFromUrl('/api/files/file_abcdefghijklmnop')).toBe('file_abcdefghijklmnop')
    expect(t.deps.files.idFromUrl('/api/files/file_abc')).toBeNull()
    expect(t.deps.files.idFromUrl('https://evil.example/api/files/file_abcdefghijklmnop')).toBeNull()
    expect(t.deps.files.idFromUrl('/api/files/file_abcdefghijklmnop?x=1')).toBeNull()
    expect(t.deps.files.idFromUrl('data:image/png;base64,AAAA')).toBeNull()
  })
})

describe('files service: bulk data imports (importFile)', () => {
  function input(bytes: Uint8Array, overrides: Partial<FileImportInput> = {}): FileImportInput {
    return { preferredId: 'file_0000000000000001', sha256: sha256(bytes), name: 'notes.txt', mime: 'text/plain', data: bytes, createdAt: 1234, ...overrides }
  }

  it('stores a new file under the preferred id with its date, sanitized name and checked type', async () => {
    const result = await t.deps.files.importFile(input(PNG, { name: 'dir/../shot.png', mime: 'image/png' }))
    expect(result).toEqual({
      reused: false,
      file: { id: 'file_0000000000000001', sha256: sha256(PNG), name: 'shot.png', mime: 'image/png', size: PNG.byteLength, createdAt: 1234 },
    })
    expect((await t.deps.files.read('file_0000000000000001')).data).toEqual(PNG)
    expect(existsSync(blobPath(PNG))).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(blobPath(PNG)).mode & 0o777).toBe(0o600)
  })

  it('reuses a row with the same content, preferring the preferred id, and never duplicates it', async () => {
    const first = await t.deps.files.importFile(input(TEXT))
    const upload = await t.deps.files.upload(new File([TEXT], 'b.txt', { type: 'text/plain' }))
    expect(await t.deps.files.importFile(input(TEXT, { preferredId: 'file_0000000000000009' }))).toEqual({ reused: true, file: first.file })
    expect((await t.deps.files.importFile(input(TEXT, { preferredId: upload.id }))).file.id).toBe(upload.id)
    // The same import again reuses every file.
    expect(await t.deps.files.importFile(input(TEXT))).toEqual({ reused: true, file: first.file })
    expect(await t.db.select().from(files)).toHaveLength(2)
    expect(storedBlobs()).toEqual([blobPath(TEXT)])
  })

  it('writes the blob again when a reused row lost it', async () => {
    const first = await t.deps.files.importFile(input(TEXT))
    rmSync(blobPath(TEXT))
    expect(await t.deps.files.importFile(input(TEXT))).toEqual({ reused: true, file: first.file })
    expect((await t.deps.files.read(first.file.id)).data).toEqual(TEXT)
  })

  it('takes a new id when the preferred id is used by other content or malformed; keeps a valid date only', async () => {
    const taken = await t.deps.files.importFile(input(TEXT))
    const other = await t.deps.files.importFile(input(PDF, { name: 'doc.pdf', mime: 'application/pdf', createdAt: -5 }))
    expect(other.reused).toBe(false)
    expect(other.file.id).not.toBe(taken.file.id)
    expect(other.file.id).toMatch(/^file_[\dA-Za-z]{16}$/)
    expect(other.file.createdAt).toBeGreaterThan(1234)
    const malformed = await t.deps.files.importFile(input(PNG, { preferredId: '../../secret.key', mime: 'image/png', name: 'a.png' }))
    expect(malformed.file.id).toMatch(/^file_[\dA-Za-z]{16}$/)
    expect(storedBlobs().sort()).toEqual([blobPath(TEXT), blobPath(PDF), blobPath(PNG)].sort())
  })

  it('refuses a sha256 mismatch, a disallowed or mismatched type and an oversized file, storing nothing', async () => {
    const mismatch = await rejection(t.deps.files.importFile(input(TEXT, { sha256: 'f'.repeat(64) })))
    expect(mismatch).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['sha256'] }] } })
    const disallowed = await rejection(t.deps.files.importFile(input(TEXT, { mime: 'application/zip', name: 'a.zip' })))
    expect(disallowed).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['mime'] }] } })
    expect((await rejection(t.deps.files.importFile(input(TEXT, { mime: 'image/png', name: 'x.png' })))).code).toBe('validation_error')
    const big = new Uint8Array(LIMITS.uploadBytes + 1)
    expect((await rejection(t.deps.files.importFile(input(big))))).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.uploadBytes } })
    expect(storedBlobs()).toEqual([])
    expect(await t.db.select().from(files)).toHaveLength(0)
  })
})

describe('files service: generated images (saveGenerated)', () => {
  const RED = encodeSolidPng(4, 3, [255, 0, 0])

  it('stores a generated image content-addressed with private permissions and a sanitized name', async () => {
    const file = await t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png', name: 'dir/image-1' })
    expect(file).toEqual({ id: expect.stringMatching(/^file_[\dA-Za-z]{16}$/), sha256: sha256(RED), name: 'image-1.png', mime: 'image/png', size: RED.byteLength, createdAt: expect.any(Number) })
    expect(await t.deps.files.get(file.id)).toEqual(file)
    expect((await t.deps.files.read(file.id)).data).toEqual(RED)
    expect(t.deps.files.idFromUrl(`/api/files/${file.id}`)).toBe(file.id)
    if (process.platform !== 'win32')
      expect(statSync(blobPath(RED)).mode & 0o777).toBe(0o600)
    const jpeg = await t.deps.files.saveGenerated({ data: JPEG, mediaType: 'image/jpg', name: 'photo' })
    expect(jpeg).toMatchObject({ mime: 'image/jpeg', name: 'photo.jpg' })
  })

  it('gives the same file id for the same bytes, keeping the first row and its name', async () => {
    const first = await t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png', name: 'image-1.png' })
    const again = await t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png; foo=bar', name: 'image-2.png' })
    expect(again).toEqual(first)
    const upload = await t.deps.files.upload(new File([GIF], 'upload.gif', { type: 'image/gif' }))
    expect(await t.deps.files.saveGenerated({ data: GIF, mediaType: 'image/gif', name: 'image-1.gif' })).toMatchObject({ id: upload.id, name: 'upload.gif' })
    expect(await t.db.select().from(files)).toHaveLength(2)
    expect(storedBlobs().sort()).toEqual([blobPath(RED), blobPath(GIF)].sort())
  })

  it('stores concurrent saves of the same bytes as one row', async () => {
    const saved = await Promise.all(Array.from({ length: 5 }, (_, index) => t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png', name: `image-${index + 1}.png` })))
    expect(new Set(saved.map(file => file.id)).size).toBe(1)
    expect(await t.db.select().from(files)).toHaveLength(1)
  })

  it('writes the blob again when a reused row lost it', async () => {
    const first = await t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png', name: 'image-1.png' })
    rmSync(blobPath(RED))
    expect(await t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png', name: 'image-1.png' })).toEqual(first)
    expect((await t.deps.files.read(first.id)).data).toEqual(RED)
  })

  it('does not reuse a row of the same bytes stored under another type', async () => {
    await t.db.insert(files).values({ id: 'file_0000000000000001', sha256: sha256(RED), name: 'odd.bin', mime: 'text/plain', size: RED.byteLength, createdAt: 1 })
    const file = await t.deps.files.saveGenerated({ data: RED, mediaType: 'image/png', name: 'image-1.png' })
    expect(file).toMatchObject({ mime: 'image/png', name: 'image-1.png' })
    expect(file.id).not.toBe('file_0000000000000001')
  })

  it('refuses SVG, other types, a type mismatch and an oversized image, storing nothing', async () => {
    const svg = await rejection(t.deps.files.saveGenerated({ data: SVG, mediaType: 'image/svg+xml', name: 'a.svg' }))
    expect(svg).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['mediaType'] }] } })
    expect((await rejection(t.deps.files.saveGenerated({ data: PDF, mediaType: 'application/pdf', name: 'a.pdf' }))).code).toBe('validation_error')
    const mismatch = await rejection(t.deps.files.saveGenerated({ data: RED, mediaType: 'image/jpeg', name: 'a.jpg' }))
    expect(mismatch).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['data'] }] } })
    const huge = new Uint8Array(LIMITS.generatedImageBytes + 1)
    huge.set(RED)
    const large = await rejection(t.deps.files.saveGenerated({ data: huge, mediaType: 'image/png', name: 'big.png' }))
    expect(large.toJSON().error).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.generatedImageBytes } })
    expect(storedBlobs()).toEqual([])
    expect(await t.db.select().from(files)).toHaveLength(0)
  })
})

describe('files service: purge', () => {
  it('deletes every row and every blob (orphans and temporary files included), keeps the root, reports row bytes', async () => {
    await t.deps.files.upload(new File([TEXT], 'a.txt', { type: 'text/plain' }))
    await t.deps.files.upload(new File([TEXT], 'b.txt', { type: 'text/plain' }))
    await t.deps.files.upload(new File([PNG], 'c.png', { type: 'image/png' }))
    mkdirSync(join(t.env.paths.files, 'zz'), { recursive: true })
    writeFileSync(join(t.env.paths.files, 'zz', 'orphan'), 'orphan')
    writeFileSync(join(t.env.paths.files, '.stray.tmp'), 'tmp')
    expect(await t.deps.files.purge()).toEqual({ files: 3, bytes: 2 * TEXT.byteLength + PNG.byteLength })
    expect(await t.db.select().from(files)).toEqual([])
    expect(existsSync(t.env.paths.files)).toBe(true)
    expect(readdirSync(t.env.paths.files)).toEqual([])
    expect(await t.deps.files.purge()).toEqual({ files: 0, bytes: 0 })
    // The store keeps working after a purge.
    const ref = await t.deps.files.upload(new File([TEXT], 'again.txt', { type: 'text/plain' }))
    expect((await t.deps.files.read(ref.id)).data).toEqual(TEXT)
  })

  it('recreates a missing files root', async () => {
    rmSync(t.env.paths.files, { recursive: true, force: true })
    expect(await t.deps.files.purge()).toEqual({ files: 0, bytes: 0 })
    expect(existsSync(t.env.paths.files)).toBe(true)
  })
})
