// The "This chat" view of the changes panel and the diff of one file (Phase 8, ADR-037, API.md 5.24 `changes.list` /
// `changes.diff`, ARCHITECTURE.md 6.17). Owner: W8.3.
//
// - `listChatChanges`: one entry per path (at most `LIMITS.changesFilesMax`, most recently changed first, +
//   `truncated`) from base (the before-state of the path's earliest file row), expected (the after-state of its latest)
//   and current (the disk); `status` added / modified / deleted / unchanged (base against current); `edits` (file rows
//   of the path: edits, reverts, rewinds, undos); `changedOutside` (current != expected); `revertible` (base `stored`,
//   or `missing` for a created file); `added` / `removed` only for the first `LIMITS.changesLineCountFiles` entries of
//   the list whose sides are text of at most `LIMITS.changesLineCountMaxBytes` (else null; the diffs of one list share
//   a time budget, `LINE_COUNT_BUDGET_MS`); `lastEditAt`; `untracked.{shellCommands, toolCalls}` (the `shell` and
//   `untracked` rows); `available: false` with `no-project` / `folder-unavailable`. Only rows of the chat's current
//   project count (a chat moved to another project lists nothing of its old one).
// - `changesFileDiff`: `source: 'chat'` here (the base against the disk through `computeWorkspaceDiff`, sides of at most
//   `LIMITS.changeDiffSideMaxBytes` else `tooLarge`, binary = a NUL byte in the first 8 KiB or a failed `decodeText`,
//   `currentSha`, `baseAvailable` = the base is missing (new file) or its blob is still stored; `404` for a path the
//   chat never changed); `source: 'git'` goes to `gitFileDiff` of ./git-changes.ts.
//
// Nothing here writes, and nothing is logged: paths and contents never reach the log.
import type { ChangeDiffQuery, ChatChangeFile, ChatChanges, ChatChangeStatus, FileDiff, WorkspaceChangeKind } from '@harness-forge/shared'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { ChangesReadOptions, DiffSide, DiskFile } from './changes-common.ts'
import type { DiskSha } from './disk.ts'
import type { CheckpointContext, CheckpointReadOptions } from './types.ts'
import { performance } from 'node:perf_hooks'
import { HarnessError, isHarnessError, LIMITS } from '@harness-forge/shared'
import { and, asc, count, desc, eq, inArray, isNotNull, max, min } from 'drizzle-orm'
import { workspaceChanges } from '../../db/schema.ts'
import { computeWorkspaceDiff, DIFF_TIMEOUT_MS } from '../../workspace/diff.ts'
import { diffSide, diskSide, EMPTY_SIDE, fileDiffOf, openChatWorkspace, projectRelPath, readDiskFile, requireChatWorkspace } from './changes-common.ts'
import { diskSha } from './disk.ts'
import { gitFileDiff } from './git-changes.ts'

/** The kinds of the file rows (the others, `shell` and `untracked`, have no path). */
export const FILE_ROW_KINDS = Object.freeze(['edit', 'revert', 'rewind', 'undo'] as const satisfies readonly WorkspaceChangeKind[])

/** Time the line-count diffs of one list may take together; the files after it get null counts. */
export const LINE_COUNT_BUDGET_MS = 5000

/** The state before the chat first changed a file (the before-state of its earliest file row). */
type Base
  = | { readonly kind: 'missing' }
    | { readonly kind: 'stored', readonly sha: string, readonly size: number | null }
    | { readonly kind: 'unavailable', readonly sha: string | null }

function baseOf(row: WorkspaceChangeRow): Base {
  if (row.beforeState === 'missing')
    return { kind: 'missing' }
  if (row.beforeState === 'stored' && row.beforeSha !== null)
    return { kind: 'stored', sha: row.beforeSha, size: row.beforeSize }
  return { kind: 'unavailable', sha: row.beforeSha }
}

/** The net change of a file: its base against the disk now. */
function chatStatus(base: Base, current: DiskSha): ChatChangeStatus {
  if (current === null)
    return base.kind === 'missing' ? 'unchanged' : 'deleted'
  if (base.kind === 'missing')
    return 'added'
  return current !== 'unreadable' && current === base.sha ? 'unchanged' : 'modified'
}

/** A path the chat never changed (in its current project). */
function notChanged(path: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `"${path}" was not changed by this chat.` })
}

function unavailable(reason: ChatChanges['reason'], projectId: string | null): ChatChanges {
  return { available: false, reason, projectId, files: [], truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } }
}

/** The disk state of a listed file: read whole when its line counts are wanted, else hashed (`diskSha`). */
async function currentOf(root: string, path: string, withContent: boolean, signal?: AbortSignal): Promise<{ sha: DiskSha, file: DiskFile | 'unreadable' | null }> {
  if (!withContent)
    return { sha: await diskSha(root, path, signal), file: null }
  try {
    const file = await readDiskFile(root, path, LIMITS.changesLineCountMaxBytes, signal)
    return { sha: file.state === 'missing' ? null : file.sha, file }
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'validation_error')
      return { sha: 'unreadable', file: 'unreadable' }
    throw error
  }
}

/** The text of a stored base of at most `maxBytes` (null: not stored any more, too large, binary). */
async function baseText(ctx: CheckpointContext, base: Base, maxBytes: number): Promise<string | null> {
  if (base.kind === 'missing')
    return ''
  if (base.kind !== 'stored' || (base.size !== null && base.size > maxBytes))
    return null
  const blob = await ctx.blobs.read(base.sha)
  if (blob === null || blob.length > maxBytes)
    return null
  return diffSide(blob).text
}

