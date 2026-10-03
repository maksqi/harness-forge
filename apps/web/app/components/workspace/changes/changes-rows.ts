// Pure helpers of the changes panel (docs/UI.md 7.21, 11.5; ADR-036, ADR-037): one row model for both views ("This
// chat" from the change journal, "Git" from `git status`), the status tiles, the summary line and the empty states.
// Store-free. Types frozen from Gate P8-0b (C20); the function bodies are stubs until W8.8 implements them in P8-A.
import type { ChangeSource, ChatChanges, GitStatus, GitUnavailableReason } from '@harness-forge/shared'

/** The two views of the panel: "This chat" (`chat`) and "Git" (`git`); the `source` of the diff and revert routes. */
export type ChangesView = ChangeSource

/** The status of a row (This chat: added / modified / deleted; Git: every `GitFileStatus`). */
export type ChangesStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed' | 'conflicted' | 'typechange'

/** One file row of either view (`ChangesFileRow`). */
export interface ChangesRow {
  /** Project-relative POSIX path. */
  path: string
  /** Git renames: the path at HEAD; else null. */
  origPath: string | null
  status: ChangesStatus
  /** This chat only: lines added (null = not counted: binary, too large, or past the counted files). */
  additions: number | null
  /** This chat only: lines removed (null = not counted). */
  deletions: number | null
  /** This chat: the file on disk is not what the agent last wrote. Git: false. */
  changedOutside: boolean
  /** This chat: its base state is stored. Git: not conflicted. */
  revertible: boolean
  /** This chat: the recorded changes of the file. Git: null. */
  edits: number | null
  /** Git only: changes in the index; This chat: null. */
  staged: boolean | null
  /** Git only: changes in the work tree; This chat: null. */
  unstaged: boolean | null
}

/**
 * Why a view lists nothing (`ChangesEmpty`, data-reason): `none` (This chat, no file changed), `clean` (Git, no
 * changes since the last commit), or why the data is not available (`GitUnavailableReason`: no-project,
 * folder-unavailable, git-missing, not-a-repo, refused, timeout, failed; This chat uses the first two).
 */
export type ChangesEmptyReason = 'none' | 'clean' | GitUnavailableReason

/** The 16px status tile of a row: its letter and the sr-only label ("A" / "Added"). */
export interface StatusTile {
  letter: string
  label: string
}

/**
 * The rows of "This chat" from `ChatChangeFile`s: files back to their original state (`unchanged`) are left out; the
 * server's order is kept (most recently changed first). Stub (C20): no rows until W8.8.
 */
export function chatChangeRows(_changes: ChatChanges): ChangesRow[] {
  return []
}

/** The rows of "Git" from `GitStatusFile`s, in the server's order (by path). Stub (C20): no rows until W8.8. */
export function gitChangeRows(_status: GitStatus): ChangesRow[] {
  return []
}

/**
 * The tile of a status: A Added, M Modified, D Deleted, U Untracked, R Renamed, ! Conflicted, T Type changed.
 * Stub (C20): W8.8 fills the table.
 */
export function statusTile(_status: ChangesStatus): StatusTile {
  return { letter: '', label: '' }
}

/**
 * The summary line (docs/UI.md 7.21): This chat "3 files changed · +24 −7"; Git "On {branch} · 4 files changed",
 * "Detached at {head}", "No commits yet". Stub (C20): empty until W8.8.
 */
export function changesSummary(_view: ChangesView, _data: ChatChanges | GitStatus): string {
  return ''
}

/**
 * Why the view lists nothing (`none`, `clean` or the unavailable reason), or null when it has rows.
 * Stub (C20): always null until W8.8.
 */
export function changesEmptyReason(_view: ChangesView, _data: ChatChanges | GitStatus): ChangesEmptyReason | null {
  return null
}
