// The checkpoint blob store (Phase 8, ADR-036, ARCHITECTURE.md 6.16 "Blob store"). Owner: W8.1 (C19 stub).
//
// `<dataDir>/checkpoints/<aa>/<sha256>`: the raw before-bytes of project files, deduplicated by sha256 (an existing blob
// is kept), folders 0700 / files 0600, written to a temp file, fsynced, then renamed; names are validated as 64
// lowercase hex characters and never resolve outside `DataPaths.checkpoints`. Writers hold the store gate
// (`createStoreGate()` of `services/files/gate.ts`) shared from the blob write until their row is inserted; prune and
// purge hold it exclusively. A separate tree from `files/`: the file sweep never walks it, and no route serves it.
//
// Stub: `put`, `read`, `has` and `remove` reject with `not_implemented` (nothing calls them before W8.1: the skeleton
// journal writes without recording); `summary` and `purge` report an empty store (the skeleton never stores a blob);
// the gate and `checkpointBlobPath` are complete.
import type { CheckpointBlobStore, CheckpointSummary } from './types.ts'
import { join } from 'node:path'
import { SHA256_HEX_PATTERN, validationError } from '@harness-forge/shared'
import { rejectsNotImplemented } from '../../not-implemented.ts'
import { createStoreGate } from '../files/gate.ts'

/** The blob store plus the members only the checkpoint modules of W8.1 use (prune, purge, the summary). */
export interface CheckpointStore extends CheckpointBlobStore {
  /** `DataPaths.checkpoints`. */
  readonly dir: string
  /** Runs `operation` holding the store gate alone (prune, purge). */
  readonly withExclusiveGate: <T>(operation: () => Promise<T>) => Promise<T>
  /** Bytes and number of the blobs on disk (`DataSummary.checkpoints`). */
  readonly summary: () => Promise<CheckpointSummary>
  /** Removes every blob and temp file (delete-all); resolves to what was removed. */
  readonly purge: () => Promise<CheckpointSummary>
}

/**
 * The path of blob `sha` inside `dir` (`<dir>/<first two hex>/<sha>`); `validation_error` for a name that is not 64
 * lowercase hex characters, so a stored or requested name never becomes a path outside the store.
 */
export function checkpointBlobPath(dir: string, sha: string): string {
  if (!SHA256_HEX_PATTERN.test(sha))
    throw validationError([{ path: ['sha'], message: 'Expected a lowercase hex SHA-256.', code: 'custom' }])
  return join(dir, sha.slice(0, 2), sha)
}

/** The checkpoint store over `dir` (`DataPaths.checkpoints`; created by `checkpoints.start()`). */
export function createCheckpointStore(dir: string): CheckpointStore {
  const gate = createStoreGate()
  const empty = async (): Promise<CheckpointSummary> => ({ bytes: 0, blobs: 0 })
  return {
    dir,
    put: rejectsNotImplemented('Storing a checkpoint'),
    read: rejectsNotImplemented('Reading a checkpoint'),
    has: rejectsNotImplemented('Reading a checkpoint'),
    remove: rejectsNotImplemented('Removing a checkpoint'),
    withSharedGate: operation => gate.shared(operation),
    withExclusiveGate: operation => gate.exclusive(operation),
    summary: empty,
    purge: empty,
  }
}
