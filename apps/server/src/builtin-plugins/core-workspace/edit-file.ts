// The `edit_file` tool of `core-workspace` (ADR-032; access `write`, timeout 30 s; policy: the `write_file` function,
// `always` for a hidden or secret-looking path, else `ask`). Replaces `old_string` in a UTF-8 text file of at most 1 MiB
// (`WORKSPACE_LIMITS.editFileMaxBytes`, read through the frozen `readWorkspaceFile`):
//
// - `old_string === new_string` is an error; `old_string` must occur exactly once unless `replace_all` ("not found"
//   tells the model to read the file again and match whitespace exactly, "occurs N times" to add context or set
//   `replace_all`); the replacement is literal (no `$&` patterns);
// - a file that is CRLF throughout is matched on its LF text (CRLF in the strings is read as LF) and written back as
//   CRLF; mixed line endings are matched raw; a leading BOM is kept;
// - the edit runs inside `journaledWrite` (Phase 8, ADR-036): under the file's lock the current state is read, the
//   replacement applied to it, the previous state snapshotted and journaled, and the result written through the frozen
//   `writeWorkspaceFile` (temp file + rename keeping the mode); it may not exceed 1 MiB. Two parallel edits of one file
//   serialize, and the second applies to the first one's result.
//
// The output carries the diff of the LF text (`computeWorkspaceDiff`, null on timeout). The model sees "Edited x: N
// replacement(s) (+a -r lines).".
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { EditFileToolInput, EditFileToolOutput } from '@harness-forge/shared'
import type { CheckpointBefore } from '../../services/checkpoints/types.ts'
import type { ResolvedWorkspacePath } from '../../workspace/paths.ts'
import { editFileToolInputSchema, editFileToolOutputSchema, HarnessError, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { decodeText } from '../../plugins/scaffold/paths.ts'
import { computeWorkspaceDiff } from '../../workspace/diff.ts'
import { journaledWrite } from '../../workspace/journal.ts'
import { BOM, byteLength, plural } from '../../workspace/text.ts'
import { requireWorkspace, textModelOutput, WRITE_TOOL_TIMEOUT_MS } from './common.ts'
import { writeFilePolicy } from './policies.ts'

export const EDIT_FILE_TOOL_NAME = 'edit_file'

function editError(message: string, field = 'old_string'): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: [field], message, code: 'custom' }] } })
}

/** True when every `\n` of the text follows a `\r` (and there is at least one). */
export function isCrlfThroughout(text: string): boolean {
  let newlines = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (index === 0 || text.charCodeAt(index - 1) !== 13)
      return false
    newlines++
  }
  return newlines > 0
}

/** Non-overlapping occurrences of `needle` in `text` (`needle` is not empty). */
export function countOccurrences(text: string, needle: string): number {
  let count = 0
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length))
    count++
  return count
}

export interface AppliedEdit {
  /** The new file text (BOM and line endings as in the original). */
  text: string
  /** Old and new text for the diff (LF for a CRLF file, without the BOM). */
  before: string
  after: string
  replacements: number
}

/** Applies an edit to the decoded file text (see the module comment); throws the model-facing errors. */
export function applyEdit(original: string, input: Pick<EditFileToolInput, 'old_string' | 'new_string' | 'replace_all'>, rel: string): AppliedEdit {
  if (input.old_string === input.new_string)
    throw editError('old_string and new_string are the same: there is nothing to change.')
  const bom = original.startsWith(BOM)
  const body = bom ? original.slice(1) : original
  const crlf = isCrlfThroughout(body)
  const text = crlf ? body.replaceAll('\r\n', '\n') : body
  const oldString = crlf ? input.old_string.replaceAll('\r\n', '\n') : input.old_string
  const newString = crlf ? input.new_string.replaceAll('\r\n', '\n') : input.new_string
  if (oldString === newString)
    throw editError('old_string and new_string are the same: there is nothing to change.')

  const occurrences = countOccurrences(text, oldString)
  if (occurrences === 0)
    throw editError(`old_string was not found in ${rel}. Read the file again and copy the text exactly, including whitespace and indentation.`)
  if (occurrences > 1 && input.replace_all !== true)
    throw editError(`old_string occurs ${occurrences} times in ${rel}. Add more surrounding lines to old_string to make it unique, or set replace_all to true to replace every occurrence.`)

  let after: string
  if (input.replace_all === true) {
    after = text.split(oldString).join(newString)
  }
  else {
    const index = text.indexOf(oldString)
    after = text.slice(0, index) + newString + text.slice(index + oldString.length)
  }
  const restored = crlf ? after.replaceAll('\n', '\r\n') : after
  return { text: bom ? BOM + restored : restored, before: text, after, replacements: input.replace_all === true ? occurrences : 1 }
}

/**
 * The UTF-8 text of the file to edit, from the before-state read under the lock; the errors of the v1.3 read (a missing
 * file is `not_found`, a file over 1 MiB `payload_too_large`, a binary file a `validation_error` on `path`).
 */
function editableText(before: CheckpointBefore, resolved: ResolvedWorkspacePath): string {
  if (before.state === 'missing')
    throw new HarnessError({ code: 'not_found', message: `"${resolved.rel}" does not exist in the project folder.` })
  const maxBytes = WORKSPACE_LIMITS.editFileMaxBytes
  if (before.state === 'too-large' || before.size > maxBytes) {
    throw new HarnessError({
      code: 'payload_too_large',
      message: `"${resolved.rel}" is larger than ${Math.floor(maxBytes / 1024)} KiB.`,
      details: { limitBytes: maxBytes },
    })
  }
  const text = decodeText(before.bytes)
  if (text === null)
    throw editError(`"${resolved.rel}" is not a UTF-8 text file: edit_file changes text files only.`, 'path')
  return text
}

/** The text the model sees for an `edit_file` output. */
export function editFileModelText(output: EditFileToolOutput): string {
  const replacements = plural(output.replacements, 'replacement')
  if (output.diff === null)
    return `Edited ${output.path}: ${replacements}.`
  return `Edited ${output.path}: ${replacements} (+${output.diff.added} -${output.diff.removed} lines).`
}

export function createEditFileTool(): ToolDefinition<EditFileToolInput, EditFileToolOutput> {
  return {
    name: EDIT_FILE_TOOL_NAME,
    description: 'Replace text in a file of the project folder. old_string must match the file exactly (whitespace and indentation included) and occur once, unless replace_all is true; read the file before editing it, and add surrounding lines to old_string to make it unique. Returns the number of replacements and a diff.',
    inputSchema: editFileToolInputSchema,
    policy: writeFilePolicy,
    timeoutMs: WRITE_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.edit_file,
    async execute(input, c) {
      const { root } = requireWorkspace(c)
      if (input.old_string === input.new_string)
        throw editError('old_string and new_string are the same: there is nothing to change.')
      let edit: AppliedEdit | undefined
      const { written } = await journaledWrite(c, root, { tool: EDIT_FILE_TOOL_NAME, path: input.path }, (before, resolved) => {
        const applied = applyEdit(editableText(before, resolved), input, resolved.rel)
        if (byteLength(applied.text) > WORKSPACE_LIMITS.editFileMaxBytes)
          throw editError(`The edit would make ${resolved.rel} larger than 1 MiB.`, 'new_string')
        edit = applied
        return applied.text
      })
      const applied = edit!
      const diff = await computeWorkspaceDiff(applied.before, applied.after)
      return { path: written.rel, replacements: applied.replacements, diff }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(editFileToolOutputSchema, output, editFileModelText)
    },
  }
}
