// Supporting files of plugin skills (Phase 12, ADR-053; ARCHITECTURE.md 6.33 "Skill files"; W12.1-T9): the `skill` tool
// lists the files of a plugin skill's folder and reads one with its `file` input (W12.7 calls these helpers from
// `chat/skills.ts`). `read_file` is not widened to plugin folders.
//
// The rules: `root` is the realpath of an active plugin's folder, `baseDir` the plugin-relative skill folder
// (`SkillDefinition.baseDir`; `.` = the plugin root), `file` a relative path inside that folder (≤ 512 characters).
// Every path resolves through `resolveWorkspacePath` / `openWorkspaceFile` with the plugin realpath as the root, and
// the skill folder itself must resolve to exactly its own path: no links anywhere on the path (the folder's or the
// file's), regular files only, not hidden, not secret-looking (`isSecretLookingPath`), not binary (a NUL byte in the
// first 8 KiB), at most `LIMITS.skillFileReadBytes` read (cut beyond, `truncated`); the list has at most
// `LIMITS.skillFilesListedMax` files, 3 levels deep, in walk order (`SKILL.md` itself, links, hidden and secret-looking
// names, `node_modules` and gitignored paths left out). File contents are never logged.
import type { PluginSkillFile } from './types.ts'
import { Buffer } from 'node:buffer'
import { posix, resolve } from 'node:path'
import { HarnessError, isHarnessError, LIMITS } from '@harness-forge/shared'
import { openWorkspaceFile, resolveWorkspacePath, toWorkspaceRel } from '../../workspace/paths.ts'
import { isHiddenWorkspacePath, isSecretLookingPath } from '../../workspace/sensitive.ts'
import { walkWorkspace } from '../../workspace/walk.ts'

/** Folder levels below a skill folder that the listing enters. */
export const PLUGIN_SKILL_FILES_MAX_DEPTH = 3
/** Directory entries the listing looks at before it stops. */
export const PLUGIN_SKILL_FILES_MAX_ENTRIES = 2000
/** The listing stops after this long. */
export const PLUGIN_SKILL_FILES_TIMEOUT_MS = 2000
/** Characters of a `file` input. */
export const PLUGIN_SKILL_FILE_PATH_MAX_CHARS = 512
/** Bytes checked for a NUL byte (a binary file). */
const BINARY_PROBE_BYTES = 8192
/** The skill file itself (left out of the listing). */
const SKILL_FILE = 'SKILL.md'

function refused(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['file'], message, code: 'custom' }] } })
}

/** The plugin-relative skill folder (`.` or a relative POSIX path), normalized; throws `validation_error` otherwise. */
function skillFolder(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir === '' || baseDir.includes('\0') || baseDir.includes('\\') || baseDir.startsWith('/'))
    throw refused('The skill has no supporting files.')
  const normalized = posix.normalize(baseDir)
  if (normalized === '..' || normalized.startsWith('../'))
    throw refused('The skill has no supporting files.')
  return normalized.replace(/\/+$/, '') || '.'
}

/** Checks the skill folder: inside the plugin and reached without any link (`resolved.rel` equals its spelling). */
async function checkedFolder(root: string, folder: string): Promise<{ absolute: string, rel: string }> {
  const lexical = toWorkspaceRel(root, resolve(root, folder))
  const resolved = await resolveWorkspacePath(root, folder)
  if (resolved.rel !== lexical)
    throw refused('The skill folder goes through a symbolic link; its files are not read.')
  return { absolute: resolved.absolute, rel: resolved.rel }
}

/**
 * The supporting files of the skill folder `baseDir` of the plugin at `root`, relative to the skill folder (POSIX, walk
 * order, `SKILL.md` itself left out). A folder the guard refuses (or a missing one) lists nothing. Rejects only when
 * `signal` aborts.
 */
