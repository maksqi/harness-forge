// The restore primitive of revert, rewind and undo (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Rewind" step 4). Owner:
// W8.2.
//
// `applyRestore(deps, plan, { kind, batchId, conflicts })`: files newest-edited first (the plan's order); per file:
//   1. an `unavailable` target (`too-large` / `evicted`) is skipped as `unavailable`;
//   2. the path resolves through the frozen guard (`allowMissing`); a `.git` segment, a path that now goes through a
//      symbolic link (its resolved path is another one) and any refusal of the guard are skipped as `refused`;
//   3. under the file's lock (`withFileLock`, shared with the agent tools): the current state is read again
//      (`readCheckpointBefore`; a file over 8 MiB is hashed by streaming) and decided again: already at the target ->
//      `unchanged`; a disk other than `expectedSha` -> skipped as `conflict` unless `conflicts: 'force'`; a stored
//      target is read from the blob store and verified (a missing or damaged blob -> `unavailable`);
//   4. holding the store gate shared from the blob write to the row insert: the current state is snapshotted (its blob
//      through `deps.blobs.put`; `missing` / `too-large` keep no blob), the target is written (`writeWorkspaceFile`;
//      the before mode is applied when the file is re-created, a git target sets the executable bits like a checkout)
//      or the file is removed (`workspace/remove.ts`), and one row of the batch kind with the batch id is inserted
//      (before = the snapshot, after = the target).
// A failure is skipped as `failed` (a write error) or `refused` (the guard) and the batch continues; folders created
// by the agent stay. There is no multi-file transaction: every write is atomic and journaled right after it, so running
// the operation again resumes it and undoing a partial batch works. `batchId: null` in the result when nothing was
// written. A row that cannot be inserted after a successful write is logged (`restore not recorded`, warn, no path at
// `info`): the file stays written and is listed.
import type { ConflictHandling, RestoreResult, RestoreSkip } from '@harness-forge/shared'
import type { ResolvedWorkspacePath, WorkspaceWriteResult } from '../../workspace/paths.ts'
import type { DiskSha } from './disk.ts'
import type { RestorePlan, RestorePlanFile, RestoreTarget } from './plan.ts'
import type { CheckpointBefore, CheckpointContext } from './types.ts'
import { open } from 'node:fs/promises'
import { isHarnessError } from '@harness-forge/shared'
import { withFileLock } from '../../workspace/file-lock.ts'
import { hasGitSegment, resolveWorkspacePath, WORKSPACE_READ_FLAGS, writeWorkspaceFile } from '../../workspace/paths.ts'
import { removeWorkspaceFile } from '../../workspace/remove.ts'
import { diskSha, readCheckpointBefore, sha256Hex } from './disk.ts'
import { targetSha } from './plan.ts'

/** The chat, its project folder and the store a restore works on. */
export interface RestoreDeps extends CheckpointContext {
  readonly chatId: string
  /** The chat's current project (the rows' `project_id`). */
  readonly projectId: string
  /** The project folder (`openWorkspace`, canonical). */
  readonly root: string
  /** Writes one file (default: the frozen `writeWorkspaceFile`); tests inject a writer that fails after file N. */
  readonly writeFile?: (root: string, path: string, data: Uint8Array) => Promise<WorkspaceWriteResult>
  /** Removes one regular file (default: `workspace/remove.ts`). */
  readonly removeFile?: (root: string, path: string) => Promise<void>
}

export interface RestoreOptions {
  /** The kind of every row of the batch. */
  readonly kind: 'revert' | 'rewind' | 'undo'
  /** `wcb_` id of the batch (`createChangeBatchId()`). */
  readonly batchId: string
  readonly conflicts: ConflictHandling
}

type FileOutcome
  = | { readonly kind: 'restored' | 'deleted' | 'unchanged' }
    | { readonly kind: 'skipped', readonly skip: RestoreSkip }

