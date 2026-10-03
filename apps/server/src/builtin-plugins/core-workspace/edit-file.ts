// The `edit_file` tool of `core-workspace` (ADR-032; access `write`, timeout 30 s). P7-0b skeleton (C14): the definition
// is final except the policy (W7.2: the same function as `write_file`) and `execute` / `toModelOutput` (W7.2: a unique
// exact match unless `replace_all`, CRLF and BOM kept, the diff, "Edited x: N replacement(s) (+a -r lines).").
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { EditFileToolInput, EditFileToolOutput } from '@harness-forge/shared'
import { editFileToolInputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { toolNotImplemented, WRITE_TOOL_TIMEOUT_MS } from './common.ts'

export const EDIT_FILE_TOOL_NAME = 'edit_file'

export function createEditFileTool(): ToolDefinition<EditFileToolInput, EditFileToolOutput> {
  return {
    name: EDIT_FILE_TOOL_NAME,
    description: 'Replace text in a file of the project folder. old_string must match the file exactly (whitespace and indentation included) and occur once, unless replace_all is true; read the file before editing it, and add surrounding lines to old_string to make it unique. Returns the number of replacements and a diff.',
    inputSchema: editFileToolInputSchema,
    policy: 'ask',
    timeoutMs: WRITE_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.edit_file,
    async execute() {
      throw toolNotImplemented(EDIT_FILE_TOOL_NAME)
    },
  }
}