export async function listPluginSkillFiles(root: string, baseDir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  let folder: { absolute: string, rel: string }
  try {
    folder = await checkedFolder(root, skillFolder(baseDir))
  }
  catch {
    signal?.throwIfAborted()
    return []
  }
  let walk
  try {
    walk = await walkWorkspace({
      root,
      start: folder.absolute,
      ...(signal === undefined ? {} : { signal }),
      maxDepth: PLUGIN_SKILL_FILES_MAX_DEPTH,
      maxEntries: PLUGIN_SKILL_FILES_MAX_ENTRIES,
      timeoutMs: PLUGIN_SKILL_FILES_TIMEOUT_MS,
    })
  }
  catch {
    // A walk that fails (the folder vanished, a permission problem) lists nothing.
    signal?.throwIfAborted()
    return []
  }
  const files: string[] = []
  for (const file of walk.files) {
    if (file.link || file.fromStart === SKILL_FILE)
      continue
    if (isHiddenWorkspacePath(file.fromStart) || isSecretLookingPath(file.fromStart))
      continue
    if (file.fromStart.length > PLUGIN_SKILL_FILE_PATH_MAX_CHARS)
      continue
    files.push(file.fromStart)
    if (files.length >= LIMITS.skillFilesListedMax)
      break
  }
  return files
}

/**
 * One supporting file of the skill folder `baseDir` of the plugin at `root`. Throws `validation_error` for a path the
 * guard refuses (outside the folder, a link, hidden, secret-looking, binary) and `not_found` for a missing file.
 */
export async function readPluginSkillFile(root: string, baseDir: string, file: string, signal?: AbortSignal): Promise<PluginSkillFile> {
  signal?.throwIfAborted()
  if (typeof file !== 'string' || file.trim() === '' || file.length > PLUGIN_SKILL_FILE_PATH_MAX_CHARS || file.includes('\0') || /\p{Cc}/u.test(file))
    throw refused(`Give a file of the skill folder (a relative path of at most ${PLUGIN_SKILL_FILE_PATH_MAX_CHARS} characters).`)
  if (file.includes('\\') || file.startsWith('/') || file.startsWith('~'))
    throw refused('Give a path relative to the skill folder.')
  const inner = posix.normalize(file.trim())
  if (inner === '.' || inner === '..' || inner.startsWith('../'))
    throw refused('The file must be inside the skill folder.')
  if (isHiddenWorkspacePath(inner))
    throw refused('Hidden files of a skill are not read.')
  if (isSecretLookingPath(inner))
    throw refused('The file looks like a secret; it is not read.')
  const folder = await checkedFolder(root, skillFolder(baseDir))
  const rel = folder.rel === '.' ? inner : `${folder.rel}/${inner}`
  const lexical = toWorkspaceRel(root, resolve(root, rel))
  if (lexical !== rel)
    throw refused('The file must be inside the skill folder.')
  let opened
  try {
    const resolved = await resolveWorkspacePath(root, rel)
    if (resolved.rel !== rel)
      throw refused('The file is a symbolic link or goes through one; it is not read.')
    opened = await openWorkspaceFile(root, rel)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      throw new HarnessError({ code: 'not_found', message: `The skill file ${inner.slice(0, PLUGIN_SKILL_FILE_PATH_MAX_CHARS)} was not found.` })
    if (isHarnessError(error))
      throw refused(error.message)
    throw error
  }
  try {
    if (opened.resolved.rel !== rel)
      throw refused('The file is a symbolic link or goes through one; it is not read.')
    const cap = LIMITS.skillFileReadBytes
    const buffer = Buffer.alloc(cap + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
    }
    if (buffer.subarray(0, Math.min(length, BINARY_PROBE_BYTES)).includes(0))
      throw refused('The file is binary; it is not read.')
    const truncated = length > cap
    let bytes = buffer.subarray(0, Math.min(length, cap))
    if (truncated) {
      // Never cut inside a UTF-8 sequence.
      let lead = bytes.length - 1
      while (lead > 0 && (bytes[lead]! & 0xC0) === 0x80)
        lead -= 1
      const first = bytes[lead]!
      const size = first >= 0xF0 ? 4 : first >= 0xE0 ? 3 : first >= 0xC0 ? 2 : 1
      if (lead + size > bytes.length)
        bytes = bytes.subarray(0, lead)
    }
    return { path: inner, content: new TextDecoder('utf-8').decode(bytes), truncated: truncated || opened.stats.size > cap }
  }
  finally {
    await opened.handle.close().catch(() => {})
  }
}
