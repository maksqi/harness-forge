// Rewind (Phase 8, ADR-036, API.md 5.24 `changes.rewindPreview` / `changes.rewind`, ARCHITECTURE.md 6.16 "Rewind").
// Owner: W8.2.
//
// Time-based: "the files as they were when user message M was sent". The range is every row of the chat in its
// current project with `message_seq >= M.seq`, on any branch (abandoned versions, an older message continued after M,
// earlier reverts and rewinds). Only user messages of the chat are targets (`400 validation_error` on `['messageId']`
// otherwise, `404` for an unknown message). The preview lists at most `LIMITS.changesFilesMax` files (+ `truncated`;
// only those are read from disk), `untracked.shellCount`, the last `LIMITS.rewindUntrackedListMax` shell commands and
// untracked tool calls of the range; the apply is `409 conflict` (`run-active`, `details.chatId`) while any chat of the
// project runs, and one `rewind` batch through `applyRestore` over every file of the range (not only the listed ones).
// Errors in order: unknown chat (404), unknown message (404), not a user message (400), no project / folder not
// available (400), a run (409, apply only).
import type { RestoreResult, RewindBody, RewindPreview, RewindShellCommand, RewindToolCall } from '@harness-forge/shared'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { ChatWorkspace, RestoreIo } from './restore-scope.ts'
import type { CheckpointContext, CheckpointReadOptions } from './types.ts'
import { createChangeBatchId, LIMITS, validationError } from '@harness-forge/shared'
import { and, eq, gte } from 'drizzle-orm'
import { messages, workspaceChanges } from '../../db/schema.ts'
import { messageNotFound } from '../chats/store.ts'
import { diskShas } from './disk.ts'
import { isFileRow, orderedPaths, planRewind } from './plan.ts'
import { assertProjectIdle, finishBatch, journalRows, openChatWorkspace, requireChat, restoreDepsOf } from './restore-scope.ts'
import { applyRestore } from './restore.ts'

export const NOT_A_USER_MESSAGE = 'Files can be rewound only to a user message.'

/** The chat, its workspace and the rows of the range of a rewind to `messageId`. */
interface RewindRange {
  readonly workspace: ChatWorkspace
  readonly rows: WorkspaceChangeRow[]
}

/** The `seq` of a user message of the chat (404 unknown, 400 another role). */
async function userMessageSeq(ctx: CheckpointContext, chatId: string, messageId: string): Promise<number> {
  const [message] = await ctx.deps.db.select({ seq: messages.seq, role: messages.role }).from(messages).where(and(eq(messages.chatId, chatId), eq(messages.id, messageId))).limit(1)
  if (message === undefined)
    throw messageNotFound(chatId, messageId)
  if (message.role !== 'user')
    throw validationError([{ path: ['messageId'], message: NOT_A_USER_MESSAGE, code: 'custom' }], NOT_A_USER_MESSAGE)
  return message.seq
}

async function rewindRange(ctx: CheckpointContext, chatId: string, messageId: string): Promise<RewindRange> {
  const chat = await requireChat(ctx, chatId)
  const seq = await userMessageSeq(ctx, chatId, messageId)
  const workspace = await openChatWorkspace(ctx, chat)
  const rows = await journalRows(ctx, workspace, gte(workspaceChanges.messageSeq, seq))
  return { workspace, rows }
}

/** The latest rows first, at most `max`. */
function latest<T>(rows: readonly WorkspaceChangeRow[], max: number, map: (row: WorkspaceChangeRow) => T | null): T[] {
  const items: T[] = []
  for (let index = rows.length - 1; index >= 0 && items.length < max; index -= 1) {
    const item = map(rows[index]!)
    if (item !== null)
      items.push(item)
  }
  return items
}

/** `GET /chats/:id/rewind?messageId=` (writes nothing). */
export async function rewindPreview(ctx: CheckpointContext, chatId: string, messageId: string, options: CheckpointReadOptions = {}): Promise<RewindPreview> {
  const { workspace, rows } = await rewindRange(ctx, chatId, messageId)
  const fileRows = rows.filter(isFileRow)
  const shellRows = rows.filter(row => row.kind === 'shell')
  const toolRows = rows.filter(row => row.kind === 'untracked')

  const paths = orderedPaths(fileRows)
  const listed = new Set(paths.slice(0, LIMITS.changesFilesMax))
  const current = await diskShas(workspace.root, listed, options.signal)
  const plan = planRewind(fileRows.filter(row => listed.has(row.path!)), current)

  const max = LIMITS.rewindUntrackedListMax
  const shell = latest<RewindShellCommand>(shellRows, max, row => ({
    command: (row.command ?? '').slice(0, LIMITS.journalCommandMaxChars),
    at: row.createdAt,
    messageId: row.messageId,
  }))
  const tools = latest<RewindToolCall>(toolRows, max, row => (row.tool === null ? null : { tool: row.tool, at: row.createdAt, messageId: row.messageId }))
  return {
    messageId,
    files: plan.files.map(file => ({ path: file.path, action: file.action, conflict: file.conflict, edits: file.edits })),
    untracked: { shellCount: shellRows.length, shell, tools },
    truncated: paths.length > listed.size,
  }
}

/** Test hooks of `rewindFiles` (a writer that fails after file N). */
export interface RewindOptions {
  readonly io?: RestoreIo
}

/** `POST /chats/:id/rewind`. */
export async function rewindFiles(ctx: CheckpointContext, chatId: string, body: RewindBody, options: RewindOptions = {}): Promise<RestoreResult> {
  const { workspace, rows } = await rewindRange(ctx, chatId, body.messageId)
  await assertProjectIdle(ctx, workspace.projectId)
  // `applyRestore` reads every file again under its lock, so the plan needs no disk state here.
  const plan = planRewind(rows.filter(isFileRow), new Map())
  const result = await applyRestore(restoreDepsOf(ctx, workspace, options.io), plan, {
    kind: 'rewind',
    batchId: createChangeBatchId(),
    conflicts: body.conflicts,
  })
  finishBatch(ctx, workspace, 'rewind', 'files rewound', result)
  return result
}
