// The `write_file` tool of `core-workspace` (ADR-032; access `write`, timeout 30 s; policy: `always` for a hidden or
// secret-looking path, else `ask`, which the Accept edits mode runs without asking). Creates a text file or replaces the
// whole content of an existing one through the frozen `writeWorkspaceFile` (path guard with `allowMissing`, `.git`
// refused, missing folders created, temp file + rename keeping the old file's mode). The content is written as given
// (at most 256 KiB, checked by the input schema).
//
// The output carries the diff against the old content (`computeWorkspaceDiff`; null when the old file is binary or
// larger than 1 MiB, or when the diff times out). The model sees "Created x (N lines)." or "Updated x (+a -r lines).".
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { WriteFileToolInput, WriteFileToolOutput } from '@harness-forge/shared'
import { isHarnessError, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS, writeFileToolInputSchema, writeFileToolOutputSchema } from '@harness-forge/shared'
import { decodeText } from '../../plugins/scaffold/paths.ts'
import { computeWorkspaceDiff } from '../../workspace/diff.ts'
import { readWorkspaceFile, resolveWorkspacePath, writeWorkspaceFile } from '../../workspace/paths.ts'
import { BOM, countLines, plural } from '../../workspace/text.ts'
import { requireWorkspace, textModelOutput, WRITE_TOOL_TIMEOUT_MS } from './common.ts'
import { writeFilePolicy } from './policies.ts'

export const WRITE_FILE_TOOL_NAME = 'write_file'

/**
 * The current text of a file before a write (a leading BOM dropped): null when it does not exist or is not comparable
 * (larger than `WORKSPACE_LIMITS.editFileMaxBytes`, or not UTF-8 text). A folder or another non-regular target throws
 * (the write would fail the same way).
 */
async function readPreviousText(root: string, path: string): Promise<string | null> {
  const resolved = await resolveWorkspacePath(root, path, { allowMissing: true })
  if (!resolved.exists)
    return null
  try {
    const { bytes } = await readWorkspaceFile(root, path, { maxBytes: WORKSPACE_LIMITS.editFileMaxBytes })
    const text = decodeText(bytes)
    return text === null ? null : stripBom(text)
  }
  catch (error) {
    if (isHarnessError(error) && (error.code === 'payload_too_large' || error.code === 'not_found'))
      return null
    throw error
  }
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
      const previous = await readPreviousText(root, input.path)
      c.signal.throwIfAborted()
      const written = await writeWorkspaceFile(root, input.path, input.content)
      const created = written.created
      const before = created ? '' : previous
      const diff = before === null ? null : await computeWorkspaceDiff(before, stripBom(input.content))
      return { path: written.rel, created, bytes: written.bytes, lines: countLines(input.content), diff }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(writeFileToolOutputSchema, output, writeFileModelText)
    },
  }
}
