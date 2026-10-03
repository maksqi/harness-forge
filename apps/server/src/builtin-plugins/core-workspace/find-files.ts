// The `find_files` tool of `core-workspace` (ADR-032; policy `safe`, access `read`, timeout 60 s): files below a folder
// of the project (default `.`, resolved through the frozen path guard) whose path matches a glob. The walk is
// `walkWorkspace` (`.git` always skipped; `node_modules` and gitignored paths unless `include_ignored`; folder links
// not entered; caps 100,000 entries, depth 64, 10 s). The glob (`picomatch`, dot files included; without `/` it
// matches the file name at any depth, else the path relative to the searched folder) is matched in the pattern Worker
// (`workspace/pattern-worker.ts`), so a pathological pattern cannot stall the server. The result is the project-relative
// paths in code point order, at most `max_results` (default 200, at most 1000); `truncated` when more files matched or
// the walk stopped early.
//
// The model sees one path per line, or "No files match."
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { FindFilesToolInput, FindFilesToolOutput } from '@harness-forge/shared'
import { lstat } from 'node:fs/promises'
import { findFilesToolInputSchema, findFilesToolOutputSchema, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { resolveWorkspacePath, workspacePathError } from '../../workspace/paths.ts'
import { compileGlob, startPatternWorker } from '../../workspace/pattern-worker.ts'
import { fitItems } from '../../workspace/trim.ts'
import { walkWorkspace } from '../../workspace/walk.ts'
import { requireWorkspace, SEARCH_TOOL_TIMEOUT_MS, textModelOutput } from './common.ts'

export const FIND_FILES_TOOL_NAME = 'find_files'

export interface FindFilesToolOptions {
  /** The pattern Worker's timeout (tests); default `SEARCH_WORKER_TIMEOUT_MS`. */
  workerTimeoutMs?: number
}

/** The resolved start folder of a walk: an existing folder of the project. */
export async function resolveSearchFolder(root: string, path: string | undefined): Promise<{ absolute: string, rel: string }> {
  const resolved = await resolveWorkspacePath(root, path ?? '.')
  if (!(await lstat(resolved.absolute)).isDirectory())
    throw workspacePathError(`"${resolved.rel}" is not a folder.`)
  return resolved
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The text the model sees for a `find_files` output. */
export function findFilesModelText(output: FindFilesToolOutput): string {
  if (output.paths.length === 0)
    return output.truncated ? 'No files match (the search stopped early; narrow the path).' : 'No files match.'
  const lines = [...output.paths]
  if (output.truncated)
    lines.push(`[truncated: showing ${output.paths.length} paths; narrow the pattern or the path]`)
  return lines.join('\n')
}

export function createFindFilesTool(options: FindFilesToolOptions = {}): ToolDefinition<FindFilesToolInput, FindFilesToolOutput> {
  return {
    name: FIND_FILES_TOOL_NAME,
    description: 'Find files of the project folder by glob pattern, e.g. "src/**/*.ts" or "*.md" (a pattern without "/" matches file names at any depth; dot files are included). .git is always skipped; node_modules and gitignored files are skipped unless include_ignored is true. Returns sorted paths relative to the project folder.',
    inputSchema: findFilesToolInputSchema,
    policy: 'safe',
    timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.find_files,
    async execute(input, c) {
      const { root } = requireWorkspace(c)
      const glob = compileGlob(input.pattern)
      const folder = await resolveSearchFolder(root, input.path)
      const walk = await walkWorkspace({ root, start: folder.absolute, includeIgnored: input.include_ignored === true, signal: c.signal })
      let keep: number[] = []
      if (walk.files.length > 0) {
        const worker = startPatternWorker({ glob, signal: c.signal, timeoutMs: options.workerTimeoutMs })
        try {
          keep = await worker.filterPaths(walk.files.map(file => file.fromStart))
        }
        finally {
          await worker.close()
        }
      }
      const matched = keep.map(index => walk.files[index]!.rel).sort(compareText)
      const maxResults = input.max_results ?? WORKSPACE_LIMITS.findDefaultResults
      const capped = matched.slice(0, maxResults)
      const base: FindFilesToolOutput = { pattern: input.pattern, paths: [], truncated: true }
      const { kept, cut } = fitItems(base, capped)
      return { pattern: input.pattern, paths: kept, truncated: cut || matched.length > capped.length || walk.truncated }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(findFilesToolOutputSchema, output, findFilesModelText)
    },
  }
}
