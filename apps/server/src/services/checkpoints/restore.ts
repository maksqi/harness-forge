// The restore primitive of revert, rewind and undo (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Rewind" step 4). Owner:
// W8.2 (C19 stub).
//
// `applyRestore(deps, plan, { kind, batchId, conflicts })`: files newest-edited first; per file, under its lock
// (`withFileLock`): read the current state again (`readCheckpointBefore`) and re-check the conflict against
// `expectedSha` (skipped unless `conflicts: 'force'`), snapshot it (the blob through `deps.blobs.put` and a row of the
// batch kind with the batch id through `deps.rows.insert`, the store gate held shared from the blob write to the row
// insert), then write the target (`writeWorkspaceFile`, plus `chmod(mode)` when the file is re-created) or remove it
// (`workspace/remove.ts`). A failure is `skipped` with `failed` and the batch continues; created folders stay;
// `batchId: null` in the result when nothing was written.
import type { ConflictHandling, RestoreResult } from '@harness-forge/shared'
import type { WorkspaceWriteResult } from '../../workspace/paths.ts'
import type { RestorePlan } from './plan.ts'
import type { CheckpointContext } from './types.ts'
import { notImplementedError } from '../../not-implemented.ts'

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

/** Applies a plan as one batch (see the module comment). */
export async function applyRestore(_deps: RestoreDeps, _plan: RestorePlan, _options: RestoreOptions): Promise<RestoreResult> {
  throw notImplementedError('Restoring files')
}
