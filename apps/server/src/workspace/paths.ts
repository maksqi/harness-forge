// The path guard of the agent workspace (Phase 7, ADR-032, ARCHITECTURE.md 6.13 "Path resolution"). FROZEN after
// P7-0b (C14): every path a workspace tool touches resolves through `resolveWorkspacePath`; no `fs` call ever runs on a
// model-supplied path without it. The read and write helpers below are the only way the tools open project files.
//
// `resolveWorkspacePath(root, input, { allowMissing })` -> `{ absolute, rel, exists }`:
//   1. the input has 1..4096 characters without control characters; `realpath(root)` must equal `root` ("The project
//      folder moved or was replaced by a link.");
//   2. `lexical = resolve(root, input)` (absolute inputs are accepted) must be inside `root` ("Path is outside the
//      project folder.");
//   3. walk up from `lexical` until `realpath` succeeds: on ENOENT / ENOTDIR the path is `lstat`ed; when it exists it
//      is a dangling symbolic link and is refused, otherwise its name joins the missing tail and the walk continues with
//      the parent (a link loop, ELOOP, is refused);
//   4. the realpath of the deepest existing entry must be inside `root` ("… resolves outside the project folder
//      (symbolic link).");
//   5. a missing tail is allowed only with `allowMissing` (writes), and its existing base must be a directory.
// `absolute` is that realpath plus the missing tail (a file link inside the root resolves to its target, so reads and
// writes act on the target and never replace the link); `rel` is `absolute` relative to the root, POSIX, `.` for the
// root itself.
//
// Writes (`writeWorkspaceFile`) refuse any `.git` segment (of the input and of the resolved path, case-insensitive),
// directories and other non-regular files, `mkdir -p` the missing folders and re-check the realpath of the parent, then
// write a temp file in the same folder (`open(…, 'wx')`, `.hf-write-<random>`), give it the old file's mode and
// `rename` it over the target. Reads (`openWorkspaceFile`, `readWorkspaceFile`) open with
// `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and refuse anything that is not a regular file after `fstat` (without
// `O_NONBLOCK`, opening a FIFO would block until a writer appears).
//
// TOCTOU: only the last path component is protected (`O_NOFOLLOW` on reads, `O_EXCL` on the temp file, the realpath
// re-check of the parent before a write). Node has no `openat2` / `RESOLVE_BENEATH`, so a parent folder swapped for a
// link between the check and the open is not caught, and hard links are not detected. These guards protect against
// model mistakes and injected paths, not against code already running in the workspace (the shell has the server's
// rights anyway; ARCHITECTURE.md 10.9).
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { HarnessError, LIMITS, workspaceToolPathSchema } from '@harness-forge/shared'
import { isWithin, TEMP_FILE_PREFIX } from '../plugins/scaffold/paths.ts'

/** `O_NOFOLLOW` / `O_NONBLOCK` where the platform has them (0 on Windows). */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const NON_BLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

/** Flags of every read: never follow a final link, never block on a FIFO. */
export const WORKSPACE_READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | NON_BLOCK

/** Prefix of the temp files of atomic writes (the same prefix as the plugin editor's writes). */
export const WORKSPACE_TEMP_PREFIX = TEMP_FILE_PREFIX

/** Mode of a file created by a write, before the process umask (like `fs.writeFile`). */
const NEW_FILE_MODE = 0o666

export const PROJECT_FOLDER_MOVED_MESSAGE = 'The project folder moved or was replaced by a link.'
export const PROJECT_FOLDER_MISSING_MESSAGE = 'The project folder no longer exists.'
export const OUTSIDE_PROJECT_MESSAGE = 'Path is outside the project folder.'

export interface ResolveWorkspacePathOptions {
  /** Writes: a missing tail is allowed when its deepest existing folder is a directory. Default false. */
  allowMissing?: boolean
}

/** A path inside the project folder, checked by `resolveWorkspacePath`. */
export interface ResolvedWorkspacePath {
  /** The realpath of the deepest existing entry plus the missing tail: always inside the root. */
  readonly absolute: string
  /** `absolute` relative to the root, POSIX separators; `.` for the root itself. */
  readonly rel: string
  /** The target exists (false only with `allowMissing`). */
  readonly exists: boolean
}

/** A regular file opened for reading by `openWorkspaceFile` (the caller closes `handle`). */
export interface OpenedWorkspaceFile {
  readonly resolved: ResolvedWorkspacePath
  readonly handle: FileHandle
  /** `fstat` of the opened file (a regular file). */
  readonly stats: Stats
}

/** Result of `readWorkspaceFile`. */
export interface WorkspaceFileContent {
  readonly resolved: ResolvedWorkspacePath
  readonly bytes: Buffer
  readonly stats: Stats
}

/** Result of `writeWorkspaceFile`. */
export interface WorkspaceWriteResult {
  readonly absolute: string
  readonly rel: string
  /** The file did not exist before. */
  readonly created: boolean
  /** Bytes written. */
  readonly bytes: number
  /** Permission bits of the written file (the old file's mode when it existed). */
  readonly mode: number
}

