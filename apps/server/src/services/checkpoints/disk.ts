// Disk access shared by the checkpoint modules (Phase 8, ADR-036 / ADR-037, ARCHITECTURE.md 6.16). Complete since P8-0b
// (C19): the journal (`journal-service.ts`, W8.1) and the restore primitive (`restore.ts`, W8.2) read the before-state of
// a file with `readCheckpointBefore` under its lock; the planner inputs (`rewind.ts`, `undo.ts`, `revert.ts`, W8.2) and
// the changes list (`changes.ts`, W8.3) read the current disk state with `diskSha` / `diskShas`; `writeWithoutRecording`
// is the journaled write minus the journal (a call without a run scope, the P8-0b skeleton, the test fakes).
//
// Every read goes through the frozen path guard (`openWorkspaceFile`: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, a regular
// file after `fstat`); hashes are streamed, so a large file never sits in memory.
import type { ResolvedWorkspacePath } from '../../workspace/paths.ts'
import type { CheckpointBefore, CheckpointWriteInput, CheckpointWriteResult } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isHarnessError, LIMITS } from '@harness-forge/shared'
import { withFileLock } from '../../workspace/file-lock.ts'
import { openWorkspaceFile, writeWorkspaceFile } from '../../workspace/paths.ts'

/** Bytes read per chunk while hashing a file. */
const HASH_CHUNK_BYTES = 1_048_576

/** The sha256 of `bytes` as lowercase hex (blob names, `before_sha`, `after_sha`, `FileDiff.currentSha`). */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface ReadCheckpointBeforeOptions {
  /** Bytes kept as `present` (default `LIMITS.checkpointFileMaxBytes`, 8 MiB); a bigger file is `too-large`. */
  maxBytes?: number
}

/**
 * The state of a file right before a change (call it under the file's lock): `missing` when `resolved.exists` is false
 * (or the file disappeared since it was resolved), `present` with the bytes, their sha256, the size and the permission
 * bits, or `too-large` (size and mode only) above `maxBytes` (also when the file grows past it while it is read). A path
 * the guard refuses (a folder, a FIFO, a link out of the project, permission denied) rejects with its
 * `validation_error`: the write that follows would fail the same way.
 */
export async function readCheckpointBefore(root: string, resolved: ResolvedWorkspacePath, options: ReadCheckpointBeforeOptions = {}): Promise<CheckpointBefore> {
  const maxBytes = options.maxBytes ?? LIMITS.checkpointFileMaxBytes
  if (!resolved.exists)
    return { state: 'missing' }
  let opened
  try {
    opened = await openWorkspaceFile(root, resolved.rel)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      return { state: 'missing' }
    throw error
  }
  const { handle, stats } = opened
  try {
    const mode = stats.mode & 0o7777
    if (stats.size > maxBytes)
      return { state: 'too-large', size: stats.size, mode }
    // Sized by `fstat` plus one byte, so a file that grew while it is read is noticed; the buffer grows (at most to one
    // byte over the cap, which tells a file past the cap from one that fits exactly).
    let buffer = Buffer.alloc(stats.size + 1)
    let length = 0
    for (;;) {
      if (length === buffer.length) {
        const grown = Buffer.alloc(Math.min(buffer.length * 2, maxBytes + 1))
        buffer.copy(grown, 0, 0, length)
        buffer = grown
      }
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
      if (length > maxBytes) {
        const now = await handle.stat()
        return { state: 'too-large', size: Math.max(now.size, length), mode }
      }
    }
    const bytes = buffer.subarray(0, length)
    return { state: 'present', bytes, sha: sha256Hex(bytes), size: length, mode }
  }
  finally {
    await handle.close()
  }
}

/**
 * The current state of a project path for a plan or a list: the sha256 of the regular file, `null` when it is missing,
 * or `'unreadable'` when the path guard refuses it (a folder, a FIFO, a link out of the project, permission denied):
 * a restore of such a path is skipped as `refused`.
 */
export type DiskSha = string | null | 'unreadable'

/** `diskSha` of one project-relative path (streamed in 1 MiB chunks; `signal` stops between chunks). */
export async function diskSha(root: string, path: string, signal?: AbortSignal): Promise<DiskSha> {
  signal?.throwIfAborted()
  let opened
  try {
    opened = await openWorkspaceFile(root, path)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      return null
    if (isHarnessError(error) && error.code === 'validation_error')
      return 'unreadable'
    throw error
  }
  const { handle } = opened
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0)
        break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  }
  finally {
    await handle.close()
  }
}

/** `diskSha` of every path (deduplicated), read one after the other; the map keeps the input order. */
export async function diskShas(root: string, paths: Iterable<string>, signal?: AbortSignal): Promise<Map<string, DiskSha>> {
  const shas = new Map<string, DiskSha>()
  for (const path of paths) {
    if (!shas.has(path))
      shas.set(path, await diskSha(root, path, signal))
  }
  return shas
}

/**
 * A write that records nothing: under the lock of `input.resolved.absolute`, the before-state (`readCheckpointBefore`),
 * `produce(before)`, `signal.throwIfAborted()`, then the frozen `writeWorkspaceFile(root, resolved.rel, data)`;
 * `recorded` is false. `journaledWrite` uses it for a call without a run scope; the P8-0b skeleton journal and the fake
 * service's journal write through it.
 */
export async function writeWithoutRecording(input: CheckpointWriteInput): Promise<CheckpointWriteResult> {
  const { root, resolved, produce, signal } = input
  return withFileLock(resolved.absolute, async () => {
    const before = await readCheckpointBefore(root, resolved)
    const data = await produce(before)
    signal.throwIfAborted()
    const written = await writeWorkspaceFile(root, resolved.rel, data)
    return { written, before, recorded: false }
  })
}
