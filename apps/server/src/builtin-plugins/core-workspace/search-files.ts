// The `search_files` tool of `core-workspace` (ADR-032; policy `safe`, access `read`, timeout 60 s). P7-0b skeleton
// (C14): the definition is final except `execute` / `toModelOutput` (W7.2: the regex runs in a killable Worker, files
// over 1 MiB and secret-looking files are skipped).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { SearchFilesToolInput, SearchFilesToolOutput } from '@harness-forge/shared'
import { searchFilesToolInputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { SEARCH_TOOL_TIMEOUT_MS, toolNotImplemented } from './common.ts'

export const SEARCH_FILES_TOOL_NAME = 'search_files'

export function createSearchFilesTool(): ToolDefinition<SearchFilesToolInput, SearchFilesToolOutput> {
  return {
    name: SEARCH_FILES_TOOL_NAME,
    description: 'Search the contents of the project files with a JavaScript regular expression (or plain text with literal: true; case-sensitive unless case_sensitive is false). Returns matching lines as "path:line: text". Narrow it with glob and path; .git, node_modules, gitignored, very large and secret-looking files are skipped.',
    inputSchema: searchFilesToolInputSchema,
    policy: 'safe',
    timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.search_files,
    async execute() {
      throw toolNotImplemented(SEARCH_FILES_TOOL_NAME)
    },
  }
}
