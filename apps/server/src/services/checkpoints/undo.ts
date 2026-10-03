// Undo of a revert, rewind or undo batch (Phase 8, ADR-036, API.md 5.24 `changes.undo`, ARCHITECTURE.md 6.16 "Undo").
// Owner: W8.2.
//
// Restores the before-states of a batch's rows (expected = their after-states, `planUndo`) as a new `undo` batch with
// the same lock, conflict (`skip` / `force`) and `409 run-active` rules; a batch that has no row of this chat in its
// current project (another chat's, an unknown one, or one recorded while the chat belonged to another project) is
// `404 not_found` ("Change batch <batchId> not found."). Undoing the undo batch redoes the original. Errors in order:
// unknown chat (404), no project / folder not available (400), unknown batch (404), a run (409).
import type { ChangeUndoBody, RestoreResult } from '@harness-forge/shared'
import type { RestoreIo } from './restore-scope.ts'
import type { CheckpointContext } from './types.ts'
import { createChangeBatchId, HarnessError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { workspaceChanges } from '../../db/schema.ts'
import { isFileRow, planUndo } from './plan.ts'
import { assertProjectIdle, finishBatch, journalRows, openChatWorkspace, requireChat, restoreDepsOf } from './restore-scope.ts'
import { applyRestore } from './restore.ts'

/** Test hooks of `undoBatch` (a writer that fails after file N). */
export interface UndoOptions {
  readonly io?: RestoreIo
}

/** `POST /chats/:id/changes/undo`. */
export async function undoBatch(ctx: CheckpointContext, chatId: string, body: ChangeUndoBody, options: UndoOptions = {}): Promise<RestoreResult> {
  const chat = await requireChat(ctx, chatId)
  const workspace = await openChatWorkspace(ctx, chat)
  const rows = (await journalRows(ctx, workspace, eq(workspaceChanges.batchId, body.batchId))).filter(isFileRow)
  if (rows.length === 0)
    throw new HarnessError({ code: 'not_found', message: `Change batch ${body.batchId} not found.` })
  await assertProjectIdle(ctx, workspace.projectId)
  // `applyRestore` reads every file again under its lock, so the plan needs no disk state here.
  const result = await applyRestore(restoreDepsOf(ctx, workspace, options.io), planUndo(rows, new Map()), {
    kind: 'undo',
    batchId: createChangeBatchId(),
    conflicts: body.conflicts,
  })
  finishBatch(ctx, workspace, 'undo', 'restore undone', result)
  return result
}
