// Removing one file of the project (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Rewind" step 4). Owner: W8.2. The only way
// the restore primitive (`services/checkpoints/restore.ts`: rewind, revert, undo) deletes a file the chat created.
//
// `removeWorkspaceFile(root, input)`: the path resolves through the frozen guard (`resolveWorkspacePath`, no missing
// tail: a missing file is `not_found`), a `.git` segment (of the input or of the resolved path) is refused, the entry
// itself is `lstat`ed and must be a regular file (a folder, a symbolic link, a FIFO or a device is refused: a link is
// never followed, so removing a link can never delete its target), then it is unlinked. Folders are never removed (a
// folder the agent created stays). Callers hold the file's lock (`withFileLock`).
import { lstat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessError } from '@harness-forge/shared'
import { hasGitSegment, resolveWorkspacePath, toWorkspaceRel, workspacePathError } from './paths.ts'

/** Result of `removeWorkspaceFile`. */
export interface WorkspaceRemoveResult {
  /** The realpath of the removed file. */
  readonly absolute: string
  /** Project-relative POSIX path of the removed file. */
  readonly rel: string
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/**
 * Removes one regular file of the project folder `root` (a canonical realpath). Throws `validation_error` (issue path
 * `['path']`) for a refused path and `not_found` for a missing file; other file system errors (permission denied on the
 * folder, a read-only file system) reject as they are.
 */
export async function removeWorkspaceFile(root: string, input: string): Promise<WorkspaceRemoveResult> {
  const lexical = resolve(root, input)
  const shown = toWorkspaceRel(root, lexical)
  // The spelling first (also a `.GIT` that does not exist on a case-sensitive file system), then the resolved path.
  if (hasGitSegment(shown))
    throw workspacePathError(`"${shown}" is inside a .git folder: the workspace tools never write there.`)
  const resolved = await resolveWorkspacePath(root, input)
  if (hasGitSegment(resolved.rel))
    throw workspacePathError(`"${shown}" is inside a .git folder: the workspace tools never write there.`)
  if (resolved.rel === '.')
    throw workspacePathError('The path names the project folder, not a file.')

  // The entry itself (never followed): a link resolves to its target above, so it is checked here by name.
  let entry
  try {
    entry = await lstat(lexical)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new HarnessError({ code: 'not_found', message: `"${shown}" does not exist in the project folder.` })
    throw error
  }
  if (entry.isSymbolicLink())
    throw workspacePathError(`"${shown}" is a symbolic link: only regular files are removed.`)
  if (entry.isDirectory())
    throw workspacePathError(`"${shown}" is a folder, not a file.`)
  if (!entry.isFile())
    throw workspacePathError(`"${shown}" is not a regular file.`)

  // The real location of the same file (a folder above it may be a link inside the project).
  const real = await lstat(resolved.absolute)
  if (!real.isFile() || real.ino !== entry.ino || real.dev !== entry.dev)
    throw workspacePathError(`"${shown}" changed while it was removed.`)
  try {
    await unlink(resolved.absolute)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT')
      throw new HarnessError({ code: 'not_found', message: `"${shown}" does not exist in the project folder.` })
    // A write error (permission denied, a read-only file system): the caller reports it as failed.
    throw error
  }
  return { absolute: resolved.absolute, rel: resolved.rel }
}
