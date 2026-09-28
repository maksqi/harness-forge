// Entry names of archives and copied folders (PLUGINS.md 12 "Archive rules", ARCHITECTURE.md 10.4 "Filesystem").
//
// A name is accepted only as a relative POSIX path: no absolute paths, no drive letters or other `:`, no backslashes,
// no NUL or control characters, no `..` and no empty segments. `.` segments (a `./` prefix written by `tar -C dir .`)
// are dropped. Segments are at most 255 UTF-8 bytes, paths at most 1024 bytes and 32 levels deep, and Windows device
// names (`con`, `nul`, `com1`, ...) are refused so an archive cannot address a device when the server runs on Windows.
import { Buffer } from 'node:buffer'
import { quoteName } from './errors.ts'

/** Maximum UTF-8 bytes of one path segment (common filesystem limit). */
export const SEGMENT_MAX_BYTES = 255
/** Maximum UTF-8 bytes of a whole relative path. */
export const PATH_MAX_BYTES = 1024
/** Maximum number of path segments. */
export const PATH_MAX_DEPTH = 32

// eslint-disable-next-line no-control-regex -- the rule is exactly "no control characters" (C0, DEL and C1)
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const DRIVE_LETTER = /^[a-z]:/i
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\..*)?$/i

export type EntryPathResult
  = | {
    ok: true
    /** Normalized relative POSIX path; `''` for the archive root itself (`./`). */
    path: string
    /** The name ended with `/`. */
    trailingSlash: boolean
  }
  | { ok: false, reason: string }

function refuse(raw: string, why: string): EntryPathResult {
  return { ok: false, reason: `The entry ${quoteName(raw)} ${why}.` }
}

/** Validates and normalizes one entry name. */
export function checkEntryPath(raw: string): EntryPathResult {
  if (raw.length === 0)
    return { ok: false, reason: 'An entry has an empty name.' }
  if (CONTROL_CHARS.test(raw))
    return refuse(raw, 'contains NUL or control characters')
  if (raw.includes('\\'))
    return refuse(raw, 'contains a backslash')
  if (raw.startsWith('/'))
    return refuse(raw, 'is an absolute path')
  if (DRIVE_LETTER.test(raw))
    return refuse(raw, 'starts with a drive letter')
  if (raw.includes(':'))
    return refuse(raw, 'contains ":" (drive letters and alternate data streams are not allowed)')

  const trailingSlash = raw.endsWith('/')
  const segments = (trailingSlash ? raw.slice(0, -1) : raw).split('/')
  const kept: string[] = []
  for (const segment of segments) {
    if (segment === '.')
      continue
    if (segment === '')
      return refuse(raw, 'contains an empty path segment')
    if (segment === '..')
      return refuse(raw, 'contains a ".." segment')
    if (Buffer.byteLength(segment, 'utf8') > SEGMENT_MAX_BYTES)
      return refuse(raw, `has a name longer than ${SEGMENT_MAX_BYTES} bytes`)
    if (WINDOWS_DEVICE.test(segment))
      return refuse(raw, 'uses a reserved device name')
    kept.push(segment)
  }
  if (kept.length > PATH_MAX_DEPTH)
    return refuse(raw, `is nested deeper than ${PATH_MAX_DEPTH} levels`)
  const path = kept.join('/')
  if (Buffer.byteLength(path, 'utf8') > PATH_MAX_BYTES)
    return refuse(raw, `is longer than ${PATH_MAX_BYTES} bytes`)
  return { ok: true, path, trailingSlash }
}

/**
 * Comparison key of a path: NFC and lowercase, so two names that would land on the same file on a case- or
 * normalization-insensitive filesystem (macOS, Windows) count as duplicates.
 */
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/** The parent paths of `path` (`a/b/c` -> `a`, `a/b`). */
export function parentPaths(path: string): string[] {
  const segments = path.split('/')
  const parents: string[] = []
  for (let index = 1; index < segments.length; index++)
    parents.push(segments.slice(0, index).join('/'))
  return parents
}
