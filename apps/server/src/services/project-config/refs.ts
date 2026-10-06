// Guarded reads of project config files and the referenced script files of executable items (Phase 11, ADR-049;
// ARCHITECTURE.md 6.29). Owner: W11.3.
//
// - `readProjectConfigFile(root, rel, maxBytes)`: one of the four settings files or `.mcp.json`. `resolveWorkspacePath`
//   must resolve to exactly `rel` (no link anywhere on the path), `openWorkspaceFile` opens it with
//   `O_NOFOLLOW | O_NONBLOCK` and `fstat` proves a regular file; at most `maxBytes` are read (one more tells a larger
//   file, also one that grew while it was read), decoded as UTF-8. Never throws; the reason of a refusal is returned.
// - `hashTrustRefs(root, paths)`: the sha256 of each referenced script file through the same guard; null for a
//   secret-looking name, a link on the path, a missing or non-regular file, a file over `TRUST_LIMITS.refFileBytes` or a
//   read failure. Rejects only when `signal` aborts.
// - The reference paths of each item kind (`hookRefPaths`, `mcpRefPaths`, `commandTrustRefPaths`) and
//   `commandTrustSubject` (the trust subject of a project command file with `` !`cmd` `` spans), shared with the
//   command resolution (W11.5) so both compute the same hash: `{ kind: 'command', name, spans, refs }`, refs = the
//   `extractCommandFileRefs` of each span in order, first seen kept, at most 8.
//
// Accepted race (ARCHITECTURE.md 10.12): a parent folder swapped for a link between the check and the open of a file
// below it (`O_NOFOLLOW` protects the last segment only). Nothing here logs a path's content.
import type { TrustHashItem, TrustRef } from '@harness-forge/shared'
import type { OpenedWorkspaceFile } from '../../workspace/paths.ts'
import type { TrustSubject } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { extractArgsFileRefs, extractCommandFileRefs, isHarnessError, TRUST_LIMITS, trustHashInput } from '@harness-forge/shared'
import { openWorkspaceFile, resolveWorkspacePath } from '../../workspace/paths.ts'
import { isSecretLookingPath } from '../../workspace/sensitive.ts'

/** The opener of project files (`openWorkspaceFile`; a test seam). */
export type OpenProjectFile = (root: string, rel: string) => Promise<OpenedWorkspaceFile>

/** Why a project file was not read. */
export type ProjectFileReadFailure = 'missing' | 'link' | 'not-file' | 'too-large' | 'failed'

export type ProjectFileBytes
  = | { readonly ok: true, readonly bytes: Buffer }
    | { readonly ok: false, readonly reason: ProjectFileReadFailure }

export type ProjectFileText
  = | { readonly ok: true, readonly text: string }
    | { readonly ok: false, readonly reason: ProjectFileReadFailure }

/** The trust hash of an item: sha256 (lowercase hex) of the shared canonical `trustHashInput(item)`. */
export function trustSha256(item: TrustHashItem): string {
  return createHash('sha256').update(trustHashInput(item), 'utf8').digest('hex')
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/** True when an existing segment of `rel` below `root` is a symbolic link (`lstat` never follows one). */
async function linkOnPath(root: string, rel: string): Promise<boolean> {
  let current = root
  for (const segment of rel.split('/')) {
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink())
        return true
    }
    catch {
      return false
    }
  }
  return false
}

