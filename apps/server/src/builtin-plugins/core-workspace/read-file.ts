// The `read_file` tool of `core-workspace` (ADR-032; access `read`, timeout 30 s). P7-0b skeleton (C14): the definition
// is final except the policy (W7.2: a function, `ask` for a secret-looking path, else `safe`) and `execute` /
// `toModelOutput` (W7.2: text files only, `cat -n` lines for the model, windowed reads through `openWorkspaceFile`).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ReadFileToolInput, ReadFileToolOutput } from '@harness-forge/shared'
import { readFileToolInputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { READ_TOOL_TIMEOUT_MS, toolNotImplemented } from './common.ts'

export const READ_FILE_TOOL_NAME = 'read_file'

export function createReadFileTool(): ToolDefinition<ReadFileToolInput, ReadFileToolOutput> {
  return {
    name: READ_FILE_TOOL_NAME,
    description: 'Read a text file of the project folder. Returns its lines with line numbers (like cat -n), at most 2000 lines or 48 KiB per call; for a longer file, continue with offset (1-based first line) and limit. Paths are relative to the project folder.',
    inputSchema: readFileToolInputSchema,
    policy: 'safe',
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.read_file,
    async execute() {
      throw toolNotImplemented(READ_FILE_TOOL_NAME)
    },
  }
}
