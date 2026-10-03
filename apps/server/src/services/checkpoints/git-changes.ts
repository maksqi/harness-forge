// The "Git" view of the changes panel and the HEAD diff of one file (Phase 8, ADR-037, API.md 5.24 `changes.git` /
// `changes.diff`, ARCHITECTURE.md 6.17). Owner: W8.3. git runs only through the hardened runner `workspace/git.ts`
// (C21: `gitStatus`, `gitHeadBlob`, `gitPathOf`); `git diff` is never run.
//
// - `mapGitStatus(info, entries, truncated)` (pure): the repository facts and the raw porcelain v2 entries (C21's
//   `GitRepoInfo` / `GitStatusEntry`) -> `GitStatus`. Status per entry: untracked `?` -> `untracked`; unmerged `u` ->
//   `conflicted`; a rename `2 R…` with its HEAD path inside the project -> `renamed` (+ `origPath`), a copy `2 C…` or a
//   rename from outside the project folder -> `added`; ordinary `1`: an `A` (Y `A` is `git add -N`) -> `added`, else a
//   `D` -> `deleted`, else a `T` -> `typechange`, else `modified`. `staged` = X is not `.`, `unstaged` = Y is not `.`
//   (untracked: neither). A path listed twice (`git rm --cached` keeps a `D.` entry and an untracked one) keeps the
//   tracked entry, marked `unstaged`. At most `LIMITS.gitStatusFilesMax` files sorted by path, + `truncated`.
// - `chatGitStatus`: the chat's project folder (`no-project` / `folder-unavailable`), then `gitStatus` (reasons
//   `git-missing | not-a-repo | refused | timeout | failed`, 1:1 from the runner; the runner's detail is logged at debug
//   only, it may name paths).
// - `gitFileDiff`: the path must be listed by the git view (`404` otherwise); the HEAD blob (of `origPath` for a rename;
//   none for untracked and added files, and with an unborn HEAD) against the disk through `computeWorkspaceDiff`: an
//   untracked or added file is `''` against the file, a deleted one HEAD against `''`. A git failure, or a chat without
//   a usable project folder, is `400 validation_error`. `FileDiff.status`: conflicted and typechange read as `modified`.
import type { FileDiff, FileDiffStatus, GitFileStatus, GitStatus, GitStatusFile, GitUnavailableReason } from '@harness-forge/shared'
import type { GitFailure, GitHeadBlob, GitHelperOptions, GitRepoInfo, GitStatusEntry } from '../../workspace/git.ts'
import type { ChangesReadOptions, DiffSide } from './changes-common.ts'
import type { CheckpointContext } from './types.ts'
import { HarnessError, LIMITS, validationError } from '@harness-forge/shared'
import { gitHeadBlob, gitPathOf, gitStatus } from '../../workspace/git.ts'
import { diffSide, EMPTY_SIDE, fileDiffOf, openChatWorkspace, readDiskFile, requireChatWorkspace } from './changes-common.ts'

// ---------- mapping ----------

