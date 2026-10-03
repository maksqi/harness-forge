// Undo of a revert, rewind or undo batch (Phase 8, ADR-036, API.md 5.24 `changes.undo`, ARCHITECTURE.md 6.16 "Undo").
// Owner: W8.2 (C19 stub).
//
// Restores the before-states of a batch's rows (expected = their after-states, `planUndo`) as a new `undo` batch with
// the same lock, conflict (`skip` / `force`) and `409 run-active` rules; a batch of another chat or an unknown one is
// `404 not_found`.
import type { ChangeUndoBody, RestoreResult } from '@harness-forge/shared'
import type { CheckpointContext } from './types.ts'
import { notImplementedError } from '../../not-implemented.ts'

/** `POST /chats/:id/changes/undo`. */
export async function undoBatch(_ctx: CheckpointContext, _chatId: string, _body: ChangeUndoBody): Promise<RestoreResult> {
  throw notImplementedError('Undoing a change')
}
