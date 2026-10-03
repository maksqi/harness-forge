// What rewind, revert and undo share (Phase 8, ADR-036 / ADR-037, API.md 5.24 "Common errors", ARCHITECTURE.md 6.16).
// Owner: W8.2.
//
// - `requireChat`: `404 not_found` for an unknown chat ("Chat <id> not found."); the one lookup of a request (Phase 9,
//   W9.7: defined in `changes-common.ts` with `NO_PROJECT_MESSAGE` and re-exported here).
// - `openChatWorkspace`: the chat's **current** project, opened through `deps.projects.openWorkspace` (the stored path
//   must still be its own realpath, a directory inside a root); a chat without a project or a folder that cannot be
//   opened is `400 validation_error` with the project service's message.
// - `assertProjectIdle`: `409 conflict` (`reason: 'run-active'`, `details.chatId`) while **any** chat of the project
//   holds a run (`deps.runs.hasRun`, the check of project deletion); nothing is written then.
// - `journalRows`: rows of the chat in its current project (rows recorded while the chat belonged to another project
//   are ignored), in journal order.
// - `restoreDepsOf`, `finishBatch`: the restore primitive's deps, and after a batch the `workspace.changed` event (only
//   when something was written) plus the log lines (counts at `info`, paths only at `debug`).
import type { RestoreResult, WorkspaceChangedSource } from '@harness-forge/shared'
import type { SQL } from 'drizzle-orm'
import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { ChatRecord } from '../chats/types.ts'
import type { RestoreDeps } from './restore.ts'
import type { CheckpointContext } from './types.ts'
import { HarnessError, LIMITS, validationError } from '@harness-forge/shared'
import { and, asc, eq } from 'drizzle-orm'
import { chats, workspaceChanges } from '../../db/schema.ts'
import { PROJECT_RUNNING_MESSAGE } from '../projects/index.ts'
import { NO_PROJECT_MESSAGE } from './changes-common.ts'

export { NO_PROJECT_MESSAGE, requireChat } from './changes-common.ts'

/** The opened project folder of a chat. */
export interface ChatWorkspace {
  readonly chatId: string
  /** The chat's current project. */
  readonly projectId: string
  /** The project folder (canonical realpath, from `openWorkspace`). */
  readonly root: string
}

function workspaceUnavailable(message: string): HarnessError {
  return validationError([{ path: [], message, code: 'custom' }], message)
}

/**
 * The chat's current project folder; `400 validation_error` without a project, for a project that no longer exists
 * and for a folder that cannot be opened (the `openWorkspace` message).
 */
export async function openChatWorkspace(ctx: CheckpointContext, chat: ChatRecord): Promise<ChatWorkspace> {
  if (chat.projectId === null)
    throw workspaceUnavailable(NO_PROJECT_MESSAGE)
  const opened = await ctx.deps.projects.openWorkspace(chat.projectId)
  if (!opened.ok)
    throw workspaceUnavailable(opened.message)
  return { chatId: chat.id, projectId: opened.workspace.projectId, root: opened.workspace.root }
}

/** `409 conflict` (`run-active`, `details.chatId`) while any chat of the project holds a run. */
export async function assertProjectIdle(ctx: CheckpointContext, projectId: string): Promise<void> {
  const members = await ctx.deps.db.select({ id: chats.id }).from(chats).where(eq(chats.projectId, projectId))
  const running = members.find(chat => ctx.deps.runs.hasRun(chat.id))
  if (running !== undefined) {
    throw new HarnessError({
      code: 'conflict',
      message: PROJECT_RUNNING_MESSAGE,
      details: { reason: 'run-active', chatId: running.id },
    })
  }
}

/** Rows of the chat in its current project (and `where`), oldest first. */
export async function journalRows(ctx: CheckpointContext, workspace: ChatWorkspace, where?: SQL): Promise<WorkspaceChangeRow[]> {
  const scope = and(eq(workspaceChanges.chatId, workspace.chatId), eq(workspaceChanges.projectId, workspace.projectId))
  return ctx.deps.db.select().from(workspaceChanges).where(where === undefined ? scope : and(scope, where)).orderBy(asc(workspaceChanges.id))
}

/** Options of the restore deps (tests inject a failing writer). */
export type RestoreIo = Pick<RestoreDeps, 'writeFile' | 'removeFile'>

/** The deps of `applyRestore` for one chat's workspace. */
export function restoreDepsOf(ctx: CheckpointContext, workspace: ChatWorkspace, io: RestoreIo = {}): RestoreDeps {
  return { ...ctx, chatId: workspace.chatId, projectId: workspace.projectId, root: workspace.root, ...io }
}

/** The paths a batch wrote (restored, then deleted). */
export function writtenPaths(result: RestoreResult): string[] {
  return [...result.restored, ...result.deleted]
}

/**
 * After a batch: `workspace.changed` (`source`, the batch id, at most `LIMITS.workspaceEventPathsMax` paths) when it
 * wrote something, and one log line with the counts at `info` (the paths at `debug`).
 */
export function finishBatch(ctx: CheckpointContext, workspace: ChatWorkspace, source: Exclude<WorkspaceChangedSource, 'tool'>, message: string, result: RestoreResult): void {
  const paths = writtenPaths(result)
  if (result.batchId !== null && paths.length > 0) {
    ctx.deps.events.emit('workspace.changed', {
      projectId: workspace.projectId,
      chatId: workspace.chatId,
      batchId: result.batchId,
      source,
      paths: paths.slice(0, LIMITS.workspaceEventPathsMax),
    })
  }
  const { logger } = ctx.deps
  logger.info(message, {
    chatId: workspace.chatId,
    projectId: workspace.projectId,
    batchId: result.batchId,
    restored: result.restored.length,
    deleted: result.deleted.length,
    unchanged: result.unchanged.length,
    skipped: result.skipped.length,
  })
  if (logger.isLevelEnabled('debug')) {
    logger.debug(`${message}: paths`, {
      batchId: result.batchId,
      restored: result.restored,
      deleted: result.deleted,
      skipped: result.skipped.map(skip => ({ path: skip.path, reason: skip.reason })),
    })
  }
}
