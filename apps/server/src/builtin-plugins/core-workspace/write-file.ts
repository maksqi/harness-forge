// The `write_file` tool of `core-workspace` (ADR-032; access `write`, timeout 30 s). P7-0b skeleton (C14): the
// definition is final except the policy (W7.2: a function, `always` for a hidden or secret-looking path, else `ask`)
// and `execute` / `toModelOutput` (W7.2: `writeWorkspaceFile`, the diff, "Created x (N lines)." / "Updated x (+a -r
// lines).").
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { WriteFileToolInput, WriteFileToolOutput } from '@harness-forge/shared'
import { WORKSPACE_TOOL_ACCESS, writeFileToolInputSchema } from '@harness-forge/shared'
import { toolNotImplemented, WRITE_TOOL_TIMEOUT_MS } from './common.ts'

export const WRITE_FILE_TOOL_NAME = 'write_file'

export function createWriteFileTool(): ToolDefinition<WriteFileToolInput, WriteFileToolOutput> {
  return {
    name: WRITE_FILE_TOOL_NAME,
    description: 'Create a text file in the project folder, or replace the whole content of an existing one (missing folders are created; at most 256 KiB). To change part of an existing file, prefer edit_file. Files inside .git are never written.',
    inputSchema: writeFileToolInputSchema,
    policy: 'ask',
    timeoutMs: WRITE_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.write_file,
    async execute() {
      throw toolNotImplemented(WRITE_FILE_TOOL_NAME)
    },
  }
}
