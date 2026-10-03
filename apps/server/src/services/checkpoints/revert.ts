// Revert of one file (Phase 8, ADR-037, API.md 5.24 `changes.revert`, ARCHITECTURE.md 6.17 "Revert"). Owner: W8.2
// (C19 stub).
//
// `chat` source: the base state (the file before the chat first changed it; a `too-large` / `evicted` base is `400`).
// `git` source: the raw HEAD blob (`gitHeadBlob` of `workspace/git.ts`; mode 100755 stays executable); an untracked or
// added file is deleted after a snapshot; a rename restores `origPath` and deletes `path`; refused (`400`): conflicted
// files, symbolic links (120000), submodules and paths with a `filter` attribute (`gitFilterAttr`, Git LFS). The git
// index is never touched. A disk state other than `expectedSha` is `409 conflict` (`stale`); `409` (`run-active`)
// while any chat of the project runs. One undoable `revert` batch through `applyRestore`.
import type { ChangeRevertBody, RestoreResult } from '@harness-forge/shared'
import type { CheckpointContext } from './types.ts'
import { notImplementedError } from '../../not-implemented.ts'

/** `POST /chats/:id/changes/revert`. */
export async function revertFile(_ctx: CheckpointContext, _chatId: string, _body: ChangeRevertBody): Promise<RestoreResult> {
  throw notImplementedError('Reverting a file')
}
