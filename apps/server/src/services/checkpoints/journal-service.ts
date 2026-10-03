// Journals of chat runs and the journal row writer (Phase 8, ADR-036, ARCHITECTURE.md 6.13 "Run scope and journaled
// writes", 6.16 "Journal"). Owner: W8.1 (C19 stub).
//
// - `createCheckpointJournal(ctx, scope)`: the journal of one run (`CheckpointService.journal`). `write` is the core of
//   `journaledWrite` (`workspace/journal.ts`): under the file lock, the before-state, `produce`, the abort check, the
//   before blob (store gate shared), the frozen `writeWorkspaceFile`, the `edit` row; then the coalesced
//   `workspace.changed` (`source: 'tool'`, at most one event per second per chat). `recordShell` / `recordUntracked`
//   insert the `shell` / `untracked` rows of W8.5's wrapper.
// - `createChangeRowWriter(deps, now)`: inserts rows (`message_seq` = the chat's `coalesce(max(seq), 0)` now,
//   `created_at` = now, a shell command cut at `LIMITS.journalCommandMaxChars`); the restore primitive (W8.2) writes its
//   `revert` / `rewind` / `undo` rows through it.
//
// Stub: the journal's `write` performs the write without recording (`writeWithoutRecording` of ./disk.ts: lock,
// before-state, `produce`, abort check, write), so the workspace tools keep working until W8.1; `recordShell` and
// `recordUntracked` record nothing; the row writer rejects with `not_implemented` (tests use
// `createTestChangeRowWriter` of `testing/fake-checkpoints.ts`).
import type { AppDeps } from '../../types.ts'
import type { CheckpointContext, CheckpointJournal, CheckpointRowWriter, CheckpointScope } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'
import { writeWithoutRecording } from './disk.ts'

/** The journal of one run (see the module comment). */
export function createCheckpointJournal(_ctx: CheckpointContext, scope: CheckpointScope): CheckpointJournal {
  return {
    scope: Object.freeze({ ...scope }),
    write: writeWithoutRecording,
    recordShell: async () => {},
    recordUntracked: async () => {},
  }
}

/** The journal row writer over the database (see the module comment). */
export function createChangeRowWriter(_deps: Pick<AppDeps, 'db'>, _now: () => number): CheckpointRowWriter {
  return {
    insert: rejectsNotImplemented('Recording a workspace change'),
  }
}
