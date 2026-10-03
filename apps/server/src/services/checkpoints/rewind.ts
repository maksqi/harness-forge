// Rewind (Phase 8, ADR-036, API.md 5.24 `changes.rewindPreview` / `changes.rewind`, ARCHITECTURE.md 6.16 "Rewind").
// Owner: W8.2 (C19 stub).
//
// Time-based: "the files as they were when user message M was sent". The range is every file row of the chat in its
// current project with `message_seq >= M.seq`, on any branch. Only user messages of the chat are targets (`400
// validation_error` on `['messageId']` otherwise, `404` for an unknown message). The preview lists at most
// `LIMITS.changesFilesMax` files (+ `truncated`), `untracked.shellCount`, the last `LIMITS.rewindUntrackedListMax`
// shell commands and untracked tool calls of the range; the apply is `409 conflict` (`run-active`, `details.chatId`)
// while any chat of the project runs, and one `rewind` batch through `applyRestore`.
import type { RestoreResult, RewindBody, RewindPreview } from '@harness-forge/shared'
import type { CheckpointContext, CheckpointReadOptions } from './types.ts'
import { notImplementedError } from '../../not-implemented.ts'

/** `GET /chats/:id/rewind?messageId=` (writes nothing). */
export async function rewindPreview(_ctx: CheckpointContext, _chatId: string, _messageId: string, _options: CheckpointReadOptions = {}): Promise<RewindPreview> {
  throw notImplementedError('The rewind preview')
}

/** `POST /chats/:id/rewind`. */
export async function rewindFiles(_ctx: CheckpointContext, _chatId: string, _body: RewindBody): Promise<RestoreResult> {
  throw notImplementedError('Rewinding files')
}
