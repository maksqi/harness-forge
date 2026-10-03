// The "Git" view of the changes panel and the HEAD diff of one file (Phase 8, ADR-037, API.md 5.24 `changes.git` /
// `changes.diff`, ARCHITECTURE.md 6.17). Owner: W8.3 (C19 stub). git runs only through the hardened runner
// `workspace/git.ts` (C21: `gitRepoInfo`, `gitStatus`, `gitHeadBlob`, `gitFilterAttr`); `git diff` is never run.
//
// - `mapGitStatus(info, entries, truncated)` (pure): the repository facts and the raw porcelain v2 entries (C21's
//   `GitRepoInfo` / `GitStatusEntry`) -> `GitStatus`: XY ->
//   `modified | added | deleted | renamed | untracked | conflicted | typechange` with `staged` / `unstaged`; `branch`,
//   `head`, `prefix`; at most `LIMITS.gitStatusFilesMax` files sorted by path, + `truncated`.
// - `chatGitStatus`: the chat's project folder (`no-project` / `folder-unavailable`), then `gitRepoInfo` and
//   `gitStatus` (reasons `git-missing | not-a-repo | refused | timeout | failed`).
// - `gitFileDiff`: the HEAD blob against the disk through `computeWorkspaceDiff` (untracked / added: `''` against the
//   file; deleted: HEAD against `''`; renamed: HEAD of `origPath` against `path`; an unborn HEAD: everything added).
import type { FileDiff, GitStatus } from '@harness-forge/shared'
import type { GitRepoInfo, GitStatusEntry } from '../../workspace/git.ts'
import type { CheckpointContext, CheckpointReadOptions } from './types.ts'
import { notImplementedError } from '../../not-implemented.ts'

/**
 * Maps the repository facts (`gitRepoInfo`, or the `GitStatusSnapshot` itself) and the raw entries of `gitStatus` to
 * the `GitStatus` DTO (see the module comment); `truncated` = the snapshot dropped entries.
 */
export function mapGitStatus(_info: GitRepoInfo, _entries: readonly GitStatusEntry[], _truncated = false): GitStatus {
  throw notImplementedError('Mapping the git status')
}

/** `GET /chats/:id/git`. */
export async function chatGitStatus(_ctx: CheckpointContext, _chatId: string, _options: CheckpointReadOptions = {}): Promise<GitStatus> {
  throw notImplementedError('The git status of a project')
}

/** `GET /chats/:id/changes/diff?source=git`: HEAD against the disk. */
export async function gitFileDiff(_ctx: CheckpointContext, _chatId: string, _path: string, _options: CheckpointReadOptions = {}): Promise<FileDiff> {
  throw notImplementedError('The git diff of a file')
}