function skipped(path: string, reason: RestoreSkip['reason'], message: string): FileOutcome {
  return { kind: 'skipped', skip: { path, reason, message } }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/**
 * A failure of one file: the path guard's refusals (`validation_error`, their messages are safe to show) are
 * `refused`; anything else is `failed` with the error code only (a system message can carry absolute paths).
 */
function failure(deps: RestoreDeps, path: string, error: unknown, what: 'read' | 'write'): FileOutcome {
  if (isHarnessError(error) && error.code === 'validation_error')
    return skipped(path, 'refused', error.message)
  const code = isHarnessError(error) ? error.code : errorCode(error) ?? 'unknown'
  deps.deps.logger.warn('restore write failed', { chatId: deps.chatId, code })
  deps.deps.logger.debug('restore write failed: path', { path, code })
  return skipped(path, 'failed', `"${path}" could not be ${what === 'read' ? 'read' : 'written'} (${code}).`)
}

function unavailableMessage(path: string, reason: 'too-large' | 'evicted'): string {
  return reason === 'too-large'
    ? `The earlier state of "${path}" was not stored: the file was larger than 8 MiB.`
    : `The earlier state of "${path}" is no longer stored (it was removed to save space).`
}

/** The disk sha of the state read under the lock (a file over the snapshot cap is hashed by streaming). */
async function currentShaOf(root: string, path: string, before: CheckpointBefore): Promise<DiskSha> {
  if (before.state === 'present')
    return before.sha
  if (before.state === 'missing')
    return null
  return diskSha(root, path)
}

/** The executable bits of a git target applied to `mode` (like a checkout: `x` wherever `r` is set, or none). */
function gitMode(mode: number, treeMode: number): number {
  const executable = (treeMode & 0o111) !== 0
  return executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111
}

/** The mode the written file should have, or null to keep the one the write left. */
function wantedMode(target: RestoreTarget, written: WorkspaceWriteResult): number | null {
  if (target.kind === 'stored')
    return written.created && target.mode !== null ? target.mode & 0o7777 : null
  if (target.kind === 'bytes' && target.mode !== null)
    return gitMode(written.mode, target.mode)
  return null
}

/** `fchmod` through a descriptor opened without following a final link (a link swapped in is never followed). */
async function setMode(absolute: string, mode: number): Promise<void> {
  const handle = await open(absolute, WORKSPACE_READ_FLAGS)
  try {
    if ((await handle.stat()).isFile())
      await handle.chmod(mode)
  }
  finally {
    await handle.close()
  }
}

/** The bytes a target writes: null = remove; `unavailable` when a stored blob is gone or damaged. */
async function targetBytes(deps: RestoreDeps, target: RestoreTarget): Promise<Uint8Array | null | 'unavailable'> {
  if (target.kind === 'bytes')
    return target.bytes
  if (target.kind === 'missing')
    return null
  if (target.kind !== 'stored')
    return 'unavailable'
  let blob
  try {
    blob = await deps.blobs.read(target.sha)
  }
  catch {
    return 'unavailable'
  }
  if (blob === null || sha256Hex(blob) !== target.sha)
    return 'unavailable'
  return blob
}

/** The before-state columns of the snapshot row (the blob is saved by the caller for `present`). */
function snapshotColumns(before: CheckpointBefore, sha: DiskSha) {
  switch (before.state) {
    case 'present':
      return { beforeState: 'stored' as const, beforeSha: before.sha, beforeSize: before.size, beforeMode: before.mode }
    case 'too-large':
      return { beforeState: 'too-large' as const, beforeSha: typeof sha === 'string' ? sha : null, beforeSize: before.size, beforeMode: before.mode }
    default:
      return { beforeState: 'missing' as const, beforeSha: null, beforeSize: null, beforeMode: null }
  }
}

/** Steps 3 – 4 for one file, holding its lock. */
async function restoreLocked(deps: RestoreDeps, file: RestorePlanFile, locked: ResolvedWorkspacePath, options: RestoreOptions): Promise<FileOutcome> {
  const { root } = deps
  const { path, target } = file
  let before: CheckpointBefore
  let current: DiskSha
  try {
    // Resolved again under the lock: a file created (or a link swapped in) since the first resolution is seen, so it
    // is never overwritten without a snapshot.
    const resolved = await resolveWorkspacePath(root, path, { allowMissing: true })
    if (resolved.absolute !== locked.absolute || resolved.rel !== path)
      return skipped(path, 'refused', `"${path}" changed while it was restored.`)
    before = await readCheckpointBefore(root, resolved)
    current = await currentShaOf(root, path, before)
  }
  catch (error) {
    return failure(deps, path, error, 'read')
  }
  if (current === 'unreadable')
    return skipped(path, 'refused', `"${path}" is not a regular file.`)

  const goal = targetSha(target)
  const modeOnly = target.kind === 'bytes' && target.mode !== null && before.state !== 'missing'
    && gitMode(before.mode, target.mode) !== before.mode
  if (current === goal && !modeOnly)
    return { kind: 'unchanged' }
  if (file.expectedSha !== undefined && current !== file.expectedSha && options.conflicts !== 'force')
    return skipped(path, 'conflict', `"${path}" changed after the chat's last recorded change.`)

  const data = await targetBytes(deps, target)
  if (data === 'unavailable')
    return skipped(path, 'unavailable', unavailableMessage(path, 'evicted'))
  const writeFile = deps.writeFile ?? writeWorkspaceFile
  const removeFile = deps.removeFile ?? (async (folder: string, rel: string) => {
    await removeWorkspaceFile(folder, rel)
  })

  return deps.blobs.withSharedGate(async (): Promise<FileOutcome> => {
    // 4a. Snapshot the current state first: without it the write could not be undone.
    try {
      if (before.state === 'present')
        await deps.blobs.put(before.bytes)
    }
    catch (error) {
      return failure(deps, path, error, 'write')
    }
    // 4b. Write the target or remove the file.
    try {
      if (data === null) {
        await removeFile(root, path)
      }
      else {
        const written = await writeFile(root, path, data)
        const mode = wantedMode(target, written)
        if (mode !== null && mode !== written.mode)
          await setMode(written.absolute, mode)
      }
    }
    catch (error) {
      return failure(deps, path, error, 'write')
    }
    // 4c. Journal it right away under the batch id.
    try {
      await deps.rows.insert({
        chatId: deps.chatId,
        projectId: deps.projectId,
        kind: options.kind,
        batchId: options.batchId,
        path,
        ...snapshotColumns(before, current),
        afterSha: data === null ? null : sha256Hex(data),
        afterSize: data === null ? null : data.byteLength,
      })
    }
    catch (error) {
      deps.deps.logger.warn('restore not recorded', { chatId: deps.chatId, batchId: options.batchId, code: isHarnessError(error) ? error.code : errorCode(error) ?? 'unknown' })
      deps.deps.logger.debug('restore not recorded: path', { path })
    }
    return { kind: data === null ? 'deleted' : 'restored' }
  })
}

/** Steps 1 – 4 for one file. */
async function restoreFile(deps: RestoreDeps, file: RestorePlanFile, options: RestoreOptions): Promise<FileOutcome> {
  const { path, target } = file
  if (target.kind === 'unavailable')
    return skipped(path, 'unavailable', unavailableMessage(path, target.reason))
  let resolved: ResolvedWorkspacePath
  try {
    resolved = await resolveWorkspacePath(deps.root, path, { allowMissing: true })
  }
  catch (error) {
    return failure(deps, path, error, 'read')
  }
  if (hasGitSegment(path) || hasGitSegment(resolved.rel))
    return skipped(path, 'refused', `"${path}" is inside a .git folder: it is never written.`)
  if (resolved.rel !== path)
    return skipped(path, 'refused', `"${path}" now leads through a symbolic link.`)
  return withFileLock(resolved.absolute, () => restoreLocked(deps, file, resolved, options))
}

/** Applies a plan as one batch (see the module comment). */
export async function applyRestore(deps: RestoreDeps, plan: RestorePlan, options: RestoreOptions): Promise<RestoreResult> {
  const restored: string[] = []
  const deleted: string[] = []
  const unchanged: string[] = []
  const skips: RestoreSkip[] = []
  for (const file of plan.files) {
    const outcome = await restoreFile(deps, file, options)
    switch (outcome.kind) {
      case 'restored':
        restored.push(file.path)
        break
      case 'deleted':
        deleted.push(file.path)
        break
      case 'unchanged':
        unchanged.push(file.path)
        break
      default:
        skips.push(outcome.skip)
    }
  }
  const wrote = restored.length + deleted.length > 0
  return { batchId: wrote ? options.batchId : null, restored, deleted, unchanged, skipped: skips }
}
