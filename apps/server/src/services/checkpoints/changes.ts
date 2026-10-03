// The "This chat" view of the changes panel and the diff of one file (Phase 8, ADR-037, API.md 5.24 `changes.list` /
// `changes.diff`, ARCHITECTURE.md 6.17). Owner: W8.3 (C19 stub).
//
// - `listChatChanges`: one entry per path (at most `LIMITS.changesFilesMax`, most recently changed first, +
//   `truncated`) from base (the earliest before-state), expected (the latest after-state) and current (`diskShas`);
//   `status` added / modified / deleted / unchanged; `edits`; `changedOutside` (current != expected); `revertible` (base
//   `stored`, or `missing` for a created file); `added` / `removed` only for the first `LIMITS.changesLineCountFiles`
//   text files of at most `LIMITS.changesLineCountMaxBytes` (else null); `lastEditAt`; `untracked.{shellCommands,
//   toolCalls}`; `available: false` with `no-project` / `folder-unavailable`.
// - `changesFileDiff`: `source: 'chat'` here (base against the disk through `computeWorkspaceDiff`, sides at most
//   `LIMITS.changeDiffSideMaxBytes` else `tooLarge`, binary = a NUL byte in the first 8 KiB or a failed `decodeText`,
//   `currentSha`, `baseAvailable`); `source: 'git'` goes to `gitFileDiff` of ./git-changes.ts.
import type { ChangeDiffQuery, ChatChanges, FileDiff } from '@harness-forge/shared'
import type { CheckpointContext, CheckpointReadOptions } from './types.ts'
import { notImplementedError } from '../../not-implemented.ts'

/** `GET /chats/:id/changes`. */
export async function listChatChanges(_ctx: CheckpointContext, _chatId: string, _options: CheckpointReadOptions = {}): Promise<ChatChanges> {
  throw notImplementedError('The changes of a chat')
}

/** `GET /chats/:id/changes/diff` for both sources (`git` is delegated to `gitFileDiff`). */
export async function changesFileDiff(_ctx: CheckpointContext, _chatId: string, _query: ChangeDiffQuery, _options: CheckpointReadOptions = {}): Promise<FileDiff> {
  throw notImplementedError('The diff of a changed file')
}