// ---------- errors ----------

/** A refused path: `validation_error` with the issue path `['path']`; the message is safe to show to the model. */
export function workspacePathError(message: string): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { issues: [{ path: ['path'], message, code: 'custom' }] },
  })
}

function workspaceNotFound(rel: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `"${rel}" does not exist in the project folder.` })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

// ---------- helpers ----------

/** `target` relative to `root` with POSIX separators; `.` for the root itself. */
export function toWorkspaceRel(root: string, target: string): string {
  const rel = relative(root, target)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

/** True when a POSIX relative path has a `.git` segment (case-insensitive: case-insensitive filesystems alias it). */
export function hasGitSegment(rel: string): boolean {
  return rel.split('/').some(segment => segment.toLowerCase() === '.git')
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return null
    throw error
  }
}

/** Step 1: the input shape (shared `workspaceToolPathSchema`: 1..4096 characters, no control characters). */
function checkInput(input: string): void {
  if (typeof input !== 'string')
    throw workspacePathError('Expected a path.')
  const parsed = workspaceToolPathSchema.safeParse(input)
  if (parsed.success)
    return
  const issue = parsed.error.issues[0]
  if (issue?.code === 'too_small')
    throw workspacePathError('The path is empty.')
  if (issue?.code === 'too_big')
    throw workspacePathError(`The path is longer than ${LIMITS.workspacePathMaxChars} characters.`)
  throw workspacePathError(issue?.message ?? 'Invalid path.')
}

/** Step 1: `realpath(root) === root`. */
async function checkRoot(root: string): Promise<void> {
  let real: string
  try {
    real = await realpath(root)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw workspacePathError(PROJECT_FOLDER_MISSING_MESSAGE)
    throw workspacePathError(PROJECT_FOLDER_MOVED_MESSAGE)
  }
  if (real !== root)
    throw workspacePathError(PROJECT_FOLDER_MOVED_MESSAGE)
}

/**
 * Resolves a model-supplied path inside the project folder `root` (a canonical realpath, e.g. `ToolWorkspace.root`).
 * Throws `validation_error` (issue path `['path']`) for a refused path and `not_found` for a missing target without
 * `allowMissing`. See the module comment for the steps.
 */
export async function resolveWorkspacePath(root: string, input: string, options: ResolveWorkspacePathOptions = {}): Promise<ResolvedWorkspacePath> {
  checkInput(input)
  await checkRoot(root)
  const lexical = resolve(root, input)
  if (!isWithin(root, lexical))
    throw workspacePathError(OUTSIDE_PROJECT_MESSAGE)
  const shown = toWorkspaceRel(root, lexical)

  // Step 3: the deepest existing entry and the missing tail below it.
  const tail: string[] = []
  let current = lexical
  let real: string
  for (;;) {
    try {
      real = await realpath(current)
      break
    }
    catch (error) {
      const code = errorCode(error)
      if (code === 'ELOOP')
        throw workspacePathError(`"${shown}" goes through a symbolic link loop.`)
      if (code === 'EACCES' || code === 'EPERM')
        throw workspacePathError(`"${shown}" cannot be accessed (permission denied).`)
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw error
      if (await lstatOrNull(current) !== null)
        throw workspacePathError(`"${toWorkspaceRel(root, current)}" is a symbolic link whose target does not exist.`)
      const parent = dirname(current)
      // The root exists (step 1), so the walk ends at the root at the latest; this guards a root removed meanwhile.
      if (current === root || parent === current)
        throw workspacePathError(PROJECT_FOLDER_MISSING_MESSAGE)
      tail.unshift(basename(current))
      current = parent
    }
  }

  // Step 4: links may point anywhere inside the root, never out of it.
  if (!isWithin(root, real))
    throw workspacePathError(`"${shown}" resolves outside the project folder (symbolic link).`)

  // Step 5: a missing tail only for writes, below an existing directory.
  if (tail.length > 0) {
    if (options.allowMissing !== true)
      throw workspaceNotFound(shown)
    const base = await lstat(real)
    if (!base.isDirectory())
      throw workspacePathError(`"${toWorkspaceRel(root, real)}" is not a folder.`)
  }
  const absolute = tail.length === 0 ? real : join(real, ...tail)
  return { absolute, rel: toWorkspaceRel(root, absolute), exists: tail.length === 0 }
}

// ---------- reads ----------

async function openForRead(resolved: ResolvedWorkspacePath): Promise<FileHandle> {
  try {
    return await open(resolved.absolute, WORKSPACE_READ_FLAGS)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === 'ELOOP')
      throw workspacePathError(`"${resolved.rel}" was replaced by a symbolic link.`)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw workspaceNotFound(resolved.rel)
    if (code === 'EACCES' || code === 'EPERM')
      throw workspacePathError(`"${resolved.rel}" cannot be read (permission denied).`)
    if (code === 'ENXIO' || code === 'EOPNOTSUPP' || code === 'EISDIR')
      throw workspacePathError(`"${resolved.rel}" is not a regular file.`)
    throw error
  }
}

