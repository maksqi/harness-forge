// The `find_files` tool of `core-workspace` (ADR-032; policy `safe`, access `read`, timeout 60 s). P7-0b skeleton (C14):
// the definition is final except `execute` / `toModelOutput` (W7.2: the async walker, nested `.gitignore` files,
// `picomatch` globs).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { FindFilesToolInput, FindFilesToolOutput } from '@harness-forge/shared'
import { findFilesToolInputSchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { SEARCH_TOOL_TIMEOUT_MS, toolNotImplemented } from './common.ts'

export const FIND_FILES_TOOL_NAME = 'find_files'

export function createFindFilesTool(): ToolDefinition<FindFilesToolInput, FindFilesToolOutput> {
  return {
    name: FIND_FILES_TOOL_NAME,
    description: 'Find files of the project folder by glob pattern, e.g. "src/**/*.ts" or "*.md" (a pattern without "/" matches file names at any depth; dot files are included). .git is always skipped; node_modules and gitignored files are skipped unless include_ignored is true. Returns sorted paths relative to the project folder.',
    inputSchema: findFilesToolInputSchema,
    policy: 'safe',
    timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.find_files,
    async execute() {
      throw toolNotImplemented(FIND_FILES_TOOL_NAME)
    },
  }
}