/** The reason of a refused resolve or open: missing, a link somewhere on the path, else a failure. */
async function failureOf(root: string, rel: string, error: unknown): Promise<ProjectFileReadFailure> {
  if (await linkOnPath(root, rel))
    return 'link'
  if ((isHarnessError(error) && error.code === 'not_found') || errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
    return 'missing'
  if (isHarnessError(error) && /not a (?:regular )?file|is a folder/.test(error.message))
    return 'not-file'
  return 'failed'
}

/**
 * Reads the bytes of a project file `rel` (a project-relative POSIX path the caller built or normalized) below the
 * canonical project root `root` through the workspace guards; at most `maxBytes`. Never throws.
 */
export async function readProjectFileBytes(root: string, rel: string, maxBytes: number, openFile: OpenProjectFile = openWorkspaceFile): Promise<ProjectFileBytes> {
  try {
    const resolved = await resolveWorkspacePath(root, rel)
    if (resolved.rel !== rel)
      return { ok: false, reason: 'link' }
  }
  catch (error) {
    return { ok: false, reason: await failureOf(root, rel, error) }
  }
  let opened: OpenedWorkspaceFile
  try {
    opened = await openFile(root, rel)
  }
  catch (error) {
    return { ok: false, reason: await failureOf(root, rel, error) }
  }
  try {
    if (opened.resolved.rel !== rel)
      return { ok: false, reason: 'link' }
    if (!opened.stats.isFile())
      return { ok: false, reason: 'not-file' }
    const cap = Math.max(0, Math.floor(maxBytes))
    if (opened.stats.size > cap)
      return { ok: false, reason: 'too-large' }
    // One byte more than allowed tells a file that grew past the cap while it was read.
    const buffer = Buffer.alloc(cap + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
    }
    if (length > cap)
      return { ok: false, reason: 'too-large' }
    return { ok: true, bytes: buffer.subarray(0, length) }
  }
  catch {
    return { ok: false, reason: 'failed' }
  }
  finally {
    await opened.handle.close().catch(() => {})
  }
}

/** Reads a project config file (a settings file, `.mcp.json`) as UTF-8 text; see `readProjectFileBytes`. */
export async function readProjectConfigFile(root: string, rel: string, maxBytes: number, openFile?: OpenProjectFile): Promise<ProjectFileText> {
  const read = await readProjectFileBytes(root, rel, maxBytes, openFile)
  if (!read.ok)
    return read
  return { ok: true, text: new TextDecoder('utf-8').decode(read.bytes) }
}

/** The sha256 of one referenced file, or null (see the module comment). */
async function hashRef(root: string, path: string, openFile: OpenProjectFile | undefined): Promise<string | null> {
  if (isSecretLookingPath(path))
    return null
  const read = await readProjectFileBytes(root, path, TRUST_LIMITS.refFileBytes, openFile)
  return read.ok ? createHash('sha256').update(read.bytes).digest('hex') : null
}

/** Options of the ref hashing (a per-build memo of file hashes, a test opener). */
export interface HashTrustRefsOptions {
  readonly signal?: AbortSignal
  /** Hashes already computed in this build, by path (shared by the items of one snapshot). */
  readonly memo?: Map<string, Promise<string | null>>
  readonly openFile?: OpenProjectFile
}

/**
 * The referenced files `paths` (project-relative, as `extractCommandFileRefs` / `extractArgsFileRefs` return them)
 * with their sha256 (null = missing, linked, not a regular file, larger than 1 MiB, secret-looking or unreadable), in
 * the order given, at most `TRUST_LIMITS.refFilesMax`. Rejects only when the signal aborts.
 */
export async function hashTrustRefs(root: string, paths: readonly string[], signalOrOptions?: AbortSignal | HashTrustRefsOptions): Promise<TrustRef[]> {
  const options: HashTrustRefsOptions = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : (signalOrOptions ?? {})
  options.signal?.throwIfAborted()
  const unique = [...new Set(paths)].slice(0, TRUST_LIMITS.refFilesMax)
  const refs = await Promise.all(unique.map(async (path) => {
    let pending = options.memo?.get(path)
    if (pending === undefined) {
      pending = hashRef(root, path, options.openFile)
      options.memo?.set(path, pending)
    }
    return { path, sha256: await pending }
  }))
  options.signal?.throwIfAborted()
  return refs
}

/** The script files a hook command names. */
export function hookRefPaths(command: string): string[] {
  return extractCommandFileRefs(command)
}

/** The script files a `.mcp.json` server names (stdio: its command, then its args; remote servers name none). */
export function mcpRefPaths(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return []
  const server = raw as Record<string, unknown>
  if (typeof server.command !== 'string')
    return []
  const args = Array.isArray(server.args) ? (server.args as unknown[]).filter((arg): arg is string => typeof arg === 'string') : []
  return extractArgsFileRefs([server.command.trim(), ...args])
}

/**
 * The script files the `` !`cmd` `` spans of a command file name: `extractCommandFileRefs` of each span in order, the
 * first occurrence kept, at most `TRUST_LIMITS.refFilesMax`.
 */
export function commandTrustRefPaths(spans: readonly string[]): string[] {
  const paths: string[] = []
  for (const span of spans) {
    for (const path of extractCommandFileRefs(span)) {
      if (paths.length >= TRUST_LIMITS.refFilesMax)
        return paths
      if (!paths.includes(path))
        paths.push(path)
    }
  }
  return paths
}

/**
 * The trust subject of a project command file with `` !`cmd` `` spans (ADR-052): `{ kind: 'command', name, spans,
 * refs }` with the referenced files hashed now; `name` is the catalog command name (no slash, no namespace).
 */
export async function commandTrustSubject(root: string, name: string, spans: readonly string[], signalOrOptions?: AbortSignal | HashTrustRefsOptions): Promise<TrustSubject> {
  const refs = await hashTrustRefs(root, commandTrustRefPaths(spans), signalOrOptions)
  const hashItem: TrustHashItem = { kind: 'command', name, spans: [...spans], refs }
  return { kind: 'command', sha256: trustSha256(hashItem), hashItem }
}

/** The reference paths an item's own fields imply (verify re-derives them, so a subject can never drop a file). */
export function refPathsOf(hashItem: TrustHashItem): string[] {
  switch (hashItem.kind) {
    case 'hook':
      // A prompt hook (Phase 12) has no command and names no file.
      return hashItem.command === null ? [] : hookRefPaths(hashItem.command)
    case 'mcp':
      return mcpRefPaths(hashItem.server)
    case 'command':
      return commandTrustRefPaths(hashItem.spans)
  }
}
