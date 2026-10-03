// Helpers shared by the changes list, the file diffs and the git view (Phase 8, ADR-037, ARCHITECTURE.md 6.17). Owner:
// W8.3. `changes.ts` and `git-changes.ts` import them, so neither module imports the other's internals.
//
// - `requireChat` and `NO_PROJECT_MESSAGE`: the one chat lookup of a changes request (`404` for an unknown chat) and the
//   message of a chat without a project; the writes (`restore-scope.ts`) re-export both (Phase 9, W9.7: one constant,
//   one lookup per request; the changes routes no longer look the chat up themselves).
// - `openChatWorkspace` / `requireChatWorkspace`: the chat's current project folder (`404` for an unknown chat; the read
//   views answer `available: false` with `no-project` / `folder-unavailable`, the diff answers `400 validation_error`
//   with the project service's message).
// - `readDiskFile`: one read of a project file through the frozen path guard (`openWorkspaceFile`): the streamed sha256,
//   the size, the first `SNIFF_BYTES` and the whole content when it is small enough.
// - `diffSide` / `fileDiffOf`: the binary rule (a NUL byte in the first 8 KiB or a failed `decodeText`), the size rule
//   (`tooLarge`) and the diff through `computeWorkspaceDiff`.
import type { ChangesUnavailableReason, FileDiff, FileDiffStatus, WorkspaceDiff } from '@harness-forge/shared'
import type { DiffOptions } from '../../workspace/diff.ts'
import type { ChatRecord } from '../chats/types.ts'
import type { OpenWorkspace } from '../projects/types.ts'
import type { CheckpointContext, CheckpointReadOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { isHarnessError, LIMITS, validationError, workspaceToolPathSchema } from '@harness-forge/shared'
import { decodeText, isWithin } from '../../plugins/scaffold/paths.ts'
import { computeWorkspaceDiff } from '../../workspace/diff.ts'
import { openWorkspaceFile, OUTSIDE_PROJECT_MESSAGE, toWorkspaceRel, workspacePathError } from '../../workspace/paths.ts'
import { chatNotFound } from '../chats/store.ts'

/** Bytes inspected for a NUL byte (the binary rule of a side that is too large to decode). */
export const SNIFF_BYTES = 8192
/** Bytes read per chunk while hashing a file. */
const READ_CHUNK_BYTES = 1_048_576

/**
 * The message of a chat without a project: the `reason: 'no-project'` of the read views, the `400 validation_error` of
 * the diffs and of the writes (`restore-scope.ts` re-exports it).
 */
export const NO_PROJECT_MESSAGE = 'This chat has no project.'

/**
 * The chat row; `404 not_found` ("Chat <id> not found.") when it does not exist. The only chat lookup of a changes
 * request: every member of the checkpoint service that takes a chat id calls it first, before any project, git or disk
 * work.
 */
export async function requireChat(ctx: CheckpointContext, chatId: string): Promise<ChatRecord> {
  const chat = await ctx.deps.chats.find(chatId)
  if (chat === null)
    throw chatNotFound(chatId)
  return chat
}

/**
 * Read options of the changes modules: the request's signal (`CheckpointReadOptions`), plus the environment the git
 * runner's allowlist reads (default `process.env`; tests point `HOME` / `PATH` at a temp folder). The service passes
 * `CheckpointReadOptions` only.
 */
export interface ChangesReadOptions extends CheckpointReadOptions {
  readonly gitEnv?: Readonly<Record<string, string | undefined>>
}

// ---------- the chat's project folder ----------

/** The chat's current project folder, or why it is not available. */
export type ChatWorkspace
  = | { readonly ok: true, readonly workspace: OpenWorkspace }
    | {
      readonly ok: false
      readonly reason: ChangesUnavailableReason
      /** The chat's project when it still exists (`folder-unavailable`); null for `no-project`. */
      readonly projectId: string | null
      /** Safe to show: the project service's message. */
      readonly message: string
    }

/**
 * The chat's current project folder through `projects.openWorkspace` (checked again on every call). `404 not_found` for
 * an unknown chat; a chat without a project or whose project no longer exists is `no-project`, a folder that cannot be
 * opened `folder-unavailable`.
 */
export async function openChatWorkspace(ctx: CheckpointContext, chatId: string): Promise<ChatWorkspace> {
  const chat = await requireChat(ctx, chatId)
  if (chat.projectId === null)
    return { ok: false, reason: 'no-project', projectId: null, message: NO_PROJECT_MESSAGE }
  const opened = await ctx.deps.projects.openWorkspace(chat.projectId)
  if (opened.ok)
    return { ok: true, workspace: opened.workspace }
  if (opened.name === null)
    return { ok: false, reason: 'no-project', projectId: null, message: opened.message }
  return { ok: false, reason: 'folder-unavailable', projectId: chat.projectId, message: opened.message }
}

/** `openChatWorkspace` for the diff routes: an unavailable folder is `400 validation_error` with its message. */
export async function requireChatWorkspace(ctx: CheckpointContext, chatId: string): Promise<OpenWorkspace> {
  const opened = await openChatWorkspace(ctx, chatId)
  if (opened.ok)
    return opened.workspace
  throw validationError([{ path: [], message: opened.message, code: 'custom' }], opened.message)
}

/**
 * A project-relative POSIX path from a request path, lexically (`./a/../b.txt` -> `b.txt`): the journal stores the
 * relative path the write tools resolved, and the disk reads go through the path guard afterwards. Throws the guard's
 * `validation_error` (`['path']`) for an invalid path, one outside the folder and the folder itself.
 */
export function projectRelPath(root: string, input: string): string {
  if (typeof input !== 'string' || !workspaceToolPathSchema.safeParse(input).success)
    throw workspacePathError(`Expected a path of 1 to ${LIMITS.workspacePathMaxChars} characters without control characters.`)
  const lexical = resolve(root, input)
  if (!isWithin(root, lexical))
    throw workspacePathError(OUTSIDE_PROJECT_MESSAGE)
  const rel = toWorkspaceRel(root, lexical)
  if (rel === '.')
    throw workspacePathError('The path names the project folder, not a file.')
  return rel
}

// ---------- disk ----------

/** One project file as read now. */
export type DiskFile
  = | { readonly state: 'missing' }
    | {
      readonly state: 'present'
      /** sha256 of the whole file (lowercase hex). */
      readonly sha: string
      readonly size: number
      /** The whole content when the file has at most `keepBytes` bytes; else null. */
      readonly bytes: Buffer | null
      /** The first `SNIFF_BYTES` bytes. */
      readonly head: Buffer
    }

const MISSING: DiskFile = Object.freeze({ state: 'missing' })

/**
 * Reads a project file once through the path guard (`openWorkspaceFile`: links only inside the project, a regular file
 * only): the sha256 (streamed in chunks of at most 1 MiB; `signal` stops between them), the size, the first
 * `SNIFF_BYTES` and the whole content when it has at most `keepBytes` bytes. `missing` when it does not exist; a path the
 * guard refuses (a folder, a link out of the project, permission denied) rejects with its `validation_error`.
 */
export async function readDiskFile(root: string, path: string, keepBytes: number, signal?: AbortSignal): Promise<DiskFile> {
  signal?.throwIfAborted()
  let opened
  try {
    opened = await openWorkspaceFile(root, path)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      return MISSING
    throw error
  }
  const { handle, stats } = opened
  try {
    const hash = createHash('sha256')
    // Sized for the file (one byte more notices growth); a file that grew is read on in chunks of this size.
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, stats.size + 1))
    const kept: Buffer[] = []
    const head: Buffer[] = []
    let size = 0
    let keepAll = true
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0)
        break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (size < SNIFF_BYTES)
        head.push(Buffer.from(chunk.subarray(0, SNIFF_BYTES - size)))
      size += bytesRead
      if (keepAll && size <= keepBytes) {
        kept.push(Buffer.from(chunk))
      }
      else if (keepAll) {
        keepAll = false
        kept.length = 0
      }
    }
    return { state: 'present', sha: hash.digest('hex'), size, bytes: keepAll ? Buffer.concat(kept) : null, head: Buffer.concat(head) }
  }
  finally {
    await handle.close()
  }
}

