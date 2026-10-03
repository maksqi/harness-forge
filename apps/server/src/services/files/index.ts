// Content-addressed upload store (API.md 5.11, table `files`, bytes in `data/files/<aa>/<sha256>`). Owner: W1.5
// (W1.5-T5). Implements `FilesService` (./types.ts) behind `createFilesService(deps)`.
//
// Every upload gets its own `files` row (id, sanitized name, validated type); identical bytes are stored once. Blobs are
// written to a temporary file and renamed into place (never a partial blob), directories 0700, files 0600. Paths come
// only from a row's validated sha256, never from request input.
//
// Bulk data (ADR-024, W5.3): `importFile` stores one attachment of a data import with the upload checks, deduplicated
// by content (an existing row with the same sha256 is reused, the backup's id is kept when it is free), and `purge`
// empties the store (every row, every blob) for delete-all.
//
// Generated images (ADR-028, W6.4): `saveGenerated` stores one image a model generated (raster types only, at most
// `LIMITS.generatedImageBytes`, magic bytes matching the type: ./generated.ts), deduplicated by content: a row with the
// same sha256 and type is returned as is (its blob written again when missing), else a new row is inserted. Saves of the
// same bytes are serialized, so they give one row even when they run concurrently.
//
// Orphaned file cleanup (ADR-035, W7.8): `upload`, `importFile` and `saveGenerated` hold the store gate (./gate.ts)
// shared around their blob write + row insert and pin the id they return (./pins.ts, in memory for the 24 h grace
// period); `sweep` (./sweep.ts) and `purge` hold it exclusively. `sweep` snapshots the pins inside the gate, so a row a
// run reused before the sweep started is never removed.
//
// Automatic sweep (ADR-039, W8.7): `sweep` honors `FileSweepInput.signal`: an aborted signal never takes the gate, and
// ./sweep.ts checks it between batches.
import type { FileRef } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { FileImportInput, FileImportResult, FilePurgeResult, FilesService, FileSweepInput, FileSweepResult, GeneratedFileInput, StoredFile } from './types.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createFileId, FILE_ID_PATTERN, HarnessError, LIMITS, SHA256_HEX_PATTERN, validationError } from '@harness-forge/shared'
import { asc, eq } from 'drizzle-orm'
import { files } from '../../db/schema.ts'
import { guardDb, isConstraintError } from '../chats/db-errors.ts'
import { createStoreGate } from './gate.ts'
import { checkGeneratedFile, generatedFileName } from './generated.ts'
import { sanitizeFileName } from './names.ts'
import { createFilePins } from './pins.ts'
import { resolveUploadType } from './sniff.ts'
import { sweepStore } from './sweep.ts'
import { FILE_URL_PREFIX, fileUrl } from './urls.ts'

export { FILE_CLEANUP_GRACE_MS } from './pins.ts'
export { FILE_URL_PREFIX, fileUrl } from './urls.ts'

export interface FilesServiceOptions {
  /** Clock of new rows, pins and the sweep's temp file cutoff (default `Date.now`; tests). */
  now?: () => number
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

/** A `validation_error` of `importFile` (one issue at `path`). */
function invalidImport(message: string, path: string): HarnessError {
  return validationError([{ path: [path], message, code: 'custom' }], message)
}

/** A stored `created_at`: the given time when it is a valid timestamp, else now. */
function validTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
}

