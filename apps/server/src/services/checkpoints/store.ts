// The checkpoint blob store (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Blob store"). Owner: W8.1.
//
// `<dataDir>/checkpoints/<aa>/<sha256>`: the raw before-bytes of project files, deduplicated by sha256 (an existing blob
// is kept and its mtime refreshed), folders 0700 / files 0600, written to a temp file in the shard folder
// (`.<sha256>.<16 hex>.tmp`, created with `O_EXCL`), fsynced, then renamed; names are validated as 64 lowercase hex
// characters and never resolve outside `DataPaths.checkpoints`. Writers hold the store gate (`createStoreGate()` of
// `services/files/gate.ts`) shared from the blob write until their row is inserted; prune and purge hold it
// exclusively. A separate tree from `files/`: the file sweep never walks it, and no route serves it.
//
// An interrupted write (a crash between the temp file and the rename) leaves only a temp file, never a partial blob
// under its final name; prune removes temp files older than `CHECKPOINT_TEMP_MAX_AGE_MS`.
import type { Buffer } from 'node:buffer'
import type { CheckpointBlobStore, CheckpointSummary } from './types.ts'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SHA256_HEX_PATTERN, validationError } from '@harness-forge/shared'
import { createStoreGate } from '../files/gate.ts'
import { sha256Hex } from './disk.ts'

/** Age after which a temp file of an interrupted write is stale (prune removes it; also the orphan blob grace). */
export const CHECKPOINT_TEMP_MAX_AGE_MS = 3_600_000

/** A shard folder: the first two hex characters of the blob names inside it. */
const SHARD_NAME = /^[\da-f]{2}$/
/** The temp file of a blob write: `.<sha256>.<16 hex>.tmp`. */
const TEMP_NAME = /^\.[\da-f]{64}\.[\da-f]{16}\.tmp$/

/** Never follow a final link when a blob is opened for reading (0 on Windows). */
const READ_FLAGS = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)

/** One file of the store (prune, purge and the summary walk them). */
export interface CheckpointStoreEntry {
  /** `blob` (a `<aa>/<sha256>` file) or `temp` (the temp file of a write). */
  readonly kind: 'blob' | 'temp'
  /** The file name (the sha256 of a blob). */
  readonly name: string
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/** The blob store plus the members only the checkpoint modules of W8.1 use (prune, purge, the summary). */
export interface CheckpointStore extends CheckpointBlobStore {
  /** `DataPaths.checkpoints`. */
  readonly dir: string
  /** Runs `operation` holding the store gate alone (prune, purge). */
  readonly withExclusiveGate: <T>(operation: () => Promise<T>) => Promise<T>
  /** Every blob and temp file of the store (regular files with a store name; anything else is ignored). */
  readonly list: () => Promise<CheckpointStoreEntry[]>
  /** The entry of one blob; null when it is not on disk (or the name is not a blob name). */
  readonly blobEntry: (sha: string) => Promise<CheckpointStoreEntry | null>
  /** Unlinks one listed file; false when it was already gone. */
  readonly unlinkEntry: (entry: CheckpointStoreEntry) => Promise<boolean>
  /** Bytes and number of the blobs on disk (`DataSummary.checkpoints`). */
  readonly summary: () => Promise<CheckpointSummary>
  /** Removes every blob and temp file (delete-all; the gate held exclusively); resolves to the blobs removed. */
  readonly purge: () => Promise<CheckpointSummary>
}

export interface CheckpointStoreOptions {
  /**
   * Tests: runs after the temp file is written and fsynced, right before the rename (a promise that never settles
   * simulates a crash at that point; a rejection is a failed write, whose temp file is removed).
   */
  readonly beforeRename?: (tempPath: string) => Promise<void>
}

/**
 * The path of blob `sha` inside `dir` (`<dir>/<first two hex>/<sha>`); `validation_error` for a name that is not 64
 * lowercase hex characters, so a stored or requested name never becomes a path outside the store.
 */
export function checkpointBlobPath(dir: string, sha: string): string {
  if (!SHA256_HEX_PATTERN.test(sha))
    throw validationError([{ path: ['sha'], message: 'Expected a lowercase hex SHA-256.', code: 'custom' }])
  return join(dir, sha.slice(0, 2), sha)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  }
  catch (error) {
    if (isMissing(error))
      return null
    throw error
  }
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  }
  catch (error) {
    if (isMissing(error))
      return []
    throw error
  }
}