/** Lines added / removed from the base to the disk, or null (see the module comment). */
async function lineCounts(ctx: CheckpointContext, base: Base, current: DiskFile | 'unreadable', deadline: number): Promise<{ added: number, removed: number } | null> {
  if (current === 'unreadable')
    return null
  const after = diskSide(current).text
  if (after === null)
    return null
  const before = await baseText(ctx, base, LIMITS.changesLineCountMaxBytes)
  if (before === null)
    return null
  if (before === after)
    return { added: 0, removed: 0 }
  const timeoutMs = Math.min(DIFF_TIMEOUT_MS, deadline - performance.now())
  if (timeoutMs <= 0)
    return null
  const diff = await computeWorkspaceDiff(before, after, { timeoutMs })
  return diff === null ? null : { added: diff.added, removed: diff.removed }
}

/** `GET /chats/:id/changes`. */
export async function listChatChanges(ctx: CheckpointContext, chatId: string, options: CheckpointReadOptions = {}): Promise<ChatChanges> {
  const { signal } = options
  const opened = await openChatWorkspace(ctx, chatId)
  if (!opened.ok)
    return unavailable(opened.reason, opened.projectId)
  const { root, projectId } = opened.workspace
  const { db } = ctx.deps
  const scope = and(eq(workspaceChanges.chatId, chatId), eq(workspaceChanges.projectId, projectId))

  const lastId = max(workspaceChanges.id)
  const groups = await db
    .select({ path: workspaceChanges.path, edits: count(), firstId: min(workspaceChanges.id), lastId })
    .from(workspaceChanges)
    .where(and(scope, isNotNull(workspaceChanges.path), inArray(workspaceChanges.kind, [...FILE_ROW_KINDS])))
    .groupBy(workspaceChanges.path)
    .orderBy(desc(lastId))
    .limit(LIMITS.changesFilesMax + 1)
  const listed = groups.slice(0, LIMITS.changesFilesMax)
  const ids = [...new Set(listed.flatMap(group => [group.firstId, group.lastId]).filter((id): id is number => id !== null))]
  const rows = ids.length === 0 ? [] : await db.select().from(workspaceChanges).where(inArray(workspaceChanges.id, ids))
  const byId = new Map(rows.map(row => [row.id, row]))

  const untracked = await db
    .select({ kind: workspaceChanges.kind, rows: count() })
    .from(workspaceChanges)
    .where(and(scope, inArray(workspaceChanges.kind, ['shell', 'untracked'])))
    .groupBy(workspaceChanges.kind)
  const untrackedCount = (kind: WorkspaceChangeKind): number => untracked.find(entry => entry.kind === kind)?.rows ?? 0

  const deadline = performance.now() + LINE_COUNT_BUDGET_MS
  const files: ChatChangeFile[] = []
  for (const group of listed) {
    signal?.throwIfAborted()
    const first = group.firstId === null ? undefined : byId.get(group.firstId)
    const last = group.lastId === null ? undefined : byId.get(group.lastId)
    if (group.path === null || first === undefined || last === undefined)
      continue
    const withCounts = files.length < LIMITS.changesLineCountFiles
    const base = baseOf(first)
    const current = await currentOf(root, group.path, withCounts, signal)
    const counts = withCounts && current.file !== null ? await lineCounts(ctx, base, current.file, deadline) : null
    files.push({
      path: group.path,
      status: chatStatus(base, current.sha),
      edits: group.edits,
      changedOutside: current.sha !== last.afterSha,
      revertible: base.kind === 'missing' || base.kind === 'stored',
      added: counts?.added ?? null,
      removed: counts?.removed ?? null,
      lastEditAt: last.createdAt,
    })
  }
  return {
    available: true,
    reason: null,
    projectId,
    files,
    truncated: groups.length > LIMITS.changesFilesMax,
    untracked: { shellCommands: untrackedCount('shell'), toolCalls: untrackedCount('untracked') },
  }
}

/** The base side of a chat diff (the whole blob is read, at most `LIMITS.checkpointFileMaxBytes`); null when not stored. */
async function chatBaseSide(ctx: CheckpointContext, base: Base): Promise<DiffSide | null> {
  if (base.kind === 'missing')
    return EMPTY_SIDE
  if (base.kind !== 'stored')
    return null
  const blob = await ctx.blobs.read(base.sha)
  if (blob === null)
    return null
  return diffSide(blob.length > LIMITS.changeDiffSideMaxBytes ? null : blob, blob)
}

/** `GET /chats/:id/changes/diff` for both sources (`git` is delegated to `gitFileDiff`). */
export async function changesFileDiff(ctx: CheckpointContext, chatId: string, query: ChangeDiffQuery, options: ChangesReadOptions = {}): Promise<FileDiff> {
  if (query.source === 'git')
    return gitFileDiff(ctx, chatId, query.path, options)
  const { signal } = options
  const { root, projectId } = await requireChatWorkspace(ctx, chatId)
  const path = projectRelPath(root, query.path)
  const { db } = ctx.deps
  const where = and(
    eq(workspaceChanges.chatId, chatId),
    eq(workspaceChanges.projectId, projectId),
    eq(workspaceChanges.path, path),
    inArray(workspaceChanges.kind, [...FILE_ROW_KINDS]),
  )
  const [first] = await db.select().from(workspaceChanges).where(where).orderBy(asc(workspaceChanges.id)).limit(1)
  if (first === undefined)
    throw notChanged(path)
  const current = await readDiskFile(root, path, LIMITS.changeDiffSideMaxBytes, signal)
  const base = baseOf(first)
  return fileDiffOf({
    source: 'chat',
    path,
    origPath: null,
    status: chatStatus(base, current.state === 'missing' ? null : current.sha),
    base: await chatBaseSide(ctx, base),
    current,
  })
}
