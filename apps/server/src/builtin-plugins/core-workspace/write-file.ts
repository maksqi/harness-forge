// The `write_file` tool of `core-workspace` (ADR-032; access `write`, timeout 30 s; policy: `always` for a hidden or
// secret-looking path, else `ask`, which the Accept edits mode runs without asking). Creates a text file or replaces the
// whole content of an existing one through `journaledWrite` (Phase 8, ADR-036: under the file's lock the previous state
// is snapshotted and journaled before the frozen `writeWorkspaceFile` writes: path guard with `allowMissing`, `.git`
// refused, missing folders created, temp file + rename keeping the old file's mode). The content is written as given
// (at most 256 KiB, checked by the input schema).
//
// The output carries the diff against the old content read under the lock (`computeWorkspaceDiff`; null when the old
// file is binary or larger than 1 MiB, or when the diff times out). The model sees "Created x (N lines)." or "Updated x
// (+a -r lines).".
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { WriteFileToolInput, WriteFileToolOutput } from '@harness-forge/shared'
import type { CheckpointBefore } from '../../services/checkpoints/types.ts'
import { WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS, writeFileToolInputSchema, writeFileToolOutputSchema } from '@harness-forge/shared'
import { decodeText } from '../../plugins/scaffold/paths.ts'
import { computeWorkspaceDiff } from '../../workspace/diff.ts'
import { journaledWrite } from '../../workspace/journal.ts'
import { BOM, countLines, plural } from '../../workspace/text.ts'
import { requireWorkspace, textModelOutput, WRITE_TOOL_TIMEOUT_MS } from './common.ts'
import { writeFilePolicy } from './policies.ts'

export const WRITE_FILE_TOOL_NAME = 'write_file'

/**
 * The text of a file before a write (a leading BOM dropped), from the before-state read under the lock: `''` when it
 * did not exist, null when it is not comparable (larger than `WORKSPACE_LIMITS.editFileMaxBytes`, or not UTF-8 text).
 */
export function previousText(before: CheckpointBefore): string | null {
  if (before.state === 'missing')
    return ''
  if (before.state === 'too-large' || before.size > WORKSPACE_LIMITS.editFileMaxBytes)
    return null
  const text = decodeText(before.bytes)
  return text === null ? null : stripBom(text)
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** The text the model sees for a `write_file` output. */
export function writeFileModelText(output: WriteFileToolOutput): string {
  if (output.created)
    return `Created ${output.path} (${plural(output.lines, 'line')}).`
  if (output.diff === null)
    return `Updated ${output.path} (${plural(output.lines, 'line')}).`
  return `Updated ${output.path} (+${output.diff.added} -${output.diff.removed} lines).`
}

export function createWriteFileTool(): ToolDefinition<WriteFileToolInput, WriteFileToolOutput> {
  return {
    name: WRITE_FILE_TOOL_NAME,
    description: 'Create a text file in the project folder, or replace the whole content of an existing one (missing folders are created; at most 256 KiB). To change part of an existing file, prefer edit_file. Files inside .git are never written.',
    inputSchema: writeFileToolInputSchema,
    policy: writeFilePolicy,
    timeoutMs: WRITE_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.write_file,
    async execute(input, c) {
      const { root } = requireWorkspace(c)
      const { written, before } = await journaledWrite(c, root, { tool: WRITE_FILE_TOOL_NAME, path: input.path }, () => input.content)
      const created = written.created
      const previous = created ? '' : previousText(before)
      const diff = previous === null ? null : await computeWorkspaceDiff(previous, stripBom(input.content))
      return { path: written.rel, created, bytes: written.bytes, lines: countLines(input.content), diff }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(writeFileToolOutputSchema, output, writeFileModelText)
    },
  }
}