/** The checkpoint store over `dir` (`DataPaths.checkpoints`; created by `checkpoints.start()`, else by the first put). */
export function createCheckpointStore(dir: string, options: CheckpointStoreOptions = {}): CheckpointStore {
  const gate = createStoreGate()

  async function put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes)
    const target = checkpointBlobPath(dir, sha)
    const existing = await lstatOrNull(target)
    if (existing !== null && existing.isFile() && existing.size === bytes.byteLength) {
      // Deduplicated: refresh the mtime, so prune's orphan grace covers the time until the caller's row is inserted.
      const now = new Date()
      await utimes(target, now, now)
      return sha
    }
    const shard = dirname(target)
    await mkdir(shard, { recursive: true, mode: 0o700 })
    const temp = join(shard, `.${sha}.${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temp, 'wx', 0o600)
    let renamed = false
    try {
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      }
      finally {
        await handle.close()
      }
      await options.beforeRename?.(temp)
      await rename(temp, target)
      renamed = true
    }
    finally {
      if (!renamed)
        await rm(temp, { force: true })
    }
    return sha
  }

  async function read(sha: string): Promise<Buffer | null> {
    const path = checkpointBlobPath(dir, sha)
    let handle
    try {
      handle = await open(path, READ_FLAGS)
    }
    catch (error) {
      if (isMissing(error) || errorCode(error) === 'ELOOP')
        return null
      throw error
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile())
        return null
      return await handle.readFile()
    }
    finally {
      await handle.close()
    }
  }

  async function has(sha: string): Promise<boolean> {
    const stats = await lstatOrNull(checkpointBlobPath(dir, sha))
    return stats !== null && stats.isFile()
  }

  async function remove(sha: string): Promise<boolean> {
    const path = checkpointBlobPath(dir, sha)
    try {
      await unlink(path)
      return true
    }
    catch (error) {
      if (isMissing(error))
        return false
      throw error
    }
  }

  async function list(): Promise<CheckpointStoreEntry[]> {
    const entries: CheckpointStoreEntry[] = []
    for (const shard of (await readdirOrEmpty(dir)).sort()) {
      if (!SHARD_NAME.test(shard))
        continue
      const folder = join(dir, shard)
      if ((await lstatOrNull(folder))?.isDirectory() !== true)
        continue
      for (const name of (await readdirOrEmpty(folder)).sort()) {
        const kind = SHA256_HEX_PATTERN.test(name) && name.startsWith(shard) ? 'blob' : TEMP_NAME.test(name) ? 'temp' : null
        if (kind === null)
          continue
        const path = join(folder, name)
        const stats = await lstatOrNull(path)
        if (stats === null || !stats.isFile())
          continue
        entries.push({ kind, name, path, size: stats.size, mtimeMs: stats.mtimeMs })
      }
    }
    return entries
  }

  async function blobEntry(sha: string): Promise<CheckpointStoreEntry | null> {
    if (!SHA256_HEX_PATTERN.test(sha))
      return null
    const path = checkpointBlobPath(dir, sha)
    const stats = await lstatOrNull(path)
    return stats !== null && stats.isFile() ? { kind: 'blob', name: sha, path, size: stats.size, mtimeMs: stats.mtimeMs } : null
  }

  async function unlinkEntry(entry: CheckpointStoreEntry): Promise<boolean> {
    try {
      await unlink(entry.path)
      return true
    }
    catch (error) {
      if (isMissing(error))
        return false
      throw error
    }
  }

  async function summary(): Promise<CheckpointSummary> {
    let bytes = 0
    let blobs = 0
    for (const entry of await list()) {
      if (entry.kind !== 'blob')
        continue
      bytes += entry.size
      blobs += 1
    }
    return { bytes, blobs }
  }

  async function purge(): Promise<CheckpointSummary> {
    return gate.exclusive(async () => {
      let bytes = 0
      let blobs = 0
      for (const entry of await list()) {
        if (await unlinkEntry(entry) && entry.kind === 'blob') {
          bytes += entry.size
          blobs += 1
        }
      }
      // Empty shard folders go too (best effort: a folder that still holds something stays).
      for (const shard of await readdirOrEmpty(dir)) {
        if (SHARD_NAME.test(shard))
          await rmdir(join(dir, shard)).catch(() => {})
      }
      return { bytes, blobs }
    })
  }

  return {
    dir,
    put,
    read,
    has,
    remove,
    withSharedGate: operation => gate.shared(operation),
    withExclusiveGate: operation => gate.exclusive(operation),
    list,
    blobEntry,
    unlinkEntry,
    summary,
    purge,
  }
}
