// Checkpoints, rewind and the changes panel data (Phase 8, ADR-036 / ADR-037, ARCHITECTURE.md 6.16 / 6.17). Owner:
// W8.1 (C19 stub). Implements `CheckpointService` (./types.ts) behind `createCheckpointService(deps)` by composing the
// modules: the store (./store.ts), journals and the row writer (./journal-service.ts), prune (./prune.ts) of W8.1; the
// rewind, revert and undo (./rewind.ts, ./revert.ts, ./undo.ts over ./plan.ts and ./restore.ts) of W8.2; the changes
// list, the diffs and the git view (./changes.ts, ./git-changes.ts) of W8.3. Every module receives the same
// `CheckpointContext` (`deps`, the blob store, the row writer, the clock).
//
// Stub (P8-0b): `start()` creates `DataPaths.checkpoints` (0700) and schedules nothing; `journal()` returns a journal
// whose `write` writes without recording (the workspace tools keep working); the route-facing members (`listChanges`,
// `fileDiff`, `gitStatus`, `revert`, `undo`, `rewindPreview`, `rewind`) reject with `not_implemented` (501); `prune`,
// `purge` and `summary` report an empty store (nothing is stored before W8.1).
import type { AppDeps } from '../../types.ts'
import type { CheckpointStore } from './store.ts'
import type { CheckpointContext, CheckpointService } from './types.ts'
import { chmod, mkdir } from 'node:fs/promises'
import process from 'node:process'
import { changesFileDiff, listChatChanges } from './changes.ts'
import { chatGitStatus } from './git-changes.ts'
import { createChangeRowWriter, createCheckpointJournal } from './journal-service.ts'
import { pruneCheckpoints } from './prune.ts'
import { revertFile } from './revert.ts'
import { rewindFiles, rewindPreview } from './rewind.ts'
import { createCheckpointStore } from './store.ts'
import { undoBatch } from './undo.ts'

export interface CheckpointServiceOptions {
  /** Clock of rows, batches and prune (default `Date.now`). */
  now?: () => number
  /** The store (default: `createCheckpointStore(deps.env.paths.checkpoints)`). */
  store?: CheckpointStore
  /**
   * Run the prune timers (every 6 hours, 60 s after a `chat.deleted`); default on, off under Vitest (tests call
   * `prune()` with fake timers or an injected `now`).
   */
  background?: boolean
}

export function createCheckpointService(deps: AppDeps, options: CheckpointServiceOptions = {}): CheckpointService {
  const now = options.now ?? Date.now
  const store = options.store ?? createCheckpointStore(deps.env.paths.checkpoints)
  // Lazy: `deps.db` and friends are read when a member runs, never while the deps are being built.
  const context = (): CheckpointContext => ({ deps, blobs: store, rows: createChangeRowWriter(deps, now), now })

  return {
    journal: scope => createCheckpointJournal(context(), scope),
    listChanges: (chatId, readOptions) => listChatChanges(context(), chatId, readOptions),
    fileDiff: (chatId, query, readOptions) => changesFileDiff(context(), chatId, query, readOptions),
    gitStatus: (chatId, readOptions) => chatGitStatus(context(), chatId, readOptions),
    revert: (chatId, body) => revertFile(context(), chatId, body),
    undo: (chatId, body) => undoBatch(context(), chatId, body),
    rewindPreview: (chatId, messageId, readOptions) => rewindPreview(context(), chatId, messageId, readOptions),
    rewind: (chatId, body) => rewindFiles(context(), chatId, body),
    start: async () => {
      await mkdir(store.dir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32')
        await chmod(store.dir, 0o700)
    },
    stop: async () => {},
    prune: async (pruneOptions = {}) => pruneCheckpoints(context(), store, { now: pruneOptions.now ?? now() }),
    purge: () => store.purge(),
    summary: () => store.summary(),
  }
}
