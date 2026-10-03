// Builtin plugin `core-workspace` (Phase 7, ADR-032 / ADR-033, PLUGINS.md 1, ARCHITECTURE.md 6.13): the workspace
// tools of project chats, registered through the public plugin SDK (plugin API 1.2.0: `ToolDefinition.workspace`,
// `ToolCallContext.workspace`). The host offers them only in a chat whose project folder opened (`c.workspace` set) and
// the `execute` tool only while `HF_WORKSPACE_SHELL` is on; every path goes through the frozen path guard
// `workspace/paths.ts` (`resolveWorkspacePath`, `openWorkspaceFile`, `readWorkspaceFile`, `writeWorkspaceFile`).
// Version 1.0.0, `engines.harness` `^1.2.0`, permission `process`, no settings.
//
// File layout (P7-0b skeleton by C14; one module per tool, each exporting `create<Tool>Tool(...)` and its name):
//
//   index.ts           manifest, `createWorkspaceTools()` (registration order, `shell` skipped on Windows), setup   W7.2
//   common.ts          guard timeouts, `requireWorkspace(c)`, `toolNotImplemented(name)`                             W7.2
//   read-file.ts       `read_file`       access read,    policy safe (W7.2: function, `ask` for secret paths), 30 s  W7.2
//   list-directory.ts  `list_directory`  access read,    policy safe, 30 s                                          W7.2
//   find-files.ts      `find_files`      access read,    policy safe, 60 s                                          W7.2
//   search-files.ts    `search_files`    access read,    policy safe, 60 s                                          W7.2
//   write-file.ts      `write_file`      access write,   policy ask (W7.2: function, `always` for hidden / secret)  W7.2
//   edit-file.ts       `edit_file`       access write,   policy ask (W7.2: as write_file), 30 s                     W7.2
//   shell-tool.ts      `shell`           access execute, policy ask, 600 s; `createShellTool({ logger })`           W7.3
//
// W7.2 owns every file of this folder except `shell-tool*` (W7.3); helpers W7.2 adds (walker, search worker, diffs,
// sensitive paths) live in `S/workspace/` or in new files here, and new test files sit next to their module
// (`read-file.test.ts`, ...). The input schemas, access levels and limits come from `@harness-forge/shared`
// (`WORKSPACE_TOOL_SCHEMAS`, `WORKSPACE_TOOL_ACCESS`, `WORKSPACE_LIMITS`).
import type { Logger, PluginManifest, ToolDefinition } from '@harness-forge/plugin-sdk'
import process from 'node:process'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { createEditFileTool } from './edit-file.ts'
import { createFindFilesTool } from './find-files.ts'
import { createListDirectoryTool } from './list-directory.ts'
import { createReadFileTool } from './read-file.ts'
import { createSearchFilesTool } from './search-files.ts'
import { createShellTool } from './shell-tool.ts'
import { createWriteFileTool } from './write-file.ts'

export {
  NO_WORKSPACE_MESSAGE,
  READ_TOOL_TIMEOUT_MS,
  requireWorkspace,
  SEARCH_TOOL_TIMEOUT_MS,
  SHELL_TOOL_TIMEOUT_MS,
  WRITE_TOOL_TIMEOUT_MS,
} from './common.ts'
export { createEditFileTool, EDIT_FILE_TOOL_NAME } from './edit-file.ts'
export { createFindFilesTool, FIND_FILES_TOOL_NAME } from './find-files.ts'
export { createListDirectoryTool, LIST_DIRECTORY_TOOL_NAME } from './list-directory.ts'
export { createReadFileTool, READ_FILE_TOOL_NAME } from './read-file.ts'
export { createSearchFilesTool, SEARCH_FILES_TOOL_NAME } from './search-files.ts'
export { createShellTool, SHELL_TOOL_NAME } from './shell-tool.ts'
export type { ShellToolOptions } from './shell-tool.ts'
export { createWriteFileTool, WRITE_FILE_TOOL_NAME } from './write-file.ts'

export const manifest = {
  manifestVersion: 1,
  id: 'core-workspace',
  name: 'Workspace tools',
  version: '1.0.0',
  description: 'Builtin workspace tools for project chats: read_file, list_directory, find_files, search_files, write_file, edit_file and shell.',
  engines: { harness: '^1.2.0' },
  main: 'index.ts',
  permissions: ['process'],
} satisfies PluginManifest

export interface WorkspaceToolsOptions {
  /** The plugin logger (`ctx.logger`), for the shell's log lines. */
  logger: Logger
  /** Default `process.platform` (tests): `shell` is not registered on Windows (the process-group kill needs POSIX). */
  platform?: NodeJS.Platform
}

/** The workspace tools in registration order (`WORKSPACE_TOOL_NAMES`); `shell` only off Windows. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createReadFileTool(),
    createListDirectoryTool(),
    createFindFilesTool(),
    createSearchFilesTool(),
    createWriteFileTool(),
    createEditFileTool(),
  ]
  if ((options.platform ?? process.platform) !== 'win32')
    tools.push(createShellTool({ logger: options.logger }))
  return tools
}

export default definePlugin({
  setup(ctx) {
    for (const tool of createWorkspaceTools({ logger: ctx.logger }))
      ctx.tools.register(tool)
  },
})
