import type { TestApp } from '../../testing/create-test-app.ts'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileRefSchema, HarnessError, LIMITS } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { files } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { PDF, PNG, TEXT } from './fixtures.test-util.ts'

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
