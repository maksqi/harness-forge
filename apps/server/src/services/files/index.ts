// Content-addressed upload store (API.md 5.11, table `files`, bytes in `data/files/<aa>/<sha256>`). Owner: W1.5
// (W1.5-T5). Implements `FilesService` (./types.ts) behind `createFilesService(deps)`.
//
// Every upload gets its own `files` row (id, sanitized name, validated type); identical bytes are stored once. Blobs are
// written to a temporary file and renamed into place (never a partial blob), directories 0700, files 0600. Paths come
// only from a row's validated sha256, never from request input.
import type { FileRef } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { FilesService, StoredFile } from './types.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createFileId, FILE_ID_PATTERN, HarnessError, LIMITS, SHA256_HEX_PATTERN, validationError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { files } from '../../db/schema.ts'
import { guardDb, isConstraintError } from '../chats/db-errors.ts'
import { sanitizeFileName } from './names.ts'
import { resolveUploadType } from './sniff.ts'

/** URL path of a stored file (the `url` of UI `file` parts). */
export const FILE_URL_PREFIX = '/api/files/'

export function fileUrl(id: string): string {
  return `${FILE_URL_PREFIX}${id}`
}

export function payloadTooLarge(): HarnessError {
  return new HarnessError({
    code: 'payload_too_large',
    message: `Files are limited to ${LIMITS.uploadBytes / 1024 / 1024} MB.`,
    details: { limitBytes: LIMITS.uploadBytes },
  })
}

function fileNotFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `File ${id} not found.` })
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function createFilesService(deps: AppDeps): FilesService {
  const { db } = deps
  const root = deps.env.paths.files

  /** `<root>/<aa>/<sha256>`; null for a malformed hash (a row that was not written by this service). */
  function blobPath(sha256: string): string | null {
    return SHA256_HEX_PATTERN.test(sha256) ? join(root, sha256.slice(0, 2), sha256) : null
  }

  async function storeBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    const directory = join(root, sha256.slice(0, 2))
    const target = join(directory, sha256)
    try {
      const existing = await stat(target)
      if (existing.isFile() && existing.size === bytes.byteLength)
        return
    }
    catch (error) {
      if (!isMissingFile(error))
        throw error
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    }
    catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async function insertRow(row: Omit<StoredFile, 'id'>): Promise<string> {
    // A random id collision is astronomically unlikely; retry a few times anyway instead of failing the upload.
    for (let attempt = 0; ; attempt++) {
      const id = createFileId()
      try {
        await guardDb(() => db.insert(files).values({ id, ...row }))
        return id
      }
      catch (error) {
        if (attempt >= 2 || !isConstraintError(error))
          throw error
      }
    }
  }

  async function get(id: string): Promise<StoredFile | null> {
    if (!FILE_ID_PATTERN.test(id))
      return null
    const [row] = await guardDb(() => db.select().from(files).where(eq(files.id, id)).limit(1))
    return row ?? null
  }

  async function requireBlob(id: string): Promise<{ file: StoredFile, path: string }> {
    const file = await get(id)
    const path = file === null ? null : blobPath(file.sha256)
    if (file === null || path === null)
      throw fileNotFound(id)
    return { file, path }
  }

  return {
    upload: async (file: File): Promise<FileRef> => {
      if (file.size > LIMITS.uploadBytes)
        throw payloadTooLarge()
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength > LIMITS.uploadBytes)
        throw payloadTooLarge()
      const type = resolveUploadType(file.type, file.name, bytes)
      if (!type.ok)
        throw validationError([{ path: ['file'], message: type.reason, code: 'custom' }], type.reason)
      const name = sanitizeFileName(file.name, type.mime)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await storeBlob(sha256, bytes)
      const id = await insertRow({ sha256, name, mime: type.mime, size: bytes.byteLength, createdAt: Date.now() })
      return { id, name, mime: type.mime, size: bytes.byteLength, url: fileUrl(id) }
    },

    get,

    read: async (id) => {
      const { file, path } = await requireBlob(id)
      try {
        const data = await readFile(path)
        return { file: { ...file, size: data.byteLength }, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
      }
      catch (error) {
        if (isMissingFile(error))
          throw fileNotFound(id)
        throw error
      }
    },

    open: async (id) => {
      const { file, path } = await requireBlob(id)
      let handle: Awaited<ReturnType<typeof open>>
      try {
        handle = await open(path, 'r')
      }
      catch (error) {
        if (isMissingFile(error))
          throw fileNotFound(id)
        throw error
      }
      try {
        const { size } = await handle.stat()
        if (size !== file.size)
          deps.logger.warn('stored file size differs from its row', { fileId: id, rowSize: file.size, size })
        // The stream closes the handle when it ends, fails or is cancelled.
        const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
        return { file: { ...file, size }, stream }
      }
      catch (error) {
        await handle.close()
        throw error
      }
    },

    idFromUrl: (url) => {
      if (typeof url !== 'string' || !url.startsWith(FILE_URL_PREFIX))
        return null
      const id = url.slice(FILE_URL_PREFIX.length)
      return FILE_ID_PATTERN.test(id) ? id : null
    },
  }
}