export function createFilesService(deps: AppDeps, options: FilesServiceOptions = {}): FilesService {
  const { db } = deps
  const root = deps.env.paths.files
  // Read at call time, so fake timers that replace `Date` after the service was built still apply (tests).
  const now = options.now ?? (() => Date.now())
  const gate = createStoreGate()
  const pins = createFilePins(now)
  const logger = deps.logger.child({ component: 'files' })

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

  /** Inserts a row under `id`; false when the id is already used (checked by the primary key, so races are safe). */
  async function insertRowWithId(id: string, row: Omit<StoredFile, 'id'>): Promise<boolean> {
    try {
      await guardDb(() => db.insert(files).values({ id, ...row }))
      return true
    }
    catch (error) {
      if (isConstraintError(error))
        return false
      throw error
    }
  }

  /** Deletes everything below the files root (blobs, temporary files, orphans); the root itself stays. */
  async function removeBlobs(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(root)
    }
    catch (error) {
      if (!isMissingFile(error))
        throw error
      await mkdir(root, { recursive: true, mode: 0o700 })
      return
    }
    for (const name of names)
      await rm(join(root, name), { recursive: true, force: true })
  }

  /**
   * Runs a blob write + row insert holding the store gate shared and pins the id it produced before the gate is
   * released, so a sweep that starts afterwards sees the pin.
   */
  async function withPinnedGate<T>(operation: () => Promise<T>, idOf: (result: T) => string): Promise<T> {
    return gate.shared(async () => {
      const result = await operation()
      pins.pin(idOf(result))
      return result
    })
  }

  async function importFile(input: FileImportInput): Promise<FileImportResult> {
    const data = input.data
    if (data.byteLength > LIMITS.uploadBytes)
      throw payloadTooLarge()
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (sha256 !== input.sha256)
      throw invalidImport('The attachment does not match its sha256: it is damaged or was altered.', 'sha256')
    const type = resolveUploadType(input.mime, input.name, data)
    if (!type.ok)
      throw invalidImport(type.reason, 'mime')
    return withPinnedGate(async () => {
      const same = await guardDb(() => db.select().from(files).where(eq(files.sha256, sha256)).orderBy(asc(files.createdAt), asc(files.id)))
      // Written again when a row survived without its blob (a no-op when the blob is there).
      await storeBlob(sha256, data)
      const reuse = same.find(row => row.id === input.preferredId) ?? same[0]
      if (reuse !== undefined)
        return { file: reuse, reused: true }
      const row = { sha256, name: sanitizeFileName(input.name, type.mime), mime: type.mime, size: data.byteLength, createdAt: validTimestamp(input.createdAt) }
      const keepId = FILE_ID_PATTERN.test(input.preferredId) && await insertRowWithId(input.preferredId, row)
      const id = keepId ? input.preferredId : await insertRow(row)
      return { file: { id, ...row }, reused: false }
    }, result => result.file.id)
  }

  /** The tail of the pending `saveGenerated` calls per sha256 (removed once the last one settles). */
  const contentLocks = new Map<string, Promise<void>>()

  /** Runs `fn` after every earlier call for the same content has settled. */
  function withContentLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    const previous = contentLocks.get(sha256) ?? Promise.resolve()
    const run = previous.then(fn)
    const settled = run.then(() => {}, () => {})
    contentLocks.set(sha256, settled)
    void settled.then(() => {
      if (contentLocks.get(sha256) === settled)
        contentLocks.delete(sha256)
    })
    return run
  }

  async function saveGenerated(input: GeneratedFileInput): Promise<StoredFile> {
    const mime = checkGeneratedFile(input.data, input.mediaType)
    const data = input.data
    const sha256 = createHash('sha256').update(data).digest('hex')
    // The content lock is taken before the gate (never the other way round): the gate is held only for the write
    // itself, never while this save waits for an earlier save of the same bytes.
    return withContentLock(sha256, () => withPinnedGate(async () => {
      const same = await guardDb(() => db.select().from(files).where(eq(files.sha256, sha256)).orderBy(asc(files.createdAt), asc(files.id)))
      const reuse = same.find(row => row.mime === mime)
      // Written again when a reused row lost its blob (a no-op when the blob is there).
      await storeBlob(sha256, data)
      if (reuse !== undefined)
        return reuse
      const row = { sha256, name: generatedFileName(input.name, mime), mime, size: data.byteLength, createdAt: now() }
      return { id: await insertRow(row), ...row }
    }, file => file.id))
  }

  async function purge(): Promise<FilePurgeResult> {
    return gate.exclusive(async () => {
      // Rows first: an interrupted purge leaves orphan blobs (removed by the next purge), never rows without blobs.
      const rows = await guardDb(() => db.delete(files).returning({ size: files.size }))
      await removeBlobs()
      return { files: rows.length, bytes: rows.reduce((total, row) => total + row.size, 0) }
    })
  }

  async function sweep(input: FileSweepInput): Promise<FileSweepResult> {
    // An aborted sweep never takes the gate. Otherwise the gate is requested before anything else, so uploads that
    // arrive later wait for the sweep.
    input.signal?.throwIfAborted()
    return gate.exclusive(() => sweepStore({ db, root, pinned: pins.snapshot(), now: now(), logger }, input))
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
      const id = await withPinnedGate(async () => {
        await storeBlob(sha256, bytes)
        return insertRow({ sha256, name, mime: type.mime, size: bytes.byteLength, createdAt: now() })
      }, rowId => rowId)
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

    importFile,

    purge,

    saveGenerated,

    sweep,

    pinnedIds: () => pins.snapshot(),

    withSharedGate: operation => gate.shared(operation),

    withExclusiveGate: operation => gate.exclusive(operation),
  }
}