function byPath(a: GitStatusFile, b: GitStatusFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** One raw entry as a `GitStatusFile`. */
export function mapGitEntry(entry: GitStatusEntry): GitStatusFile {
  if (entry.type === 'untracked')
    return { path: entry.path, origPath: null, status: 'untracked', staged: false, unstaged: false }
  const x = entry.xy.charAt(0)
  const y = entry.xy.charAt(1)
  const flags = { staged: x !== '.', unstaged: y !== '.' }
  if (entry.type === 'unmerged')
    return { path: entry.path, origPath: null, status: 'conflicted', ...flags }
  if (entry.type === 'renamed') {
    if (entry.score.startsWith('R') && entry.origPath !== null)
      return { path: entry.path, origPath: entry.origPath, status: 'renamed', ...flags }
    return { path: entry.path, origPath: null, status: 'added', ...flags }
  }
  let status: GitFileStatus = 'modified'
  if (x === 'A' || y === 'A')
    status = 'added'
  else if (x === 'D' || y === 'D')
    status = 'deleted'
  else if (x === 'T' || y === 'T')
    status = 'typechange'
  return { path: entry.path, origPath: null, status, ...flags }
}

/**
 * Maps the repository facts (`gitRepoInfo`, or the `GitStatusSnapshot` itself) and the raw entries of `gitStatus` to
 * the `GitStatus` DTO (see the module comment); `truncated` = the snapshot dropped entries.
 */
export function mapGitStatus(info: GitRepoInfo, entries: readonly GitStatusEntry[], truncated = false): GitStatus {
  const byName = new Map<string, GitStatusFile>()
  for (const entry of entries) {
    const file = mapGitEntry(entry)
    const known = byName.get(file.path)
    if (known === undefined)
      byName.set(file.path, file)
    else if (known.status === 'untracked' && file.status !== 'untracked')
      byName.set(file.path, { ...file, unstaged: true })
    else if (known.status !== 'untracked' && file.status === 'untracked')
      byName.set(file.path, { ...known, unstaged: true })
  }
  const files = [...byName.values()].sort(byPath)
  const max = LIMITS.gitStatusFilesMax
  return {
    available: true,
    reason: null,
    branch: info.branch,
    head: info.head,
    prefix: info.prefix,
    files: files.slice(0, max),
    truncated: truncated || files.length > max,
  }
}

function unavailableStatus(reason: GitUnavailableReason): GitStatus {
  return { available: false, reason, branch: null, head: null, prefix: '', files: [], truncated: false }
}

// ---------- runner options and failures ----------

async function helperOptions(ctx: CheckpointContext, options: ChangesReadOptions): Promise<GitHelperOptions> {
  return {
    workspaceRoots: await ctx.deps.projects.roots(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.gitEnv === undefined ? {} : { parentEnv: options.gitEnv }),
  }
}

/** Why git did not answer, safe to show (`FileDiff` with `source: 'git'` answers it as `400`). */
const GIT_FAILURE_MESSAGES: Readonly<Record<GitFailure['reason'], string>> = Object.freeze({
  'git-missing': 'Git is not installed on the server.',
  'not-a-repo': 'The project folder is not inside a Git repository.',
  'refused': 'Git refused to read this repository (it may belong to another user).',
  'timeout': 'Git took too long to answer.',
  'failed': 'Git could not read this repository.',
})

function logFailure(ctx: CheckpointContext, what: string, failure: GitFailure): void {
  ctx.deps.logger.debug(what, { reason: failure.reason, message: failure.message, ...(failure.detail === undefined ? {} : { detail: failure.detail }) })
}

/** `400 validation_error` on `['source']`: the git view is not available. */
function gitUnavailableError(reason: GitFailure['reason']): HarnessError {
  const message = `The Git view is not available: ${GIT_FAILURE_MESSAGES[reason]}`
  return validationError([{ path: ['source'], message, code: 'custom' }], message)
}

// ---------- status ----------

/** `GET /chats/:id/git`. */
export async function chatGitStatus(ctx: CheckpointContext, chatId: string, options: ChangesReadOptions = {}): Promise<GitStatus> {
  const opened = await openChatWorkspace(ctx, chatId)
  if (!opened.ok)
    return unavailableStatus(opened.reason)
  const snapshot = await gitStatus(opened.workspace.root, await helperOptions(ctx, options))
  if (!snapshot.ok) {
    logFailure(ctx, 'git status not available', snapshot)
    return unavailableStatus(snapshot.reason)
  }
  return mapGitStatus(snapshot, snapshot.entries, snapshot.truncated)
}

// ---------- diff ----------

const DIFF_STATUS: Readonly<Record<GitFileStatus, FileDiffStatus>> = Object.freeze({
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
  conflicted: 'modified',
  typechange: 'modified',
})

/** The HEAD side of a diff: `''` when HEAD has no such file; null for a submodule (no content). */
function headSide(blob: GitHeadBlob | null): DiffSide | null {
  if (blob === null)
    return EMPTY_SIDE
  if (blob.tooLarge)
    return { text: null, binary: false, tooLarge: true }
  if (blob.content === null)
    return null
  return diffSide(blob.content)
}

/** A path the git view does not list. */
function notListed(path: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `"${path}" has no changes since the last commit.` })
}

/** `GET /chats/:id/changes/diff?source=git`: HEAD against the disk. */
export async function gitFileDiff(ctx: CheckpointContext, chatId: string, path: string, options: ChangesReadOptions = {}): Promise<FileDiff> {
  const { root } = await requireChatWorkspace(ctx, chatId)
  const rel = await gitPathOf(root, path)
  const git = await helperOptions(ctx, options)
  const snapshot = await gitStatus(root, git)
  if (!snapshot.ok) {
    logFailure(ctx, 'git status not available', snapshot)
    throw gitUnavailableError(snapshot.reason)
  }
  const listed = mapGitStatus(snapshot, snapshot.entries, snapshot.truncated).files.find(file => file.path === rel)
  if (listed === undefined)
    throw notListed(rel)

  let base: DiffSide | null = EMPTY_SIDE
  if (listed.status !== 'untracked' && listed.status !== 'added') {
    const head = await gitHeadBlob(root, listed.origPath ?? rel, { ...git, maxBytes: LIMITS.changeDiffSideMaxBytes })
    if (!head.ok) {
      logFailure(ctx, 'git blob not available', head)
      throw gitUnavailableError(head.reason)
    }
    base = headSide(head.blob)
  }
  const current = await readDiskFile(root, rel, LIMITS.changeDiffSideMaxBytes, options.signal)
  return fileDiffOf({ source: 'git', path: rel, origPath: listed.origPath, status: DIFF_STATUS[listed.status], base, current })
}