/**
 * Opens an existing regular file of the project for reading: resolved through `resolveWorkspacePath`, opened with
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then `fstat`: a folder, a FIFO, a socket or a device is refused (and closed).
 * The caller must close `handle` (windowed reads of large files stream from it).
 */
export async function openWorkspaceFile(root: string, input: string): Promise<OpenedWorkspaceFile> {
  const resolved = await resolveWorkspacePath(root, input)
  const handle = await openForRead(resolved)
  try {
    const stats = await handle.stat()
    if (stats.isDirectory())
      throw workspacePathError(`"${resolved.rel}" is a folder, not a file.`)
    if (!stats.isFile())
      throw workspacePathError(`"${resolved.rel}" is not a regular file.`)
    return { resolved, handle, stats }
  }
  catch (error) {
    await handle.close()
    throw error
  }
}

/** `payload_too_large` for a file above `maxBytes`. */
function workspaceFileTooLarge(rel: string, maxBytes: number): HarnessError {
  const size = maxBytes >= 1024 ? `${Math.floor(maxBytes / 1024)} KiB` : `${maxBytes} bytes`
  return new HarnessError({
    code: 'payload_too_large',
    message: `"${rel}" is larger than ${size}.`,
    details: { limitBytes: maxBytes },
  })
}

/**
 * Reads a whole regular file of the project (`openWorkspaceFile`), at most `maxBytes` (`payload_too_large` beyond,
 * also when the file grows while it is read).
 */
export async function readWorkspaceFile(root: string, input: string, options: { maxBytes: number }): Promise<WorkspaceFileContent> {
  const { resolved, handle, stats } = await openWorkspaceFile(root, input)
  try {
    if (stats.size > options.maxBytes)
      throw workspaceFileTooLarge(resolved.rel, options.maxBytes)
    // One byte more than allowed tells a file that grew past the cap from one that fits exactly.
    const buffer = Buffer.alloc(options.maxBytes + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
      if (length > options.maxBytes)
        throw workspaceFileTooLarge(resolved.rel, options.maxBytes)
    }
    return { resolved, bytes: buffer.subarray(0, length), stats }
  }
  finally {
    await handle.close()
  }
}

// ---------- writes ----------

/** Refuses a write path with a `.git` segment (the input as given and the resolved path). */
function checkNotGit(root: string, input: string, resolved: ResolvedWorkspacePath): void {
  const lexical = toWorkspaceRel(root, resolve(root, input))
  if (hasGitSegment(lexical) || hasGitSegment(resolved.rel))
    throw workspacePathError(`"${lexical}" is inside a .git folder: the workspace tools never write there.`)
}

/**
 * Creates or replaces a regular file of the project atomically. The path resolves with `allowMissing`; a `.git`
 * segment, a folder and any other non-regular target are refused; missing folders are created (`mkdir -p`) and the
 * realpath of the parent is checked again; the data goes to a temp file in the same folder (`.hf-write-<random>`,
 * created with `O_EXCL`) that gets the old file's mode and is renamed over the target (a link to the file is kept: the
 * target is the link's resolved file). A failed write removes the temp file.
 */
export async function writeWorkspaceFile(root: string, input: string, data: string | Uint8Array): Promise<WorkspaceWriteResult> {
  const resolved = await resolveWorkspacePath(root, input, { allowMissing: true })
  checkNotGit(root, input, resolved)
  let previous: Stats | null = null
  if (resolved.exists) {
    previous = await lstat(resolved.absolute)
    if (previous.isDirectory())
      throw workspacePathError(`"${resolved.rel}" is a folder, not a file.`)
    if (!previous.isFile())
      throw workspacePathError(`"${resolved.rel}" is not a regular file.`)
  }

  const parent = dirname(resolved.absolute)
  if (!resolved.exists)
    await mkdir(parent, { recursive: true })
  // The folders were checked before they were created: the parent must still be exactly where the check put it.
  let realParent: string
  try {
    realParent = await realpath(parent)
  }
  catch {
    throw workspacePathError(`The folder of "${resolved.rel}" changed while it was written.`)
  }
  if (realParent !== parent || !isWithin(root, realParent))
    throw workspacePathError(`The folder of "${resolved.rel}" changed while it was written.`)

  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const temp = join(parent, `${WORKSPACE_TEMP_PREFIX}${randomBytes(8).toString('hex')}`)
  const mode = previous === null ? null : previous.mode & 0o7777
  const handle = await open(temp, 'wx', mode === null ? NEW_FILE_MODE : 0o600)
  let written = false
  try {
    try {
      await handle.writeFile(bytes)
      if (mode !== null)
        await handle.chmod(mode)
    }
    finally {
      await handle.close()
    }
    await rename(temp, resolved.absolute)
    written = true
  }
  finally {
    if (!written)
      await rm(temp, { force: true })
  }
  const after = await lstat(resolved.absolute)
  return { absolute: resolved.absolute, rel: resolved.rel, created: !resolved.exists, bytes: bytes.byteLength, mode: after.mode & 0o7777 }
}