// ---------- diff sides ----------

/** One side of a diff: its text, or why there is none. */
export interface DiffSide {
  /** The decoded text; null when binary or too large. */
  readonly text: string | null
  readonly binary: boolean
  readonly tooLarge: boolean
}

/** The side of a missing file (or of a base that is new). */
export const EMPTY_SIDE: DiffSide = Object.freeze({ text: '', binary: false, tooLarge: false })

/**
 * A side from its bytes: `bytes` (the whole content, null when it is over the side limit) and `head` (its first bytes,
 * for the NUL rule). Binary = a NUL byte in the first `SNIFF_BYTES` or content that `decodeText` refuses (a NUL byte
 * anywhere, invalid UTF-8).
 */
export function diffSide(bytes: Uint8Array | null, head: Uint8Array | null = bytes): DiffSide {
  const sniffed = head === null ? false : head.subarray(0, SNIFF_BYTES).includes(0)
  if (bytes === null)
    return { text: null, binary: sniffed, tooLarge: true }
  const text = sniffed ? null : decodeText(bytes)
  return text === null ? { text: null, binary: true, tooLarge: false } : { text, binary: false, tooLarge: false }
}

/** The side of a file read by `readDiskFile`. */
export function diskSide(file: DiskFile): DiffSide {
  return file.state === 'missing' ? EMPTY_SIDE : diffSide(file.bytes, file.head)
}

/** Input of `fileDiffOf`. */
export interface FileDiffParts {
  readonly source: FileDiff['source']
  readonly path: string
  readonly origPath: string | null
  readonly status: FileDiffStatus
  /** The base side; null when the base is not available (no diff). */
  readonly base: DiffSide | null
  readonly current: DiskFile
  /** `computeWorkspaceDiff` options (tests). */
  readonly diffOptions?: DiffOptions
}

/** The `FileDiff` of a base side against the disk (`diff` null when binary, too large or the base is not available). */
export async function fileDiffOf(parts: FileDiffParts): Promise<FileDiff> {
  const current = diskSide(parts.current)
  const sides = parts.base === null ? [current] : [parts.base, current]
  const binary = sides.some(side => side.binary)
  const tooLarge = sides.some(side => side.tooLarge)
  let diff: WorkspaceDiff | null = null
  if (parts.base !== null && parts.base.text !== null && current.text !== null && !binary && !tooLarge)
    diff = await computeWorkspaceDiff(parts.base.text, current.text, parts.diffOptions)
  return {
    source: parts.source,
    path: parts.path,
    origPath: parts.origPath,
    status: parts.status,
    binary,
    tooLarge,
    diff,
    currentSha: parts.current.state === 'present' ? parts.current.sha : null,
    baseAvailable: parts.base !== null,
  }
}
