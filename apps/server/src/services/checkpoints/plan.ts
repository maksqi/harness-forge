// The restore planner (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Rewind" step 2). Owner: W8.2. Pure: no I/O, no clock;
// the callers read the rows (`rewind.ts`, `undo.ts`, `revert.ts`) and the disk (`diskShas` of ./disk.ts).
//
// Per path: **target** = the before-state of the earliest row in the range, **expected** = the after-state of the
// latest row, **current** = the disk. Actions: `unchanged` (current = target), `restore`, `delete` (the target is
// missing), `unavailable` (the target is `too-large` or `evicted`). Conflict = current != expected (never set for an
// `unchanged` file: nothing is written there). Rows of another project are ignored (the callers pass the chat's current
// project). Idempotent: a second plan after an apply sees the apply's own rows and every file comes out `unchanged`.
// Files are ordered newest-edited first (the order of the restore and of the preview): by the id of their latest row
// (the global journal order), which `lastEditAt` follows.
//
// `applyRestore` (./restore.ts) re-reads every file under its lock and decides again from `target` and `expectedSha`:
// `action`, `conflict` and `current` describe the disk when the plan was made (the preview).
import type { RewindAction } from '@harness-forge/shared'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { DiskSha } from './disk.ts'
import { sha256Hex } from './disk.ts'

/** What a restore writes back to one path. */
export type RestoreTarget
  = | {
    readonly kind: 'stored'
    /** The blob (the before-state of a journal row). */
    readonly sha: string
    readonly size: number
    /** The permission bits of the before-state: applied when the restore re-creates the file. */
    readonly mode: number | null
  }
  | {
    readonly kind: 'bytes'
    /** Content given directly (the HEAD blob of a git revert). */
    readonly bytes: Uint8Array
    /**
     * The git tree mode bits (`0o755` for `100755`, `0o644` for `100644`): only the executable bits are applied (to
     * the mode the write left), like a git checkout; null = keep the mode.
     */
    readonly mode: number | null
  }
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

/** The row kinds that change a file (the rest, `shell` / `untracked`, have no path and are never restored). */
export const FILE_ROW_KINDS: readonly string[] = Object.freeze(['edit', 'revert', 'rewind', 'undo'])

/** True for a journal row that changed one file (a path and a file kind). */
export function isFileRow(row: WorkspaceChangeRow): boolean {
  return row.path !== null && row.path !== '' && FILE_ROW_KINDS.includes(row.kind)
}

/** The target of a restore to the before-state of `row`. */
export function beforeTarget(row: WorkspaceChangeRow): RestoreTarget {
  switch (row.beforeState) {
    case 'missing':
      return { kind: 'missing' }
    case 'stored':
      // A stored row always has its sha and size; a damaged row cannot be restored.
      if (row.beforeSha === null || row.beforeSize === null)
        return { kind: 'unavailable', reason: 'evicted' }
      return { kind: 'stored', sha: row.beforeSha, size: row.beforeSize, mode: row.beforeMode }
    case 'too-large':
      return { kind: 'unavailable', reason: 'too-large' }
    default:
      return { kind: 'unavailable', reason: 'evicted' }
  }
}

/** The sha a target leaves on disk (null = no file); undefined for an unavailable target. */
export function targetSha(target: RestoreTarget): string | null | undefined {
  switch (target.kind) {
    case 'stored':
      return target.sha
    case 'bytes':
      return sha256Hex(target.bytes)
    case 'missing':
      return null
    default:
      return undefined
  }
}

/** The action for a target against the disk. */
export function restoreAction(target: RestoreTarget, current: DiskSha): RewindAction {
  if (target.kind === 'unavailable')
    return 'unavailable'
  if (current === targetSha(target))
    return 'unchanged'
  return target.kind === 'missing' ? 'delete' : 'restore'
}

/** One planned file from a target, its expected state and the disk (`conflict` is never set for `unchanged`). */
export function planFile(input: {
  path: string
  target: RestoreTarget
  expectedSha?: string | null
  current: DiskSha
  edits: number
  lastEditAt: number
}): RestorePlanFile {
  const action = restoreAction(input.target, input.current)
  const conflict = action !== 'unchanged' && input.expectedSha !== undefined && input.current !== input.expectedSha
  return {
    path: input.path,
    action,
    conflict,
    edits: input.edits,
    target: input.target,
    ...(input.expectedSha === undefined ? {} : { expectedSha: input.expectedSha }),
    current: input.current,
    lastEditAt: input.lastEditAt,
  }
}

interface PathRows {
  readonly path: string
  readonly earliest: WorkspaceChangeRow
  readonly latest: WorkspaceChangeRow
  readonly count: number
}

/** The file rows grouped by path: the earliest and latest row by id, newest-edited path first. */
export function groupByPath(rows: readonly WorkspaceChangeRow[]): PathRows[] {
  const groups = new Map<string, { earliest: WorkspaceChangeRow, latest: WorkspaceChangeRow, count: number }>()
  for (const row of rows) {
    if (!isFileRow(row))
      continue
    const path = row.path!
    const group = groups.get(path)
    if (group === undefined) {
      groups.set(path, { earliest: row, latest: row, count: 1 })
      continue
    }
    group.count += 1
    if (row.id < group.earliest.id)
      group.earliest = row
    if (row.id > group.latest.id)
      group.latest = row
  }
  return [...groups].map(([path, group]) => ({ path, ...group })).sort((a, b) => b.latest.id - a.latest.id || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Paths of the file rows, newest-edited first (what a preview lists before it reads the disk). */
export function orderedPaths(rows: readonly WorkspaceChangeRow[]): string[] {
  return groupByPath(rows).map(group => group.path)
}

function planGroups(groups: readonly PathRows[], current: ReadonlyMap<string, DiskSha>): RestorePlan {
  return {
    files: groups.map(group => planFile({
      path: group.path,
      target: beforeTarget(group.earliest),
      expectedSha: group.latest.afterSha,
      current: current.has(group.path) ? current.get(group.path)! : null,
      edits: group.count,
      lastEditAt: group.latest.createdAt,
    })),
  }
}

/**
 * The plan of a rewind (and of a `chat` revert, with the rows of one path): `rows` are the file rows of the range
 * (`message_seq >=` the target message's seq, the chat's current project, every kind but `shell` / `untracked`), in any
 * order; `current` maps each path to its disk sha (a path without an entry counts as missing).
 */
export function planRewind(rows: readonly WorkspaceChangeRow[], current: ReadonlyMap<string, DiskSha>): RestorePlan {
  return planGroups(groupByPath(rows), current)
}

/**
 * The plan of an undo: `rows` are the rows of one batch; the target of each path is the before-state of its row, the
 * expected state its after-state (a batch writes each path once; with several rows of one path, the earliest
 * before-state and the latest after-state count, as in a rewind).
 */
export function planUndo(rows: readonly WorkspaceChangeRow[], current: ReadonlyMap<string, DiskSha>): RestorePlan {
  return planGroups(groupByPath(rows), current)
}
