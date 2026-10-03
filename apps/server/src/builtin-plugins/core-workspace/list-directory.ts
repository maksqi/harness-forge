// The `list_directory` tool of `core-workspace` (ADR-032; policy `safe`, access `read`, timeout 30 s): the entries of a
// folder of the project (default `.`), resolved through the frozen path guard, sorted by name (code point order), at
// most `WORKSPACE_LIMITS.listMaxEntries` (1000; `truncated`). The temp files of atomic writes (`.hf-write-*`) are not
// listed. Types: `file`, `dir`, `symlink` (not followed), `other` (FIFOs, sockets, devices).
//
// The model sees one name per line, `name/` for a folder and `name@` for a link (like `ls -F`).
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ListDirectoryToolInput, ListDirectoryToolOutput, WorkspaceEntryType } from '@harness-forge/shared'
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { listDirectoryToolInputSchema, listDirectoryToolOutputSchema, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { resolveWorkspacePath, WORKSPACE_TEMP_PREFIX, workspacePathError } from '../../workspace/paths.ts'
import { fitItems } from '../../workspace/trim.ts'
import { READ_TOOL_TIMEOUT_MS, requireWorkspace, textModelOutput } from './common.ts'

export const LIST_DIRECTORY_TOOL_NAME = 'list_directory'

function entryType(entry: Dirent): WorkspaceEntryType {
  if (entry.isSymbolicLink())
    return 'symlink'
  if (entry.isDirectory())
    return 'dir'
  if (entry.isFile())
    return 'file'
  return 'other'
}

/** The text the model sees for a `list_directory` output. */
export function listDirectoryModelText(output: ListDirectoryToolOutput): string {
  if (output.entries.length === 0)
    return output.truncated ? '[truncated]' : `(${output.path} is an empty folder)`
  const lines = output.entries.map(entry => entry.type === 'dir' ? `${entry.name}/` : entry.type === 'symlink' ? `${entry.name}@` : entry.name)
  if (output.truncated)
    lines.push(`[truncated: only the first ${output.entries.length} entries are listed]`)
  return lines.join('\n')
}

export function createListDirectoryTool(): ToolDefinition<ListDirectoryToolInput, ListDirectoryToolOutput> {
  return {
    name: LIST_DIRECTORY_TOOL_NAME,
    description: 'List the files and folders of a folder in the project (default: the project folder itself). Folder names end with "/". At most 1000 entries, sorted by name.',
    inputSchema: listDirectoryToolInputSchema,
    policy: 'safe',
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.list_directory,
    async execute(input, c) {
      const { root } = requireWorkspace(c)
      const resolved = await resolveWorkspacePath(root, input.path ?? '.')
      if (!(await lstat(resolved.absolute)).isDirectory())
        throw workspacePathError(`"${resolved.rel}" is not a folder.`)
      c.signal.throwIfAborted()
      const dirents = await readdir(resolved.absolute, { withFileTypes: true })
      const entries = dirents
        .filter(entry => !entry.name.startsWith(WORKSPACE_TEMP_PREFIX))
        .map(entry => ({ name: entry.name, type: entryType(entry) }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const capped = entries.slice(0, WORKSPACE_LIMITS.listMaxEntries)
      const base: ListDirectoryToolOutput = { path: resolved.rel, entries: [], truncated: true }
      const { kept, cut } = fitItems(base, capped)
      return { path: resolved.rel, entries: kept, truncated: cut || entries.length > capped.length }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(listDirectoryToolOutputSchema, output, listDirectoryModelText)
    },
  }
}
