// Pure helpers of the changes panel (docs/UI.md 7.21, 11.5; ADR-036, ADR-037): one row model for both views ("This
// chat" from the change journal, "Git" from `git status`), the status tiles, the summary line and the empty states.
// Store-free. Types frozen from Gate P8-0b (C20); W8.8 implemented the bodies and added the DOM ids, the footer notes and
// the display path.
import type { ChangeSource, ChatChanges, GitStatus, GitUnavailableReason } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'

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

/** DOM id of the panel (the toggle's `aria-controls`); one panel shows at a time (pane or sheet). */
export const CHANGES_PANEL_ID = 'hf-changes-panel'
/** DOM id of the panel's `h2` "Changes" (labels the desktop `<aside>` and the sheet). */
export const CHANGES_HEADING_ID = 'hf-changes-heading'

/** U+2212, as in the tool rows' `+a −d`. */
const MINUS = '\u2212'

function isChatChanges(data: ChatChanges | GitStatus): data is ChatChanges {
  return 'untracked' in data
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/**
 * The rows of "This chat" from `ChatChangeFile`s: files back to their original state (`unchanged`) are left out; the
 * server's order is kept (most recently changed first).
 */
export function chatChangeRows(changes: ChatChanges): ChangesRow[] {
  const rows: ChangesRow[] = []
  for (const file of changes.files) {
    if (file.status === 'unchanged')
      continue
    rows.push({
      path: file.path,
      origPath: null,
      status: file.status,
      additions: file.added,
      deletions: file.removed,
      changedOutside: file.changedOutside,
      revertible: file.revertible,
      edits: file.edits,
      staged: null,
      unstaged: null,
    })
  }
  return rows
}

/** The rows of "Git" from `GitStatusFile`s, in the server's order (by path); a conflicted file is not revertible. */
export function gitChangeRows(status: GitStatus): ChangesRow[] {
  return status.files.map(file => ({
    path: file.path,
    origPath: file.origPath,
    status: file.status,
    additions: null,
    deletions: null,
    changedOutside: false,
    revertible: file.status !== 'conflicted',
    edits: null,
    staged: file.staged,
    unstaged: file.unstaged,
  }))
}

const STATUS_TILES: Record<ChangesStatus, StatusTile> = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
  untracked: { letter: 'U', label: 'Untracked' },
  renamed: { letter: 'R', label: 'Renamed' },
  conflicted: { letter: '!', label: 'Conflicted' },
  typechange: { letter: 'T', label: 'Type changed' },
}

/** The tile of a status: A Added, M Modified, D Deleted, U Untracked, R Renamed, ! Conflicted, T Type changed. */
export function statusTile(status: ChangesStatus): StatusTile {
  return STATUS_TILES[status]
}

/** "3 files changed" / "1 file changed". */
function filesChanged(count: number): string {
  return plural(count, 'file changed', 'files changed')
}

/**
 * The summary line (docs/UI.md 7.21): This chat "3 files changed · +24 −7" (the totals of the known line counts, left
 * out when none is known); Git "On {branch} · 4 files changed", "Detached at {head}" (7 characters), "No commits yet"
 * (an unborn HEAD). Empty when the view is not available, and for This chat without rows (the empty state says it).
 */
export function changesSummary(view: ChangesView, data: ChatChanges | GitStatus): string {
  if (!data.available)
    return ''
  if (view === 'chat' && isChatChanges(data)) {
    const rows = chatChangeRows(data)
    if (rows.length === 0)
      return ''
    const counted = rows.filter(row => row.additions !== null || row.deletions !== null)
    if (counted.length === 0)
      return filesChanged(rows.length)
    const additions = counted.reduce((sum, row) => sum + (row.additions ?? 0), 0)
    const deletions = counted.reduce((sum, row) => sum + (row.deletions ?? 0), 0)
    return `${filesChanged(rows.length)} · +${additions.toLocaleString('en-US')} ${MINUS}${deletions.toLocaleString('en-US')}`
  }
  if (isChatChanges(data))
    return ''
  const where = data.head === null
    ? 'No commits yet'
    : data.branch !== null ? `On ${data.branch}` : `Detached at ${data.head.slice(0, 7)}`
  return data.files.length > 0 ? `${where} · ${filesChanged(data.files.length)}` : where
}

/**
 * Why the view lists nothing (`none`, `clean` or the unavailable reason), or null when it has rows. A view that is
 * not available without a reason reads as `no-project` (This chat) or `failed` (Git).
 */
export function changesEmptyReason(view: ChangesView, data: ChatChanges | GitStatus): ChangesEmptyReason | null {
  if (!data.available)
    return data.reason ?? (view === 'chat' ? 'no-project' : 'failed')
  if (isChatChanges(data))
    return chatChangeRows(data).length === 0 ? 'none' : null
  return data.files.length === 0 ? 'clean' : null
}

/** The footer of a capped list: "Showing the first 500 files." (This chat) / "Showing the first 2,000 files." (Git). */
export function changesTruncatedNote(view: ChangesView): string {
  const max = view === 'chat' ? LIMITS.changesFilesMax : LIMITS.gitStatusFilesMax
  return `Showing the first ${max.toLocaleString('en-US')} files.`
}

/**
 * The untracked note of This chat (data-slot="changes-untracked"): "3 shell commands and 1 other tool call in this
 * chat may have changed files too. They aren't listed here."; a zero part is left out; null when both are zero.
 */
export function untrackedNote(untracked: ChatChanges['untracked']): string | null {
  const parts: string[] = []
  if (untracked.shellCommands > 0)
    parts.push(plural(untracked.shellCommands, 'shell command', 'shell commands'))
  if (untracked.toolCalls > 0)
    parts.push(plural(untracked.toolCalls, 'other tool call', 'other tool calls'))
  if (parts.length === 0)
    return null
  return `${parts.join(' and ')} in this chat may have changed files too. They aren't listed here.`
}

/** The path a row shows: `{origPath} → {path}` for a rename, else the path. */
export function rowLabel(row: Pick<ChangesRow, 'path' | 'origPath'>): string {
  return row.origPath ? `${row.origPath} → ${row.path}` : row.path
}

/** The file name of a path ("Revert parser.ts?"). */
export function fileName(path: string): string {
  return path.split('/').pop() || path
}
