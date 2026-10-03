// The restore planner (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Rewind" step 2). Owner: W8.2 (C19 stub). Pure: no I/O,
// no clock; the callers read the rows (`rewind.ts`, `undo.ts`, `revert.ts`) and the disk (`diskShas` of ./disk.ts).
//
// Per path: **target** = the before-state of the earliest row in the range, **expected** = the after-state of the
// latest row, **current** = the disk. Actions: `unchanged` (current = target), `restore`, `delete` (the target is
// missing), `unavailable` (the target is `too-large` or `evicted`). Conflict = current != expected. Rows of another
// project are ignored (the callers pass the chat's current project). Idempotent: a second plan after an apply sees the
// apply's own rows and every file comes out `unchanged`. Files are ordered newest-edited first (the order of the
// restore and of the preview).
import type { RewindAction } from '@harness-forge/shared'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { DiskSha } from './disk.ts'
import { notImplementedError } from '../../not-implemented.ts'

/** What a restore writes back to one path. */
export type RestoreTarget
  = | { readonly kind: 'stored', readonly sha: string, readonly size: number, readonly mode: number | null }
    | { readonly kind: 'bytes', readonly bytes: Uint8Array, readonly mode: number | null }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unavailable', readonly reason: 'too-large' | 'evicted' }

/** One path of a plan. */
export interface RestorePlanFile {
  /** Project-relative POSIX path. */
  readonly path: string
  readonly action: RewindAction
  /** The disk differs from `expectedSha` (skipped unless `conflicts: 'force'`). */
  readonly conflict: boolean
  /** Rows of this path in the range. */
  readonly edits: number
  /**
   * The before-state of the earliest row (`stored`: a blob of the store; `bytes`: content given directly, e.g. the HEAD
   * blob of a git revert; `missing`: delete the file).
   */
  readonly target: RestoreTarget
  /**
   * The disk state the latest recorded change left (`after_sha`; null = it removed the file). The restore re-checks the
   * disk against it under the lock; `undefined` = no check (a git revert without `expectedSha`).
   */
  readonly expectedSha?: string | null
  /** The disk when the plan was made. */
  readonly current: DiskSha
  /** `created_at` of the latest row (the newest-edited-first order). */
  readonly lastEditAt: number
}

export interface RestorePlan {
  /** Every path of the range, newest-edited first. */
  readonly files: readonly RestorePlanFile[]
}

/**
 * The plan of a rewind (and of a `chat` revert, with the rows of one path): `rows` are the file rows of the range
 * (`message_seq >=` the target message's seq, the chat's current project, every kind but `shell` / `untracked`), in any
 * order; `current` maps each path to its disk sha.
 */
export function planRewind(_rows: readonly WorkspaceChangeRow[], _current: ReadonlyMap<string, DiskSha>): RestorePlan {
  throw notImplementedError('Planning a rewind')
}

/**
 * The plan of an undo: `rows` are the rows of one batch; the target of each path is the before-state of its row, the
 * expected state its after-state.
 */
export function planUndo(_rows: readonly WorkspaceChangeRow[], _current: ReadonlyMap<string, DiskSha>): RestorePlan {
  throw notImplementedError('Planning an undo')
}
