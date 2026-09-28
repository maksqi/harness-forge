// Traversal-safe file access inside a plugin directory (API.md 5.18, W3.4-T3). A path is accepted only when it is a
// relative POSIX path of safe segments (`pluginFilePathSchema`), every existing segment is a real entry of its parent
// with exactly that name (no symbolic links, no case-insensitive aliases such as `PLUGIN.JSON` for `plugin.json`),
// every parent is a directory, and the realpath of the deepest existing entry stays inside the plugin directory.
// Files are text only: valid UTF-8 without NUL bytes, at most `LIMITS.pluginFileBytes`.
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { HarnessError, LIMITS, pluginFilePathSchema } from '@harness-forge/shared'

/** Maximum size of a file read or written through the files API. */
export const PLUGIN_FILE_MAX_BYTES = LIMITS.pluginFileBytes

/** Bytes inspected to decide whether a listed file is text. */
const SNIFF_BYTES = 8192

/** Prefix of the temporary files of atomic writes (never listed). */
export const TEMP_FILE_PREFIX = '.hf-write-'

/** `O_NOFOLLOW` where the platform has it (the final path component must not be a symbolic link). */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

export function pathError(message: string): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { issues: [{ path: ['path'], message, code: 'custom' }] },
  })
}

export function fileNotFound(path: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `The file "${path}" does not exist.` })
}

export function fileTooLarge(limitBytes: number = PLUGIN_FILE_MAX_BYTES): HarnessError {
  return new HarnessError({
    code: 'payload_too_large',
    message: `Files are limited to ${Math.round(limitBytes / 1024)} KB.`,
    details: { limitBytes },
  })
}

/** True when `target` is `root` or below it (both absolute and resolved). */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  }
  catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      return null
    throw error
  }
}

/** Folders that are never listed or opened (repository internals, installed packages). */
export const BLOCKED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/** Hidden files and folders (a segment starting with ".") are never created, changed or deleted. */
export function isHiddenPath(relativePath: string): boolean {
  return relativePath.split('/').some(segment => segment.startsWith('.'))
}

export interface ResolvePathOptions {
  /** The path is written or deleted: hidden segments are refused too. */
  modify?: boolean
}

export interface ResolvedPluginPath {
  /** The validated relative POSIX path (exact names of the existing segments). */
  path: string
  /** Absolute path below the plugin directory. */
  absolute: string
  /** `lstat` of the target; null when it does not exist yet. */
  stats: Stats | null
}

/**
 * Validates `relativePath` against the plugin directory `root` (a realpath). Missing trailing segments are allowed
 * (writes create them); anything else unusual is a `validation_error`. `.git` and `node_modules` are never opened, and
 * hidden segments are refused for writes and deletes (a stolen session must not plant `.git/hooks` or editor tasks in
 * a linked folder).
 */
export async function resolvePluginPath(root: string, relativePath: string, options: ResolvePathOptions = {}): Promise<ResolvedPluginPath> {
  const parsed = pluginFilePathSchema.safeParse(relativePath)
  if (!parsed.success)
    throw pathError(parsed.error.issues[0]?.message ?? 'Invalid file path.')
  const segments = relativePath.split('/')
  if (segments.some(segment => BLOCKED_SEGMENTS.has(segment)))
    throw pathError('The .git and node_modules folders cannot be opened through the editor.')
  if (options.modify && isHiddenPath(relativePath))
    throw pathError('Hidden files and folders (names starting with ".") cannot be created, changed or deleted through the editor.')
  let current = root
  let stats: Stats | null = null
  let deepestExisting = root
  for (const [index, segment] of segments.entries()) {
    const shown = segments.slice(0, index + 1).join('/')
    const names = await readdir(current)
    const next = join(current, segment)
    if (!names.includes(segment)) {
      if (await lstatOrNull(next) !== null)
        throw pathError(`"${shown}" differs in letter case from an existing file or folder.`)
      stats = null
      break
    }
    stats = await lstat(next)
    if (stats.isSymbolicLink())
      throw pathError(`"${shown}" is a symbolic link: links cannot be opened through the editor.`)
    if (index < segments.length - 1 && !stats.isDirectory())
      throw pathError(`"${shown}" is not a folder.`)
    current = next
    deepestExisting = next
  }
  const real = await realpath(deepestExisting)
  if (!isWithin(root, real))
    throw pathError('The path points outside the plugin directory.')
  return { path: relativePath, absolute: join(root, relativePath), stats }
}

/** Text of UTF-8 bytes without NUL characters (the BOM is kept so the file round-trips), else null. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0))
    return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  catch {
    return null
  }
}

/** Whether the first bytes of a file look like UTF-8 text (an incomplete trailing sequence is fine). */
export function looksLikeText(prefix: Uint8Array): boolean {
  if (prefix.includes(0))
    return false
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix, { stream: true })
    return true
  }
  catch {
    return false
  }
}

async function withHandle<T>(path: string, flags: number, run: (handle: FileHandle) => Promise<T>): Promise<T> {
  let handle: FileHandle
  try {
    handle = await open(path, flags | NO_FOLLOW)
  }
  catch (error) {
    if (errorCode(error) === 'ELOOP')
      throw pathError('Symbolic links cannot be opened through the editor.')
    throw error
  }
  try {
    return await run(handle)
  }
  finally {
    await handle.close()
  }
}

/**
 * Reads a regular file of at most `maxBytes` (`payload_too_large` beyond), never following a final symbolic link.
 * Returns the bytes and the `fstat` of the opened file.
 */
export async function readRegularFile(path: string, maxBytes: number = PLUGIN_FILE_MAX_BYTES): Promise<{ bytes: Buffer, stats: Stats }> {
  return withHandle(path, constants.O_RDONLY, async (handle) => {
    const stats = await handle.stat()
    if (!stats.isFile())
      throw pathError('Only files can be opened.')
    if (stats.size > maxBytes)
      throw fileTooLarge(maxBytes)
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes)
      throw fileTooLarge(maxBytes)
    return { bytes, stats }
  })
}

/** The first bytes of a regular file (for the text check of listings). */
export async function readPrefix(path: string, bytes: number = SNIFF_BYTES): Promise<Uint8Array> {
  return withHandle(path, constants.O_RDONLY, async (handle) => {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  })
}
