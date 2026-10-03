// The `list_directory` tool of `core-workspace` (ADR-032; policy `safe`, access `read`, timeout 30 s). P7-0b skeleton
// (C14): the definition is final except `execute` / `toModelOutput` (W7.2: at most 1000 entries, `dir/` suffixes in the
// model text).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ListDirectoryToolInput, ListDirectoryToolOutput } from '@harness-forge/shared'
import { listDirectoryToolInputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { READ_TOOL_TIMEOUT_MS, toolNotImplemented } from './common.ts'

export const LIST_DIRECTORY_TOOL_NAME = 'list_directory'

export function createListDirectoryTool(): ToolDefinition<ListDirectoryToolInput, ListDirectoryToolOutput> {
  return {
    name: LIST_DIRECTORY_TOOL_NAME,
    description: 'List the files and folders of a folder in the project (default: the project folder itself). Folder names end with "/". At most 1000 entries, sorted by name.',
    inputSchema: listDirectoryToolInputSchema,
    policy: 'safe',
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.list_directory,
    async execute() {
      throw toolNotImplemented(LIST_DIRECTORY_TOOL_NAME)
    },
  }
}
