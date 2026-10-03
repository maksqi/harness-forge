// The journaled write of the agent workspace (Phase 8, ADR-036, ARCHITECTURE.md 6.13 "Run scope and journaled writes").
// Owner: W8.1. The `core-workspace` file tools (`write_file`, `edit_file`) write only through `journaledWrite`.
//
// `journaledWrite(c, root, input, produce)`: resolve the path (`resolveWorkspacePath` with `allowMissing`) and refuse a
// `.git` segment early (the message of `writeWorkspaceFile`), then hand the write to the run's journal
// (`runScopeOf(c)?.journal`, `CheckpointJournal.write`): under the per-file lock, the before-state, `produce(before)`,
// the abort check, the before blob, the frozen `writeWorkspaceFile` and the journal row. A call without a run scope (no
// chat run with a workspace: a test, a plugin's own context object), or whose scope belongs to another project than
// `c.workspace`, writes the same way without recording (`writeWithoutRecording`). Recording failures never fail the
// write (`recorded: false`, logged by the journal).
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { CheckpointBefore, CheckpointWriteResult } from '../services/checkpoints/types.ts'
import type { ResolvedWorkspacePath } from './paths.ts'
import { resolve } from 'node:path'
import { writeWithoutRecording } from '../services/checkpoints/disk.ts'
import { hasGitSegment, resolveWorkspacePath, toWorkspaceRel, workspacePathError } from './paths.ts'
import { runScopeOf } from './run-scope.ts'

export interface JournaledWriteInput {
  /** The tool name for the journal row (`write_file`, `edit_file`). */
  readonly tool: string
  /** The path as the model gave it (resolved here, relative to `root` or absolute inside it). */
  readonly path: string
}

/**
 * Builds the new content from the before-state, under the file's lock; `resolved` is the checked target (its `rel` is
 * the project-relative path for messages). A throw ends the write: nothing is stored, written or journaled.
 */
export type JournaledProduce = (before: CheckpointBefore, resolved: ResolvedWorkspacePath) => string | Uint8Array | Promise<string | Uint8Array>

/** Refuses a `.git` segment in the input as given or in the resolved path (the message of `writeWorkspaceFile`). */
function refuseGit(root: string, input: string, resolved: ResolvedWorkspacePath): void {
  const lexical = toWorkspaceRel(root, resolve(root, input))
  if (hasGitSegment(lexical) || hasGitSegment(resolved.rel))
    throw workspacePathError(`"${lexical}" is inside a .git folder: the workspace tools never write there.`)
}

/** One write of a workspace tool, journaled when the call runs in a chat run with a workspace (see the module comment). */
export async function journaledWrite(c: ToolCallContext, root: string, input: JournaledWriteInput, produce: JournaledProduce): Promise<CheckpointWriteResult> {
  const resolved = await resolveWorkspacePath(root, input.path, { allowMissing: true })
  refuseGit(root, input.path, resolved)
  const scope = runScopeOf(c)
  const write = {
    toolCallId: scope?.toolCallId ?? c.toolCallId,
    tool: input.tool,
    root,
    resolved,
    produce: (before: CheckpointBefore) => produce(before, resolved),
    signal: c.signal,
  }
  const journal = scope?.journal ?? null
  const projectId = c.workspace?.projectId
  if (journal === null || scope?.projectId !== projectId || journal.scope.projectId !== projectId)
    return writeWithoutRecording(write)
  return journal.write(write)
}
