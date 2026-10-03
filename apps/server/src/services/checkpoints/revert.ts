// Revert of one file (Phase 8, ADR-037, API.md 5.24 `changes.revert`, ARCHITECTURE.md 6.17 "Revert"). Owner: W8.2.
//
// `chat` source: the base state (the file before the chat first changed it: the before-state of the chat's earliest
// row of the path in its current project; `404` for a path the chat never changed). A base that is `too-large` or
// `evicted` is not written: `200` with `skipped` (`unavailable`) and `batchId: null` (API.md 5.24).
// `git` source: the raw HEAD blob (`gitHeadBlob` of `workspace/git.ts`; mode 100755 stays executable); an untracked or
// added file is deleted after a snapshot; a rename restores `origPath` and deletes `path` (a copy only deletes `path`).
// Refused (`400 validation_error`): conflicted (unmerged) files, symbolic links (120000, at HEAD, in the index or on
// disk), submodules, paths with a `filter` attribute (`gitFilterAttr`, Git LFS), a path git ignores (neither at HEAD nor
// listed: deleting it is never a "revert"), and a git view that is not available (its reason). The git index is never
// touched (only `status`, `ls-tree`, `cat-file` and `check-attr` run, with `GIT_OPTIONAL_LOCKS=0`).
// Both: a path the guard refuses is `400` on `['path']`; `409` (`run-active`) while any chat of the project runs; a
// disk state other than `expectedSha` (when given; null = missing) is `409 conflict` (`stale`) and nothing is written
// (the restore re-checks it under the lock: a change in between is skipped as `conflict`). One undoable `revert` batch
// through `applyRestore`.
import type { ChangeRevertBody, RestoreResult } from '@harness-forge/shared'
import type { GitFailure, GitHelperOptions, GitStatusEntry } from '../../workspace/git.ts'
import type { RestorePlan, RestorePlanFile, RestoreTarget } from './plan.ts'
import type { ChatWorkspace, RestoreIo } from './restore-scope.ts'
import type { CheckpointContext } from './types.ts'
import { resolve } from 'node:path'
import { createChangeBatchId, HarnessError, validationError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { workspaceChanges } from '../../db/schema.ts'
import { isWithin } from '../../plugins/scaffold/paths.ts'
import { gitFilterAttr, gitHeadBlob, gitPathOf, gitStatus } from '../../workspace/git.ts'
import { hasGitSegment, OUTSIDE_PROJECT_MESSAGE, resolveWorkspacePath, toWorkspaceRel, workspacePathError } from '../../workspace/paths.ts'
import { diskSha } from './disk.ts'
import { isFileRow, planFile, planRewind } from './plan.ts'
import { assertProjectIdle, finishBatch, journalRows, openChatWorkspace, requireChat, restoreDepsOf } from './restore-scope.ts'
import { applyRestore } from './restore.ts'

export const STALE_MESSAGE = 'The file changed since it was shown. Refresh and try again.'

const GIT_REASON_MESSAGES: Readonly<Record<GitFailure['reason'], string>> = Object.freeze({
  'git-missing': 'git is not installed on the server.',
  'not-a-repo': 'the project folder is not inside a git repository.',
  'refused': 'git refused the repository (for example, a folder owned by another user).',
  'timeout': 'git did not answer in time.',
  'failed': 'a git command failed.',
})

/** Options of `revertFile` beyond the frozen signature (tests). */
export interface RevertOptions {
  /** A writer / remover for the restore (a writer that fails). */
  readonly io?: RestoreIo
  /** Options of the git helpers (tests: `parentEnv` with a temp `HOME`, `timeoutMs`). */
  readonly git?: Pick<GitHelperOptions, 'parentEnv' | 'timeoutMs' | 'killGraceMs'>
}

/** `400 validation_error` on `['path']`. */
function pathRefused(message: string): HarnessError {
  return workspacePathError(message)
}

/** `400 validation_error` on `['source']`: the git view is not available. */
function gitUnavailable(ctx: CheckpointContext, failure: GitFailure): HarnessError {
  if (failure.detail !== undefined)
    ctx.deps.logger.debug('git revert unavailable', { reason: failure.reason, detail: failure.detail })
  const message = `The git view is not available: ${GIT_REASON_MESSAGES[failure.reason]}`
  return validationError([{ path: ['source'], message, code: 'custom' }], message)
}

/** The project-relative path of a chat revert: lexical (the journal's own spelling), checked by the path guard. */
async function chatPathOf(root: string, input: string): Promise<string> {
  const lexical = resolve(root, input)
  if (!isWithin(root, lexical))
    throw pathRefused(OUTSIDE_PROJECT_MESSAGE)
  const rel = toWorkspaceRel(root, lexical)
  if (rel === '.')
    throw pathRefused('The path names the project folder, not a file.')
  if (hasGitSegment(rel))
    throw pathRefused(`"${rel}" is inside a .git folder: it is never written.`)
  // Links out of the folder, a file used as a folder, a moved project folder: the guard's own 400.
  await resolveWorkspacePath(root, rel, { allowMissing: true })
  return rel
}

interface PreparedRevert {
  /** The path the client named (the `expectedSha` check). */
  readonly path: string
  readonly plan: RestorePlan
}

/** `chat` source: the base state of the path. */
async function chatRevert(ctx: CheckpointContext, workspace: ChatWorkspace, body: ChangeRevertBody): Promise<PreparedRevert> {
  const rel = await chatPathOf(workspace.root, body.path)
  const rows = (await journalRows(ctx, workspace, eq(workspaceChanges.path, rel))).filter(isFileRow)
  if (rows.length === 0)
    throw new HarnessError({ code: 'not_found', message: `"${rel}" has no changes in this chat.` })
  const files = planRewind(rows, new Map()).files.map(file => ({ ...file, expectedSha: body.expectedSha }))
  return { path: rel, plan: { files } }
}

/** One file of a git revert (the restore reads the disk again under the lock). */
function gitFile(path: string, target: RestoreTarget, expectedSha: string | null | undefined): RestorePlanFile {
  return planFile({ path, target, expectedSha, current: null, edits: 1, lastEditAt: 0 })
}

/** `git` source: HEAD of the path, a rename and an untracked or added file. */
async function gitRevert(ctx: CheckpointContext, workspace: ChatWorkspace, body: ChangeRevertBody, gitOptions: RevertOptions['git']): Promise<PreparedRevert> {
  const { root } = workspace
  const helper: GitHelperOptions = { workspaceRoots: await ctx.deps.projects.roots(), ...gitOptions }
  const rel = await gitPathOf(root, body.path)
  if (hasGitSegment(rel))
    throw pathRefused(`"${rel}" is inside a .git folder: it is never written.`)
  const status = await gitStatus(root, helper)
  if (!status.ok)
    throw gitUnavailable(ctx, status)
  const entry: GitStatusEntry | undefined = status.entries.find(item => item.path === rel || item.path === `${rel}/`)

  if (entry?.type === 'unmerged')
    throw pathRefused(`"${rel}" has a merge conflict: resolve it with git first.`)
  if (entry !== undefined && entry.type !== 'untracked') {
    const modes = [entry.modeHead, entry.modeIndex, entry.modeWorktree]
    if (entry.submodule.startsWith('S') || modes.includes('160000'))
      throw pathRefused(`"${rel}" is a submodule: revert it with git.`)
    if (modes.includes('120000'))
      throw pathRefused(`"${rel}" is a symbolic link: revert it with git.`)
  }

  /** The HEAD state of a path as a restore target (null = not at HEAD). */
  const headTarget = async (path: string): Promise<RestoreTarget | null> => {
    const head = await gitHeadBlob(root, path, helper)
    if (!head.ok)
      throw gitUnavailable(ctx, head)
    const { blob } = head
    if (blob === null)
      return null
    if (blob.kind === 'symlink')
      throw pathRefused(`"${path}" is a symbolic link: revert it with git.`)
    if (blob.kind === 'submodule')
      throw pathRefused(`"${path}" is a submodule: revert it with git.`)
    if (blob.content === null)
      return { kind: 'unavailable', reason: 'too-large' }
    return { kind: 'bytes', bytes: blob.content, mode: blob.kind === 'executable' ? 0o755 : 0o644 }
  }

  let files: RestorePlanFile[]
  if (entry?.type === 'untracked') {
    if (entry.path.endsWith('/'))
      throw pathRefused(`"${rel}" is a folder (a nested repository), not a file.`)
    files = [gitFile(rel, { kind: 'missing' }, body.expectedSha)]
  }
  else if (entry?.type === 'renamed') {
    if (entry.score.startsWith('C')) {
      // A copy: the original is still at HEAD and in place.
      files = [gitFile(rel, { kind: 'missing' }, body.expectedSha)]
    }
    else {
      if (entry.origPath === null)
        throw pathRefused(`"${rel}" was renamed from a path outside the project folder: revert it with git.`)
      const original = await headTarget(entry.origPath)
      if (original === null)
        throw pathRefused(`"${entry.origPath}" is not at HEAD: revert it with git.`)
      files = [gitFile(entry.origPath, original, undefined), gitFile(rel, { kind: 'missing' }, body.expectedSha)]
    }
  }
  else {
    const target = await headTarget(rel)
    if (target === null && entry === undefined) {
      // Neither at HEAD nor listed by `git status`: ignored (or the listing was cut), or not there at all.
      const current = await diskSha(root, rel)
      if (current !== null) {
        throw pathRefused(status.truncated
          ? `"${rel}" is not in the git view (too many changed files): revert it with git.`
          : `"${rel}" is ignored by git: it cannot be reverted to HEAD.`)
      }
    }
    files = [gitFile(rel, target ?? { kind: 'missing' }, body.expectedSha)]
  }

  const filters = await gitFilterAttr(root, files.map(file => file.path), helper)
  if (!filters.ok)
    throw gitUnavailable(ctx, filters)
  for (const file of files) {
    const filter = filters.filters.get(file.path) ?? null
    if (filter !== null)
      throw pathRefused(`"${file.path}" uses a git filter (${filter}, for example Git LFS): revert it with git.`)
  }
  return { path: rel, plan: { files } }
}

/** `409 conflict` (`stale`) when the disk state of `path` is not `expectedSha` (when given). */
async function assertNotStale(root: string, path: string, expectedSha: string | null | undefined): Promise<void> {
  if (expectedSha === undefined)
    return
  const current = await diskSha(root, path)
  // A path that cannot be read as a file is refused by the restore itself.
  if (current !== 'unreadable' && current !== expectedSha)
    throw new HarnessError({ code: 'conflict', message: STALE_MESSAGE, details: { reason: 'stale' } })
}

/** `POST /chats/:id/changes/revert`. */
export async function revertFile(ctx: CheckpointContext, chatId: string, body: ChangeRevertBody, options: RevertOptions = {}): Promise<RestoreResult> {
  const chat = await requireChat(ctx, chatId)
  const workspace = await openChatWorkspace(ctx, chat)
  const prepared = body.source === 'chat'
    ? await chatRevert(ctx, workspace, body)
    : await gitRevert(ctx, workspace, body, options.git)
  await assertProjectIdle(ctx, workspace.projectId)
  await assertNotStale(workspace.root, prepared.path, body.expectedSha)
  const result = await applyRestore(restoreDepsOf(ctx, workspace, options.io), prepared.plan, {
    kind: 'revert',
    batchId: createChangeBatchId(),
    conflicts: 'skip',
  })
  finishBatch(ctx, workspace, 'revert', 'file reverted', result)
  return result
}
